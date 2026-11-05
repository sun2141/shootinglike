/**
 * 카메라 보정 — 사용자가 찍은 골대 네 모서리 + 멈춘 공 크기 + (선택) 사람 키로
 * 초점거리와 카메라 자세를 구한다.
 *
 * 골대 4점만으로도 자세와 초점거리가 이론상 정해지지만, 뒤 대각선 구도에선 초점거리가 흐릿하다.
 * 그래서 폰 메인 카메라의 화각(초점거리 ≈ 0.74 × 영상 긴 변, 35mm 환산 26mm 안팎)을 약한 사전값으로 넣고,
 * 초점거리를 훑어 비용 곡선에서 '그럴듯한 범위'를 함께 돌려준다 → 속도 범위로 이어진다.
 */
import { Cam, GOALS, goalObject, poseFromGoal, type GoalKind, type Vec3 } from './camera';
import { leastSquares } from './lm';

export interface HeightObs {
  /** 발(땅 닿는 곳) 화면 좌표 */
  foot: [number, number];
  /** 머리 꼭대기 화면 좌표 */
  head: [number, number];
  heightM: number;
  name: string;
}

export interface CalibInput {
  width: number;
  height: number;
  /** 왼쪽 아래, 오른쪽 아래, 오른쪽 위, 왼쪽 위 */
  goal: [number, number][];
  goalKind: GoalKind;
  /** 멈춘 공: 중심과 지름(px) */
  ball: { u: number; v: number; d: number } | null;
  ballM: number;
  heights: HeightObs[];
  /** 초점거리 사전값 (영상 긴 변 대비). 기본 0.74 (lib/ballspeed 와 같은 값), 표준편차 0.08 */
  focalPrior?: { ratio: number; sigma: number } | null;
}

export interface CalibResult {
  cam: Cam;
  /** 1σ 범위의 초점거리 (사전값 포함 비용 곡선 기준) */
  fRange: [number, number];
  /** 범위 양 끝에서 다시 맞춘 카메라 — 속도 범위 계산용 */
  camLo: Cam;
  camHi: Cam;
  diag: {
    f: number;
    fRatio: number;
    goalPx: number[];
    heights: { name: string; ratio: number; distM: number }[];
    ballRatio: number | null;
    /** 멈춘 공 3D 위치 */
    ballPos: Vec3 | null;
    camPos: Vec3;
    cost: number;
  };
}

function residualFactory(inp: CalibInput) {
  const obj = goalObject(inp.goalKind);
  const L = Math.max(inp.width, inp.height);
  const s = L / 1920;
  const goalSig = Math.max(2, 4 * s);
  const hSig = Math.max(2, 3 * s);
  const prior = inp.focalPrior === undefined ? { ratio: 0.74, sigma: 0.08 } : inp.focalPrior;
  return (cam: Cam): number[] => {
    const r: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = cam.proj(obj[i]);
      r.push((p[0] - inp.goal[i][0]) / goalSig, (p[1] - inp.goal[i][1]) / goalSig);
    }
    for (const h of inp.heights) {
      const P = cam.ground(h.foot[0], h.foot[1]);
      const top = cam.proj([P[0], P[1], h.heightM]);
      r.push((top[1] - h.head[1]) / hSig);
    }
    if (inp.ball) {
      const pred = predictedBallPx(cam, inp.ball.u, inp.ball.v, inp.ballM);
      // 공 가장자리는 음영 때문에 작게 잡히는 경향이 있어 10% 여유
      r.push((pred - inp.ball.d) / Math.max(3 * s, 0.1 * inp.ball.d));
    }
    if (prior) r.push((cam.f / L - prior.ratio) / prior.sigma);
    const C = cam.C;
    // 카메라는 경기장 쪽(y<0), 땅 위(z>0.2)에 있어야 한다
    r.push(C[1] > -1 ? (C[1] + 1) * 50 : 0);
    r.push(C[2] < 0.2 ? (0.2 - C[2]) * 50 : 0);
    return r;
  };
}

export function predictedBallPx(cam: Cam, u: number, v: number, ballM: number): number {
  const P = cam.ground(u, v, ballM / 2);
  const C = cam.C;
  const dist = Math.hypot(P[0] - C[0], P[1] - C[1], P[2] - C[2]);
  return (cam.f * ballM) / dist;
}

function fitPoseAtF(inp: CalibInput, res: (c: Cam) => number[], f: number, init: number[] | null) {
  const { width: W, height: H } = inp;
  const starts: number[][] = [];
  const p = poseFromGoal(inp.goal, inp.goalKind, f, W, H);
  if (p) starts.push(p);
  if (init) starts.push(init);
  let best: { x: number[]; cost: number } | null = null;
  for (const s0 of starts) {
    const r = leastSquares((q) => res(Cam.fromParams([f, ...q], W, H)), s0, {
      scale: [0.05, 0.05, 0.05, 1, 1, 1],
      loss: 'soft_l1',
      fScale: 3,
      maxIter: 60,
    });
    if (!best || r.cost < best.cost) best = { x: r.x, cost: r.cost };
  }
  return best;
}

export function calibrate(inp: CalibInput): CalibResult | null {
  const { width: W, height: H } = inp;
  const L = Math.max(W, H);
  const res = residualFactory(inp);

  // 1) 초점거리 훑기 (0.45L ~ 1.6L)
  const grid: number[] = [];
  for (let k = 0; k <= 26; k++) grid.push(L * 0.45 * Math.pow(1.6 / 0.45, k / 26));
  const prof: { f: number; cost: number; x: number[] }[] = [];
  let prev: number[] | null = null;
  for (const f of grid) {
    const b = fitPoseAtF(inp, res, f, prev);
    if (!b) continue;
    prof.push({ f, cost: b.cost, x: b.x });
    prev = b.x;
  }
  if (!prof.length) return null;
  let bi = 0;
  for (let i = 1; i < prof.length; i++) if (prof[i].cost < prof[bi].cost) bi = i;

  // 2) f 까지 풀어 마무리
  const full = leastSquares((q) => res(Cam.fromParams(q, W, H)), [prof[bi].f, ...prof[bi].x], {
    lo: [0.3 * L, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity],
    hi: [3 * L, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity],
    scale: [0.02 * L, 0.05, 0.05, 0.05, 1, 1, 1],
    loss: 'soft_l1',
    fScale: 3,
    maxIter: 100,
  });
  const cam = Cam.fromParams(full.x, W, H);
  const C = cam.C;
  if (!(C[1] < 0) || !(C[2] > 0.1)) return null;

  // 3) 1σ 범위: 비용이 최소 + 0.5 가 되는 f (훑기 곡선을 다시 맞춘 자세로 정밀화)
  const c0 = full.cost;
  const at = (f: number) => fitPoseAtF(inp, res, f, full.x.slice(1));
  const edge = (dir: 1 | -1): { f: number; x: number[] } => {
    let lo = full.x[0];
    let loX = full.x.slice(1);
    const step = 0.03;
    // 밖으로 나가며 문턱을 넘는 곳을 찾고, 이분법으로 좁힌다
    for (let k = 0; k < 20; k++) {
      const f = lo * (1 + dir * step);
      const b = at(f);
      if (!b) break;
      if (b.cost - c0 > 0.5) {
        let a = lo;
        let bnd = f;
        let bestX = loX;
        for (let j = 0; j < 6; j++) {
          const m = 0.5 * (a + bnd);
          const bm = at(m);
          if (!bm) break;
          if (bm.cost - c0 > 0.5) bnd = m;
          else {
            a = m;
            bestX = bm.x;
          }
        }
        return { f: a, x: bestX };
      }
      lo = f;
      loX = b.x;
      if (Math.abs(lo / full.x[0] - 1) > 0.5) break;
    }
    return { f: lo, x: loX };
  };
  const eLo = edge(-1);
  const eHi = edge(1);
  const camLo = Cam.fromParams([eLo.f, ...eLo.x], W, H);
  const camHi = Cam.fromParams([eHi.f, ...eHi.x], W, H);

  // 진단
  const obj = goalObject(inp.goalKind);
  const goalPx = obj.map((P, i) => {
    const p = cam.proj(P);
    return Math.round(Math.hypot(p[0] - inp.goal[i][0], p[1] - inp.goal[i][1]) * 10) / 10;
  });
  const heights = inp.heights.map((h) => {
    const P = cam.ground(h.foot[0], h.foot[1]);
    const top = cam.proj([P[0], P[1], h.heightM]);
    const pred = h.foot[1] - top[1];
    const meas = h.foot[1] - h.head[1];
    return {
      name: h.name,
      ratio: Math.round((meas / pred) * 1000) / 1000,
      distM: Math.round(Math.hypot(P[0] - C[0], P[1] - C[1], P[2] - C[2]) * 10) / 10,
    };
  });
  let ballRatio: number | null = null;
  let ballPos: Vec3 | null = null;
  if (inp.ball) {
    ballRatio = Math.round((inp.ball.d / predictedBallPx(cam, inp.ball.u, inp.ball.v, inp.ballM)) * 1000) / 1000;
    ballPos = cam.ground(inp.ball.u, inp.ball.v, inp.ballM / 2);
  }
  return {
    cam,
    fRange: [eLo.f, eHi.f],
    camLo,
    camHi,
    diag: { f: cam.f, fRatio: cam.f / L, goalPx, heights, ballRatio, ballPos, camPos: C, cost: c0 },
  };
}

export { GOALS };
