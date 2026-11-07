import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import { EDIT_ACTIONS, badRequest, cleanTruth, json, num, str, type EditAction } from "@/lib/refauto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 워커가 가져갈 대기 중인 수정 요청 (오래된 것부터) */
export async function GET(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  const edits = await getPrisma().refautoEdit.findMany({
    where: { status },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return NextResponse.json({ edits });
}

function cleanPoint(p: unknown): [number, number] | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const x = num(p[0]);
  const y = num(p[1]);
  return x === null || y === null ? null : [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

function cleanClicks(c: unknown) {
  if (!c || typeof c !== "object") return null;
  const src = c as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(src.kicker) && src.kicker.length === 2) {
    const pts = src.kicker.map(cleanPoint);
    if (pts.every(Boolean)) out.kicker = pts;
  }
  if (Array.isArray(src.goal) && src.goal.length === 4) {
    const pts = src.goal.map(cleanPoint);
    if (pts.every(Boolean)) out.goal = pts;
  }
  if (Array.isArray(src.ball) && src.ball.length === 3) {
    const b = src.ball.map(num);
    if (b.every((x) => x !== null)) out.ball = b;
  }
  return Object.keys(out).length ? out : null;
}

function cleanMeta(m: unknown) {
  if (!m || typeof m !== "object") return null;
  const src = m as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const k = num(src.kicker_cm);
  if (k !== null && k >= 100 && k <= 220) out.kicker_cm = k;
  const d = num(src.dummy_cm);
  if (d !== null && d >= 50 && d <= 250) out.dummy_cm = d;
  const b = num(src.ball);
  if (b === 3 || b === 4 || b === 5) out.ball = b;
  const g = str(src.goal, 20);
  if (g === "adult" || g === "youth" || g === "futsal") out.goal = g;
  const p = str(src.pitch, 20);
  if (p === "adult" || p === "none") out.pitch = p;
  return Object.keys(out).length ? out : null;
}

/**
 * 관리자 화면 → 수정 요청.
 *   {videoId, kick, action: accept|reject|recompute, meta?, clicks?}
 *   {videoId, kick, action: truth, truth?: {value, unit, device, note} | null, penalty?: boolean | null}
 * 확정·제외는 화면에 바로 반영하고, Mac 이 켜지면 영상 옆 메모(.json)에도 남긴다.
 */
export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return badRequest("본문이 JSON 이 아닙니다.");
  const videoId = str(body.videoId, 64);
  const kick = Math.round(Number(body.kick));
  const action = str(body.action, 20) as EditAction | null;
  if (!videoId || !Number.isFinite(kick) || !action || !EDIT_ACTIONS.includes(action)) {
    return badRequest("videoId, kick, action 이 필요합니다.");
  }
  const prisma = getPrisma();
  const target = await prisma.refautoKick.findUnique({
    where: { videoId_kick: { videoId, kick } },
    include: { video: { select: { meta: true } } },
  });
  if (!target) return NextResponse.json({ error: "킥을 찾을 수 없습니다." }, { status: 404 });

  if (action === "truth") {
    // 정답(레이더 속도·페널티킥 여부)은 다시 계산할 필요가 없다 → 화면(DB)에 바로 넣고, Mac 에는 백업용으로만 보낸다
    const truth = body.truth === undefined ? undefined : cleanTruth(body.truth);
    if (truth === undefined && body.truth !== undefined) return badRequest("속도 값이 올바르지 않습니다 (15~220 km/h).");
    const penalty = body.penalty === true ? true : body.penalty === false ? false : null;
    const data = { ...((target.data as Record<string, unknown> | null) ?? {}) };
    if (truth !== undefined) data.truth = truth;
    data.penalty = penalty;
    await prisma.refautoKick.update({ where: { id: target.id }, data: { data: json(data) as Prisma.InputJsonValue } });
    await prisma.refautoEdit.updateMany({
      where: { videoId, kick, status: "pending", action },
      data: { status: "superseded", doneAt: new Date() },
    });
    const edit = await prisma.refautoEdit.create({
      data: {
        videoId,
        kick,
        action,
        meta: json({ truth: data.truth ?? null, penalty, t_kick: data.t_kick ?? null }) as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({ edit, data });
  }

  const meta = cleanMeta(body.meta);
  const clicks = cleanClicks(body.clicks);
  if (action === "recompute" && !meta && !clicks) return badRequest("바꿀 값이나 클릭이 없습니다.");
  const known = (target.video.meta as Record<string, unknown> | null)?.kicker_cm;
  if (clicks?.kicker && !meta?.kicker_cm && !known) {
    return badRequest("키커 키(cm)를 함께 입력하세요.");
  }

  // 같은 킥의 처리 안 된 이전 요청은 새 요청으로 대체
  await prisma.refautoEdit.updateMany({
    where: { videoId, kick, status: "pending", action },
    data: { status: "superseded", doneAt: new Date() },
  });
  const edit = await prisma.refautoEdit.create({
    data: {
      videoId,
      kick,
      action,
      meta: json(meta) as Prisma.InputJsonValue,
      clicks: json(clicks) as Prisma.InputJsonValue,
    },
  });
  if (action === "accept" || action === "reject") {
    await prisma.refautoKick.update({
      where: { id: target.id },
      data: { status: action === "accept" ? "manual" : "rejected", source: "manual" },
    });
  }
  return NextResponse.json({ edit });
}

/** 워커 → 처리 결과: {ids: [...], status: done|failed, result?} */
export async function PATCH(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const body = await req.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 100) : [];
  const status = body?.status === "failed" ? "failed" : "done";
  if (!ids.length) return badRequest("ids 가 필요합니다.");
  const r = await getPrisma().refautoEdit.updateMany({
    where: { id: { in: ids } },
    data: { status, result: str(body?.result, 500), doneAt: new Date() },
  });
  return NextResponse.json({ updated: r.count });
}
