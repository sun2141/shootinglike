import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getReferenceCalibrationFactor } from "@/lib/analysis/reference-calibration";
import { getPrisma } from "@/lib/prisma";
import { badRequest, str } from "@/lib/refauto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 확정된 킥을 레퍼런스 정답표(ReferenceVideo)에 등록한다.
 * 앱 측정값이 아직 없으므로 측정값 = 레퍼런스 값, isActive=false 로 넣는다
 * → /admin/references 목록에는 보이지만 보정 계수 계산에는 섞이지 않는다.
 */
export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const body = await req.json().catch(() => null);
  const kickId = str(body?.kickId, 64);
  if (!kickId) return badRequest("kickId 가 필요합니다.");
  const prisma = getPrisma();
  const k = await prisma.refautoKick.findUnique({ where: { id: kickId }, include: { video: true } });
  if (!k) return NextResponse.json({ error: "킥을 찾을 수 없습니다." }, { status: 404 });
  if (k.referenceId) return NextResponse.json({ error: "이미 등록했습니다.", referenceId: k.referenceId }, { status: 409 });
  if (!["A", "manual"].includes(k.status) || !k.speedKmh) {
    return badRequest("확정(A)이나 수동 확정인 킥만 등록할 수 있습니다.");
  }

  const speed = Math.round(k.speedKmh * 10) / 10;
  const info = (k.video.info ?? {}) as Record<string, number | null>;
  const meta = (k.video.meta ?? {}) as Record<string, number | string | null>;
  const data = (k.data ?? {}) as Record<string, unknown>;
  const tStart = typeof data.t_kick === "number" ? data.t_kick : null;
  const tEnd = typeof data.t_end === "number" ? data.t_end : null;
  const kicker = Number(meta.kicker_cm);

  const reference = await prisma.referenceVideo.create({
    data: {
      label: `rearview ${k.video.file} #${k.kick}`.slice(0, 80),
      sourceFilename: k.video.file.slice(0, 140),
      knownSpeedKmh: speed,
      measuredSpeedKmh: speed,
      knownDistanceMeters: k.distM,
      videoWidth: Number.isFinite(info.width) ? info.width : null,
      videoHeight: Number.isFinite(info.height) ? info.height : null,
      durationSeconds: Number.isFinite(info.duration) ? info.duration : null,
      fps: Number.isFinite(info.fps) ? info.fps : null,
      timingStartSeconds: tStart !== null && tEnd !== null && tEnd > tStart ? tStart : null,
      timingEndSeconds: tStart !== null && tEnd !== null && tEnd > tStart ? tEnd : null,
      playerHeightCm: Number.isFinite(kicker) && kicker >= 120 && kicker <= 220 ? kicker : null,
      cameraAngle: "rear-diagonal (refauto)",
      trajectoryPoints: k.trackPoints,
      ballDiameterPx: typeof data.ball_px === "number" ? data.ball_px : null,
      calibrationFactor: getReferenceCalibrationFactor({ knownSpeedKmh: speed, measuredSpeedKmh: speed }) ?? 1,
      notes: `refauto · 판정 ${k.status} · 궤적 오차 ${k.rmsPx?.toFixed(1) ?? "?"}px · 앱 측정 없음 — 보정 계산 제외`.slice(0, 500),
      isActive: false,
    },
  });
  await prisma.refautoKick.update({ where: { id: k.id }, data: { referenceId: reference.id } });
  return NextResponse.json({ reference });
}
