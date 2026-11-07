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
  ExternalLink,
  Film,
  Gauge,
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
  collector?: Collector | null;
  accuracy?: Accuracy;
};
type CollectItem = { id: string; title?: string; decision?: string; reason?: string; device?: string; priority?: number; file?: string | null; error?: string | null };
type Collector = {
  at?: string;
  host?: string;
  last?: { found?: number; new?: number; keep?: number; review?: number; reject?: number; downloaded?: number; moved?: number; waiting?: number; errors?: string[]; queries?: string[] };
  totals?: { seen?: number; keep?: number; review?: number; reject?: number; downloaded?: number };
  queue?: number;
  downloaded?: CollectItem[];
  review?: CollectItem[];
};
type ErrSummary = { n: number; bias: number | null; medianAbs: number | null; maxAbs: number | null; items: { file: string; kick: number; status: string; measured: number; truth: number; err: number }[] };
type Accuracy = { radar: { all: ErrSummary; sure: ErrSummary }; penalty: ErrSummary; otherTruth: number };

const TARGET_N = 20; // 구도별 이 정도 모이면 평균 치우침을 ±2% 안으로 안다 (레이더 1회 ±6% 기준)
function pct(x: number | null | undefined) {
  return x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
}

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

          <CollectorCard c={data?.collector ?? null} now={data?.generatedAt} />
        </section>

        {/* 측정 정확도 */}
        <section className="flex flex-col gap-3">
          <SectionTitle>측정 정확도 (정답과 비교)</SectionTitle>
          <AccuracyCard a={data?.accuracy} />
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
  ["옆 구도 영상 자동 수집·측정", "유튜브 수집은 대각선 뒤 분석(refauto)으로만 들어갑니다 — 옆에서 찍은 영상(구속 측정 방식)은 따로 연결 필요"],
  ["골대 없는 영상 보정", "작은 네트·리바운더·측정 부스에 차는 영상은 골대가 없어 지금은 측정 불가 — 네트·선·공 크기로 보정하는 방법 필요"],
  ["레이더 숫자 자동 판독", "정답 숫자는 사람이 영상을 보고 입력 (레이더 화면은 자동 판독이 잘 안 됨)"],
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

function CollectorCard({ c, now }: { c: Collector | null; now?: string }) {
  const age = c?.at && now ? (new Date(now).getTime() - new Date(c.at).getTime()) / 1000 : Infinity;
  const state = !c ? "unknown" : age < 7 * 3600 ? "on" : age < 26 * 3600 ? "idle" : "off";
  const t = c?.totals ?? {};
  const last = c?.last ?? {};
  return (
    <div className="glass-card p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <IconBox color="var(--color-neon-blue)">
            <Search size={18} />
          </IconBox>
          <div>
            <div className="font-semibold">유튜브 레퍼런스 수집</div>
            <p className="text-xs text-gray-400">6시간마다 검색 → AI 선별(레이더·페널티킥) → 받기 → USB 폴더 → 자동 분석</p>
          </div>
        </div>
        <StatusPill state={state} />
      </div>
      {!c ? (
        <p className="text-xs text-gray-400">
          아직 한 번도 실행되지 않았습니다. Mac 에서 <code className="font-mono text-gray-300">bash scripts/refauto/install_launchd.sh /Volumes/64B/freekick</code> 를 실행하면 시작됩니다.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            <Stat label="마지막 실행" value={now ? ago(c.at, now) : "–"} />
            <Stat label="살펴본 영상" value={`${t.seen ?? 0}`} />
            <Stat label="받음" value={`${t.downloaded ?? 0}`} />
            <Stat label="받을 차례" value={`${c.queue ?? 0}`} />
          </div>
          <p className="text-[11px] text-gray-500">
            지난 실행: 새 영상 {last.new ?? 0} · 받기 {last.keep ?? 0} · 애매 {last.review ?? 0} · 제외 {last.reject ?? 0} · 받음 {last.downloaded ?? 0}
            {last.waiting ? ` · USB 기다림 ${last.waiting}` : ""}
          </p>
          {(last.errors ?? []).length > 0 && (
            <p className="rounded-lg border border-yellow-300/30 bg-yellow-300/10 px-3 py-2 text-xs text-yellow-100">{last.errors!.join(" · ")}</p>
          )}
          {(c.downloaded ?? []).length > 0 && (
            <ul className="flex flex-col gap-1 text-xs">
              {c.downloaded!.slice(0, 5).map((v) => (
                <li key={v.id}>
                  <a href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="flex items-start gap-1.5 text-gray-300 hover:text-white">
                    <ExternalLink size={12} className="mt-0.5 shrink-0 text-gray-500" />
                    <span className="min-w-0 flex-1 truncate">{v.title ?? v.id}</span>
                    <span className="shrink-0 text-gray-500">{v.reason === "penalty" ? "페널티킥" : "레이더"}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/admin/refauto?tab=youtube"
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/15 py-2.5 text-sm font-semibold hover:bg-white/5"
          >
            받은 영상 분석 결과 · 정답 입력 <ArrowUpRight size={16} />
          </Link>
        </>
      )}
    </div>
  );
}

function AccuracyCard({ a }: { a?: Accuracy }) {
  const r = a?.radar.all;
  const sure = a?.radar.sure;
  const p = a?.penalty;
  return (
    <div className="glass-card p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <IconBox color="#ffc53d">
          <Gauge size={18} />
        </IconBox>
        <div>
          <div className="font-semibold">정답이 있는 킥으로 오차 확인</div>
          <p className="text-xs text-gray-400">
            레이더 숫자는 킥 하나당 ±6% 흔들려서, 하나보다 <b className="text-gray-300">여럿의 평균</b>을 봅니다. 구도별 {TARGET_N}개가 목표입니다.
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <ErrBox title="레이더 정답 (전체)" s={r} note="측정 ÷ 정답 − 1" />
        <ErrBox title="레이더 정답 (확정·수동 확정만)" s={sure} note="자동 판정이 믿을 만한 킥" />
        <ErrBox title="페널티킥 거리" s={p} note="계산한 킥 거리 ÷ 11 m − 1 · 거리 축척이 틀린 만큼 속도도 틀림" />
        <div className="rounded-xl bg-white/5 p-3 text-xs text-gray-400 flex flex-col justify-center gap-1">
          <span>스마트볼·앱 등 통계 제외 정답 {a?.otherTruth ?? 0}개</span>
          <Link href="/admin/refauto?tab=truth" className="text-sky-300 hover:underline">
            정답 있는 킥 모두 보기 →
          </Link>
        </div>
      </div>
      {r && r.items.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs font-mono text-gray-300">
          {r.items.slice(0, 5).map((i) => (
            <li key={`${i.file}#${i.kick}`} className="flex justify-between gap-2">
              <span className="truncate font-sans">
                {i.file} · 킥{i.kick}
              </span>
              <span className="shrink-0">
                {i.measured.toFixed(1)} / {i.truth.toFixed(1)} <span className={Math.abs(i.err) <= 0.07 ? "text-[var(--color-neon-green)]" : "text-orange-300"}>{pct(i.err)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrBox({ title, s, note }: { title: string; s?: ErrSummary; note: string }) {
  const n = s?.n ?? 0;
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-gray-400">{title}</span>
        <span className="font-mono text-[11px] text-gray-500">
          {n}/{TARGET_N}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-xl font-bold">{n ? pct(s!.bias) : "–"}</span>
        <span className="text-[11px] text-gray-400">평균 치우침</span>
      </div>
      <div className="text-[11px] text-gray-500">
        {n ? `오차 중앙값 ${pct(s!.medianAbs).replace("+", "±")} · 최대 ${pct(s!.maxAbs).replace("+", "±")}` : "아직 없음"} · {note}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full bg-[#ffc53d]" style={{ width: `${Math.min(100, (100 * n) / TARGET_N)}%` }} />
      </div>
    </div>
  );
}
