/**
 * 계측 — 픽셀 궤적을 실제 속도/거리로 바꾼다.
 *
 * 스케일의 출발점은 공 지름이다. 공은 규격이 정해져 있어서, 화면에서 몇 픽셀로 보이는지만
 * 알면 그 자리의 "1미터가 몇 픽셀인지"가 나온다. 문제는 이 자가 흔들린다는 것이다.
 * 모션블러 한 번에 반지름이 배로 뛰고, 그러면 속도는 절반이 된다.
 *
 * 그래서 자를 한 번 더 검산한다. 공중의 공은 연직 가속도가 반드시 9.81 m/s² 다.
 * 복원된 궤적의 연직 가속도를 재서 9.81 과 비교하면, 스케일이 몇 배 틀렸는지가
 * 정답 라벨 없이도 그대로 나온다. 4.9 가 나왔다면 자가 2배 틀린 것이다.
 *
 * 주의: 공기저항의 연직 성분이 섞이므로 중력만 놓고 맞추면 10~20% 쏠린다.
 * 올라갈 때는 저항이 아래로, 내려올 때는 위로 작용하기 때문이다. 그래서 항력을 넣고
 * 몇 번 반복해서 기대 연직가속도를 갱신한다.
 */
import type { GravityCheck, Measurement, TrajectoryPoint } from './types';

const KMH = 3.6;
const G = 9.81;

export interface Series {
  t: number[];
  x: number[];
  y: number[];
  r: number[];
  observed: boolean[];
}

export interface MeasureInput {
  series: Series;
  focalPx: number;
  cx: number;
  cy: number;
  ballDiameterM: number;
  dragCoefficient: number;
  gravityCalibration: boolean;
  requireGravityCheck: boolean;
  videoWidth: number;
  videoHeight: number;
  fpsMeasured: number | null;
  durationS: number | null;
  totalFrames: number;
  droppedHint: boolean;
  cameraMotionPx?: number;
  decodedFrames?: number | null;
}

/** 2차 다항 국소 평활 (Savitzky-Golay 와 같은 아이디어, 창 크기 5 고정 시 계수 내장) */
export function smooth(v: number[], window = 5): number[] {
  const n = v.length;
  if (n < 5) return v.slice();
  const half = Math.max(1, Math.floor(window / 2));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    // 국소 2차 최소제곱
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let j = lo; j <= hi; j++) {
      const u = j - i;
      const u2 = u * u;
      s0 += 1; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
      b0 += v[j]; b1 += v[j] * u; b2 += v[j] * u2;
    }
    const m = [
      [s0, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ];
    const sol = solve3(m, [b0, b1, b2]);
    out[i] = sol ? sol[0] : v[i];
  }
  return out;
}

function solve3(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Huber 가중 1차 로버스트 피팅. 반지름이 튄 프레임의 영향을 눌러준다. */
export function robustLinearFit(t: number[], v: number[]): { a: number; b: number; relResid: number } | null {
  const n = t.length;
  if (n < 3) return null;
  let w = new Array<number>(n).fill(1);
  let a = 0;
  let b = 0;
  for (let iter = 0; iter < 12; iter++) {
    let sw = 0, swt = 0, swtt = 0, swv = 0, swtv = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      sw += wi; swt += wi * t[i]; swtt += wi * t[i] * t[i];
      swv += wi * v[i]; swtv += wi * t[i] * v[i];
    }
    const det = sw * swtt - swt * swt;
    if (Math.abs(det) < 1e-12) return null;
    a = (sw * swtv - swt * swv) / det;
    b = (swtt * swv - swt * swtv) / det;
    const resid = t.map((ti, i) => v[i] - (a * ti + b));
    const med = median(resid.map(Math.abs));
    const s = 1.4826 * med + 1e-9;
    const k = 1.5 * s;
    w = resid.map((r) => (Math.abs(r) <= k ? 1 : k / (Math.abs(r) + 1e-12)));
  }
  const resid = t.map((ti, i) => v[i] - (a * ti + b));
  const relResid = median(resid.map(Math.abs)) / (median(v.map(Math.abs)) + 1e-9);
  return { a, b, relResid };
}

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** 2차 피팅 y = c2 t² + c1 t + c0. 연직 가속도 = 2*c2 */
function quadraticFit(t: number[], y: number[]): { c2: number; c1: number; c0: number; r2: number; rms: number; snr: number } | null {
  const n = t.length;
  if (n < 5) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const u = t[i];
    const u2 = u * u;
    s0 += 1; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    b0 += y[i]; b1 += y[i] * u; b2 += y[i] * u2;
  }
  const sol = solve3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [b0, b1, b2]);
  if (!sol) return null;
  const [c0, c1, c2] = sol;
  const mean = y.reduce((p, c) => p + c, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = c2 * t[i] * t[i] + c1 * t[i] + c0;
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - mean) ** 2;
  }
  const rms = Math.sqrt(ssRes / n);
  // 중력을 얼마나 '실제로 봤는가'. 2차항이 만들어낸 높이 차이가 잔차보다 충분히 커야
  // 연직 가속도를 믿을 수 있다. 구간이 짧으면 이 값이 바로 무너진다.
  const span = t[n - 1] - t[0];
  const snr = Math.abs(c2 * span * span) / (rms + 1e-9);
  return { c2, c1, c0, r2: 1 - ssRes / (ssTot + 1e-12), rms, snr };
}

/** 화면상 이동량이 갑자기 커지는 지점 = 임팩트. 스케일과 무관한 상대 기준이다. */
function detectImpact(pxSpeed: number[]): number {
  if (pxSpeed.length < 4) return 0;
  const sorted = [...pxSpeed].sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.9)];
  if (hi <= 0) return 0;
  let first = -1;
  for (let i = 0; i < pxSpeed.length; i++) {
    if (pxSpeed[i] >= 0.35 * hi) { first = i; break; }
  }
  if (first <= 0) return 0;
  const before = median(pxSpeed.slice(0, first));
  return before < 0.22 * hi ? first : 0;
}

export function measure(input: MeasureInput): Measurement {
  const { series, focalPx: f, cx, cy, ballDiameterM } = input;
  const ballR = ballDiameterM / 2;
  const warnings: string[] = [];

  const base: Measurement = {
    ok: false,
    verified: false,
    speedKmh: null, speedRawKmh: null, peakSpeedKmh: null,
    launchAngleDeg: null, flightTimeS: null,
    pathDistanceM: null, straightDistanceM: null,
    ballDiameterPxAtImpact: null, pxPerMeterAtImpact: null,
    gravityCheck: null, quality: null, confidence: 0, confidenceParts: {}, warnings,
    trajectory: [], frames: input.totalFrames, observedFrames: 0,
    fpsMeasured: input.fpsMeasured, durationS: input.durationS,
    focalPxUsed: f, videoWidth: input.videoWidth, videoHeight: input.videoHeight,
    cameraMotionPx: input.cameraMotionPx ?? null,
    processedFrames: input.totalFrames,
    decodedFrames: input.decodedFrames ?? null,
  };

  const n = series.t.length;
  base.observedFrames = series.observed.filter(Boolean).length;
  if (n < 8) {
    warnings.push('공이 잡힌 프레임이 너무 적어 측정할 수 없습니다. 측면에서 공이 더 크게 나오도록 찍어보세요.');
    return base;
  }

  const xs = smooth(series.x);
  const ys = smooth(series.y);
  const rs = smooth(series.r, 5);
  const t = series.t;

  // 임팩트 이후 구간만 쓴다
  const pxSpeed = [0];
  for (let i = 1; i < n; i++) {
    const dt = Math.max(t[i] - t[i - 1], 1e-6);
    pxSpeed.push(Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) / dt);
  }
  let i0 = detectImpact(pxSpeed);
  if (n - i0 < 8) i0 = 0;

  const T = t.slice(i0).map((v) => v - t[i0]);
  const X0 = xs.slice(i0);
  const Y0 = ys.slice(i0);
  const R0 = rs.slice(i0);

  // 깊이는 반지름에 반비례한다. 반지름이 프레임마다 튀므로 로버스트 1차 피팅으로 눌러 쓴다.
  const zRaw = R0.map((r) => (f * ballR) / Math.max(r, 1e-6));
  const fit = robustLinearFit(T, zRaw);
  const z = fit ? T.map((tt, i) => {
    const v = fit.a * tt + fit.b;
    return v > 0.3 ? v : zRaw[i];
  }) : zRaw;

  let P = T.map((_, i) => ({
    X: ((X0[i] - cx) * z[i]) / f,
    Y: ((Y0[i] - cy) * z[i]) / f,
    Z: z[i],
  }));
  P = P.map((p, i, arr) => p); // (평활은 아래에서 축별로)
  const sX = smooth(P.map((p) => p.X));
  const sY = smooth(P.map((p) => p.Y));
  const sZ = smooth(P.map((p) => p.Z));
  for (let i = 0; i < P.length; i++) { P[i] = { X: sX[i], Y: sY[i], Z: sZ[i] }; }

  // ---- 보정 전 값: 화면 2D 이동량만으로 낸 속도 (기존 방식과 같은 계산) ----
  const pxPerM0 = (2 * R0[0]) / ballDiameterM;
  let speedRaw: number | null = null;
  {
    const k = Math.min(5, P.length - 1);
    const vals: number[] = [];
    for (let i = 1; i <= k; i++) {
      const dt = Math.max(T[i] - T[i - 1], 1e-6);
      const pxm = (2 * ((R0[i] + R0[i - 1]) / 2)) / ballDiameterM;
      vals.push((Math.hypot(X0[i] - X0[i - 1], Y0[i] - Y0[i - 1]) / pxm / dt) * KMH);
    }
    speedRaw = vals.length ? median(vals) : null;
  }

  // ---- 중력 자기검산 ----
  const gq = quadraticFit(T, P.map((p) => p.Y));
  let scale = 1;
  let gravityCheck: GravityCheck | null = null;
  if (gq) {
    const aMeasured = 2 * gq.c2; // 아래가 + 이므로 정상이면 +9.81 근처
    let expected = G;
    let k = aMeasured > 0.5 ? expected / aMeasured : 1;
    const span = T[T.length - 1] - T[0];
    const strongEnough = gq.snr >= 4 && span >= 0.25;
    if (input.gravityCalibration && aMeasured > 0.5 && gq.r2 > 0.85 && strongEnough) {
      // 항력 보정은 k 에 대해 2차(속도가 k 배면 항력은 k² 배)라 그대로 반복하면 발산한다.
      // 실제로 60fps 1080p 정상 클립에서 expected 가 2.9e7 까지 튀어 측정 9.59 m/s²(거의 중력)를
      // "물리적 범위 밖"으로 버렸다. → 물리적으로 가능한 범위로 자르고, 감쇠를 걸어 수렴시킨다.
      const EXPECTED_LO = G * 0.55; // 빠르게 상승하는 공: 항력이 아래로 더해져도 이 아래로는 안 간다
      const EXPECTED_HI = G * 1.75;
      let clamped = false;
      for (let iter = 0; iter < 12; iter++) {
        // k 를 적용한 궤적에서 속도를 구해 항력의 연직 성분을 추정한다
        let accVy = 0;
        let cnt = 0;
        for (let i = 1; i < P.length; i++) {
          const dt = Math.max(T[i] - T[i - 1], 1e-6);
          const vx = (k * (P[i].X - P[i - 1].X)) / dt;
          const vy = (k * (P[i].Y - P[i - 1].Y)) / dt;
          const vz = (k * (P[i].Z - P[i - 1].Z)) / dt;
          const sp = Math.hypot(vx, vy, vz);
          accVy += -input.dragCoefficient * sp * vy; // 항력의 연직(아래+) 성분
          cnt++;
        }
        const expectedRaw = G + (cnt ? accVy / cnt : 0);
        // 항력 추정이 물리적 범위를 벗어나면(깊이 복원이 어긋나 속도가 폭주한 경우) 항력 보정을
        // 포기하고 순수 중력으로 검산한다. 한계값으로 자르면 그 잘린 값이 그대로 배율이 되어
        // 더 나쁜 보정을 만든다.
        if (!Number.isFinite(expectedRaw) || expectedRaw < EXPECTED_LO || expectedRaw > EXPECTED_HI) {
          expected = G;
          clamped = true;
          k = expected / aMeasured;
          break;
        }
        expected = expectedRaw;
        const kTarget = expected / aMeasured;
        if (!Number.isFinite(kTarget) || kTarget <= 0) break;
        const kNew = 0.5 * (k + kTarget); // 감쇠 — 2차 반복의 발산을 막는다
        if (Math.abs(kNew - k) < 1e-4) { k = kNew; break; }
        k = kNew;
      }
      const applied = k > 0.3 && k < 3.5;
      scale = applied ? k : 1;
      gravityCheck = {
        measuredVerticalAccel: round(aMeasured, 3),
        expectedVerticalAccel: round(expected, 3),
        scaleFactor: round(scale, 4),
        fitR2: round(gq.r2, 4),
        curvatureSnr: round(gq.snr, 2),
        applied,
        note: applied
          ? (Math.abs(scale - 1) < 0.08
            ? '연직 가속도가 중력과 일치합니다. 픽셀↔미터 환산이 맞습니다.'
            : `연직 가속도가 ${aMeasured.toFixed(2)} m/s² 로 나와 (정상은 9.81), 픽셀↔미터 환산을 ×${scale.toFixed(2)} 로 바로잡았습니다.`)
          : '연직 가속도가 물리적 범위를 벗어나 보정을 적용하지 않았습니다.'
            + (clamped ? ' (항력 추정이 불안정해 순수 중력으로 검산했습니다)' : ''),
      };
      if (!applied) warnings.push('중력 검산 결과가 물리적 범위를 벗어납니다. 촬영 각도나 공 검출을 확인하세요.');
      else if (scale > 1.15) {
        // 반지름이 크게 측정되면 px/m 이 커지고 미터가 작아져서 속도가 낮게 나온다.
        warnings.push(`공이 실제보다 크게 측정돼 속도가 낮게 나오고 있었습니다 (모션블러가 흔한 원인). ×${scale.toFixed(2)} 로 올려 보정했습니다.`);
      } else if (scale < 0.87) {
        warnings.push(`공이 실제보다 작게 측정돼 속도가 높게 나오고 있었습니다. ×${scale.toFixed(2)} 로 낮춰 보정했습니다.`);
      }
    } else {
      gravityCheck = {
        measuredVerticalAccel: round(aMeasured, 3),
        expectedVerticalAccel: G,
        scaleFactor: 1,
        fitR2: round(gq.r2, 4),
        curvatureSnr: round(gq.snr, 2),
        applied: false,
        note: gq.r2 <= 0.85
          ? '연직 궤적이 포물선에 맞지 않아 검산을 신뢰할 수 없습니다 (추적 오류 가능).'
          : `공이 화면에 잡힌 구간이 ${span.toFixed(2)}초로 짧아 중력을 충분히 관측하지 못했습니다.`,
      };
      warnings.push('중력 검산을 적용하지 못해 픽셀↔미터 환산을 검증할 수 없습니다. 이 속도는 크게 틀릴 수 있습니다.');
      if (gq.r2 <= 0.85) warnings.push('연직 궤적이 포물선이 아닙니다 — 공이 아닌 물체를 따라갔거나 카메라가 크게 움직였을 수 있습니다.');
    }
  }

  if (scale !== 1) P = P.map((p) => ({ X: p.X * scale, Y: p.Y * scale, Z: p.Z * scale }));

  // ---- 속도/거리 ----
  const V: Array<{ x: number; y: number; z: number; s: number }> = [];
  for (let i = 0; i < P.length; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(P.length - 1, i + 1);
    const dt = Math.max(T[b] - T[a], 1e-6);
    const vx = (P[b].X - P[a].X) / dt;
    const vy = (P[b].Y - P[a].Y) / dt;
    const vz = (P[b].Z - P[a].Z) / dt;
    V.push({ x: vx, y: vy, z: vz, s: Math.hypot(vx, vy, vz) });
  }
  const head = Math.min(5, V.length);
  const v0 = {
    x: median(V.slice(0, head).map((v) => v.x)),
    y: median(V.slice(0, head).map((v) => v.y)),
    z: median(V.slice(0, head).map((v) => v.z)),
  };
  const speed0 = Math.hypot(v0.x, v0.y, v0.z);
  const horiz = Math.hypot(v0.x, v0.z);

  let path = 0;
  for (let i = 1; i < P.length; i++) {
    path += Math.hypot(P[i].X - P[i - 1].X, P[i].Y - P[i - 1].Y, P[i].Z - P[i - 1].Z);
  }

  base.speedKmh = round(speed0 * KMH, 2);
  base.speedRawKmh = speedRaw === null ? null : round(speedRaw, 2);
  base.peakSpeedKmh = round(Math.max(...V.map((v) => v.s)) * KMH, 2);
  base.launchAngleDeg = round((Math.atan2(-v0.y, horiz) * 180) / Math.PI, 2);
  base.flightTimeS = round(T[T.length - 1] - T[0], 3);
  base.pathDistanceM = round(path, 3);
  base.straightDistanceM = round(
    Math.hypot(P[P.length - 1].X - P[0].X, P[P.length - 1].Y - P[0].Y, P[P.length - 1].Z - P[0].Z), 3);
  base.ballDiameterPxAtImpact = round(2 * R0[0], 2);
  base.pxPerMeterAtImpact = round(pxPerM0, 2);
  base.gravityCheck = gravityCheck;

  base.trajectory = P.map((p, i) => ({
    t: round(t[i0 + i], 4),
    x: round(X0[i], 1), y: round(Y0[i], 1), r: round(R0[i], 2),
    observed: series.observed[i0 + i],
    X: round(p.X, 3), Y: round(p.Y, 3), Z: round(p.Z, 3),
    speedKmh: round(V[i].s * KMH, 2),
  }));

  // 공이 카메라 쪽/반대쪽으로 크게 움직였는지 — 2D 계산이 과소평가되는 상황
  const rFirst = R0[0];
  const rLast = R0[R0.length - 1];
  const depthChange = Math.abs(rFirst - rLast) / Math.max(rFirst, 1e-6);
  // 깊이 속도가 전체 속도의 절반을 넘으면, 값의 대부분이 '공 반지름이 줄어드는 속도'에서 나온 것이다.
  // 반지름은 모션블러에 가장 취약한 값이라 이 구도는 검증할 수 없다.
  const spanSec = Math.max(t[i0 + P.length - 1] - t[i0], 1e-6);
  const depthSpeed = Math.abs(P[P.length - 1].Z - P[0].Z) / spanSec;
  const depthShare = (base.speedKmh ?? 0) > 0.4 ? depthSpeed / ((base.speedKmh as number) / 3.6) : 0;
  const depthUnreliable = depthChange > 0.35 || depthShare > 0.5;
  if (depthChange > 0.25) {
    warnings.push('공이 카메라에서 멀어지거나 가까워지는 성분이 큽니다. 화면 2D 이동량만 쓰면 크게 과소평가되는 구도입니다.');
  }
  if ((input.cameraMotionPx ?? 0) > input.videoWidth * 0.35) {
    warnings.push('촬영 중 카메라가 많이 움직였습니다. 고정하고 찍으면 정확도가 올라갑니다.');
  }
  if (input.droppedHint) {
    warnings.push('재생 중 프레임이 누락됐습니다. 시간축은 실제 프레임 시각을 쓰므로 속도가 틀어지지는 않지만, 표본이 줄어 신뢰도가 떨어집니다.');
  }
  if (base.speedKmh !== null && (base.speedKmh < 8 || base.speedKmh > 210)) {
    warnings.push(`속도 ${base.speedKmh} km/h 는 물리적으로 이상합니다. 결과를 신뢰하지 마세요.`);
  }

  const parts: Record<string, number> = {
    detection: clamp01(base.observedFrames / Math.max(input.totalFrames * 0.25, 1)),
    trackLength: clamp01(P.length / 15),
    gravityFit: gravityCheck ? clamp01(gravityCheck.fitR2) : 0.3,
    gravitySnr: gravityCheck ? clamp01((gravityCheck.curvatureSnr ?? 0) / 8) : 0.2,
    // 중력 검산이 적용되지 못했다면 스케일을 검증할 방법이 없다. 이때 값을 그대로
    // 내보내면 122% 씩 틀린 숫자가 아무 경고 없이 리더보드에 올라간다. 그래서 크게 깎는다.
    scaleAgreement: gravityCheck?.applied
      ? clamp01(1 - Math.abs(Math.log(Math.max(gravityCheck.scaleFactor, 1e-6))) * 0.8)
      : 0.12,
    depthFit: fit ? clamp01(1 - fit.relResid * 4) : 0.3,
    plausibility: base.speedKmh !== null && base.speedKmh >= 8 && base.speedKmh <= 210 ? 1 : 0,
    // 브라우저는 재생 중 프레임을 버린다. 표본이 절반으로 줄면 중력 검산도 그만큼 약해지므로
    // 신뢰도에 그대로 반영해야 한다 — 그래야 사용자가 터미널판을 쓸 이유를 안다.
    sampling: input.decodedFrames && input.decodedFrames > 0
      ? clamp01(0.35 + 0.65 * (input.totalFrames / input.decodedFrames))
      : 1,
  };
  base.confidenceParts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 3)]));
  base.confidence = round(
    Math.pow(parts.detection, 0.4) * Math.pow(parts.trackLength, 0.3) *
    Math.pow(parts.gravityFit, 0.5) * Math.pow(parts.gravitySnr, 0.35) *
    Math.pow(parts.scaleAgreement, 0.4) *
    Math.pow(parts.depthFit, 0.3) * parts.plausibility, 3);
  // ── 이 영상이 애초에 잴 수 있는 영상인가 ──
  // 실제 클립을 돌려보니 400x224 짜리가 섞여 있었다. 그런 영상에서 공은 3px 이고,
  // 3px 짜리 원의 지름을 1px 틀리게 재면 거리가 33% 틀어진다. 원리적으로 불가능하다.
  // 그럴 때는 '다시 찍어보세요' 같은 두루뭉술한 안내 대신 이유를 정확히 말해야 한다.
  const ballPx = base.ballDiameterPxAtImpact;
  const rFirst0 = R0[0];
  const rLast0 = R0[R0.length - 1];
  const depthChg = Math.abs(rFirst0 - rLast0) / Math.max(rFirst0, 1e-6);
  const geometry: 'side' | 'away' | 'unknown' =
    depthChg > 0.3 && Math.abs(base.launchAngleDeg ?? 0) < 8 ? 'away'
      : depthChg < 0.25 ? 'side' : 'unknown';
  const reasons: string[] = [];
  if (ballPx !== null && ballPx < 4) {
    reasons.push(`공이 ${ballPx.toFixed(1)}px 로만 보입니다 — 이 크기로는 어떤 방법으로도 속도를 잴 수 없습니다`);
  }
  if (input.videoWidth < 720) {
    reasons.push(`영상 가로가 ${input.videoWidth}px 입니다 (720px 이상 권장)`);
  }
  if (geometry === 'away') {
    reasons.push('공이 카메라에서 멀어지는 구도(후방/정면)입니다 — 화면에서 포물선이 거의 안 그려져 중력 검산이 어렵습니다');
  }
  if ((input.fpsMeasured ?? 60) < 50) {
    reasons.push(`${Math.round(input.fpsMeasured ?? 0)}fps 입니다 (60fps 이상 권장)`);
  }
  if (depthUnreliable && geometry !== 'away') {
    reasons.push('공이 카메라 쪽/반대쪽으로 날아갑니다 — 공의 진행 방향과 직각(옆)에서 찍어야 잴 수 있습니다');
  }
  base.quality = {
    videoWidth: input.videoWidth,
    fps: input.fpsMeasured,
    ballPx,
    geometry,
    usable: !(ballPx !== null && ballPx < 4) && input.videoWidth >= 640,
    verdict: reasons.length
      ? reasons.join(' · ')
      : '촬영 조건은 측정에 적합합니다.',
  };

  // 깊이(카메라 쪽/반대쪽) 성분이 크면 속도가 공 반지름 변화에 좌우된다. 반지름은 모션블러에
  // 가장 취약한 값이라, 중력 검산(화면 세로축)은 통과해도 속도는 몇 배 틀어질 수 있다.
  // 실제로 IMG_0021/0022 가 이 경로로 화면 2D 83~93 km/h 를 172~200 km/h 로 부풀렸다.
  if (depthUnreliable) {
    warnings.push(
      `공이 카메라 쪽/반대쪽으로 크게 움직입니다 (속도의 ${Math.round(depthShare * 100)}%가 그 성분). ` +
      '이 성분은 공 크기 변화로만 추정해 모션블러에 크게 흔들리므로 검증할 수 없습니다. 옆에서(공의 진행 방향과 직각) 찍어주세요.',
    );
  }
  // 세계 최고 기록이 211 km/h 다. 그 위의 값은 측정이 틀린 것이지 기록이 아니다.
  const speedImplausible = base.speedKmh !== null && (base.speedKmh > 210 || base.speedKmh < 8);
  base.verified =
    Boolean(gravityCheck?.applied) && base.confidence >= 0.35 && !depthUnreliable && !speedImplausible;
  if (!base.verified && input.requireGravityCheck) {
    // 검증 못 한 값을 숫자로 내보내면 그게 곧 기록이 된다. 차라리 못 쟀다고 하는 게 낫다.
    base.speedKmh = null;
    base.peakSpeedKmh = null;
    // 거리도 같은 스케일에서 나온 값이라 함께 보류한다. 각도는 방향이라 스케일과 무관하다.
    base.pathDistanceM = null;
    base.straightDistanceM = null;
    // 왜 못 쟀는지를 촬영 조건으로 먼저 설명한다. 조건이 문제면 다시 찍는 게 유일한 답이고,
    // 조건이 멀쩡한데 실패한 거라면 그건 우리 쪽 문제다 — 둘을 섞어서 말하면 안 된다.
    warnings.push(base.quality && !base.quality.usable
      ? `이 영상으로는 측정이 불가능합니다: ${base.quality.verdict}`
      : base.quality && base.quality.geometry === 'away'
        ? `스케일을 검증하지 못했습니다: ${base.quality.verdict}`
        : '스케일을 검증하지 못했습니다. 카메라를 고정하고 측면에서, 공이 화면 안에서 더 오래 보이도록 다시 찍어주세요.');
  }
  base.ok = base.speedKmh !== null;
  return base;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
function round(v: number, d: number): number {
  if (!Number.isFinite(v)) return NaN;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}
