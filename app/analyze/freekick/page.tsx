"use client";

/**
 * 대각선 뒤에서 찍은 프리킥 측정 (베타).
 * 영상은 이 기기에서만 분석한다 — 서버로 보내는 것은 없다 (트래픽·서버 비용 0).
 * 사용자가 한 장면에서 골대 네 모서리와 공을 찍으면, 나머지(킥 순간·공 추적·3D 궤적)는 자동.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ImageIcon, Loader2, RotateCcw, Undo2 } from "lucide-react";
import { analyzeRearview, type RearviewResult } from "@/lib/rearview/analyze";
import { VideoFrameSource, processingSize } from "@/lib/rearview/browser";
import { GOALS, goalObject, type GoalKind } from "@/lib/rearview/camera";
import { fitRestBall, toGray } from "@/lib/rearview/track";

const BALLS = [
  { id: "5", label: "5호 (성인)", m: 0.22 },
  { id: "4", label: "4호 (초등 고학년)", m: 0.205 },
  { id: "3", label: "3호 (저학년)", m: 0.185 },
] as const;

const STEPS = [
  "골대 왼쪽 기둥 아래 (땅에 닿는 곳)",
  "골대 오른쪽 기둥 아래",
  "골대 오른쪽 위 모서리",
  "골대 왼쪽 위 모서리",
  "공 한가운데",
] as const;

type Phase = "pick" | "mark" | "running" | "result";
type Pt = [number, number];

const MAX_FILE = 300 * 1024 * 1024;

export default function FreekickPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLCanvasElement>(null);
  const frameCanvas = useRef<HTMLCanvasElement | null>(null);
  /** 측정 시작 때의 장면 (결과 그림용) — 분석 중 탐색으로 frameCanvas 가 바뀌므로 따로 둔다 */
  const tapCanvas = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<Phase>("pick");

  const [phase, setPhase] = useState<Phase>("pick");
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [tapTime, setTapTime] = useState(0);
  const [pts, setPts] = useState<Pt[]>([]);
  const [ballD, setBallD] = useState<number | null>(null);
  const [ballScale, setBallScale] = useState(1);
  const [goalKind, setGoalKind] = useState<GoalKind>("adult");
  const [ballId, setBallId] = useState<(typeof BALLS)[number]["id"]>("5");
  const [drag, setDrag] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [progress, setProgress] = useState<{ stage: string; p: number }>({ stage: "", p: 0 });
  const [result, setResult] = useState<RearviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > MAX_FILE) {
      setError("300MB 이하의 짧은 영상을 골라 주세요 (킥 앞뒤 몇 초면 충분합니다).");
      return;
    }
    setError(null);
    setResult(null);
    setPts([]);
    setBallD(null);
    setBallScale(1);
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
    setPhase("mark");
  }, []);

  // 현재 장면을 처리 해상도 캔버스로 (공 원 맞춤용)
  const grabFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const p = processingSize(v);
    const c = frameCanvas.current ?? document.createElement("canvas");
    frameCanvas.current = c;
    c.width = p.width;
    c.height = p.height;
    c.getContext("2d", { willReadFrequently: true })?.drawImage(v, 0, 0, p.width, p.height);
  }, []);

  const onLoaded = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(Number.isFinite(v.duration) ? v.duration : 0);
    const p = processingSize(v);
    setSize({ width: p.width, height: p.height });
    const t = Math.min(0.3, (v.duration || 1) / 4);
    v.currentTime = t;
    setTapTime(t);
  }, []);

  const onSeeked = useCallback(() => {
    grabFrame();
    // 장면을 바꿨으면 공 크기를 새 장면에서 다시 잰다 (분석 중 탐색은 무시)
    if (phaseRef.current === "mark") setBallD(null);
  }, [grabFrame]);

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = t;
    setTapTime(t);
  };

  // 공 원 맞춤 (공을 찍었을 때, 장면이 바뀌었을 때)
  const measureBall = useCallback(
    (ball: Pt, goal: Pt[]) => {
      const c = frameCanvas.current;
      if (!c) return;
      const gh = Math.abs((goal[0][1] + goal[1][1]) / 2 - (goal[2][1] + goal[3][1]) / 2) || c.height * 0.15;
      const R = Math.round(Math.max(40, 0.35 * gh));
      const x0 = Math.round(ball[0]) - R;
      const y0 = Math.round(ball[1]) - R;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const img = ctx.getImageData(x0, y0, 2 * R, 2 * R);
      const g = toGray(img.data, 2 * R, 2 * R);
      const fit = fitRestBall(g, R, R, Math.max(3, 0.03 * gh), 0.3 * gh);
      if (fit && fit.d > 0.08 * gh && fit.d < 0.7 * gh) {
        setPts((p) => [...p.slice(0, 4), [fit.u + x0, fit.v + y0]]);
        setBallD(fit.d);
      } else {
        setBallD(0.2 * gh); // 못 찾으면 대략값 — 사용자가 크기를 맞춘다
      }
      setBallScale(1);
    },
    [],
  );

  useEffect(() => {
    if (pts.length === 5 && ballD === null) measureBall(pts[4], pts.slice(0, 4));
  }, [pts, ballD, measureBall]);

  // 표시 좌표 ↔ 처리 좌표
  const toProc = (e: React.PointerEvent<HTMLCanvasElement>): Pt | null => {
    const c = overlayRef.current;
    if (!c || !size) return null;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * size.width, ((e.clientY - r.top) / r.height) * size.height];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toProc(e);
    const c = overlayRef.current;
    if (!p || !c || !size) return;
    c.setPointerCapture(e.pointerId);
    const perPx = size.width / c.getBoundingClientRect().width;
    // 이미 찍은 점 근처면 옮기기
    let idx = -1;
    let best = 22 * perPx;
    pts.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    if (idx < 0) {
      if (pts.length >= 5) return;
      idx = pts.length;
      setPts((old) => [...old, p]);
    }
    setDrag({ idx, x: p[0], y: p[1] });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const p = toProc(e);
    if (!p) return;
    setPts((old) => old.map((q, i) => (i === drag.idx ? p : q)));
    setDrag({ ...drag, x: p[0], y: p[1] });
  };
  const onUp = () => {
    if (drag && drag.idx === 4) setBallD(null); // 공을 옮겼으면 다시 잰다
    setDrag(null);
  };

  // 겹쳐 그리기 + 돋보기
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !size || phase !== "mark") return;
    c.width = size.width;
    c.height = size.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const u = size.width / 640;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2 * u;
    if (pts.length >= 2) {
      ctx.strokeStyle = "#39FF14";
      ctx.beginPath();
      const g = pts.slice(0, Math.min(4, pts.length));
      g.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (g.length === 4) ctx.closePath();
      ctx.stroke();
    }
    pts.forEach((p, i) => {
      ctx.fillStyle = i === 4 ? "#04d9ff" : "#39FF14";
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = `${10 * u}px sans-serif`;
      ctx.fillText(String(i + 1), p[0] + 5 * u, p[1] - 5 * u);
    });
    if (pts.length === 5 && ballD) {
      ctx.strokeStyle = "#04d9ff";
      ctx.beginPath();
      ctx.arc(pts[4][0], pts[4][1], (ballD * ballScale) / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    const L = loupeRef.current;
    const src = frameCanvas.current;
    if (L && src) {
      const lc = L.getContext("2d");
      if (lc) {
        lc.clearRect(0, 0, L.width, L.height);
        if (drag) {
          const zoom = 4;
          const half = L.width / zoom / 2;
          lc.imageSmoothingEnabled = false;
          lc.drawImage(src, drag.x - half, drag.y - half, half * 2, half * 2, 0, 0, L.width, L.height);
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
    }
  }, [pts, drag, size, ballD, ballScale, phase]);

  const ballM = BALLS.find((b) => b.id === ballId)?.m ?? 0.22;

  const run = async () => {
    const v = videoRef.current;
    if (!v || pts.length < 5 || !ballD) return;
    const snap = document.createElement("canvas");
    const fc = frameCanvas.current;
    if (fc) {
      snap.width = fc.width;
      snap.height = fc.height;
      snap.getContext("2d")?.drawImage(fc, 0, 0);
      tapCanvas.current = snap;
    }
    setPhase("running");
    setError(null);
    try {
      const src = new VideoFrameSource(v);
      const r = await analyzeRearview(src, {
        tapTime,
        goal: pts.slice(0, 4),
        goalKind,
        ball: { u: pts[4][0], v: pts[4][1], d: ballD * ballScale },
        ballM,
        heights: [],
        onProgress: (stage, p) => setProgress({ stage, p }),
      });
      if (process.env.NODE_ENV !== "production") {
        console.debug("[rearview]", JSON.stringify({ grade: r.grade, speed: r.speedKmh, range: r.speedRange, reasons: r.reasons, timings: r.timings, debug: r.debug && { ...r.debug, raw: r.debug.raw.slice(0, 40).map((q) => [+q.t.toFixed(3), Math.round(q.u), Math.round(q.v), q.dia]) }, n: r.track.length, ball: pts[4], ballD: ballD * ballScale, f: r.calib?.cam.f }));
      }
      setResult(r);
      setPhase("result");
      v.pause();
      v.currentTime = tapTime;
    } catch (e) {
      setError(e instanceof Error ? e.message : "분석 중 오류가 났습니다.");
      setPhase("mark");
    }
  };

  // 결과 그림: 탭한 장면 + 골대 모델 + 궤적
  useEffect(() => {
    if (phase !== "result" || !result?.calib) return;
    const c = resultRef.current;
    const src = tapCanvas.current;
    if (!c || !src) return;
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    const cam = result.calib.cam;
    const u = src.width / 640;
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = "#ff00ff";
    ctx.beginPath();
    goalObject(goalKind).forEach((P, i) => {
      const p = cam.proj(P);
      if (i) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#39FF14";
    for (const p of result.track) {
      ctx.beginPath();
      ctx.arc(p.u, p.v, 2 * u, 0, Math.PI * 2);
      ctx.fill();
    }
    if (result.fit) {
      ctx.strokeStyle = "#ffa500";
      ctx.beginPath();
      result.fit.path.forEach((s, i) => {
        if (cam.depth(s.P) <= 0.1) return;
        const p = cam.proj(s.P);
        if (i) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
      });
      ctx.stroke();
    }
  }, [phase, result, goalKind]);

  const reset = () => {
    setPhase("mark");
    setResult(null);
  };

  const canRun = pts.length === 5 && !!ballD;
  const step = Math.min(pts.length, 4);
  const cross = result?.goalCross;
  const crossbar = GOALS[goalKind].h;

  return (
    <div className="min-h-screen flex flex-col px-4 py-6 sm:p-8">
      <header className="w-full max-w-3xl mx-auto flex items-center justify-between mb-6">
        <Link href="/analyze" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>측정 화면</span>
        </Link>
        <span className="font-mono text-xs tracking-widest text-[var(--color-neon-green)]">FREE KICK · BETA</span>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-bold">프리킥 측정 (대각선 뒤 촬영)</h1>
          <p className="mt-1 text-sm text-gray-400">
            공 뒤쪽 대각선에서 골대까지 보이게 찍은 영상으로 구속·거리·골라인 높이를 잽니다. 영상은 이 기기 안에서만 분석되고
            어디에도 올라가지 않습니다.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-yellow-300/30 bg-yellow-300/10 p-4 text-sm text-yellow-100">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {phase === "pick" && (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col items-center justify-center gap-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-8 cursor-pointer transition-colors">
              <input type="file" accept="video/*" className="hidden" onChange={onFile} />
              <ImageIcon size={32} className="text-[var(--color-neon-blue)]" />
              <span className="font-bold">영상 고르기 / 촬영하기</span>
            </label>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-300">
              <p className="font-bold text-white mb-2">이렇게 찍으면 잘 잽니다</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>공 뒤쪽 대각선, <strong>골대 네 모서리가 모두</strong> 보이게</li>
                <li>폰은 <strong>삼각대나 고정된 곳</strong>에 — 따라 돌리지 않기</li>
                <li><strong>기본(1×) 카메라</strong>로, 줌·광각(0.5×) 없이 가로로</li>
                <li>60fps 가 있으면 켜기. 킥 앞 2초 ~ 공이 골대에 닿을 때까지</li>
              </ul>
            </div>
          </div>
        )}

        {/* 영상 — 표시와 분석에 함께 쓴다 */}
        <div className={phase === "pick" ? "hidden" : "flex flex-col gap-3"}>
          <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black">
            {url && (
              <video
                ref={videoRef}
                src={url}
                playsInline
                muted
                preload="auto"
                onLoadedMetadata={onLoaded}
                onSeeked={onSeeked}
                onLoadedData={grabFrame}
                className={phase === "result" ? "hidden" : "block w-full h-auto"}
              />
            )}
            {phase === "mark" && (
              <canvas
                ref={overlayRef}
                className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              />
            )}
            {phase === "mark" && (
              <canvas
                ref={loupeRef}
                width={160}
                height={160}
                className={`pointer-events-none absolute top-2 ${drag && size && drag.x < size.width / 2 ? "right-2" : "left-2"} w-28 h-28 rounded-lg border border-white/40 ${drag ? "" : "hidden"}`}
              />
            )}
            {phase === "result" && <canvas ref={resultRef} className="block w-full h-auto" />}
          </div>

          {phase === "mark" && (
            <>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 shrink-0">장면</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.01, duration)}
                  step={0.01}
                  value={tapTime}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  className="w-full accent-[var(--color-neon-green)]"
                  aria-label="장면 고르기"
                />
                <span className="font-mono text-xs text-gray-400 w-12 text-right">{tapTime.toFixed(2)}s</span>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
                {pts.length < 5 ? (
                  <p>
                    <span className="text-gray-400">공이 제자리에 놓인 장면(차기 전)을 고른 뒤, 차례로 찍어 주세요 — </span>
                    <strong className="text-[var(--color-neon-green)]">
                      {pts.length + 1}. {STEPS[pts.length]}
                    </strong>
                  </p>
                ) : (
                  <p className="text-gray-300">찍은 점은 끌어서 옮길 수 있습니다. 파란 원이 공 테두리에 맞는지 확인해 주세요.</p>
                )}
                {pts.length > 0 && pts.length < 5 && step > 0 && (
                  <p className="mt-1 text-xs text-gray-500">모서리는 흰 파이프의 한가운데를 찍습니다. 누른 채 움직이면 확대돼 보입니다.</p>
                )}
              </div>
              {pts.length === 5 && ballD && (
                <label className="flex items-center gap-3 text-sm">
                  <span className="shrink-0 text-gray-400">공 크기</span>
                  <input
                    type="range"
                    min={0.6}
                    max={1.6}
                    step={0.01}
                    value={ballScale}
                    onChange={(e) => setBallScale(Number(e.target.value))}
                    className="w-full accent-[var(--color-neon-blue)]"
                    aria-label="공 크기 맞추기"
                  />
                  <span className="font-mono text-xs text-gray-400 w-14 text-right">{(ballD * ballScale).toFixed(0)}px</span>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  골대
                  <select
                    value={goalKind}
                    onChange={(e) => setGoalKind(e.target.value as GoalKind)}
                    className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-bold text-white"
                  >
                    {(Object.keys(GOALS) as GoalKind[]).map((k) => (
                      <option key={k} value={k} className="bg-black">
                        {GOALS[k].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-gray-400">
                  공
                  <select
                    value={ballId}
                    onChange={(e) => setBallId(e.target.value as (typeof BALLS)[number]["id"])}
                    className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-bold text-white"
                  >
                    {BALLS.map((b) => (
                      <option key={b.id} value={b.id} className="bg-black">
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setPts((p) => p.slice(0, -1));
                    setBallD(null);
                  }}
                  disabled={!pts.length}
                  className="flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm disabled:opacity-40"
                >
                  <Undo2 size={16} /> 되돌리기
                </button>
                <button
                  type="button"
                  onClick={run}
                  disabled={!canRun}
                  className="flex-1 rounded-xl bg-[var(--color-neon-green)] px-4 py-3 font-bold text-black disabled:opacity-40"
                >
                  측정하기
                </button>
              </div>
              <label className="text-center text-xs text-gray-500 underline cursor-pointer">
                다른 영상 고르기
                <input type="file" accept="video/*" className="hidden" onChange={onFile} />
              </label>
            </>
          )}

          {phase === "running" && (
            <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 size={16} className="animate-spin text-[var(--color-neon-green)]" />
                {progress.stage || "준비 중"}
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-white/10">
                <div className="h-full bg-[var(--color-neon-green)] transition-all" style={{ width: `${Math.round(progress.p * 100)}%` }} />
              </div>
              <p className="text-xs text-gray-500">영상을 천천히 재생하며 공을 따라갑니다. 화면을 끄지 말고 기다려 주세요.</p>
            </div>
          )}

          {phase === "result" && result && (
            <div className="flex flex-col gap-4">
              {result.grade === "failed" ? (
                <div className="rounded-xl border border-yellow-300/30 bg-yellow-300/10 p-4 text-sm text-yellow-100">
                  <p className="font-bold mb-1">측정하지 못했습니다</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {result.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="flex items-baseline gap-3">
                    <span className="text-5xl font-black text-[var(--color-neon-green)]">{result.speedKmh?.toFixed(0)}</span>
                    <span className="text-lg text-gray-300">km/h</span>
                    <span
                      className={`ml-auto rounded-full px-3 py-1 text-xs font-bold ${
                        result.grade === "measured" ? "bg-[var(--color-neon-green)] text-black" : "bg-white/15 text-white"
                      }`}
                    >
                      {result.grade === "measured" ? "측정" : "추정"}
                    </span>
                  </div>
                  {result.speedRange && (
                    <p className="mt-1 text-sm text-gray-400">
                      범위 {result.speedRange[0].toFixed(0)} ~ {result.speedRange[1].toFixed(0)} km/h
                    </p>
                  )}
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-black/30 p-3">
                      <dt className="text-xs text-gray-400">골라인까지 거리</dt>
                      <dd className="text-lg font-bold">{result.distanceM?.toFixed(1)} m</dd>
                    </div>
                    <div className="rounded-lg bg-black/30 p-3">
                      <dt className="text-xs text-gray-400">발사각</dt>
                      <dd className="text-lg font-bold">{result.elevDeg?.toFixed(0)}°</dd>
                    </div>
                    {cross && (
                      <div className="col-span-2 rounded-lg bg-black/30 p-3">
                        <dt className="text-xs text-gray-400">골라인 지날 때 높이</dt>
                        <dd className="text-lg font-bold">
                          {cross.z.toFixed(2)} m{" "}
                          <span className="text-sm font-normal text-gray-400">
                            {cross.z > crossbar
                              ? `(크로스바 ${crossbar} m 위)`
                              : Math.abs(cross.x) > GOALS[goalKind].w / 2
                                ? "(골대 옆)"
                                : "(골대 안쪽 높이)"}
                          </span>
                        </dd>
                      </div>
                    )}
                  </dl>
                  {result.reasons.length > 0 && (
                    <ul className="mt-3 list-disc pl-5 text-xs text-gray-400 space-y-1">
                      {result.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 text-xs text-gray-500">
                    범위는 폰 카메라 화각을 정확히 몰라서 생기는 폭입니다. 분홍 선은 계산한 골대, 주황 선은 계산한 공의 궤적입니다 —
                    영상 속 골대·공과 겹칠수록 믿을 만합니다.
                  </p>
                </div>
              )}
              <div className="flex gap-3">
                <button type="button" onClick={reset} className="flex items-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm">
                  <RotateCcw size={16} /> 점 다시 찍기
                </button>
                <label className="flex-1 cursor-pointer rounded-xl bg-white/10 px-4 py-3 text-center text-sm font-bold">
                  다른 영상
                  <input type="file" accept="video/*" className="hidden" onChange={onFile} />
                </label>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
