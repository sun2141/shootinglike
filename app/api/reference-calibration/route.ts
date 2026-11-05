import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { buildReferenceCalibrationSummary } from "@/lib/analysis/reference-calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const prisma = getPrisma();
    const references = await prisma.referenceVideo.findMany({
      where: {
        isActive: true,
        knownSpeedKmh: { gt: 0 },
        measuredSpeedKmh: { gt: 0 },
      },
      // No explicit `select`: the calibration summary reads measurement-quality
      // columns, and listing them here would break the build whenever the
      // Prisma client has not been regenerated after a schema change.
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(
      { calibration: buildReferenceCalibrationSummary(references) },
      // 분석할 때마다 부르는 요청이라 CDN 에 5분 캐시 — 사용자가 늘어도 DB 조회는 5분에 한 번
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" } },
    );
  } catch (error) {
    console.error("Failed to load reference calibration:", error);
    return NextResponse.json({
      calibration: buildReferenceCalibrationSummary([]),
    });
  }
}
