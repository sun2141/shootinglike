import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { buildReferenceCalibrationSummary } from "@/lib/analysis/reference-calibration";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReferenceRouteContext = {
  params: Promise<{ id: string }>;
};

async function getCalibrationPayload() {
  const prisma = getPrisma();
  const activeReferences = await prisma.referenceVideo.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return buildReferenceCalibrationSummary(activeReferences);
}

export async function PATCH(req: Request, context: ReferenceRouteContext) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const { id } = await context.params;
    const body = await req.json();
    const prisma = getPrisma();

    const reference = await prisma.referenceVideo.update({
      where: { id },
      data: {
        isActive: body.isActive !== false,
      },
    });

    return NextResponse.json({
      reference,
      calibration: await getCalibrationPayload(),
    });
  } catch (error) {
    console.error("Failed to update reference video:", error);
    return NextResponse.json({ error: "Failed to update reference video." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: ReferenceRouteContext) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const { id } = await context.params;
    const prisma = getPrisma();

    await prisma.referenceVideo.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      calibration: await getCalibrationPayload(),
    });
  } catch (error) {
    console.error("Failed to delete reference video:", error);
    return NextResponse.json({ error: "Failed to delete reference video." }, { status: 500 });
  }
}
