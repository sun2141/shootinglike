import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";

/**
 * 리더보드 기록 관리 (관리자 전용).
 *
 * GET    — 최근 기록 목록
 * DELETE — { id } 하나 삭제, { all: true } 전체 삭제
 *
 * 지금은 중력 검산을 통과한 측정만 저장되지만, 예전 방식으로 쌓인 기록(1~61 km/h 같은 값)이
 * 남아 있어 한 번 비울 수단이 필요하다.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauthorized = verifyAdminReferenceRequest(req);
  if (unauthorized) return unauthorized;

  try {
    const prisma = getPrisma();
    const [records, total] = await Promise.all([
      prisma.analysis.findMany({
        take: 100,
        orderBy: { createdAt: "desc" },
        include: { user: true },
      }),
      prisma.analysis.count(),
    ]);

    return NextResponse.json({
      total,
      records: records.map((r) => ({
        id: r.id,
        nickname: r.user?.nickname ?? null,
        estimatedSpeedKmh: r.estimatedSpeedKmh,
        formScore: r.formScore,
        kickType: r.kickType,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to list records", error);
    return NextResponse.json({ error: "기록을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const unauthorized = verifyAdminReferenceRequest(req);
  if (unauthorized) return unauthorized;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // 본문이 없으면 아래에서 잘못된 요청으로 처리한다
  }
  const { id, all } = (body ?? {}) as { id?: unknown; all?: unknown };

  try {
    const prisma = getPrisma();

    if (all === true) {
      const { count } = await prisma.analysis.deleteMany({});
      return NextResponse.json({ deleted: count });
    }

    if (typeof id === "string" && id.trim()) {
      await prisma.analysis.delete({ where: { id: id.trim() } });
      return NextResponse.json({ deleted: 1 });
    }

    return NextResponse.json({ error: "id 또는 all 이 필요합니다." }, { status: 400 });
  } catch (error) {
    console.error("Failed to delete records", error);
    return NextResponse.json({ error: "삭제하지 못했습니다." }, { status: 500 });
  }
}
