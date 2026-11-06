import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 관리자 대시보드(/admin)용 한 번에 보는 현황: 표별 개수, DB 용량, 자동 분석 판정 분포, Mac 워커 상태.
 * 가벼운 count 몇 번이라 열 때마다 불러도 비용이 거의 없다.
 */
export async function GET(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const prisma = getPrisma();
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [
      analyses,
      analysesWeek,
      users,
      refs,
      refsActive,
      videos,
      kickGroups,
      editsPending,
      states,
      lastAnalysis,
      lastRef,
      dbSize,
      images,
    ] = await Promise.all([
      prisma.analysis.count(),
      prisma.analysis.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count(),
      prisma.referenceVideo.count(),
      prisma.referenceVideo.count({ where: { isActive: true } }),
      prisma.refautoVideo.count(),
      prisma.refautoKick.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.refautoEdit.count({ where: { status: "pending" } }),
      prisma.refautoState.findMany(),
      prisma.analysis.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.referenceVideo.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`,
      prisma.$queryRaw<{ n: bigint; bytes: bigint }[]>`SELECT count(*) AS n, COALESCE(sum(octet_length(bytes)), 0) AS bytes FROM "RefautoImage"`,
    ]);

    const kicks: Record<string, number> = {};
    for (const g of kickGroups) kicks[g.status] = g._count._all;
    const state = Object.fromEntries(states.map((s) => [s.key, s.value])) as Record<string, unknown>;
    const manualRefs = Array.isArray(state.manual_refs) ? state.manual_refs.length : 0;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      db: {
        bytes: Number(dbSize[0]?.bytes ?? 0),
        images: { count: Number(images[0]?.n ?? 0), bytes: Number(images[0]?.bytes ?? 0) },
      },
      records: { total: analyses, week: analysesWeek, users, last: lastAnalysis?.createdAt ?? null },
      references: { total: refs, active: refsActive, last: lastRef?.createdAt ?? null },
      refauto: { videos: videos, kicks, editsPending, manualRefs, worker: state.worker ?? null },
    });
  } catch (error) {
    console.error("admin overview failed:", error);
    return NextResponse.json({ error: "현황을 불러오지 못했습니다." }, { status: 500 });
  }
}
