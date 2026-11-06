"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  CircleCheck,
  Cpu,
  Database,
  Film,
  KeyRound,
  ListOrdered,
  Loader2,
  RefreshCw,
  Search,
  Smartphone,
  Target,
  TriangleAlert,
  Trophy,
  Video,
} from "lucide-react";

/**
 * 관리자 대시보드: 지금 할 일 · 자동화 · 데이터베이스 현황 · 관리 화면 · 사용자 화면 · 아직 없는 기능.
 * 숫자는 /api/admin/overview 한 번으로 받는다 (토큰은 다른 관리자 화면과 같은 저장소 키).
 */

const TOKEN_KEY = "freekickAdminReferenceToken";
const DB_LIMIT_BYTES = 512 * 1024 * 1024; // Neon 무료 플랜 저장 한도(0.5GB) 기준 참고선

type Worker = { at?: string; host?: string; seconds?: number; cv?: string; cv_expected?: string | null };
type Overview = {
  generatedAt: string;
  db: { bytes: number; images: { count: number; bytes: number } };
  records: { total: number; week: number; users: number; last: string | null };
  references: { total: number; active: number; last: string | null };
  refauto: { videos: number; kicks: Record<string, number>; editsPending: number; manualRefs: number; worker: Worker | null };
};

const VERDICTS: { key: string; label: string; color: string; tab: string }[] = [
  { key: "A", label: "확정", color: "#39FF14", tab: "A" },
  { key: "manual", label: "수동 확정", color: "#8be36f", tab: "manual" },
  { key: "B", label: "추정", color: "#04d9ff", tab: "B" },
  { key: "review", label: "확인 필요", color: "#ffc53d", tab: "review" },
  { key: "not_measurable", label: "측정 불가", color: "#ff6b6b", tab: "not_measurable" },
  { key: "rejected", label: "제외", color: "#6b7280", tab: "rejected" },
];

async function fetchOverview(token: string): Promise<{ data?: Overview; error?: string }> {
  try {
    const res = await fetch("/api/admin/overview", { headers: token ? { "x-admin-token": token } : {}, cache: "no-store" });
    if (res.status === 401) return { error: "토큰이 맞지 않습니다." };
    const j = await res.json();
    if (!res.ok) return { error: j?.error ?? "현황을 불러오지 못했습니다." };
    return { data: j };
  } catch {
    return { error: "현황을 불러오지 못했습니다." };
  }
}

const TOKEN_EVENT = "admin-token-change";
function subscribeStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(TOKEN_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(TOKEN_EVENT, cb);
  };
}
function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function ago(iso: string | null | undefined, now: string) {
  if (!iso) return "기록 없음";
  const s = (new Date(now).getTime() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

function mb(bytes: number) {
  return bytes >= 1024 * 1024 * 100 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AdminDashboard({ configured, developmentOpen }: { configured: boolean; developmentOpen: boolean }) {
  // 토큰은 이 기기의 localStorage 에 있다 (서버 렌더 때는 null → 깜빡임 없이 클라이언트에서 채움)
  const stored = useSyncExternalStore(subscribeStorage, readToken, () => null);
  const token = stored ?? "";
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const needToken = stored !== null && configured && (!token || error === "토큰이 맞지 않습니다.");

  const apply = (r: { data?: Overview; error?: string }) => {
    if (r.data) setData(r.data);
    setError(r.error ?? null);
  };

  // 새로고침 버튼
  const load = useCallback(async () => {
    setLoading(true);
    apply(await fetchOverview(token));
    setLoading(false);
  }, [token]);

  // 처음 열 때·토큰을 바꿨을 때 (결과는 비동기 콜백에서 반영)
  useEffect(() => {
    if (stored === null || (configured && !token)) return;
    let alive = true;
    void fetchOverview(token).then((r) => alive && apply(r));
    return () => {
      alive = false;
    };
  }, [stored, token, configured]);

  const saveToken = () => {
    const t = draft.trim();
    if (!t) return;
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {}
    setDraft("");
    window.dispatchEvent(new Event(TOKEN_EVENT));
  };

  const ra = data?.refauto;
  const worker = ra?.worker ?? null;
  // 서버가 현황을 만든 시각 기준 (렌더 중에 Date.now() 를 부르지 않는다)
  const workerAge = worker?.at && data ? (new Date(data.generatedAt).getTime() - new Date(worker.at).getTime()) / 1000 : Infinity;
  const workerState = workerAge < 15 * 60 ? "on" : workerAge < 6 * 3600 ? "idle" : "off";
  const kicks = ra?.kicks ?? {};
  const totalKicks = Object.values(kicks).reduce((a, b) => a + b, 0);
  const todo = (kicks.review ?? 0) + (ra?.editsPending ?? 0);

  return (
    <div className="min-h-screen px-4 py-6 sm:p-8">
      <div className="mx-auto w-full max-w-3xl flex flex-col gap-8">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white">
            <ArrowLeft size={18} /> 앱으로
          </Link>
          <button
            onClick={() => void load()}
            disabled={loading || needToken}
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-40"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 새로고침
          </button>
        </header>

        <div>
          <p className="font-mono text-[11px] tracking-[0.25em] text-[var(--color-neon-green)]">ADMIN</p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold">관리자 대시보드</h1>
          <p className="mt-1 text-sm text-gray-400">자동화 · 데이터 현황 · 관리 화면을 한곳에서 봅니다. 사용자 화면에는 이 주소가 보이지 않습니다.</p>
        </div>

        {/* 토큰 */}
        {needToken ? (
          <section className="glass-card p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound size={16} className="text-[var(--color-neon-green)]" /> 관리자 토큰
            </div>
            <p className="text-xs text-gray-400">한 번 넣으면 이 기기에 저장되고, 다른 관리자 화면에서도 같이 씁니다.</p>
            <div className="flex gap-2">
              <input
                type="password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveToken()}
                placeholder="ADMIN_REFERENCE_TOKEN"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-base sm:text-sm"
              />
              <button onClick={saveToken} className="rounded-xl bg-[var(--color-neon-green)] px-4 font-semibold text-black">
                확인
              </button>
            </div>
            {error && <p className="text-xs text-red-300">{error}</p>}
          </section>
        ) : (
          error && <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>
        )}
        {!configured && (
          <p className="rounded-xl border border-yellow-300/30 bg-yellow-300/10 px-3 py-2 text-sm text-yellow-100">
            {developmentOpen ? "개발 모드 — 토큰 없이 열려 있습니다." : "ADMIN_REFERENCE_TOKEN 이 없어 관리자 API 가 막혀 있습니다."}
          </p>
        )}

        {/* 지금 할 일 */}
        {data && (
          <Link
            href={todo ? "/admin/refauto?tab=review" : "/admin/refauto"}
            className={`group flex items-center gap-4 rounded-2xl border p-4 transition-colors ${
              todo ? "border-[#ffc53d]/40 bg-[#ffc53d]/10 hover:bg-[#ffc53d]/15" : "border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/10"
            }`}
          >
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${todo ? "bg-[#ffc53d]/20 text-[#ffc53d]" : "bg-[var(--color-neon-green)]/20 text-[var(--color-neon-green)]"}`}>
              {todo ? <TriangleAlert size={20} /> : <CircleCheck size={20} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{todo ? `확인할 킥 ${kicks.review ?? 0}건` : "지금 확인할 것이 없습니다"}</div>
              <div className="text-xs text-gray-300">
                {todo
                  ? `확정·제외하거나 골대·공을 찍어 고칩니다${ra?.editsPending ? ` · Mac 반영 대기 ${ra.editsPending}건` : ""}`
                  : `측정 불가 ${kicks.not_measurable ?? 0}건은 손으로 고치면 살릴 수 있습니다`}
              </div>
            </div>
            <ChevronRight size={18} className="shrink-0 text-gray-400 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        )}

        {/* 자동화 */}
        <section className="flex flex-col gap-3">
          <SectionTitle>자동화</SectionTitle>

          <div className="glass-card p-4 sm:p-5 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <IconBox color="var(--color-neon-pink)">
                  <Video size={18} />
                </IconBox>
                <div>
                  <div className="font-semibold">레퍼런스 영상 자동 분석</div>
                  <p className="text-xs text-gray-400">USB 영상 폴더를 Mac 이 5분마다 분석 → 결과를 여기에 올림</p>
                </div>
              </div>
              <StatusPill state={data ? workerState : "unknown"} />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="마지막 동기화" value={data ? ago(worker?.at, data.generatedAt) : "–"} />
              <Stat label="영상" value={data ? `${ra?.videos ?? 0}개` : "–"} />
              <Stat label="킥" value={data ? `${totalKicks}개` : "–"} />
            </div>

            {totalKicks > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/5">
                  {VERDICTS.filter((v) => kicks[v.key]).map((v) => (
                    <div key={v.key} style={{ width: `${(100 * kicks[v.key]) / totalKicks}%`, background: v.color }} title={`${v.label} ${kicks[v.key]}`} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {VERDICTS.filter((v) => kicks[v.key]).map((v) => (
                    <Link
                      key={v.key}
                      href={`/admin/refauto?tab=${v.tab}`}
                      className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1.5 text-xs text-gray-200 hover:bg-white/5"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: v.color }} />
                      {v.label} <span className="font-mono text-gray-400">{kicks[v.key]}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {worker && (
              <p className="text-[11px] text-gray-500 flex flex-wrap items-center gap-x-2">
                <Cpu size={12} /> {worker.host ?? "Mac"} · 1회 {worker.seconds ?? "?"}초 · OpenCV {worker.cv ?? "?"}
                {worker.cv && worker.cv_expected && worker.cv !== worker.cv_expected && <span className="text-yellow-300">(검증 판 {worker.cv_expected} 아님)</span>}
              </p>
            )}

            <Link
              href="/admin/refauto"
              className="flex items-center justify-center gap-1.5 rounded-xl bg-white text-black py-2.5 text-sm font-semibold hover:bg-gray-200"
            >
              분석 결과 열기 <ArrowUpRight size={16} />
            </Link>
          </div>

          <div className="glass-card p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <IconBox color="var(--color-neon-blue)">
                  <Search size={18} />
                </IconBox>
                <div>
                  <div className="font-semibold">유튜브 영상 수집</div>
                  <p className="text-xs text-gray-400">검색 → AI 선별(Jev) → 다운로드 → 구속 측정</p>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-gray-300">Mac 명령으로만</span>
            </div>
            <ol className="grid gap-2 text-xs text-gray-300">
              <li className="flex gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span className="font-mono text-[var(--color-neon-blue)]">1</span>
                <span>
                  후보 찾기·선별 <code className="font-mono text-gray-400">npm run jev:filter -- --search &quot;프리킥 구속&quot;</code>
                </span>
              </li>
              <li className="flex gap-2 rounded-lg bg-white/5 px-3 py-2">
                <span className="font-mono text-[var(--color-neon-blue)]">2</span>
                <span>
                  받기·측정 <code className="font-mono text-gray-400">npm run jev:collect</code> → <code className="font-mono text-gray-400">~/shooting-videos</code>
                </span>
              </li>
            </ol>
            <p className="text-xs text-gray-500">자동 실행·이 화면 연결·DB 저장은 아직 없습니다 (아래 &apos;아직 없는 기능&apos;).</p>
          </div>
        </section>

        {/* 데이터베이스 */}
        <section className="flex flex-col gap-3">
          <SectionTitle>데이터베이스 현황</SectionTitle>
          <div className="glass-card p-4 sm:p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <IconBox color="var(--color-neon-green)">
                <Database size={18} />
              </IconBox>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">저장 용량</span>
                  <span className="font-mono text-sm">{data ? mb(data.db.bytes) : "–"}</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-[var(--color-neon-green)]"
                    style={{ width: `${data ? Math.min(100, (100 * data.db.bytes) / DB_LIMIT_BYTES) : 0}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-gray-500">Neon Postgres · 무료 플랜 한도 0.5GB 기준 · 그중 확인 이미지 {data ? mb(data.db.images.bytes) : "–"}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DbRow icon={<Trophy size={14} />} label="리더보드 기록" value={data?.records.total} sub={data ? `최근 7일 ${data.records.week} · 사용자 ${data.records.users}` : undefined} />
              <DbRow icon={<Target size={14} />} label="레퍼런스 정답표" value={data?.references.total} sub={data ? `보정에 사용 ${data.references.active}` : undefined} />
              <DbRow icon={<Film size={14} />} label="자동 분석 영상" value={data?.refauto.videos} sub={data ? `킥 ${totalKicks} · 수동 분석 ${data.refauto.manualRefs}` : undefined} />
              <DbRow icon={<Video size={14} />} label="확인 이미지" value={data?.db.images.count} sub={data ? mb(data.db.images.bytes) : undefined} />
            </div>
          </div>
        </section>

        {/* 관리 화면 */}
        <section className="flex flex-col gap-3">
          <SectionTitle>관리 화면</SectionTitle>
          <div className="glass-card divide-y divide-white/5 overflow-hidden">
            <NavRow href="/admin/refauto" icon={<Video size={18} />} color="var(--color-neon-pink)" title="자동 분석 결과" desc="확정·제외·수정 (골대·공·키커 클릭)" badge={kicks.review ? `확인 ${kicks.review}` : undefined} />
            <NavRow href="/admin/references" icon={<Target size={18} />} color="var(--color-neon-green)" title="레퍼런스 정답표" desc="속도를 아는 클립 업로드·비교" badge="PC 권장" muted />
            <NavRow href="/admin/records" icon={<ListOrdered size={18} />} color="var(--color-neon-blue)" title="기록 관리" desc="리더보드 기록 보기·삭제" />
          </div>
        </section>

        {/* 사용자 화면 */}
        <section className="flex flex-col gap-3">
          <SectionTitle>사용자 화면</SectionTitle>
          <div className="glass-card divide-y divide-white/5 overflow-hidden">
            <NavRow href="/" icon={<Smartphone size={18} />} color="#ffffff" title="홈" desc="/" />
            <NavRow href="/analyze" icon={<Target size={18} />} color="#ffffff" title="구속 측정" desc="/analyze · 옆에서 찍은 영상" />
            <NavRow href="/analyze/freekick" icon={<Video size={18} />} color="#ffffff" title="프리킥 측정" desc="/analyze/freekick · 대각선 뒤" badge="베타" muted />
            <NavRow href="/leaderboard" icon={<Trophy size={18} />} color="#ffffff" title="구속 순위" desc="/leaderboard" />
          </div>
        </section>

        {/* 아직 없는 기능 */}
        <section className="flex flex-col gap-3 pb-6">
          <SectionTitle>아직 없는 기능</SectionTitle>
          <ul className="glass-card divide-y divide-white/5 overflow-hidden text-sm">
            {MISSING.map(([title, desc]) => (
              <li key={title} className="flex gap-3 p-4">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-gray-500" />
                <div>
                  <div className="font-medium text-gray-200">{title}</div>
                  <div className="text-xs text-gray-500">{desc}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

const MISSING: [string, string][] = [
  ["유튜브 수집 자동 실행", "jev:filter·jev:collect 를 Mac 이 정해진 시간에 돌리고 결과를 이 화면에서 보기 — 지금은 손으로 명령 실행"],
  ["수집 영상 → 자동 분석 연결", "유튜브에서 받은 영상(~/shooting-videos, 옆 구도)은 USB 자동 분석(뒤 대각선)과 따로 놉니다"],
  ["레퍼런스로 앱 보정", "정답표는 아직 '보정에 사용 안 함' — 같은 영상의 앱 측정값과 짝지어 보정 계수를 내는 단계가 없음"],
  ["프리킥 측정 결과 저장", "/analyze/freekick 결과는 저장·리더보드에 올라가지 않음"],
  ["알림", "확인할 킥이 생기거나 Mac 이 오래 꺼져 있으면 휴대폰으로 알리기"],
  ["관리자 로그인", "지금은 기기마다 토큰을 한 번 입력하는 방식"],
];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 font-mono text-[11px] uppercase tracking-[0.2em] text-gray-500">{children}</h2>;
}

function IconBox({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5" style={{ color }}>
      {children}
    </div>
  );
}

function StatusPill({ state }: { state: "on" | "idle" | "off" | "unknown" }) {
  const m = {
    on: ["실행 중", "bg-[var(--color-neon-green)]", "text-[var(--color-neon-green)] border-[var(--color-neon-green)]/30"],
    idle: ["대기", "bg-[#ffc53d]", "text-[#ffc53d] border-[#ffc53d]/30"],
    off: ["꺼짐", "bg-gray-500", "text-gray-400 border-white/15"],
    unknown: ["–", "bg-gray-600", "text-gray-500 border-white/10"],
  }[state];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${m[2]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m[1]} ${state === "on" ? "animate-pulse" : ""}`} />
      {m[0]}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/5 px-2 py-2.5">
      <div className="text-sm font-semibold">{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

function DbRow({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value?: number; sub?: string }) {
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
        {icon} {label}
      </div>
      <div className="mt-1 font-mono text-xl font-bold">{value ?? "–"}</div>
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

function NavRow({
  href,
  icon,
  color,
  title,
  desc,
  badge,
  muted,
}: {
  href: string;
  icon: React.ReactNode;
  color: string;
  title: string;
  desc: string;
  badge?: string;
  muted?: boolean;
}) {
  return (
    <Link href={href} className="group flex items-center gap-3 p-4 hover:bg-white/5 transition-colors">
      <IconBox color={color}>{icon}</IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {badge && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                muted ? "border border-white/15 text-gray-400" : "bg-[#ffc53d]/15 text-[#ffc53d]"
              }`}
            >
              {badge}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-gray-500">{desc}</div>
      </div>
      <ChevronRight size={18} className="shrink-0 text-gray-500 group-hover:translate-x-0.5 group-hover:text-gray-300 transition" />
    </Link>
  );
}
