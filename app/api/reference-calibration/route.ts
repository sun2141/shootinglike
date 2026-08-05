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

    return NextResponse.json({
      calibration: buildReferenceCalibrationSummary(references),
    });
  } catch (error) {
    console.error("Failed to load reference calibration:", error);
    return NextResponse.json({
      calibration: buildReferenceCalibrationSummary([]),
    });
  }
}
