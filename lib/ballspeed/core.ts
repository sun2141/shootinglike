/**
 * 플랫폼과 무관한 계측 코어.
 *
 * 프레임을 어디서 얻는지(브라우저 재생 / ffmpeg 디코딩)만 다르고, 그 뒤 계산은 완전히 같다.
 * 그래서 브라우저 페이지와 터미널 CLI 가 이 파일 하나를 공유한다.
 */
import { detectFrame } from './detect';
import { measure, type Series } from './measure';
import { estimateShift, shiftGray, type Shift } from './stabilize';
import { buildTrack, type RejectedChain } from './track';
import {
  BALL_DIAMETER_M,
  type AnalyzeOptions,
  type FrameObservation,
  type Gray,
  type Measurement,
} from './types';

export interface CapturedFrame {
  /** 검출 해상도의 명도 프레임 */
  g: Gray;
  /** 영상 안에서의 실제 시각(초). fps 가정이 아니라 실측값이어야 한다. */
  t: number;
}

export interface FrameSourceInfo {
  /** 원본 영상 크기 */
  width: number;
  height: number;
  /** 원본 px = 검출 px * scale */
  scale: number;
  detectWidth: number;
  durationS: number | null;
  fpsMeasured: number | null;
  droppedHint: boolean;
  decodedFrames: number | null;
}

/**
 * 담아둔 프레임으로 카메라 보정 → 공 검출 → 궤적 → 계측까지 한 번에.
 * 프레임을 담는 일과 계산하는 일을 분리해 둔 이유는, 재생 콜백 안에서 무거운 계산을 하면
 * 브라우저가 프레임을 통째로 버려서 표본이 절반으로 줄기 때문이다.
 */
export function analyzeFrames(
  frames: CapturedFrame[],
  info: FrameSourceInfo,
  opts: AnalyzeOptions = {},
): Measurement {
  const ballDiameterM = opts.ballDiameterM ?? BALL_DIAMETER_M[opts.ballSize ?? 'size5'];
  const stabilize = opts.stabilize ?? true;

  // 1) 카메라 이동 누적. 바로 앞 프레임과만 비교하면 프레임당 1px 미만의 완만한 패닝이
  //    반올림으로 사라지므로, 기준 프레임을 두고 충분히 멀어졌을 때만 갈아끼운다.
  const cum: Array<{ x: number; y: number }> = [];
  let refIdx = 0;
  let refCum = { x: 0, y: 0 };
  for (let k = 0; k < frames.length; k++) {
    if (k === 0 || !stabilize) {
      cum.push({ x: 0, y: 0 });
      continue;
    }
    const rel: Shift = estimateShift(frames[refIdx].g, frames[k].g);
    const here = { x: refCum.x + rel.dx, y: refCum.y + rel.dy };
    cum.push(here);
    if (Math.hypot(rel.dx, rel.dy) > 10) {
      refIdx = k;
      refCum = here;
    }
  }

  // 2) 3프레임 차분 검출. 이웃 프레임은 현재 프레임 좌표계로 옮긴 뒤 차분해야
  //    카메라가 움직인 부분이 '움직이는 물체'로 오검출되지 않는다.
  const obs: FrameObservation[] = [];
  for (let k = 0; k < frames.length; k++) {
    const c = frames[k];
    const prev = k > 0 ? frames[k - 1] : null;
    const next = k < frames.length - 1 ? frames[k + 1] : null;
    let pg: Gray | null = null;
    let ng: Gray | null = null;
    if (prev) {
      const d = stabilize ? { x: cum[k].x - cum[k - 1].x, y: cum[k].y - cum[k - 1].y } : { x: 0, y: 0 };
      pg = stabilize ? shiftGray(prev.g, d.x, d.y) : prev.g;
    }
    if (next) {
      const d = stabilize ? { x: cum[k + 1].x - cum[k].x, y: cum[k + 1].y - cum[k].y } : { x: 0, y: 0 };
      ng = stabilize ? shiftGray(next.g, -d.x, -d.y) : next.g;
    }
    obs.push({ t: c.t, index: k, candidates: pg || ng ? detectFrame(c.g, pg, ng) : [] });
    if (k % 12 === 0) opts.onProgress?.(0.5 + (0.5 * k) / Math.max(frames.length, 1));
  }
  opts.onProgress?.(1);

  const rejected: RejectedChain[] = [];
  const track = buildTrack(obs, {
    maxStepPx: Math.max(60, info.detectWidth * 0.35),
    fps: info.fpsMeasured,
  },
    opts.collectDebug ? rejected : undefined);
  const focalPx = opts.focalPx ?? info.width * (opts.focalWidthRatio ?? 0.74);
  const common = {
    focalPx,
    cx: info.width / 2,
    cy: info.height / 2,
    ballDiameterM,
    dragCoefficient: opts.dragCoefficient ?? 0.009,
    gravityCalibration: opts.gravityCalibration ?? true,
    requireGravityCheck: opts.requireGravityCheck ?? true,
    videoWidth: info.width,
    videoHeight: info.height,
    fpsMeasured: info.fpsMeasured,
    durationS: info.durationS,
    totalFrames: frames.length,
    droppedHint: info.droppedHint,
    cameraMotionPx: cameraMotion(cum) * info.scale,
    decodedFrames: info.decodedFrames,
  };
  const attach = (m: Measurement): Measurement => {
    if (opts.collectDebug) {
      m.debug = {
        scale: info.scale,
        frames: obs.map((o) => ({
          t: Math.round(o.t * 1e4) / 1e4,
          candidates: o.candidates.map((c) => ({
            x: Math.round(c.x * info.scale * 10) / 10,
            y: Math.round(c.y * info.scale * 10) / 10,
            r: Math.round(c.r * info.scale * 100) / 100,
            conf: Math.round(c.conf * 1000) / 1000,
          })),
        })),
        picked: track ? track.idx.map(({ f, c }) => [f, c] as [number, number]) : [],
        rejected,
      };
    }
    return m;
  };

  if (!track) {
    const m = measure({ ...common, series: emptySeries() });
    m.warnings.unshift('영상에서 공을 찾지 못했습니다. 공과 전신이 함께 보이도록 측면에서 다시 찍어보세요.');
    return attach(m);
  }
  return attach(measure({ ...common, series: buildSeries(obs, track.idx, info.scale, stabilize ? cum : null) }));
}

function emptySeries(): Series {
  return { t: [], x: [], y: [], r: [], observed: [] };
}

function cameraMotion(cum: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < cum.length; i++) {
    total += Math.hypot(cum[i].x - cum[i - 1].x, cum[i].y - cum[i - 1].y);
  }
  return total;
}

function buildSeries(
  obs: FrameObservation[],
  idx: Array<{ f: number; c: number }>,
  scale: number,
  cum: Array<{ x: number; y: number }> | null,
): Series {
  const first = idx[0].f;
  const last = idx[idx.length - 1].f;
  const known = new Map<number, { x: number; y: number; r: number }>();
  for (const { f, c } of idx) {
    const cand = obs[f].candidates[c];
    // 카메라가 움직인 만큼을 빼서 '고정 카메라에서 본 좌표'로 되돌린다
    const off = cum && f < cum.length ? cum[f] : { x: 0, y: 0 };
    known.set(f, { x: (cand.x - off.x) * scale, y: (cand.y - off.y) * scale, r: cand.r * scale });
  }
  const t: number[] = [], x: number[] = [], y: number[] = [], r: number[] = [], observed: boolean[] = [];
  const keys = [...known.keys()].sort((a, b) => a - b);
  for (let fi = first; fi <= last; fi++) {
    t.push(obs[fi].t);
    const hit = known.get(fi);
    if (hit) {
      x.push(hit.x); y.push(hit.y); r.push(hit.r); observed.push(true);
    } else {
      let lo = keys[0];
      let hi = keys[keys.length - 1];
      for (const k of keys) { if (k < fi) lo = k; else { hi = k; break; } }
      const a = known.get(lo)!;
      const b = known.get(hi)!;
      const ta = obs[lo].t, tb = obs[hi].t;
      const w = tb > ta ? (obs[fi].t - ta) / (tb - ta) : 0;
      x.push(a.x + (b.x - a.x) * w);
      y.push(a.y + (b.y - a.y) * w);
      r.push(a.r + (b.r - a.r) * w);
      observed.push(false);
    }
  }
  return { t, x, y, r, observed };
}

/** 프레임 버퍼 크기를 메모리 예산에서 역산 */
export function framesForBudget(bytesPerFrame: number, budgetMB = 96): number {
  return Math.max(40, Math.floor((budgetMB * 1024 * 1024) / Math.max(bytesPerFrame, 1)));
}

export * from './types';
export { detectFrame, refineRadius } from './detect';
export { buildTrack } from './track';
export { measure, smooth, robustLinearFit } from './measure';
export { estimateShift, shiftGray } from './stabilize';
