/**
 * 작은 비선형 최소제곱 (Levenberg–Marquardt). 매개변수 수십 개 이하, 잔차 수백 개 규모용.
 * scipy.optimize.least_squares 의 쓰임새(경계, soft_l1 손실, x_scale)를 필요한 만큼만 흉내 낸다.
 */

export interface LsqOptions {
  lo?: number[];
  hi?: number[];
  /** 매개변수 크기 감각 — 수치 미분 간격과 감쇠 스케일에 쓴다 */
  scale?: number[];
  loss?: 'linear' | 'soft_l1';
  /** soft_l1 에서 이 값보다 큰 잔차는 선형으로만 벌점 */
  fScale?: number;
  maxIter?: number;
}

export interface LsqResult {
  x: number[];
  /** 0.5 * Σρ(r²) — scipy 와 같은 정의 */
  cost: number;
  fun: number[];
  iterations: number;
}

function clamp(x: number[], lo?: number[], hi?: number[]): number[] {
  if (!lo && !hi) return x;
  return x.map((v, i) => {
    let o = v;
    if (lo && Number.isFinite(lo[i]) && o < lo[i]) o = lo[i];
    if (hi && Number.isFinite(hi[i]) && o > hi[i]) o = hi[i];
    return o;
  });
}

function robustCost(r: number[], loss: 'linear' | 'soft_l1', fs: number): number {
  let c = 0;
  if (loss === 'linear') {
    for (const v of r) c += v * v;
    return 0.5 * c;
  }
  const f2 = fs * fs;
  for (const v of r) {
    const z = (v * v) / f2;
    c += 2 * (Math.sqrt(1 + z) - 1);
  }
  return 0.5 * f2 * c;
}

/** 대칭 양의 정부호에 가까운 n×n 계를 부분 피벗 가우스 소거로 푼다 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function leastSquares(fun: (p: number[]) => number[], p0: number[], opts: LsqOptions = {}): LsqResult {
  const n = p0.length;
  const loss = opts.loss ?? 'linear';
  const fs = opts.fScale ?? 1;
  const scale = opts.scale ?? p0.map((v) => Math.max(1e-3, Math.abs(v)));
  const maxIter = opts.maxIter ?? 100;
  let x = clamp([...p0], opts.lo, opts.hi);
  let r = fun(x);
  let cost = robustCost(r, loss, fs);
  let lambda = 1e-3;
  let it = 0;

  for (; it < maxIter; it++) {
    // 가중치 (IRLS) — soft_l1: ρ'(z) = 1/√(1+z)
    const m = r.length;
    const w = new Array(m);
    for (let i = 0; i < m; i++) {
      w[i] = loss === 'linear' ? 1 : 1 / Math.sqrt(Math.sqrt(1 + (r[i] * r[i]) / (fs * fs)));
    }
    // 수치 야코비안 (전방 차분), 열 단위
    const J: number[][] = [];
    for (let j = 0; j < n; j++) {
      let h = 1e-4 * scale[j];
      let xp = [...x];
      xp[j] += h;
      if (opts.hi && Number.isFinite(opts.hi[j]) && xp[j] > opts.hi[j]) {
        h = -h;
        xp = [...x];
        xp[j] += h;
      }
      const rp = fun(xp);
      const col = new Array(m);
      for (let i = 0; i < m; i++) col[i] = ((rp[i] - r[i]) / h) * w[i];
      J.push(col);
    }
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      const ca = J[a];
      for (let b = a; b < n; b++) {
        const cb = J[b];
        let s = 0;
        for (let i = 0; i < m; i++) s += ca[i] * cb[i];
        A[a][b] = s;
        A[b][a] = s;
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += ca[i] * r[i] * w[i];
      g[a] = s;
    }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.map((row, i) => row.map((v, k) => (i === k ? v + lambda * Math.max(v, 1e-9) + 1e-12 : v)));
      const d = solveLinear(Ad, g.map((v) => -v));
      if (!d) {
        lambda *= 10;
        continue;
      }
      const xn = clamp(x.map((v, i) => v + d[i]), opts.lo, opts.hi);
      const rn = fun(xn);
      const cn = robustCost(rn, loss, fs);
      if (Number.isFinite(cn) && cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        const step = Math.max(...d.map((v, i) => Math.abs(v) / scale[i]));
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        if (rel < 1e-9 || step < 1e-7) return { x, cost, fun: r, iterations: it + 1 };
        break;
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  return { x, cost, fun: r, iterations: it };
}
