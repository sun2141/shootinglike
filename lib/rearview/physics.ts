/**
 * 3D 궤적 맞춤: 중력 + 공기저항 + 회전(마그누스). 화면 궤적과의 재투영 오차를 최소화.
 * scripts/refauto/physics.py 와 같은 모델 (검증은 그쪽 결과와 비교).
 */
import type { Cam, Vec3 } from './camera';
import { leastSquares } from './lm';

const G = 9.81;
const DT = 0.005;

export interface Obs {
  t: number;
  u: number;
  v: number;
}

export interface Sim {
  /** 0, DT, 2DT … 시각의 위치 */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  n: number;
}

export function simulate(P0: Vec3, v0: Vec3, k: number, s: Vec3, T: number): Sim {
  const n = Math.max(2, Math.ceil(T / DT) + 2);
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const Z = new Float64Array(n);
  let px = P0[0], py = P0[1], pz = P0[2];
  let vx = v0[0], vy = v0[1], vz = v0[2];
  const [sx, sy, sz] = s;
  const h = 0.5 * DT;
  X[0] = px; Y[0] = py; Z[0] = pz;
  for (let i = 1; i < n; i++) {
    let sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let ax = -k * sp * vx + (sy * vz - sz * vy);
    let ay = -k * sp * vy + (sz * vx - sx * vz);
    let az = -G - k * sp * vz + (sx * vy - sy * vx);
    const mx = vx + h * ax, my = vy + h * ay, mz = vz + h * az;
    sp = Math.sqrt(mx * mx + my * my + mz * mz);
    ax = -k * sp * mx + (sy * mz - sz * my);
    ay = -k * sp * my + (sz * mx - sx * mz);
    az = -G - k * sp * mz + (sx * my - sy * mx);
    px += DT * mx; py += DT * my; pz += DT * mz;
    vx += DT * ax; vy += DT * ay; vz += DT * az;
    X[i] = px; Y[i] = py; Z[i] = pz;
  }
  return { x: X, y: Y, z: Z, n };
}

function at(sim: Sim, t: number): Vec3 {
  const f = Math.max(0, t / DT);
  const i = Math.min(sim.n - 2, Math.floor(f));
  const a = Math.min(1, f - i);
  return [
    sim.x[i] + a * (sim.x[i + 1] - sim.x[i]),
    sim.y[i] + a * (sim.y[i + 1] - sim.y[i]),
    sim.z[i] + a * (sim.z[i + 1] - sim.z[i]),
  ];
}

export interface FitResult {
  speedKmh: number;
  elevDeg: number;
  /** 킥 순간 (영상 시각, 초) */
  tKick: number;
  dragK: number;
  spin: Vec3;
  /** 재투영 오차 rms (px) */
  rmsPx: number;
  P0: Vec3;
  v0: Vec3;
  /** 골라인(y=0)을 지나는 순간: 시각, 가로 위치, 높이 */
  goalCross: { t: number; x: number; z: number } | null;
  nUsed: number;
  tSpan: number;
  dropped: number;
  /** 궤적 (영상 시각, 3D) — 겹쳐 그리기용 */
  path: { t: number; P: Vec3 }[];
  /** 내부: 다음 맞춤의 시작값 */
  params: number[];
  /** 최종 맞춤에 쓴 관측 (튀는 점 뺀 뒤) */
  used: Obs[];
}

function fitOnce(cam: Cam, P0: Vec3, obs: Obs[], warm: number[] | null): { x: number[]; cost: number; fun: number[] } {
  const tFirst = obs[0].t;
  const res = (p: number[]): number[] => {
    const t0 = p[3];
    let tMax = 0;
    for (const o of obs) tMax = Math.max(tMax, o.t - t0);
    const sim = simulate(P0, [p[0], p[1], p[2]], p[4], [p[5], p[6], p[7]], tMax + 0.02);
    const r: number[] = [];
    for (const o of obs) {
      const q = cam.proj(at(sim, o.t - t0));
      r.push(q[0] - o.u, q[1] - o.v);
    }
    return r;
  };
  const d0 = Math.hypot(P0[0], P0[1]) + 1e-9;
  const dx = -P0[0] / d0;
  const dy = -P0[1] / d0;
  const lo = [-70, -70, -70, tFirst - 0.25, 0.005, -1.2, -1.2, -1.2];
  const hi = [70, 70, 70, tFirst - 0.003, 0.02, 1.2, 1.2, 1.2];
  const scale = [5, 5, 5, 0.02, 0.003, 0.2, 0.2, 0.2];
  const starts: number[][] = [];
  if (warm) starts.push([...warm.slice(0, 3), Math.min(warm[3], tFirst - 0.004), ...warm.slice(4)]);
  const speeds = warm ? [26] : [22, 32];
  const elevs = warm ? [20] : [15, 30];
  // warm 이 있어도 기본 시작값 하나는 함께 — 다른 골짜기에 빠진 warm 을 바로잡는다
  for (const sp of speeds) {
    for (const el of elevs) {
      const c = Math.cos((el * Math.PI) / 180);
      const sn = Math.sin((el * Math.PI) / 180);
      starts.push([sp * dx * c, sp * dy * c, sp * sn, tFirst - 0.04, 0.012, 0, 0, 0]);
    }
  }
  let best: { x: number[]; cost: number; fun: number[] } | null = null;
  for (const s0 of starts) {
    const r = leastSquares(res, s0, { lo, hi, scale, loss: 'soft_l1', fScale: 2, maxIter: 80 });
    if (!best || r.cost < best.cost) best = r;
  }
  return best!;
}

function pack(cam: Cam, P0: Vec3, obs: Obs[], r: { x: number[]; fun: number[] }): FitResult {
  const p = r.x;
  const v: Vec3 = [p[0], p[1], p[2]];
  const sp = Math.hypot(...v);
  let ss = 0;
  for (const e of r.fun) ss += e * e;
  const rms = Math.sqrt(ss / Math.max(1, obs.length));
  const sim = simulate(P0, v, p[4], [p[5], p[6], p[7]], 3.0);
  let cross: FitResult['goalCross'] = null;
  for (let i = 0; i < sim.n; i++) {
    if (sim.y[i] >= 0) {
      cross = { t: p[3] + i * DT, x: sim.x[i], z: sim.z[i] };
      break;
    }
  }
  const path: FitResult['path'] = [];
  const stopI = cross ? Math.min(sim.n, Math.round((cross.t - p[3]) / DT) + 1) : sim.n;
  for (let i = 0; i < stopI; i += 5) path.push({ t: p[3] + i * DT, P: [sim.x[i], sim.y[i], sim.z[i]] });
  void cam;
  return {
    speedKmh: sp * 3.6,
    elevDeg: (Math.asin(p[2] / sp) * 180) / Math.PI,
    tKick: p[3],
    dragK: p[4],
    spin: [p[5], p[6], p[7]],
    rmsPx: rms,
    P0,
    v0: v,
    goalCross: cross,
    nUsed: obs.length,
    tSpan: obs[obs.length - 1].t - obs[0].t,
    dropped: 0,
    path,
    params: p,
    used: obs,
  };
}

/** 맞춘 궤적과 각 관측점 사이 거리(px) */
export function residualsPx(cam: Cam, fit: FitResult, obs: Obs[]): number[] {
  const p = fit.params;
  let tMax = 0;
  for (const o of obs) tMax = Math.max(tMax, o.t - p[3]);
  const sim = simulate(fit.P0, fit.v0, p[4], [p[5], p[6], p[7]], Math.max(0.05, tMax + 0.02));
  return obs.map((o) => {
    const q = cam.proj(at(sim, o.t - p[3]));
    return Math.hypot(q[0] - o.u, q[1] - o.v);
  });
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * 바운드·골망·펜스에 닿기 전 '자유 비행' 구간만 쓴다.
 * 앞쪽 0.4초로 시작해 step 점씩 늘리며 다시 맞추고, 새로 넣은 점들이 궤적에서 벗어나면 멈춘다.
 * tolPx 는 1920 기준 3px 를 해상도에 맞춰 넘긴다.
 */
export function fitFlight(cam: Cam, P0: Vec3, obsAll: Obs[], opts: { tolPx?: number; maxT?: number; step?: number; warm?: number[] | null } = {}): FitResult {
  const tol = opts.tolPx ?? 3;
  const maxT = opts.maxT ?? 2.5;
  const step = opts.step ?? 8;
  const obs = obsAll.filter((o) => o.t - obsAll[0].t <= maxT);
  const t0 = obs[0].t;
  let n = Math.min(obs.length, Math.max(10, obs.filter((o) => o.t - t0 <= 0.4).length));
  let raw = fitOnce(cam, P0, obs.slice(0, n), opts.warm ?? null);
  let fit = pack(cam, P0, obs.slice(0, n), raw);
  while (n < obs.length) {
    const m = Math.min(obs.length, n + step);
    const trialRaw = fitOnce(cam, P0, obs.slice(0, m), fit.params);
    const trial = pack(cam, P0, obs.slice(0, m), trialRaw);
    const r = residualsPx(cam, trial, obs.slice(0, m));
    const lim = Math.max(tol, 3 * median(r.slice(0, n)));
    const firstBad = r.slice(n, m).findIndex((e) => e > lim);
    if (firstBad >= 0) {
      if (firstBad > 0) {
        const n2 = n + firstBad;
        raw = fitOnce(cam, P0, obs.slice(0, n2), trial.params);
        fit = pack(cam, P0, obs.slice(0, n2), raw);
        n = n2;
      }
      break;
    }
    fit = trial;
    n = m;
  }
  // 튀는 점(다리·그림자를 잡은 프레임) 빼고 한 번 더
  const used = obs.slice(0, n);
  const r = residualsPx(cam, fit, used);
  const lim = Math.max(tol * 5 / 3, 4 * median(r));
  const keep = used.filter((_, i) => r[i] <= lim);
  if (keep.length < n && keep.length >= 10) {
    raw = fitOnce(cam, P0, keep, fit.params);
    fit = pack(cam, P0, keep, raw);
    fit.dropped = n - keep.length;
  }
  // 마지막으로 여러 시작값에서 다시 맞춰 가장 낮은 비용을 고른다.
  // 구간을 늘려 가며 이어 맞추면 처음 빠진 골짜기(회전·항력이 엉뚱한 해)에 머물 수 있다 — 점 좌표가
  // 1px 반올림만 달라져도 속도가 10% 넘게 달라지는 경우가 있었다.
  {
    const set = fit.used;
    const a = fitOnce(cam, P0, set, fit.params);
    const b = fitOnce(cam, P0, set, null);
    const best = b.cost < a.cost ? b : a;
    const dropped = fit.dropped;
    fit = pack(cam, P0, set, best);
    fit.dropped = dropped;
  }
  fit.nUsed = n;
  fit.tSpan = obs[n - 1].t - obs[0].t;
  return fit;
}

/**
 * 같은 관측을 다른 카메라(초점거리 범위 끝)로 다시 맞춘 속도.
 * 본 맞춤이 고른 관측(fit.used)을 그대로 쓰고, 시작값은 본 맞춤 결과 + 기본값 몇 개.
 */
export function refitSpeed(cam: Cam, P0: Vec3, used: Obs[], warm: number[]): number {
  const a = fitOnce(cam, P0, used, warm);
  const b = fitOnce(cam, P0, used, null);
  const r = b.cost < a.cost ? b : a;
  return Math.hypot(r.x[0], r.x[1], r.x[2]) * 3.6;
}
