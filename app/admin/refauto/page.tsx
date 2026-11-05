"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Cpu, Loader2, Pencil, RefreshCw, Upload, X } from "lucide-react";

/**
 * 프리킥 레퍼런스 자동 작업 결과 (scripts/refauto 가 Mac 에서 올린 것).
 * Mac 이 꺼져 있어도 결과를 보고 확정·제외·수정 요청을 남길 수 있다.
 * 수정 요청은 Mac 이 다음에 켜질 때 가져가 다시 계산한다.
 */

const ADMIN_TOKEN_STORAGE_KEY = "freekickAdminReferenceToken";
const PAGE = 12;

type Kick = {
  id: string;
  videoId: string;
  kick: number;
  status: string;
  source: string;
  reasons: string[] | null;
  notes: string[] | null;
  speedKmh: number | null;
  elevDeg: number | null;
  distM: number | null;
  rmsPx: number | null;
  trackPoints: number | null;
  data: Record<string, unknown> | null;
  overlayImageId: string | null;
  frameImageId: string | null;
  candidateFrames: { n: number; imageId: string }[] | null;
  referenceId: string | null;
};
type Video = {
  id: string;
  file: string;
  status: string;
  reason: string | null;
  meta: Record<string, unknown> | null;
  info: { width?: number; height?: number; rotate?: number } | null;
  kicks: Kick[];
};
type Edit = { id: string; videoId: string; kick: number; action: string; status: string; result: string | null; createdAt: string };
type ManualRef = { file: string; kick: number; status: string; speed_kmh: number; speed_range?: number[]; dist_m?: number; result?: string; method?: string };
type Payload = {
  videos: Video[];
  edits: Edit[];
  state: { worker?: { at?: string; host?: string; folder?: string; summary?: string }; manual_refs?: ManualRef[] };
};

const STATUS_KO: Record<string, string> = {
  A: "확정",
  B: "추정",
  review: "확인 필요",
  manual: "수동 확정",
  rejected: "제외",
  not_measurable: "측정 불가",
  not_freekick: "프리킥 아님",
  error: "오류",
};
const STATUS_COLOR: Record<string, string> = {
  A: "text-[var(--color-neon-green)] border-[var(--color-neon-green)]/40",
  manual: "text-[var(--color-neon-green)] border-[var(--color-neon-green)]/40",
  B: "text-yellow-200 border-yellow-200/40",
  review: "text-orange-300 border-orange-300/40",
  rejected: "text-gray-400 border-gray-500/40",
  not_measurable: "text-red-300 border-red-300/40",
  not_freekick: "text-gray-400 border-gray-500/40",
  error: "text-red-300 border-red-300/40",
};
const TABS = ["review", "B", "A", "manual", "not_measurable", "not_freekick", "rejected", "manual_refs", "all"] as const;
type Tab = (typeof TABS)[number];

type Item = { video: Video; kick: Kick | null; status: string };

function ago(iso?: string) {
  if (!iso) return "없음";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

export default function RefautoAdminPage() {
  const [token, setToken] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [data, setData] = useState<Payload | null>(null);
  const [tabSel, setTab] = useState<Tab | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());

  const headers = useCallback(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token.trim()) h["x-admin-token"] = token.trim();
    return h;
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/refauto", { headers: headers(), cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "불러오지 못했습니다.");
      setData(j);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const imageUrl = useCallback((id: string | null | undefined) => (id ? (images[id] ?? null) : null), [images]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const v of data?.videos ?? []) {
      if (!v.kicks.length) out.push({ video: v, kick: null, status: v.status });
      for (const k of v.kicks) out.push({ video: v, kick: k, status: k.status });
    }
    return out;
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, manual_refs: data?.state.manual_refs?.length ?? 0 };
    for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items, data]);

  // 탭을 고르기 전에는: '확인 필요'가 비어 있으면 손볼 것이 많은 '측정 불가'(없으면 전체)를 보여 준다
  const tab: Tab = tabSel ?? (counts.review || !data ? "review" : counts.not_measurable ? "not_measurable" : "all");

  const pending = useMemo(() => {
    const m = new Map<string, Edit>();
    for (const e of data?.edits ?? []) if (e.status === "pending") m.set(`${e.videoId}#${e.kick}`, e);
    return m;
  }, [data]);

  const post = useCallback(
    async (url: string, body: unknown, ok: string) => {
      setLoading(true);
      setMessage(null);
      try {
        const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error ?? "저장하지 못했습니다.");
        setMessage(ok);
        await load();
        return true;
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "저장하지 못했습니다.");
        setLoading(false);
        return false;
      }
    },
    [headers, load]
  );

  const filtered = useMemo(() => (tab === "all" ? items : items.filter((i) => i.status === tab)), [items, tab]);
  // 휴대폰 데이터·DB 읽기를 아끼려고 카드(이미지)는 12개씩만 띄운다
  const [limit, setLimit] = useState(PAGE);
  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);
  const worker = data?.state.worker;

  // 이미지는 토큰 헤더가 필요해서 fetch → blob URL 로 띄운다 (보이는 것만)
  const neededImages = useMemo(() => {
    const ids = shown.map((i) => i.kick?.overlayImageId ?? i.kick?.frameImageId).filter(Boolean) as string[];
    const k = editing?.kick;
    if (k) ids.push(...[k.frameImageId, ...(k.candidateFrames ?? []).map((c) => c.imageId)].filter(Boolean) as string[]);
    return ids;
  }, [shown, editing]);

  useEffect(() => {
    for (const id of neededImages) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      fetch(`/api/admin/refauto/image/${id}`, { headers: headers() })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((b) => setImages((m) => ({ ...m, [id]: URL.createObjectURL(b) })))
        .catch(() => requested.current.delete(id));
    }
  }, [neededImages, headers]);

  return (
    <div className="min-h-screen p-4 sm:p-8">
      <header className="max-w-6xl mx-auto flex items-center justify-between mb-6">
        <Link href="/admin" className="text-gray-400 hover:text-white flex items-center gap-2">
          <ArrowLeft size={20} />
          <span>관리자</span>
        </Link>
        <span className="font-mono text-sm tracking-widest text-[var(--color-neon-green)]">REFAUTO</span>
      </header>

      <main className="max-w-6xl mx-auto flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-bold mb-1">프리킥 레퍼런스 자동 작업</h1>
          <p className="text-gray-400 text-sm">
            Mac 이 영상 폴더를 분석해 올린 결과입니다. 확정·제외는 바로 반영되고, 수정(클릭·영상 정보)은 Mac 이 다음에 켜질 때 다시
            계산합니다. 키커를 한 번 찍어 두면 같은 삼각대로 찍은 영상은 자동으로 확정됩니다.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              try {
                localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, e.target.value);
              } catch {}
            }}
            placeholder="관리자 토큰"
            className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-base sm:text-sm flex-1 min-w-0 sm:flex-none sm:w-56"
          />
          <button onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/5">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} 새로고침
          </button>
          <span className="flex items-center gap-2 text-sm text-gray-400">
            <Cpu size={16} />
            Mac 마지막 동기화 {ago(worker?.at)}
            {worker?.host ? ` · ${worker.host}` : ""}
            {pending.size ? ` · 반영 대기 ${pending.size}건` : ""}
          </span>
        </div>
        {message && <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">{message}</div>}

        <div className="-mx-4 px-4 flex gap-2 overflow-x-auto whitespace-nowrap pb-1 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
          {TABS.filter((t) => counts[t] || t === "review" || t === "all").map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setLimit(PAGE);
              }}
              className={`shrink-0 rounded-full px-3 py-2 sm:py-1.5 text-sm border ${
                tab === t ? "bg-[var(--color-neon-green)] text-black border-transparent" : "border-white/15 text-gray-300 hover:bg-white/5"
              }`}
            >
              {t === "all" ? "전체" : t === "manual_refs" ? "수동 분석" : STATUS_KO[t]} {counts[t] ?? 0}
            </button>
          ))}
        </div>

        {tab === "manual_refs" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-400 text-left">
                <tr>
                  <th className="py-2 pr-4">영상</th>
                  <th className="py-2 pr-4">판정</th>
                  <th className="py-2 pr-4 text-right">초속</th>
                  <th className="py-2 pr-4 text-right">거리</th>
                  <th className="py-2">결과·방법</th>
                </tr>
              </thead>
              <tbody>
                {(data?.state.manual_refs ?? []).map((m) => (
                  <tr key={`${m.file}#${m.kick}`} className="border-t border-white/10">
                    <td className="py-2 pr-4">{m.file}</td>
                    <td className="py-2 pr-4">{m.status === "manual" ? "확정" : "추정"}</td>
                    <td className="py-2 pr-4 text-right font-mono">
                      {m.speed_kmh.toFixed(1)}
                      {m.speed_range ? ` (${m.speed_range[0]}~${m.speed_range[1]})` : ""}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono">{m.dist_m ?? ""}</td>
                    <td className="py-2 text-gray-400">
                      {m.result} · {m.method}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((it) => {
              const k = it.kick;
              const img = imageUrl(k?.overlayImageId ?? k?.frameImageId);
              const wait = k ? pending.get(`${it.video.id}#${k.kick}`) : undefined;
              const reasons = k ? (k.reasons ?? []) : [it.video.reason ?? ""];
              return (
                <div key={`${it.video.id}#${k?.kick ?? 0}`} className="glass-card overflow-hidden flex flex-col">
                  {k && (
                    <div className="aspect-video bg-black flex items-center justify-center">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img} alt={`${it.video.file} 킥${k.kick}`} className="w-full h-full object-contain" />
                      ) : (
                        <Loader2 className="animate-spin text-gray-600" />
                      )}
                    </div>
                  )}
                  <div className="p-4 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold break-all">
                        {it.video.file}
                        {k ? ` · 킥${k.kick}` : ""}
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_COLOR[it.status] ?? ""}`}>
                        {STATUS_KO[it.status] ?? it.status}
                      </span>
                    </div>
                    {k?.speedKmh != null && (
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <span className="font-mono text-2xl font-bold">{k.speedKmh.toFixed(1)} km/h</span>
                        <span className="text-xs text-gray-400">
                          발사각 {k.elevDeg?.toFixed(0)}° · 거리 {k.distM?.toFixed(1)} m · 오차 {k.rmsPx?.toFixed(1)}px
                        </span>
                      </div>
                    )}
                    {(k?.notes ?? []).length > 0 && <div className="text-xs text-gray-400">{k!.notes!.join(" · ")}</div>}
                    {reasons.filter(Boolean).length > 0 && (
                      <ul className="list-disc pl-4 text-xs text-gray-400 space-y-0.5">
                        {reasons.filter(Boolean).map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                    {wait && (
                      <div className="text-xs text-yellow-200">
                        Mac 반영 대기 ({wait.action === "recompute" ? "다시 계산" : wait.action === "accept" ? "확정 기록" : "제외 기록"})
                      </div>
                    )}
                    {k?.referenceId && <div className="text-xs text-[var(--color-neon-green)]">레퍼런스 정답표에 등록됨</div>}
                    {k && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {k.speedKmh != null && k.status !== "manual" && (
                          <button
                            onClick={() => void post("/api/admin/refauto/edits", { videoId: it.video.id, kick: k.kick, action: "accept" }, "확정했습니다.")}
                            className="flex items-center gap-1 rounded-lg bg-[var(--color-neon-green)] text-black px-3 py-1.5 text-sm font-semibold"
                          >
                            <Check size={14} /> 이 값으로 확정
                          </button>
                        )}
                        <button onClick={() => setEditing(it)} className="flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-sm">
                          <Pencil size={14} /> 수정
                        </button>
                        {k.status !== "rejected" && (
                          <button
                            onClick={() => void post("/api/admin/refauto/edits", { videoId: it.video.id, kick: k.kick, action: "reject" }, "제외했습니다.")}
                            className="flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-sm"
                          >
                            <X size={14} /> 제외
                          </button>
                        )}
                        {["A", "manual"].includes(k.status) && !k.referenceId && (
                          <button
                            onClick={() => void post("/api/admin/refauto/register", { kickId: k.id }, "레퍼런스 정답표에 등록했습니다.")}
                            className="flex items-center gap-1 rounded-lg border border-[var(--color-neon-green)]/40 text-[var(--color-neon-green)] px-3 py-1.5 text-sm"
                          >
                            <Upload size={14} /> 정답표 등록
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {!shown.length && <p className="text-gray-400 text-sm">해당하는 항목이 없습니다.</p>}
            {filtered.length > shown.length && (
              <button
                onClick={() => setLimit((n) => n + PAGE)}
                className="sm:col-span-2 lg:col-span-3 rounded-xl border border-white/15 py-3 text-sm text-gray-300"
              >
                더 보기 ({shown.length}/{filtered.length})
              </button>
            )}
          </div>
        )}
      </main>

      {editing?.kick && (
        <Editor
          item={editing}
          imageUrl={imageUrl}
          onClose={() => setEditing(null)}
          onSave={async (meta, clicks) => {
            const ok = await post(
              "/api/admin/refauto/edits",
              { videoId: editing.video.id, kick: editing.kick!.kick, action: "recompute", meta, clicks },
              "수정 요청을 남겼습니다. Mac 이 켜지면 다시 계산합니다."
            );
            if (ok) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

type Tool = "kicker" | "goal" | "ball";
const NEED: Record<Tool, number> = { kicker: 2, goal: 4, ball: 2 };
const HINT: Record<Tool, string[]> = {
  kicker: ["키커 발바닥(땅)", "키커 머리 꼭대기"],
  goal: ["왼쪽 기둥 아래", "오른쪽 기둥 아래", "오른쪽 위 모서리", "왼쪽 위 모서리"],
  ball: ["멈춘 공의 중심", "공의 가장자리"],
};
const COLOR: Record<Tool, string> = { kicker: "#ffd400", goal: "#ff3df0", ball: "#35e0ff" };
const TOOL_KO: Record<Tool, string> = { kicker: "키커", goal: "골대", ball: "멈춘 공" };

function Editor({
  item,
  imageUrl,
  onClose,
  onSave,
}: {
  item: Item;
  imageUrl: (id: string | null | undefined) => string | null;
  onClose: () => void;
  onSave: (meta: Record<string, unknown>, clicks: Record<string, unknown>) => Promise<void>;
}) {
  const k = item.kick!;
  const meta0 = item.video.meta ?? {};
  // 기준 장면 좌표 폭: 워커가 올린 coord_w, 없으면 Reader 규칙(가로 1920 이하로 축소)으로 영상 크기에서 계산
  const info = item.video.info ?? {};
  const rawW = [90, 270].includes(Number(info.rotate)) ? info.height : info.width;
  const coordW = Number((k.data ?? {}).coord_w) || (rawW ? Math.min(rawW, 1920) : 1920);
  const frames = [{ n: -1, imageId: k.frameImageId ?? "" }, ...(k.candidateFrames ?? [])].filter((f) => f.imageId);
  const [frame, setFrame] = useState(frames[0]?.imageId ?? "");
  const [tool, setTool] = useState<Tool>("goal");
  const [pts, setPts] = useState<Partial<Record<Tool, [number, number][]>>>({});
  const [drag, setDrag] = useState<{ tool: Tool; idx: number } | null>(null);
  const [form, setForm] = useState({
    kicker_cm: String(meta0.kicker_cm ?? ""),
    dummy_cm: String(meta0.dummy_cm ?? "160"),
    ball: String(meta0.ball ?? "5"),
    goal: String(meta0.goal ?? "adult"),
    pitch: String(meta0.pitch ?? "adult"),
  });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const url = imageUrl(frame);
  const moving = Number((k.data ?? {}).camera_motion_px) > 4;

  // 모달이 열려 있는 동안 뒤 화면이 같이 스크롤되지 않게
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setAspect(img.width / Math.max(1, img.height));
      setImgReady((n) => n + 1);
    };
    img.src = url;
  }, [url]);

  // 사진 + 찍은 점 + 돋보기
  useEffect(() => {
    const img = imgRef.current;
    const c = canvas.current;
    if (!img || !c) return;
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    const s = img.width / coordW;
    const u = img.width / 640;
    x.lineWidth = 2 * u;
    for (const [t, list] of Object.entries(pts) as [Tool, [number, number][]][]) {
      x.strokeStyle = x.fillStyle = COLOR[t];
      if (list.length > 1) {
        x.beginPath();
        list.forEach(([px, py], i) => (i ? x.lineTo(px * s, py * s) : x.moveTo(px * s, py * s)));
        if (t === "goal" && list.length === 4) x.closePath();
        x.stroke();
      }
      list.forEach(([px, py], i) => {
        x.fillStyle = COLOR[t];
        x.beginPath();
        x.arc(px * s, py * s, 3.5 * u, 0, 7);
        x.fill();
        x.fillStyle = "#000";
        x.font = `bold ${9 * u}px sans-serif`;
        x.fillText(String(i + 1), px * s + 4 * u, py * s - 4 * u);
      });
    }
    const L = loupe.current;
    const lc = L?.getContext("2d");
    if (L && lc) {
      lc.clearRect(0, 0, L.width, L.height);
      const p = drag ? pts[drag.tool]?.[drag.idx] : undefined;
      if (p) {
        const zoom = 4;
        const half = L.width / zoom / 2;
        lc.imageSmoothingEnabled = false;
        lc.drawImage(c, p[0] * s - half, p[1] * s - half, half * 2, half * 2, 0, 0, L.width, L.height);
        lc.strokeStyle = "#39FF14";
        lc.lineWidth = 1;
        lc.beginPath();
        lc.moveTo(L.width / 2, 0);
        lc.lineTo(L.width / 2, L.height);
        lc.moveTo(0, L.height / 2);
        lc.lineTo(L.width, L.height / 2);
        lc.stroke();
      }
    }
  }, [imgReady, pts, coordW, drag]);

  // 화면 좌표 → 기준 장면 좌표
  const toCoord = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * coordW, ((e.clientY - r.top) / r.width) * coordW];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toCoord(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const perPx = coordW / e.currentTarget.getBoundingClientRect().width;
    // 이미 찍은 점 근처를 누르면 그 점을 옮긴다 (손가락 크기 ≈ 22px)
    let hit: { tool: Tool; idx: number } | null = null;
    let best = 22 * perPx;
    for (const [t, list] of Object.entries(pts) as [Tool, [number, number][]][]) {
      list.forEach((q, i) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < best) {
          best = d;
          hit = { tool: t, idx: i };
        }
      });
    }
    if (!hit) {
      const cur = pts[tool] ?? [];
      if (cur.length >= NEED[tool]) return;
      hit = { tool, idx: cur.length };
      setPts((old) => ({ ...old, [tool]: [...(old[tool] ?? []), p] }));
    }
    setDrag(hit);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const p = toCoord(e);
    setPts((old) => ({ ...old, [drag.tool]: (old[drag.tool] ?? []).map((q, i) => (i === drag.idx ? p : q)) }));
  };
  const onUp = () => setDrag(null);

  const n = pts[tool]?.length ?? 0;
  const hint = n < NEED[tool] ? `${n + 1}/${NEED[tool]} · ${HINT[tool][n]} 을 누르세요` : "다 찍었습니다. 점을 끌어 고치거나 저장하세요.";

  const save = async () => {
    setErr(null);
    const clicks: Record<string, unknown> = {};
    if (pts.kicker?.length === 2) clicks.kicker = pts.kicker;
    if (pts.goal?.length === 4) clicks.goal = pts.goal;
    if (pts.ball?.length === 2) {
      const [a, b] = pts.ball;
      clicks.ball = [a[0], a[1], 2 * Math.hypot(b[0] - a[0], b[1] - a[1])];
    }
    for (const t of ["kicker", "goal", "ball"] as Tool[]) {
      const m = pts[t]?.length ?? 0;
      if (m > 0 && m < NEED[t]) {
        setErr(`${TOOL_KO[t]} 점을 ${NEED[t]}개 모두 찍거나 지우세요.`);
        return;
      }
    }
    if (clicks.kicker && !form.kicker_cm) {
      setErr("키커 키(cm)를 입력하세요.");
      return;
    }
    const meta = {
      kicker_cm: form.kicker_cm ? Number(form.kicker_cm) : undefined,
      dummy_cm: form.dummy_cm ? Number(form.dummy_cm) : undefined,
      ball: Number(form.ball),
      goal: form.goal,
      pitch: form.pitch,
    };
    setSaving(true);
    await onSave(meta, clicks);
    setSaving(false);
  };

  const field = "w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2.5 text-base sm:text-sm text-white";

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-stretch sm:items-center justify-center sm:p-6" role="dialog" aria-modal="true">
      <div className="bg-[#0d1117] sm:border border-white/10 sm:rounded-2xl w-full max-w-6xl h-full sm:h-auto sm:max-h-[95vh] overflow-y-auto overscroll-contain lg:grid lg:grid-cols-[1fr_320px]">
        {/* 사진: 휴대폰에서는 위에 붙어 있어 아래 입력을 하면서도 보인다 */}
        <div className="sticky top-0 z-10 bg-black lg:static">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm lg:hidden">
            <span className="font-semibold truncate">
              {item.video.file} · 킥{k.kick}
            </span>
            <button onClick={onClose} aria-label="닫기" className="shrink-0 rounded-lg border border-white/15 p-2">
              <X size={16} />
            </button>
          </div>
          {/* 세로·정사각 영상도 화면 절반을 넘지 않게: 가로폭을 높이 한도에 맞춰 줄인다 (비율 유지 → 클릭 좌표가 정확) */}
          <div className="relative mx-auto" style={{ width: `min(100%, calc(48vh * ${aspect.toFixed(4)}))` }}>
            {url ? (
              <canvas
                ref={canvas}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                className="block w-full h-auto touch-none cursor-crosshair"
              />
            ) : (
              <div className="aspect-video flex items-center justify-center">
                <Loader2 className="animate-spin text-gray-600" />
              </div>
            )}
            <canvas
              ref={loupe}
              width={160}
              height={160}
              className={`pointer-events-none absolute top-2 left-2 w-28 h-28 rounded-lg border border-white/40 bg-black ${drag ? "" : "hidden"}`}
            />
          </div>
          <div className="px-3 py-2 text-xs sm:text-sm text-gray-200 bg-white/5">{hint}</div>
          {frames.length > 1 && !moving && (
            <div className="flex gap-2 overflow-x-auto px-3 py-2">
              {frames.map((f) => (
                <button
                  key={f.imageId}
                  onClick={() => setFrame(f.imageId)}
                  className={`shrink-0 rounded border px-3 py-1.5 text-xs ${f.imageId === frame ? "border-[var(--color-neon-green)] text-[var(--color-neon-green)]" : "border-white/15 text-gray-400"}`}
                >
                  {f.n < 0 ? "기준 장면" : `${f.n}번 프레임`}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 flex flex-col gap-3 text-sm">
          <div className="hidden lg:block font-semibold break-all">
            {item.video.file} · 킥{k.kick}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["goal", "ball", "kicker"] as Tool[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTool(t);
                  if (t !== "kicker") setFrame(frames[0]?.imageId ?? "");
                }}
                className={`rounded-lg border px-2 py-2.5 text-center ${tool === t ? "border-[var(--color-neon-green)] text-white" : "border-white/15 text-gray-300"}`}
              >
                <span className="block font-semibold" style={{ color: COLOR[t] }}>
                  {TOOL_KO[t]}
                </span>
                <span className="block text-[11px] text-gray-400">
                  {pts[t]?.length ?? 0}/{NEED[t]}점
                </span>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPts((o) => ({ ...o, [tool]: (o[tool] ?? []).slice(0, -1) }))}
              disabled={!n}
              className="flex-1 rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40"
            >
              마지막 점 지우기
            </button>
            <button onClick={() => setPts((o) => ({ ...o, [tool]: [] }))} disabled={!n} className="flex-1 rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">
              {TOOL_KO[tool]} 다시
            </button>
          </div>
          <p className="text-xs text-gray-400">
            {tool === "goal"
              ? "골대: 왼아래 → 오른아래 → 오른위 → 왼위 (파이프 중심). 가려진 모서리는 보이는 기둥을 따라 짐작해 찍으세요."
              : tool === "ball"
                ? "멈춘 공: 중심 → 가장자리. 대충 누른 뒤 끌면 돋보기로 맞출 수 있습니다."
                : "키커: 곧게 선 장면에서 발바닥 → 머리 꼭대기. 아래에 키를 입력하세요."}
            {!moving && frames.length > 1 && tool === "kicker" ? " 사진 아래에서 장면을 고를 수 있습니다." : ""}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["kicker_cm", "키커 키 (cm)"],
                ["dummy_cm", "더미 높이 (cm)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-1 text-gray-400">
                {label}
                <input type="number" inputMode="numeric" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={field} />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-gray-400">
              골대
              <select value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} className={field}>
                <option value="adult">성인 7.32×2.44</option>
                <option value="youth">유소년 5×2</option>
                <option value="futsal">풋살 3×2</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-gray-400">
              공
              <select value={form.ball} onChange={(e) => setForm({ ...form, ball: e.target.value })} className={field}>
                <option value="5">5호</option>
                <option value="4">4호</option>
                <option value="3">3호</option>
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-gray-400">
              경기장 선
              <select value={form.pitch} onChange={(e) => setForm({ ...form, pitch: e.target.value })} className={field}>
                <option value="adult">성인 규격 선 사용</option>
                <option value="none">사용 안 함</option>
              </select>
            </label>
          </div>
          {err && <div className="text-red-300">{err}</div>}
          <div className="sticky bottom-0 -mx-4 -mb-4 mt-1 flex gap-2 border-t border-white/10 bg-[#0d1117] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 rounded-lg bg-[var(--color-neon-green)] text-black px-4 py-3 font-semibold disabled:opacity-60"
            >
              {saving ? "저장 중…" : "저장 (Mac 에서 다시 계산)"}
            </button>
            <button onClick={onClose} className="rounded-lg border border-white/15 px-4 py-3">
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
