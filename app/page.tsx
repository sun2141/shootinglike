import Link from 'next/link';
import { Activity, ChevronRight, Target, Timer, Trophy, Zap } from 'lucide-react';

/**
 * 사용자 화면: 홈 · 구속 측정(/analyze) · 프리킥 측정(/analyze/freekick, 베타) · 리더보드.
 * 관리자 화면(/admin)은 여기서 링크하지 않는다 — 주소로 직접 들어간다.
 *
 * 배경은 그림 파일 없이 CSS·SVG 로 그린 축구장: 잔디 줄무늬 + 잔디 결(노이즈) + 흰 경기장 선 + 조명 빛.
 * (이미지를 받지 않으니 휴대폰 데이터·서버 트래픽이 늘지 않는다)
 */

// 잔디 결: 아주 옅은 노이즈를 겹쳐 '평평한 초록'이 아니라 인조잔디처럼 보이게
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.7  0 0 0 0 1  0 0 0 0 0.6  0 0 0 0.55 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")";

const FEATURES = [
  { icon: Target, title: '옆에서', text: '공이 날아가는 방향과 직각으로 서서 찍어주세요. 뒤나 앞에서 찍으면 잴 수 없습니다.', color: '#b8ff3b' },
  { icon: Zap, title: '60fps 이상', text: '30fps 로는 빠른 슛의 궤적이 남지 않습니다. 카메라 설정에서 올려주세요.', color: '#38e1ff' },
  { icon: Activity, title: '폰 고정', text: '들고 따라가지 말고 세워두세요. 공이 화면에서 동전만 하게 보이는 거리가 좋습니다.', color: '#ffd23f' },
  { icon: Timer, title: '킥 앞뒤 3초', text: '짧게 찍을수록 정확합니다. 앱 안에서 찍으면 4초에 자동으로 멈춥니다.', color: '#ff7a59' },
];

export default function Home() {
  return (
    <div className="relative isolate min-h-screen overflow-hidden px-4 py-10 sm:p-8 flex flex-col items-center justify-center">
      <PitchBackground />

      <main className="max-w-4xl w-full flex flex-col items-center text-center space-y-10 sm:space-y-12">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/30 px-4 py-1.5 backdrop-blur-md">
            <span className="h-2 w-2 rounded-full bg-[#b8ff3b] shadow-[0_0_8px_#b8ff3b]" />
            <span className="text-sm font-medium tracking-wider text-white/90">중력으로 측정하는 공속도</span>
          </div>

          <h1 className="text-[2.35rem] leading-[1.05] sm:text-6xl md:text-8xl font-black tracking-tighter text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.45)]">
            HOW FAST YOUR <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#d7ff3f] via-[#7dff6a] to-[#3ee6ff]">FREEKICK</span>
          </h1>

          <p className="text-base sm:text-xl text-white/75 max-w-2xl mx-auto font-light">
            프리킥을 옆에서 찍으면 공 속도를 측정합니다. 장비는 필요 없습니다.{' '}
            <br className="hidden sm:block" />
            <span className="text-white/90">검산을 통과한 값만 보여주고, 측정 안 된 경우엔 이유를 알려드립니다.</span>
          </p>
        </div>

        <div className="flex w-full max-w-md flex-col gap-3">
          {/* 주 버튼: 형광 잔디색 */}
          <Link
            href="/analyze"
            className="group flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-[#d7ff3f] to-[#5cf26b] px-5 py-4 text-left text-[#06240f] shadow-[0_8px_30px_rgba(150,255,80,0.35)] ring-1 ring-white/40 transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            <span>
              <span className="block text-lg font-extrabold">구속 측정</span>
              <span className="block text-xs font-medium text-[#06240f]/70">옆에서 찍은 슛 영상</span>
            </span>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#06240f] text-[#d7ff3f] transition-transform group-hover:translate-x-1">
              <ChevronRight size={20} />
            </span>
          </Link>
          <div className="grid grid-cols-2 gap-3">
            {/* 하늘·조명색 */}
            <Link
              href="/analyze/freekick"
              className="flex flex-col items-start gap-1 rounded-2xl bg-gradient-to-br from-[#2bd4ff]/90 to-[#2563eb]/90 px-4 py-3.5 text-left text-white shadow-[0_8px_24px_rgba(43,180,255,0.3)] ring-1 ring-white/30 transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              <span className="flex items-center gap-1.5 font-bold">
                프리킥 측정
                <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-semibold">베타</span>
              </span>
              <span className="text-xs text-white/80">공 뒤 대각선에서</span>
            </Link>
            {/* 트로피 금색 */}
            <Link
              href="/leaderboard"
              className="flex flex-col items-start gap-1 rounded-2xl bg-gradient-to-br from-[#ffd23f] to-[#ff8a3d] px-4 py-3.5 text-left text-[#2a1600] shadow-[0_8px_24px_rgba(255,170,60,0.3)] ring-1 ring-white/30 transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              <span className="flex items-center gap-1.5 font-bold">
                <Trophy size={16} /> 리더보드
              </span>
              <span className="text-xs text-[#2a1600]/75">구속 순위</span>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-6 w-full mt-6 pt-10 sm:mt-16 sm:pt-16 border-t border-white/15">
          {FEATURES.map(({ icon: Icon, title, text, color }) => (
            <div
              key={title}
              className="rounded-2xl border border-white/15 bg-[#04170b]/55 p-4 sm:p-6 flex flex-col items-center text-center space-y-3 backdrop-blur-md"
            >
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ color, background: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}55` }}
              >
                <Icon size={24} />
              </div>
              <h3 className="text-lg font-bold">{title}</h3>
              <p className="text-white/65 text-sm">{text}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

/** 위에서 내려다본 잔디 경기장 (세로 화면 기준). 글자가 잘 읽히게 가장자리와 아래는 어둡게 */
function PitchBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      {/* 잔디 줄무늬 (깎은 방향이 번갈아 보이는 띠) */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(180deg, #12612f 0px, #12612f 72px, #0e5428 72px, #0e5428 144px)',
        }}
      />
      {/* 잔디 결 */}
      <div className="absolute inset-0 opacity-[0.22] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      {/* 경기장 선 */}
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 1600" preserveAspectRatio="xMidYMid slice" fill="none">
        <g stroke="white" strokeOpacity="0.16" strokeWidth="5">
          <rect x="60" y="60" width="880" height="1480" />
          <line x1="60" y1="800" x2="940" y2="800" />
          <circle cx="500" cy="800" r="150" />
          <circle cx="500" cy="800" r="7" fill="white" fillOpacity="0.16" />
          {/* 위쪽 페널티 박스·골 에어리어·아크 */}
          <rect x="230" y="60" width="540" height="260" />
          <rect x="370" y="60" width="260" height="90" />
          <path d="M 390 320 A 150 150 0 0 0 610 320" />
          <circle cx="500" cy="235" r="6" fill="white" fillOpacity="0.16" />
          {/* 아래쪽 */}
          <rect x="230" y="1280" width="540" height="260" />
          <rect x="370" y="1450" width="260" height="90" />
          <path d="M 390 1280 A 150 150 0 0 1 610 1280" />
          <circle cx="500" cy="1365" r="6" fill="white" fillOpacity="0.16" />
          {/* 코너 아크 */}
          <path d="M 60 90 A 30 30 0 0 0 90 60 M 910 60 A 30 30 0 0 0 940 90 M 60 1510 A 30 30 0 0 1 90 1540 M 940 1510 A 30 30 0 0 0 910 1540" />
        </g>
      </svg>
      {/* 경기장 조명: 위에서 비추는 밝은 빛 + 형광 연두·하늘색 번짐 */}
      <div className="absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[#e9ffd0]/20 blur-[110px]" />
      <div className="absolute top-1/3 -left-32 h-80 w-80 rounded-full bg-[#b8ff3b]/20 blur-[100px]" />
      <div className="absolute bottom-10 -right-24 h-80 w-80 rounded-full bg-[#2bd4ff]/20 blur-[110px]" />
      {/* 가장자리·아래를 어둡게 (글자 대비) */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,transparent_0%,rgba(2,14,6,0.35)_55%,rgba(2,10,5,0.85)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent to-[#020c05]/80" />
    </div>
  );
}
