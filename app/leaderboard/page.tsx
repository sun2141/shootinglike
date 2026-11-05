import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { getPrisma } from "@/lib/prisma";

// Server component. 빌드 때 DB 에 붙지 않도록 페이지는 요청마다 그리되,
// 순위 조회 결과는 60초 캐시한다 — 조회 수가 늘어도 DB 조회는 1분에 한 번.
export const dynamic = 'force-dynamic';

const loadTop = unstable_cache(
  async () =>
    getPrisma().analysis.findMany({
      take: 20,
      // 구속 순위판이므로 속도가 먼저다. 저장 자체가 중력 검산을 통과한 측정만 들어온다.
      orderBy: [{ estimatedSpeedKmh: 'desc' }, { formScore: 'desc' }],
      include: { user: true },
    }),
  ['leaderboard-top20'],
  { revalidate: 60 },
);

type LeaderboardAnalysis = Prisma.AnalysisGetPayload<{
  include: { user: true };
}>;

export default async function LeaderboardPage() {
  let analyses: LeaderboardAnalysis[] = [];
  try {
    analyses = await loadTop();
  } catch (err) {
    console.error("DB connection error:", err);
    // Ignore error if DB is not connected yet, show empty list
  }

  return (
    <div className="min-h-screen flex flex-col p-8 relative">
      <header className="w-full max-w-4xl mx-auto flex items-center justify-between mb-12">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>홈으로</span>
        </Link>
        <div className="font-mono text-sm tracking-widest text-[var(--color-neon-blue)]">
          RANKINGS
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-8 border-b border-white/10 pb-6">
          <div className="w-12 h-12 rounded-full bg-[var(--color-neon-blue)]/20 flex items-center justify-center text-[var(--color-neon-blue)]">
            <Trophy size={24} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">구속 순위</h1>
            <p className="text-gray-400 text-sm">중력 검산을 통과한 측정만 올라갑니다.</p>
          </div>
        </div>

        <div className="glass-card overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <th className="p-4 text-sm font-medium text-gray-400">순위</th>
                <th className="p-4 text-sm font-medium text-gray-400">닉네임</th>
                <th className="p-4 text-sm font-medium text-gray-400">구속</th>
                <th className="p-4 text-sm font-medium text-gray-400 text-right">폼 점수</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {analyses.length > 0 ? analyses.map((analysis, index) => {
                const i = index + 1;
                return (
                  <tr key={analysis.id} className="hover:bg-white/5 transition-colors">
                    <td className="p-4">
                      <span className={`font-mono text-lg font-bold ${i === 1 ? 'text-yellow-400' : i === 2 ? 'text-gray-300' : i === 3 ? 'text-amber-600' : 'text-gray-500'}`}>
                        #{i}
                      </span>
                    </td>
                    <td className="p-4 font-medium">{analysis.user?.nickname || 'Unknown Player'}</td>
                    <td className="p-4 font-mono text-[var(--color-neon-green)]">{analysis.estimatedSpeedKmh} km/h</td>
                    <td className="p-4 text-right font-mono text-[var(--color-neon-blue)]">{analysis.formScore} pts</td>
                  </tr>
                )
              }) : (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-500">
                    아직 기록이 없습니다. 첫 기록을 남겨보세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
