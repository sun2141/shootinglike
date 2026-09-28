import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import { badRequest, json, num, str, type SyncKick, type SyncVideo } from "@/lib/refauto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mac 워커 → 계산 결과 올리기.
 *   {videos: SyncVideo[], state?: {worker: {...}, manual_refs: [...]}}
 * 영상 단위로 통째로 바꾼다(그 영상의 킥 목록 = 보낸 것). 이미 등록한 referenceId 는 유지.
 */
export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return badRequest("본문이 JSON 이 아닙니다.");
  const prisma = getPrisma();
  const videos: SyncVideo[] = Array.isArray(body.videos) ? body.videos.slice(0, 50) : [];

  let n = 0;
  for (const v of videos) {
    const id = str(v?.id, 64);
    const file = str(v?.file, 300);
    if (!id || !file) continue;
    const processedAt = v.processedAt ? new Date(v.processedAt) : null;
    const videoData = {
      file,
      status: str(v.status, 40) ?? "unknown",
      reason: str(v.reason, 500),
      meta: json(v.meta ?? null) as Prisma.InputJsonValue,
      info: json(v.info ?? null) as Prisma.InputJsonValue,
      processedAt: processedAt && !Number.isNaN(processedAt.getTime()) ? processedAt : null,
    };
    const kicks: SyncKick[] = Array.isArray(v.kicks) ? v.kicks.slice(0, 20) : [];

    await prisma.$transaction(async (tx) => {
      await tx.refautoVideo.upsert({ where: { id }, update: videoData, create: { id, ...videoData } });
      const old = await tx.refautoKick.findMany({ where: { videoId: id } });
      const keepRef = new Map(old.map((k) => [k.kick, k.referenceId]));
      const sent = new Set<number>();
      for (const k of kicks) {
        const kick = Math.round(Number(k.kick));
        if (!Number.isFinite(kick) || kick < 1) continue;
        sent.add(kick);
        const data = {
          status: str(k.status, 40) ?? "review",
          source: str(k.source, 40) ?? "auto",
          reasons: json(k.reasons ?? []) as Prisma.InputJsonValue,
          notes: json(k.notes ?? []) as Prisma.InputJsonValue,
          speedKmh: num(k.speedKmh),
          elevDeg: num(k.elevDeg),
          distM: num(k.distM),
          rmsPx: num(k.rmsPx),
          trackPoints: num(k.trackPoints) === null ? null : Math.round(Number(k.trackPoints)),
          data: json(k.data ?? null) as Prisma.InputJsonValue,
          overlayImageId: str(k.overlayImageId, 40),
          frameImageId: str(k.frameImageId, 40),
          candidateFrames: json(k.candidateFrames ?? []) as Prisma.InputJsonValue,
        };
        await tx.refautoKick.upsert({
          where: { videoId_kick: { videoId: id, kick } },
          update: data,
          create: { videoId: id, kick, ...data, referenceId: keepRef.get(kick) ?? null },
        });
      }
      const stale = old.filter((k) => !sent.has(k.kick)).map((k) => k.id);
      if (stale.length) await tx.refautoKick.deleteMany({ where: { id: { in: stale } } });
    });
    n += 1;
  }

  if (body.state && typeof body.state === "object") {
    for (const key of ["worker", "manual_refs"] as const) {
      if (body.state[key] === undefined) continue;
      const value = json(body.state[key]) as Prisma.InputJsonValue;
      await prisma.refautoState.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
  }
  return NextResponse.json({ synced: n });
}
