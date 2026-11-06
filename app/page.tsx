import Link from 'next/link';
import { Anton } from 'next/font/google';
import { Activity, ChevronRight, Target, Timer, Trophy, Zap } from 'lucide-react';

/**
 * 사용자 화면: 홈 · 구속 측정(/analyze) · 프리킥 측정(/analyze/freekick, 베타) · 리더보드.
 * 관리자 화면(/admin)은 여기서 링크하지 않는다 — 주소로 직접 들어간다.
 *
 * 화면 자체가 위에서 본 경기장 한 면: 위 골대·페널티 박스에 제목, 하프라인의 센터서클에 주 버튼,
 * 아래 페널티 박스에 촬영 요령. 선은 모두 실제 요소의 테두리라 그림 파일이 필요 없다.
 */

const display = Anton({ weight: '400', subsets: ['latin'], display: 'swap' });

const INK = '#0E3A1C'; // 진한 잔디색 — 글자·그림자 공통
const CHALK = 'rgba(255,255,255,0.92)'; // 분필선

const TIPS = [
  { icon: Target, title: '옆에서', text: '공이 날아가는 방향과 직각으로' },
  { icon: Zap, title: '60fps 이상', text: '30fps 는 궤적이 남지 않아요' },
  { icon: Activity, title: '폰 고정', text: '공이 동전만 하게 보이는 거리' },
  { icon: Timer, title: '킥 앞뒤 3초', text: '짧을수록 정확해요' },
];

const line = { borderColor: CHALK };

export default function Home() {
  return (
    <div
      className="min-h-screen px-3 py-6 sm:py-10"
      style={{
        color: INK,
        background: 'repeating-linear-gradient(180deg, #5CBB66 0 68px, #53B05D 68px 136px)',
      }}
    >
      {/* 터치라인 */}
      <div className="relative mx-auto mt-3 w-full max-w-[560px] rounded-[4px] border-2 px-3 pb-3" style={line}>
        <Corners />
        {/* 위 골대 */}
        <div className="absolute -top-[12px] left-1/2 h-[12px] w-[26%] -translate-x-1/2 border-2 border-b-0" style={line} />

        {/* 위 페널티 박스: 제목 */}
        <section className="relative mx-auto w-[86%] border-2 border-t-0 px-3 pb-7 text-center" style={line}>
          <div className="mx-auto w-[56%] border-2 border-t-0 py-2" style={line}>
            <span className="text-[13px] font-semibold tracking-tight">중력으로 측정하는 프리킥</span>
          </div>
          <h1
            className={`${display.className} mt-5 text-[3.1rem] leading-[0.95] tracking-wide text-white sm:text-7xl`}
            style={{ textShadow: `3px 4px 0 ${INK}` }}
          >
            HOW FAST
            <br />
            YOUR
            <br />
            FREEKICK
          </h1>
          {/* 페널티 아크 */}
          <div className="absolute left-1/2 top-full h-[64px] w-[128px] -translate-x-1/2 rounded-b-full border-2 border-t-0" style={line} />
        </section>

        <p className="mx-auto mt-[92px] max-w-[30ch] break-keep text-center text-[15px] leading-relaxed sm:text-base">
          프리킥을 옆에서 찍으면 공 속도를 측정합니다. 장비는 필요 없습니다. 검산을 통과한 값만 보여주고, 측정 안 된 경우엔 이유를
          알려드립니다.
        </p>

        {/* 하프라인 + 센터서클: 주 버튼 */}
        <div className="relative my-8 flex h-[250px] items-center justify-center">
          <div className="absolute inset-x-[-14px] top-1/2 h-[2px] -translate-y-1/2" style={{ background: CHALK }} />
          <div className="absolute left-1/2 top-1/2 h-[236px] w-[236px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={line} />
          <Link
            href="/analyze"
            className="relative flex h-[176px] w-[176px] flex-col items-center justify-center rounded-full border-2 bg-white text-center transition-transform active:translate-y-[3px] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-white"
            style={{ borderColor: INK, boxShadow: `0 6px 0 ${INK}` }}
          >
            <span className="text-[22px] font-extrabold leading-tight">구속 측정</span>
            <span className="mt-1 text-xs opacity-70">옆에서 찍은 슛 영상</span>
            <span className="mt-3 flex h-8 w-8 items-center justify-center rounded-full text-white" style={{ background: INK }}>
              <ChevronRight size={18} />
            </span>
          </Link>
        </div>

        {/* 아래 하프: 보조 버튼 둘 */}
        <div className="grid grid-cols-2 gap-3 px-1">
          <KitButton href="/analyze/freekick" bg="#FFE15A" title="프리킥 측정" sub="공 뒤 대각선에서" tag="베타" />
          <KitButton href="/leaderboard" bg="#A9E4FF" title="리더보드" sub="구속 순위" icon={<Trophy size={16} />} />
        </div>

        {/* 아래 페널티 박스: 촬영 요령 */}
        <section className="relative mx-auto mt-[100px] w-[94%] border-2 border-b-0 px-3 pt-5" style={line}>
          <div className="absolute bottom-full left-1/2 h-[64px] w-[128px] -translate-x-1/2 rounded-t-full border-2 border-b-0" style={line} />
          <ul className="grid grid-cols-2 gap-x-3 gap-y-4">
            {TIPS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white" style={{ color: INK }}>
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold">{title}</span>
                  <span className="block break-keep text-xs leading-snug opacity-75">{text}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mx-auto mt-5 w-[56%] border-2 border-b-0 py-2 text-center" style={line}>
            <span className="text-[13px] font-semibold">촬영 요령</span>
          </div>
        </section>
        {/* 아래 골대 */}
        <div className="absolute -bottom-[12px] left-1/2 h-[12px] w-[26%] -translate-x-1/2 border-2 border-t-0" style={line} />
      </div>
    </div>
  );
}

/** 보조 버튼: 주 버튼과 같은 테두리·글자색·그림자, 색만 다르게 */
function KitButton({ href, bg, title, sub, tag, icon }: { href: string; bg: string; title: string; sub: string; tag?: string; icon?: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-start gap-0.5 rounded-2xl border-2 px-4 py-3 text-left transition-transform active:translate-y-[3px] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white"
      style={{ background: bg, borderColor: INK, boxShadow: `0 5px 0 ${INK}` }}
    >
      <span className="flex items-center gap-1.5 text-[15px] font-extrabold">
        {icon}
        {title}
        {tag && (
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ background: INK }}>
            {tag}
          </span>
        )}
      </span>
      <span className="text-xs opacity-75">{sub}</span>
    </Link>
  );
}

/** 코너 아크 네 개 */
function Corners() {
  const c = 'absolute h-4 w-4 border-2';
  return (
    <>
      <span className={`${c} -left-[2px] -top-[2px] rounded-br-full border-l-0 border-t-0`} style={line} />
      <span className={`${c} -right-[2px] -top-[2px] rounded-bl-full border-r-0 border-t-0`} style={line} />
      <span className={`${c} -bottom-[2px] -left-[2px] rounded-tr-full border-b-0 border-l-0`} style={line} />
      <span className={`${c} -bottom-[2px] -right-[2px] rounded-tl-full border-b-0 border-r-0`} style={line} />
    </>
  );
}
