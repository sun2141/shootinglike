/**
 * 대각선 뒤에서 찍은 프리킥 — 전체 흐름 (브라우저·Node 공용, 프레임 공급만 다르다).
 *
 *   1. 보정: 사용자가 찍은 골대 네 모서리 + 멈춘 공 (+ 선택: 사람 키) → 카메라
 *   2. 킥 순간: 멈춘 공 자리가 바뀌기 시작하는 시각 (저해상도로 빠르게)
 *   3. 추적: 킥 전후 3초만 원본 해상도 관심 영역으로 공을 따라감 (흔들림은 평행이동 보정)
 *   4. 궤적: 중력+항력+회전 3D 궤적 맞춤 → 속도·발사각·골라인 높이
 *   5. 범위: 초점거리 1σ 범위 양 끝 카메라로 다시 맞춰 속도 범위
 *
 * 모든 계산은 사용자 기기에서 끝난다. 서버로는 결과 숫자만 간다.
 */
import { calibrate, type CalibResult, type HeightObs } from './calibrate';
import type { GoalKind, Vec3 } from './camera';
import { fitFlight, refitSpeed, type FitResult, type Obs } from './physics';
import { BallTracker, KickFinder, type GrayImage, type TrackPoint } from './track';

export interface FrameAccess {
  /** 영상 시각(초) */
  t: number;
  /** 처리 해상도 좌표의 사각형 RGBA (바깥은 0) */
  region(x: number, y: number, w: number, h: number): Uint8ClampedArray | Uint8Array;
  /** 흔들림 추정용 저해상도 명도 (가로 THUMB_W) */
  thumb(): GrayImage;
}

export interface ScanStats {
  frames: number;
  /** 건너뛴 프레임 비율 (0~1) */
  dropped: number;
}

export interface FrameSource {
  /** 처리 해상도 */
  width: number;
  height: number;
  duration: number;
  /**
   * t0~t1 구간 프레임을 차례로 넘겨준다 (t0 순간에 보이는 프레임부터).
   * quality 'fast' 는 빠르게(프레임을 좀 건너뛰어도 됨), 'full' 은 모든 프레임, 'slow' 는 기기가 느릴 때 다시 읽기.
   */
  scan(
    t0: number,
    t1: number,
    quality: 'fast' | 'full' | 'slow',
    /** false 를 돌려주면 거기서 멈춘다 */
    cb: (f: FrameAccess) => void | boolean,
    onProgress?: (p: number) => void,
  ): Promise<ScanStats>;
}

export const THUMB_W = 480;

export interface RearviewInput {
  /** 골대·공을 찍은 장면의 시각 (킥 전, 공이 멈춰 있는 장면) */
  tapTime: number;
  /** 왼쪽 아래, 오른쪽 아래, 오른쪽 위, 왼쪽 위 (처리 해상도 px) */
  goal: [number, number][];
  goalKind: GoalKind;
  /** 멈춘 공: 중심과 지름 (처리 해상도 px) */
  ball: { u: number; v: number; d: number };
  ballM: number;
  heights: HeightObs[];
  /**
   * 초점거리 사전값 (영상 긴 변 대비). 비우면 폰 메인 카메라 기본값 0.74 ± 0.08.
   * 레퍼런스(속도를 아는 영상)로 기기별 값을 확인했다면 좁은 σ 로 넘긴다.
   */
  focalPrior?: { ratio: number; sigma: number };
  onProgress?: (stage: string, p: number) => void;
}

export type Grade = 'measured' | 'estimated' | 'failed';

export interface RearviewResult {
  grade: Grade;
  reasons: string[];
  speedKmh: number | null;
  /** 1σ 범위 */
  speedRange: [number, number] | null;
  elevDeg: number | null;
  /** 공 → 골라인 거리 (m) */
  distanceM: number | null;
  /** 골라인을 지날 때 높이·가로 위치 (m) — 골대 기준 */
  goalCross: { x: number; z: number; t: number } | null;
  tKick: number | null;
  track: TrackPoint[];
  fit: FitResult | null;
  calib: CalibResult | null;
  cameraMotionPx: number;
  timings: Record<string, number>;
  /** 진단: 멈춘 공 자리가 바뀌기 시작한 시각, 추적기가 잡은 원래 점들 */
  debug?: { tStart: number | null; raw: TrackPoint[]; stop: string };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ------------------------------------------------------------ 흔들림 (평행이동, 소수 px)
function sad(a: GrayImage, b: GrayImage, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0;
  let n = 0;
  const w = a.width;
  for (let y = Math.max(y0, y0 - dy); y < Math.min(y1, y1 - dy); y += 3) {
    for (let x = Math.max(x0, x0 - dx); x < Math.min(x1, x1 - dx); x += 3) {
      s += Math.abs(a.data[y * w + x] - b.data[(y + dy) * w + x + dx]);
      n++;
    }
  }
  return n ? s / n : Infinity;
}

/** ref 를 (dx,dy) 옮기면 cur 과 맞는다. 공이 날아가는 영역(exclude)은 뺀다 */
export function estimateShiftSub(ref: GrayImage, cur: GrayImage, guess: [number, number], exclude: [number, number, number, number] | null): [number, number] {
  const w = ref.width;
  const h = ref.height;
  // 가장자리 여백을 두고 전체에서, 관심 영역과 겹치면 위/아래 중 큰 쪽만
  let x0 = 16, y0 = 16, x1 = w - 16, y1 = h - 16;
  if (exclude) {
    const [ex0, ey0, ex1, ey1] = exclude;
    const top = ey0 - y0;
    const bottom = y1 - ey1;
    const left = ex0 - x0;
    const right = x1 - ex1;
    const areas = [top * (x1 - x0), bottom * (x1 - x0), left * (y1 - y0), right * (y1 - y0)];
    const k = areas.indexOf(Math.max(...areas));
    if (areas[k] > 0.15 * w * h) {
      if (k === 0) y1 = ey0;
      else if (k === 1) y0 = ey1;
      else if (k === 2) x1 = ex0;
      else x0 = ex1;
    }
  }
  let bx = Math.round(guess[0]);
  let by = Math.round(guess[1]);
  // 거친 탐색 (±12, 2px) → 세밀 (±2, 1px)
  let best = Infinity;
  for (let dy = by - 12; dy <= by + 12; dy += 2) {
    for (let dx = bx - 12; dx <= bx + 12; dx += 2) {
      const c = sad(ref, cur, dx, dy, x0, y0, x1, y1);
      if (c < best) {
        best = c;
        bx = dx;
        by = dy;
      }
    }
  }
  const cx = bx;
  const cy = by;
  for (let dy = cy - 2; dy <= cy + 2; dy++) {
    for (let dx = cx - 2; dx <= cx + 2; dx++) {
      const c = sad(ref, cur, dx, dy, x0, y0, x1, y1);
      if (c < best) {
        best = c;
        bx = dx;
        by = dy;
      }
    }
  }
  // 포물선으로 소수 px
  const sub = (cm: number, c0: number, cp: number) => {
    const den = cm - 2 * c0 + cp;
    return den > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cm - cp)) / den)) : 0;
  };
  const sx = sub(sad(ref, cur, bx - 1, by, x0, y0, x1, y1), best, sad(ref, cur, bx + 1, by, x0, y0, x1, y1));
  const sy = sub(sad(ref, cur, bx, by - 1, x0, y0, x1, y1), best, sad(ref, cur, bx, by + 1, x0, y0, x1, y1));
  return [bx + sx, by + sy];
}

// ------------------------------------------------------------ 본 흐름
export async function analyzeRearview(src: FrameSource, inp: RearviewInput): Promise<RearviewResult> {
  const timings: Record<string, number> = {};
  const W = src.width;
  const H = src.height;
  const s = Math.max(W, H) / 1920;
  const reasons: string[] = [];
  const fail = (why: string, extra: Partial<RearviewResult> = {}): RearviewResult => ({
    grade: 'failed',
    reasons: [...reasons, why],
    speedKmh: null,
    speedRange: null,
    elevDeg: null,
    distanceM: null,
    goalCross: null,
    tKick: null,
    track: [],
    fit: null,
    calib: null,
    cameraMotionPx: 0,
    timings,
    ...extra,
  });

  // 1) 보정
  let t = now();
  inp.onProgress?.('카메라 맞추는 중', 0);
  const calib = calibrate({
    width: W,
    height: H,
    goal: inp.goal,
    goalKind: inp.goalKind,
    ball: inp.ball,
    ballM: inp.ballM,
    heights: inp.heights,
    focalPrior: inp.focalPrior,
  });
  timings.calib = now() - t;
  if (!calib) return fail('골대 네 모서리로 카메라를 맞추지 못했습니다. 모서리를 다시 찍어 주세요.');
  const d = calib.diag;
  if (Math.max(...d.goalPx) > 12 * s) reasons.push('골대 모서리가 서로 맞지 않습니다 (찍은 위치나 골대 규격을 확인해 주세요)');
  for (const h of d.heights) {
    if (h.ratio < 0.9 || h.ratio > 1.1) reasons.push(`${h.name} 키가 화면과 ${Math.round(Math.abs(h.ratio - 1) * 100)}% 어긋납니다 (발·머리 위치 확인)`);
  }
  if (d.ballRatio !== null && (d.ballRatio < 0.7 || d.ballRatio > 1.4)) reasons.push('공 크기가 골대와 맞지 않습니다 (공 원 크기 확인)');
  const P0 = d.ballPos as Vec3;
  const distanceM = -P0[1];
  if (!(distanceM > 5 && distanceM < 45)) return fail(`공 → 골라인 거리가 ${distanceM.toFixed(1)} m 로 계산돼 비현실적입니다`, { calib });

  // 2) 킥 순간
  t = now();
  const half = Math.max(3, Math.round(inp.ball.d * 0.45));
  const box = (f: FrameAccess): GrayImage => {
    const n = 2 * half + 1;
    const rgba = f.region(Math.round(inp.ball.u) - half, Math.round(inp.ball.v) - half, n, n);
    const g = new Float32Array(n * n);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return { data: g, width: n, height: n };
  };
  let finder: KickFinder | null = null;
  await src.scan(
    inp.tapTime,
    src.duration,
    'fast',
    (f) => {
      const p = box(f).data as Float32Array;
      if (!finder) finder = new KickFinder(p);
      else {
        finder.push(f.t, p);
        // 공 자리가 1.5초 넘게 계속 비어 있으면 더 볼 필요 없다
        if (finder.goneFor() > 1.5) return false;
      }
    },
    (p) => inp.onProgress?.('차는 순간 찾는 중', p),
  );
  timings.kick = now() - t;
  const tStart = (finder as KickFinder | null)?.result() ?? null;
  if (tStart === null) return fail('공이 차이는 장면을 찾지 못했습니다. 공을 찍은 장면이 킥 전인지 확인해 주세요.', { calib });

  // 3) 추적: 관심 영역 = 멈춘 공 ~ 골대, 위로 골대 높이만큼 더
  t = now();
  const gx = inp.goal.map((p) => p[0]);
  const gy = inp.goal.map((p) => p[1]);
  const gh = Math.max(...gy) - Math.min(...gy);
  const gw = Math.max(...gx) - Math.min(...gx);
  const margin = 3 * inp.ball.d;
  let rx0 = Math.min(inp.ball.u, ...gx) - Math.max(margin, 0.6 * gw);
  let rx1 = Math.max(inp.ball.u, ...gx) + Math.max(margin, 0.6 * gw);
  let ry0 = Math.min(...gy) - 1.5 * gh;
  let ry1 = inp.ball.v + margin;
  rx0 = Math.max(0, Math.floor(rx0));
  ry0 = Math.max(0, Math.floor(ry0));
  rx1 = Math.min(W, Math.ceil(rx1));
  ry1 = Math.min(H, Math.ceil(ry1));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const goalCenter: [number, number] = [gx.reduce((a, b) => a + b, 0) / 4, gy.reduce((a, b) => a + b, 0) / 4];
  const ts = THUMB_W / W;
  const exclude: [number, number, number, number] = [rx0 * ts, ry0 * ts, rx1 * ts, ry1 * ts];
  // 기준 장면(탭한 장면)의 저해상도 — 흔들림 기준
  let refThumb: GrayImage | null = null;
  await src.scan(inp.tapTime, inp.tapTime, 'full', (f) => {
    if (!refThumb) refThumb = f.thumb();
  });
  const runTrack = async (quality: 'full' | 'slow') => {
    // 킥 순간 추정은 몇 프레임 늦을 수 있어 조금 앞에서부터 찾는다
    const tracker = new BallTracker({ rest: inp.ball, goalCenter, goalCorners: inp.goal, tStart: tStart - 0.08, scale: s });
    let shift: [number, number] = [0, 0];
    let maxMotion = 0;
    const stats = await src.scan(
      Math.max(inp.tapTime, tStart - 0.25),
      Math.min(src.duration, tStart + 3.2),
      quality,
      (f) => {
        if (tracker.mode === 'done') return false;
        if (refThumb) {
          shift = estimateShiftSub(refThumb, f.thumb(), [shift[0], shift[1]], exclude);
          maxMotion = Math.max(maxMotion, Math.hypot(shift[0], shift[1]) / ts);
        }
        const sx = Math.round(shift[0] / ts);
        const sy = Math.round(shift[1] / ts);
        tracker.push({ t: f.t, data: f.region(rx0 + sx, ry0 + sy, rw, rh), width: rw, height: rh, ox: rx0, oy: ry0 });
      },
      (p) => inp.onProgress?.(quality === 'full' ? '공 따라가는 중' : '공 따라가는 중 (천천히 다시)', p),
    );
    return { tracker, maxMotion, stats };
  };
  let run = await runTrack('full');
  // 기기가 느려 프레임을 많이 건너뛰었으면 더 천천히 한 번 더
  if (run.stats.dropped > 0.1) run = await runTrack('slow');
  const { tracker, maxMotion } = run;
  timings.droppedPct = Math.round(run.stats.dropped * 100);
  timings.track = now() - t;
  const track = tracker.result();
  const debug = { tStart, raw: tracker.pts, stop: tracker.reason };
  if (track.length < 10) {
    return fail(`공을 충분히 따라가지 못했습니다 (${track.length}점${tracker.reason ? `, ${tracker.reason}` : ''}). 삼각대로 고정하고 공이 가려지지 않게 찍어 주세요.`, {
      calib,
      track,
      cameraMotionPx: maxMotion,
      distanceM,
      debug,
    });
  }

  // 4) 궤적
  t = now();
  inp.onProgress?.('궤적 계산 중', 0);
  const obs: Obs[] = track.map((p) => ({ t: p.t, u: p.u, v: p.v }));
  const fit = fitFlight(calib.cam, P0, obs, { tolPx: 3 * s });
  // 5) 범위 — 초점거리 끝의 카메라에서는 공 위치도 다시 잡는다
  const lo = refitSpeed(calib.camLo, calib.camLo.ground(inp.ball.u, inp.ball.v, inp.ballM / 2), fit.used, fit.params);
  const hi = refitSpeed(calib.camHi, calib.camHi.ground(inp.ball.u, inp.ball.v, inp.ballM / 2), fit.used, fit.params);
  timings.fit = now() - t;
  const speed = fit.speedKmh;
  // 화각(초점거리) 범위에서 오는 폭 + 추적·모델에서 오는 최소 ±3%
  const range: [number, number] = [Math.min(speed * 0.97, lo, hi), Math.max(speed * 1.03, lo, hi)];

  // 판정
  if (fit.rmsPx > 5 * s) reasons.push(`궤적이 매끄럽지 않습니다 (오차 ${fit.rmsPx.toFixed(1)}px)`);
  if (fit.nUsed < 12 || fit.tSpan < 0.3) reasons.push(`날아가는 구간이 짧습니다 (${fit.nUsed}점, ${fit.tSpan.toFixed(2)}초)`);
  if (!(speed > 20 && speed < 160)) reasons.push(`속도 ${speed.toFixed(0)} km/h 는 비현실적입니다`);
  if (maxMotion > 40 * s) reasons.push('카메라가 많이 움직였습니다 — 삼각대나 고정된 곳에서 찍으면 정확해집니다');
  const hard = reasons.length > 0;
  // 이 구도에선 골대·공만으로 초점거리가 정해지지 않아 폰 화각 사전값이 결과를 좌우한다.
  // 그래서 기기 화각이 레퍼런스로 확인된 경우(focalPrior σ ≤ 0.03)에만 '측정', 나머지는 '추정'.
  const knownLens = !!inp.focalPrior && inp.focalPrior.sigma <= 0.03;
  const tight = (range[1] - range[0]) / 2 / speed <= 0.05;
  let grade: Grade = 'failed';
  if (!hard) grade = knownLens && tight && fit.nUsed >= 18 && fit.rmsPx <= 2 * s ? 'measured' : 'estimated';

  return {
    grade,
    reasons,
    speedKmh: grade === 'failed' ? null : speed,
    speedRange: grade === 'failed' ? null : range,
    elevDeg: fit.elevDeg,
    distanceM,
    goalCross: fit.goalCross,
    tKick: fit.tKick,
    track: track.slice(0, fit.nUsed),
    fit,
    calib,
    cameraMotionPx: maxMotion,
    timings,
    debug,
  };
}
