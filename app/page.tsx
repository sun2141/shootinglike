import Link from 'next/link';
import { Activity, Target, Timer, Zap } from 'lucide-react';

/**
 * 사용자 화면은 셋뿐이다: 홈 · 측정(/analyze) · 리더보드.
 * 관리자 화면(/admin)은 여기서 링크하지 않는다 — 주소로 직접 들어간다.
 */
export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[var(--color-neon-green)]/10 rounded-full blur-[120px] -z-10" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[var(--color-neon-blue)]/10 rounded-full blur-[120px] -z-10" />

      <main className="max-w-4xl w-full flex flex-col items-center text-center space-y-12">
        <div className="space-y-6">
          <div className="inline-block px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md mb-4">
            <span className="text-sm font-medium tracking-wider text-gray-300 uppercase">
              중력으로 검산하는 구속 측정
            </span>
          </div>

          <h1 className="text-6xl md:text-8xl font-black tracking-tighter text-white">
            MASTER YOUR <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--color-neon-green)] to-[var(--color-neon-blue)]">
              FREEKICK
            </span>
          </h1>

          <p className="text-xl text-gray-400 max-w-2xl mx-auto font-light">
            프리킥을 옆에서 찍으면 공 속도를 재드립니다. 장비는 필요 없습니다.
            <br className="hidden sm:block" />
            <span className="text-gray-300">검산을 통과한 값만 보여주고, 못 잰 경우엔 이유를 알려드립니다.</span>
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
          <Link
            href="/analyze"
            className="px-8 py-4 bg-white text-black font-bold rounded-full hover:scale-105 transition-transform duration-300 shadow-[0_0_20px_rgba(255,255,255,0.3)] text-lg"
          >
            측정 시작
          </Link>
          <Link
            href="/leaderboard"
            className="px-8 py-4 bg-transparent border border-white/20 text-white font-bold rounded-full hover:bg-white/10 transition-colors duration-300 text-lg"
          >
            리더보드
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 w-full mt-16 pt-16 border-t border-white/10">
          <div className="glass-card p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-green)]/10 flex items-center justify-center text-[var(--color-neon-green)]">
              <Target size={24} />
            </div>
            <h3 className="text-lg font-bold">옆에서</h3>
            <p className="text-gray-400 text-sm">공이 날아가는 방향과 직각으로 서서 찍어주세요. 뒤나 앞에서 찍으면 잴 수 없습니다.</p>
          </div>

          <div className="glass-card p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-blue)]/10 flex items-center justify-center text-[var(--color-neon-blue)]">
              <Zap size={24} />
            </div>
            <h3 className="text-lg font-bold">60fps 이상</h3>
            <p className="text-gray-400 text-sm">30fps 로는 빠른 슛의 궤적이 남지 않습니다. 카메라 설정에서 올려주세요.</p>
          </div>

          <div className="glass-card p-6 flex flex-col items-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white">
              <Activity size={24} />
            </div>
            <h3 className="text-lg font-bold">폰 고정</h3>
            <p className="text-gray-400 text-sm">들고 따라가지 말고 세워두세요. 공이 화면에서 동전만 하게 보이는 거리가 좋습니다.</p>
          </div>

          <div className="glass-card p-6 flex flex-col items-center text-center space-y-3">
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
