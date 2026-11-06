import Link from 'next/link';
import { Activity, ChevronRight, Target, Timer, Trophy, Zap } from 'lucide-react';

/**
 * 사용자 화면: 홈 · 구속 측정(/analyze) · 프리킥 측정(/analyze/freekick, 베타) · 리더보드.
 * 관리자 화면(/admin)은 여기서 링크하지 않는다 — 주소로 직접 들어간다.
 */
export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10 sm:p-8 relative overflow-hidden">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[var(--color-neon-green)]/10 rounded-full blur-[120px] -z-10" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[var(--color-neon-blue)]/10 rounded-full blur-[120px] -z-10" />

      <main className="max-w-4xl w-full flex flex-col items-center text-center space-y-10 sm:space-y-12">
        <div className="space-y-6">
          <div className="inline-block px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md mb-4">
            <span className="text-sm font-medium tracking-wider text-gray-300 uppercase">
              중력으로 검산하는 구속 측정
            </span>
          </div>

          <h1 className="text-5xl sm:text-6xl md:text-8xl font-black tracking-tighter text-white">
            MASTER YOUR <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--color-neon-green)] to-[var(--color-neon-blue)]">
              FREEKICK
            </span>
          </h1>

          <p className="text-base sm:text-xl text-gray-400 max-w-2xl mx-auto font-light">
            프리킥을 옆에서 찍으면 공 속도를 재드립니다. 장비는 필요 없습니다.{" "}
            <br className="hidden sm:block" />
            <span className="text-gray-300">검산을 통과한 값만 보여주고, 못 잰 경우엔 이유를 알려드립니다.</span>
          </p>
        </div>

        <div className="flex w-full max-w-md flex-col gap-3">
          <Link
            href="/analyze"
            className="group flex items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 text-left text-black shadow-[0_0_24px_rgba(255,255,255,0.25)] transition-transform hover:scale-[1.02]"
          >
            <span>
              <span className="block text-lg font-bold">구속 측정</span>
              <span className="block text-xs text-gray-600">옆에서 찍은 슛 영상</span>
            </span>
            <ChevronRight className="shrink-0 transition-transform group-hover:translate-x-1" />
          </Link>
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/analyze/freekick"
              className="group flex flex-col items-start gap-1 rounded-2xl border border-[var(--color-neon-blue)]/40 bg-[var(--color-neon-blue)]/10 px-4 py-3.5 text-left transition-colors hover:bg-[var(--color-neon-blue)]/20"
            >
              <span className="flex items-center gap-1.5 font-bold">
                프리킥 측정
                <span className="rounded-full bg-[var(--color-neon-blue)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-neon-blue)]">베타</span>
              </span>
              <span className="text-xs text-gray-400">공 뒤 대각선에서</span>
            </Link>
            <Link
              href="/leaderboard"
              className="group flex flex-col items-start gap-1 rounded-2xl border border-white/15 px-4 py-3.5 text-left transition-colors hover:bg-white/10"
            >
              <span className="flex items-center gap-1.5 font-bold">
                <Trophy size={16} className="text-[var(--color-neon-green)]" /> 리더보드
              </span>
              <span className="text-xs text-gray-400">구속 순위</span>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-6 w-full mt-6 pt-10 sm:mt-16 sm:pt-16 border-t border-white/10">
          <div className="glass-card p-4 sm:p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-green)]/10 flex items-center justify-center text-[var(--color-neon-green)]">
              <Target size={24} />
            </div>
            <h3 className="text-lg font-bold">옆에서</h3>
            <p className="text-gray-400 text-sm">공이 날아가는 방향과 직각으로 서서 찍어주세요. 뒤나 앞에서 찍으면 잴 수 없습니다.</p>
          </div>

          <div className="glass-card p-4 sm:p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-blue)]/10 flex items-center justify-center text-[var(--color-neon-blue)]">
              <Zap size={24} />
            </div>
            <h3 className="text-lg font-bold">60fps 이상</h3>
            <p className="text-gray-400 text-sm">30fps 로는 빠른 슛의 궤적이 남지 않습니다. 카메라 설정에서 올려주세요.</p>
          </div>

          <div className="glass-card p-4 sm:p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white">
              <Activity size={24} />
            </div>
            <h3 className="text-lg font-bold">폰 고정</h3>
            <p className="text-gray-400 text-sm">들고 따라가지 말고 세워두세요. 공이 화면에서 동전만 하게 보이는 거리가 좋습니다.</p>
          </div>

          <div className="glass-card p-4 sm:p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white">
              <Timer size={24} />
            </div>
            <h3 className="text-lg font-bold">킥 앞뒤 3초</h3>
            <p className="text-gray-400 text-sm">짧게 찍을수록 정확합니다. 앱 안에서 찍으면 4초에 자동으로 멈춥니다.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
