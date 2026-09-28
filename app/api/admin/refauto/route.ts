import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 관리자 화면용 목록: 영상·킥·대기 중인 수정 요청·워커 상태·수동 분석 레퍼런스 */
export async function GET(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const prisma = getPrisma();
    const [videos, edits, states] = await Promise.all([
      prisma.refautoVideo.findMany({
        orderBy: { file: "asc" },
        include: { kicks: { orderBy: { kick: "asc" } } },
      }),
      prisma.refautoEdit.findMany({
        where: { OR: [{ status: "pending" }, { doneAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } }] },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.refautoState.findMany(),
    ]);
    const state = Object.fromEntries(states.map((s) => [s.key, s.value]));
    return NextResponse.json({ videos, edits, state });
  } catch (error) {
    console.error("refauto list failed:", error);
    return NextResponse.json({ error: "목록을 불러오지 못했습니다." }, { status: 500 });
  }
}
