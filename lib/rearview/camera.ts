/**
 * 핀홀 카메라 + 좌표계.
 * 원점 = 골라인 중앙(땅), x = 골라인 방향, y = 골대 → 경기장 쪽이 음수, z = 위 (단위 m).
 * 화면 좌표는 '처리 해상도' px (영상 원본 가로가 1920 을 넘으면 줄인 크기).
 */

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // 행 우선

export const GOALS = {
  adult: { w: 7.32, h: 2.44, label: '성인 (7.32×2.44 m)' },
  youth: { w: 5.0, h: 2.0, label: '유소년 (5×2 m)' },
  futsal: { w: 3.0, h: 2.0, label: '풋살 (3×2 m)' },
} as const;
export type GoalKind = keyof typeof GOALS;

/** 골대 파이프 지름. 모서리는 파이프 중심을 찍는다고 본다 */
const TUBE = 0.12;

/** 골대 네 모서리 3D: 왼쪽 아래, 오른쪽 아래, 오른쪽 위, 왼쪽 위 (화면에서 본 좌우) */
export function goalObject(kind: GoalKind): Vec3[] {
  const { w: W, h: H } = GOALS[kind];
  const w = W / 2 + TUBE / 2;
  const h = H + TUBE / 2;
  return [
    [-w, 0, 0],
    [w, 0, 0],
    [w, 0, h],
    [-w, 0, h],
  ];
}

export function rodrigues(rv: Vec3): Mat3 {
  const th = Math.hypot(rv[0], rv[1], rv[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = rv[0] / th;
  const ky = rv[1] / th;
  const kz = rv[2] / th;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

/** 회전 행렬 → 회전 벡터 */
export function rotToVec(R: Mat3): Vec3 {
  const tr = R[0] + R[4] + R[8];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180° 근처: 대각 성분으로 축을 구한다
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
    return [x * th, y * th, z * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

export class Cam {
  readonly cx: number;
  readonly cy: number;
  constructor(
    readonly f: number,
    readonly R: Mat3,
    readonly t: Vec3,
    readonly width: number,
    readonly height: number,
  ) {
    this.cx = width / 2;
    this.cy = height / 2;
  }

  static fromParams(p: number[], width: number, height: number): Cam {
    return new Cam(p[0], rodrigues([p[1], p[2], p[3]]), [p[4], p[5], p[6]], width, height);
  }

  /** 카메라 중심 (월드) */
  get C(): Vec3 {
    const R = this.R;
    const t = this.t;
    return [
      -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
      -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
      -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
  }

  /** 월드 점 → 카메라 좌표 깊이 (앞이 +) */
  depth(P: Vec3): number {
    const R = this.R;
    return R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + this.t[2];
  }

  proj(P: Vec3): [number, number] {
    const R = this.R;
    const x = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + this.t[0];
    const y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + this.t[1];
    const z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + this.t[2];
    return [(this.f * x) / z + this.cx, (this.f * y) / z + this.cy];
  }

  /** 화면 점을 지나는 광선 방향 (월드) */
  ray(u: number, v: number): Vec3 {
    const x = (u - this.cx) / this.f;
    const y = (v - this.cy) / this.f;
    const R = this.R;
    return [R[0] * x + R[3] * y + R[6], R[1] * x + R[4] * y + R[7], R[2] * x + R[5] * y + R[8]];
  }

  /** 화면 점 → 높이 z 인 수평면 위의 점 */
  ground(u: number, v: number, z = 0): Vec3 {
    const d = this.ray(u, v);
    const C = this.C;
    const s = (z - C[2]) / d[2];
    return [C[0] + s * d[0], C[1] + s * d[1], C[2] + s * d[2]];
  }
}

// ------------------------------------------------------------ 평면 호모그래피로 초기 자세
/** 4점 이상 (X,Y) → (u,v) 호모그래피 (h33 = 1) */
export function homography(src: [number, number][], dst: [number, number][]): number[] | null {
  const n = src.length;
  // 정규 방정식으로 푼다 (4점이면 정확해)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const [X, Y] = src[i];
    const [u, v] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]);
    b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]);
    b.push(v);
  }
  const AtA = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)));
  const Atb = Array.from({ length: 8 }, (_, i) => A.reduce((s, r, k) => s + r[i] * b[k], 0));
  const h = gauss(AtA, Atb);
  return h ? [...h, 1] : null;
}

function gauss(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
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

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 3×3 를 가장 가까운 회전 행렬로 (극분해 반복) */
function orthonormalize(M: Mat3): Mat3 {
  let R = [...M] as Mat3;
  for (let it = 0; it < 30; it++) {
    const inv = invT(R);
    if (!inv) break;
    const next = R.map((v, i) => 0.5 * (v + inv[i])) as Mat3;
    const diff = next.reduce((s, v, i) => s + Math.abs(v - R[i]), 0);
    R = next;
    if (diff < 1e-12) break;
  }
  return R;
}

/** (M⁻¹)ᵀ */
function invT(M: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  // 여인수 행렬 / det = (M⁻¹)ᵀ
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

/**
 * 골대(세로 평면 y=0) 네 모서리로 초점거리 f 에서의 자세를 구한다.
 * 반환: [rvec(3), t(3)] 또는 null.
 */
export function poseFromGoal(corners: [number, number][], kind: GoalKind, f: number, width: number, height: number): number[] | null {
  const obj = goalObject(kind);
  const H = homography(
    obj.map((P) => [P[0], P[2]] as [number, number]),
    corners,
  );
  if (!H) return null;
  const cx = width / 2;
  const cy = height / 2;
  // K⁻¹ H 의 열
  const col = (j: number): Vec3 => [(H[j] - cx * H[6 + j]) / f, (H[3 + j] - cy * H[6 + j]) / f, H[6 + j]];
  const b1 = col(0);
  const b2 = col(1);
  const b3 = col(2);
  let lam = 2 / (Math.hypot(...b1) + Math.hypot(...b2));
  if (b3[2] * lam < 0) lam = -lam; // 골대가 카메라 앞에 있도록
  const rx: Vec3 = [b1[0] * lam, b1[1] * lam, b1[2] * lam];
  const rz: Vec3 = [b2[0] * lam, b2[1] * lam, b2[2] * lam];
  const ry = cross(rz, rx);
  // 열 = 월드 축의 카메라 좌표 표현
  const M: Mat3 = [rx[0], ry[0], rz[0], rx[1], ry[1], rz[1], rx[2], ry[2], rz[2]];
  const R = orthonormalize(M);
  const t: Vec3 = [b3[0] * lam, b3[1] * lam, b3[2] * lam];
  return [...rotToVec(R), ...t];
}
