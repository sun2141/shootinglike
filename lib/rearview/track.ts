/**
 * 공 찾기·추적 — 순수 함수/클래스 (브라우저·Node 공용).
 *
 * 프레임은 '관심 영역(ROI) 잘라낸 RGBA' 로 들어온다. 모든 프레임의 잘라낸 영역은
 * 기준 장면 좌표에서 같은 자리를 가리키도록(흔들림 보정 반영) 호출하는 쪽이 맞춰 준다.
 * 7장 고리 버퍼만 들고 있어 메모리는 ROI 7장 분량이다.
 */

export interface Crop {
  /** 영상 시각(초) */
  t: number;
  /** RGBA, width*height*4 */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** 이 잘라낸 영역의 (0,0) 이 기준 좌표에서 어디인지 */
  ox: number;
  oy: number;
}

export interface TrackPoint {
  t: number;
  u: number;
  v: number;
  dia: number;
}

// ------------------------------------------------------------ 멈춘 공 원 맞춤
export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray | Float32Array;
  width: number;
  height: number;
}

/** RGBA → 명도 (Float32) */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { data: g, width, height };
}

function bil(img: GrayImage, x: number, y: number): number {
  const { data, width: w, height: h } = img;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const a = x - x0;
  const b = y - y0;
  const i = y0 * w + x0;
  return (data[i] * (1 - a) + data[i + 1] * a) * (1 - b) + (data[i + w] * (1 - a) + data[i + w + 1] * a) * b;
}

function circleLsq(P: [number, number][]): { cx: number; cy: number; r: number } | null {
  // x²+y² = 2ax + 2by + c
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, n = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of P) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; n++;
    sxz += x * z; syz += y * z; sz += z;
  }
  const A = [
    [2 * sxx, 2 * sxy, sx],
    [2 * sxy, 2 * syy, sy],
    [2 * sx, 2 * sy, n],
  ];
  const b = [sxz, syz, sz];
  const det3 = (M: number[][]) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det3(A);
  if (Math.abs(D) < 1e-9) return null;
  const col = (k: number) => A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const a = det3(col(0)) / D;
  const bb = det3(col(1)) / D;
  const c = det3(col(2)) / D;
  const r2 = c + a * a + bb * bb;
  return r2 > 0 ? { cx: a, cy: bb, r: Math.sqrt(r2) } : null;
}

/**
 * 탭한 곳 근처의 밝은 공 가장자리를 방사 방향 밝기 변화로 찾아 원을 맞춘다.
 * 아래쪽(그림자·잔디 접촉)은 뺀다. 반환: 중심과 지름(px), 맞춤 잔차.
 */
export function fitRestBall(img: GrayImage, cx: number, cy: number, rMin: number, rMax: number) {
  let c: [number, number] = [cx, cy];
  let r = 0.5 * (rMin + rMax);
  // outermost: 공 안쪽 무늬(검은 줄)도 경계처럼 보이므로 첫 회에는 '가장 바깥의 뚜렷한 경계'를 쓴다
  const edges = (lo: number, hi: number, outermost = false): [number, number][] => {
    const pts: [number, number][] = [];
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * 2 * Math.PI;
      const deg = (a * 180) / Math.PI;
      if (deg > 40 && deg < 140) continue; // 화면 아래쪽 (그림자·잔디 접촉)
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const prof: [number, number][] = [];
      let best = -Infinity;
      let br = -1;
      for (let rr = Math.max(0.5, lo); rr < hi; rr += 0.25) {
        const g = bil(img, c[0] + dx * (rr - 0.5), c[1] + dy * (rr - 0.5)) - bil(img, c[0] + dx * (rr + 0.5), c[1] + dy * (rr + 0.5));
        if (Number.isNaN(g)) break;
        prof.push([rr, g]);
        if (g > best) {
          best = g;
          br = rr;
        }
      }
      if (outermost && best > 4) {
        const thr = 0.5 * best;
        for (let i = prof.length - 2; i > 0; i--) {
          if (prof[i][1] >= thr && prof[i][1] >= prof[i - 1][1] && prof[i][1] >= prof[i + 1][1]) {
            br = prof[i][0];
            break;
          }
        }
      }
      if (br > 0 && best > 4) pts.push([c[0] + dx * br, c[1] + dy * br]);
    }
    return pts;
  };
  for (let it = 0; it < 3; it++) {
    const P = edges(it === 0 ? rMin : 0.8 * r, it === 0 ? rMax : 1.2 * r, it === 0);
    if (P.length < 12) return null;
    const f1 = circleLsq(P);
    if (!f1) return null;
    const e = P.map(([x, y]) => Math.abs(Math.hypot(x - f1.cx, y - f1.cy) - f1.r));
    const thr = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.7)];
    const f2 = circleLsq(P.filter((_, i) => e[i] <= thr));
    if (!f2) return null;
    c = [f2.cx, f2.cy];
    r = f2.r;
  }
  const P = edges(0.8 * r, 1.2 * r);
  const res = P.map(([x, y]) => Math.abs(Math.hypot(x - c[0], y - c[1]) - r)).sort((a, b) => a - b);
  const med = res.length ? res[Math.floor(res.length / 2)] : 9;
  if (Math.hypot(c[0] - cx, c[1] - cy) > Math.max(6, r * 1.2)) return null;
  return { u: c[0], v: c[1], d: 2 * r, resid: med };
}

// ------------------------------------------------------------ 킥 순간 찾기
/**
 * 멈춘 공 자리의 작은 조각이 기준(탭한 장면)과 얼마나 다른지 시계열로 받아,
 * '끝까지 계속 달라진 구간'의 시작 = 발이 공에 닿기 직전을 돌려준다.
 */
export class KickFinder {
  private series: { t: number; d: number }[] = [];
  constructor(private readonly ref: Float32Array) {}

  static patch(img: GrayImage, cx: number, cy: number, half: number): Float32Array {
    const n = 2 * half + 1;
    const out = new Float32Array(n * n);
    for (let j = -half, k = 0; j <= half; j++) {
      for (let i = -half; i <= half; i++, k++) {
        const x = Math.min(img.width - 1, Math.max(0, Math.round(cx + i)));
        const y = Math.min(img.height - 1, Math.max(0, Math.round(cy + j)));
        out[k] = img.data[y * img.width + x];
      }
    }
    return out;
  }

  push(t: number, patch: Float32Array) {
    let s = 0;
    for (let i = 0; i < patch.length; i++) s += Math.abs(patch[i] - this.ref[i]);
    this.series.push({ t, d: s / patch.length });
  }

  /** 끝에서부터 계속 '달라진' 상태였던 시간(초) */
  goneFor(thr = 14): number {
    const s = this.series;
    let i = s.length - 1;
    while (i >= 0 && s[i].d > thr) i--;
    return i < s.length - 1 ? s[s.length - 1].t - s[i + 1].t : 0;
  }

  /** 반환: 변화 시작 시각 (없으면 null) */
  result(thr = 14): number | null {
    const s = this.series;
    if (s.length < 5) return null;
    // 끝에서부터 거슬러 올라가며 '달라진' 상태가 이어지는 구간을 찾는다 (짧은 되돌림 3프레임까지 허용)
    let i = s.length - 1;
    let tail = 0;
    while (i >= 0 && s[i].d > thr) {
      i--;
      tail++;
    }
    if (tail < 3) {
      // 끝부분에 다른 물체가 들어왔을 수도 있다 — 가장 긴 '달라진' 구간을 쓴다
      let bestStart = -1;
      let bestLen = 0;
      let st = -1;
      for (let k = 0; k < s.length; k++) {
        if (s[k].d > thr) {
          if (st < 0) st = k;
          if (k - st + 1 > bestLen) {
            bestLen = k - st + 1;
            bestStart = st;
          }
        } else st = -1;
      }
      return bestLen >= 5 ? s[bestStart].t : null;
    }
    let start = i + 1;
    for (;;) {
      let j = start - 1;
      let gap = 0;
      while (j >= 0 && s[j].d <= thr && gap < 3) {
        j--;
        gap++;
      }
      if (j >= 0 && s[j].d > thr && gap < 3) {
        while (j >= 0 && s[j].d > thr) j--;
        start = j + 1;
      } else break;
    }
    return s[start].t;
  }
}

// ------------------------------------------------------------ 추적
interface Blob {
  x: number;
  y: number;
  dia: number;
  area: number;
}

export interface TrackerSetup {
  /** 멈춘 공 (기준 좌표) */
  rest: { u: number; v: number; d: number };
  /** 골대 중앙 (기준 좌표) — 공이 날아가는 대략의 방향 */
  goalCenter: [number, number];
  /** 골대 네 모서리 — 공이 날아갈 수 있는 방향의 폭 */
  goalCorners?: [number, number][];
  /** 이 시각 이후부터 공이 떠난 것을 찾는다 (KickFinder 결과) */
  tStart: number;
  /** 처리 해상도 / 1920 */
  scale: number;
  /** 밝기 문턱 (기본 120) */
  minGray?: number;
}

export function blobsIn(c: Crop, prev: Crop, next: Crop, x0: number, y0: number, x1: number, y1: number, minGray: number): Blob[] {
  const w = c.width;
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w, Math.ceil(x1));
  y1 = Math.min(c.height, Math.ceil(y1));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 3 || bh < 3) return [];
  const m = new Uint8Array(bw * bh);
  const a = c.data;
  const p = prev.data;
  const n = next.data;
  for (let y = 0; y < bh; y++) {
    let k = ((y + y0) * w + x0) * 4;
    for (let x = 0; x < bw; x++, k += 4) {
      const r = a[k], g = a[k + 1], b = a[k + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      if ((r + g + b) / 3 <= minGray || mx - mn >= 90) continue;
      const dp = Math.max(Math.abs(r - p[k]), Math.abs(g - p[k + 1]), Math.abs(b - p[k + 2]));
      if (dp <= 25) continue;
      const dn = Math.max(Math.abs(r - n[k]), Math.abs(g - n[k + 1]), Math.abs(b - n[k + 2]));
      if (dn <= 25) continue;
      m[y * bw + x] = 1;
    }
  }
  // 8-연결 성분
  const lab = new Int32Array(bw * bh);
  const out: Blob[] = [];
  const stack: number[] = [];
  let next_ = 1;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue;
    let sx = 0, sy = 0, cnt = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    lab[i] = next_;
    stack.push(i);
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % bw;
      const qy = (q - qx) / bw;
      sx += qx; sy += qy; cnt++;
      if (qx < minx) minx = qx;
      if (qx > maxx) maxx = qx;
      if (qy < miny) miny = qy;
      if (qy > maxy) maxy = qy;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = qy + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = qx + dx;
          if (xx < 0 || xx >= bw) continue;
          const j = yy * bw + xx;
          if (m[j] && !lab[j]) {
            lab[j] = next_;
            stack.push(j);
          }
        }
      }
    }
    next_++;
    if (cnt < 3) continue;
    out.push({ x: sx / cnt + x0 + c.ox, y: sy / cnt + y0 + c.oy, dia: Math.max(maxx - minx + 1, maxy - miny + 1), area: cnt });
  }
  return out;
}

/** 사슬의 화면 속도가 들쭉날쭉하지 않은지 (중앙값의 0.3~3배) */
function steadySpeed(c: TrackPoint[]): boolean {
  const sp: number[] = [];
  for (let i = 1; i < c.length; i++) sp.push(Math.hypot(c[i].u - c[i - 1].u, c[i].v - c[i - 1].v) / Math.max(1e-3, c[i].t - c[i - 1].t));
  const m = [...sp].sort((a, b) => a - b)[Math.floor(sp.length / 2)];
  return sp.filter((v) => v < 0.3 * m || v > 3 * m).length <= 1;
}

function polyPredict(pts: TrackPoint[], t: number): [number, number] {
  const a = pts.slice(-8);
  const deg = a.length >= 6 ? 2 : 1;
  const t0 = a[a.length - 1].t;
  const fit = (vals: number[]) => {
    // 최소제곱 다항식 (시간은 마지막 점 기준으로 이동해 조건수를 낮춘다)
    const n = deg + 1;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    a.forEach((p, i) => {
      const x = p.t - t0;
      const pw = [1, x, x * x];
      for (let r = 0; r < n; r++) {
        b[r] += pw[r] * vals[i];
        for (let c = 0; c < n; c++) A[r][c] += pw[r] * pw[c];
      }
    });
    // 가우스 소거
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) return vals[vals.length - 1];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const co = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * co[k];
      co[r] = s / A[r][r];
    }
    const x = t - t0;
    return co[0] + co[1] * x + (deg === 2 ? co[2] * x * x : 0);
  };
  return [fit(a.map((p) => p.u)), fit(a.map((p) => p.v))];
}

export class BallTracker {
  private buf: Crop[] = [];
  private hist: { t: number; blobs: Blob[] }[] = [];
  pts: TrackPoint[] = [];
  private miss = 0;
  /** 사슬로 잡은 점 수 — 그 직후 몇 프레임은 최근 3점으로만 예측한다 (킥 직후 점은 발과 겹쳐 흔들림) */
  private acqAt = 0;
  private dtFrame = 1 / 60;
  mode: 'acquire' | 'track' | 'done' = 'acquire';
  reason = '';
  private readonly bp: number;
  private readonly s: number;
  private readonly minGray: number;
  private readonly dir: [number, number];
  private readonly cosCone: number;

  constructor(private readonly setup: TrackerSetup) {
    this.bp = Math.max(4, setup.rest.d);
    this.s = setup.scale;
    this.minGray = setup.minGray ?? 120;
    const gx = setup.goalCenter[0] - setup.rest.u;
    const gy = setup.goalCenter[1] - setup.rest.v;
    const gn = Math.hypot(gx, gy) || 1;
    this.dir = [gx / gn, gy / gn];
    // 골대 모서리들이 멈춘 공에서 보이는 방향 폭 + 25° 여유. 공이 떠오르며 화면에선 더 위로 가므로 최소 ±70°
    let half = 70;
    for (const [cx, cy] of setup.goalCorners ?? []) {
      const dx = cx - setup.rest.u;
      const dy = cy - setup.rest.v;
      const c = (dx * this.dir[0] + dy * this.dir[1]) / (Math.hypot(dx, dy) || 1);
      half = Math.max(half, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI + 25);
    }
    this.cosCone = Math.cos((Math.min(85, half) * Math.PI) / 180);
  }

  push(frame: Crop) {
    if (this.mode === 'done') return;
    this.buf.push(frame);
    if (this.buf.length > 7) this.buf.shift();
    if (this.buf.length < 7) return;
    const c = this.buf[3];
    this.dtFrame = Math.max(1 / 240, (this.buf[6].t - this.buf[0].t) / 6);
    if (c.t < this.setup.tStart) return;
    if (this.mode === 'acquire') this.acquireStep(c);
    else this.trackStep(c);
  }

  private sizeOk(b: Blob): boolean {
    return b.dia <= 3 * this.bp + 6 && b.area <= 2.5 * this.bp * this.bp + 30;
  }

  private acquireStep(c: Crop) {
    const { rest, tStart } = this.setup;
    const bp = this.bp;
    const el = c.t - tStart;
    if (el > 1.0) {
      this.mode = 'done';
      this.reason = '공이 날아가기 시작하는 장면을 찾지 못함';
      return;
    }
    // 공 속도 상한: 초속 35 m 가 화면에서 공 지름의 약 160배/초
    const R = 3 * bp + 160 * bp * (el + 0.1);
    const blobs = blobsIn(c, this.buf[0], this.buf[6], rest.u - R - c.ox, rest.v - R - c.oy, rest.u + R - c.ox, rest.v + R - c.oy, this.minGray)
      .filter((b) => this.sizeOk(b))
      // 킥 직후의 공은 멈췄을 때 크기와 비슷하다 — 손가락·옷 주름 같은 작은 조각은 뺀다
      .filter((b) => b.dia >= 0.35 * bp && b.area >= 0.08 * bp * bp && b.dia <= 1.3 * bp + 4 * this.s)
      .filter((b) => {
        const dx = b.x - rest.u;
        const dy = b.y - rest.v;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 1.0 * bp) return false;
        // 골대 쪽 방향
        return (dx * this.dir[0] + dy * this.dir[1]) / d > this.cosCone;
      });
    this.hist.push({ t: c.t, blobs });
    const chain = this.findChain();
    if (chain) {
      this.pts = chain;
      this.acqAt = chain.length;
      this.mode = 'track';
    }
  }

  /** 멈춘 공 자리에서 멀어지며 매끄럽게 이어지는 후보 6개 이상 */
  private findChain(): TrackPoint[] | null {
    const { rest } = this.setup;
    const bp = this.bp;
    const H = this.hist;
    let best: TrackPoint[] | null = null;
    for (let i = 0; i < H.length; i++) {
      for (const a of H[i].blobs) {
        const da = Math.hypot(a.x - rest.u, a.y - rest.v);
        const since = H[i].t - this.setup.tStart;
        if (da > 2.5 * bp + 60 * bp * Math.max(0, since)) continue; // 첫 점은 멈춘 자리 근처
        // 두 번째 점
        for (let j = i + 1; j <= Math.min(H.length - 1, i + 3); j++) {
          for (const b of H[j].blobs) {
            const dt = H[j].t - H[i].t;
            const vx = (b.x - a.x) / dt;
            const vy = (b.y - a.y) / dt;
            const sp = Math.hypot(vx, vy);
            if (sp > 160 * bp || sp < 2 * bp) continue;
            const db = Math.hypot(b.x - rest.u, b.y - rest.v);
            if (db <= da) continue;
            // 두 점을 잇는 직선이 멈춘 공 근처를 지나야 한다
            const lx = b.x - a.x;
            const ly = b.y - a.y;
            const ln = Math.hypot(lx, ly) || 1;
            const perp = Math.abs((rest.u - a.x) * ly - (rest.v - a.y) * lx) / ln;
            if (perp > 1.5 * bp + 4 * this.s) continue;
            // 그 속도로 거슬러 가면 킥 순간(변화 시작 뒤)에 멈춘 자리에 있어야 한다
            if (da / sp > since + 0.08) continue;
            const chain: TrackPoint[] = [
              { t: H[i].t, u: a.x, v: a.y, dia: a.dia },
              { t: H[j].t, u: b.x, v: b.y, dia: b.dia },
            ];
            let miss = 0;
            for (let k = j + 1; k < H.length && miss <= 2; k++) {
              const last = chain[chain.length - 1];
              const prev = chain[chain.length - 2];
              const dt0 = last.t - prev.t;
              const pvx = (last.u - prev.u) / dt0;
              const pvy = (last.v - prev.v) / dt0;
              const dt1 = H[k].t - last.t;
              const px = last.u + pvx * dt1;
              const py = last.v + pvy * dt1;
              // 킥 직후엔 발과 겹쳐 속도가 들쭉날쭉하므로 넉넉히
              const gate = 0.6 * Math.hypot(pvx, pvy) * dt1 + 0.5 * bp + 6 * this.s;
              let pick: Blob | null = null;
              let pd = Infinity;
              const dLast = Math.hypot(last.u - rest.u, last.v - rest.v);
              for (const cnd of H[k].blobs) {
                const d = Math.hypot(cnd.x - px, cnd.y - py);
                // 공은 멈춘 자리에서 계속 멀어지고, 제자리에 머물지 않는다
                if (Math.hypot(cnd.x - rest.u, cnd.y - rest.v) <= dLast) continue;
                if (Math.hypot(cnd.x - last.u, cnd.y - last.v) < Math.max(2 * this.s, 0.1 * bp)) continue;
                if (d < gate && d < pd) {
                  pd = d;
                  pick = cnd;
                }
              }
              if (pick) {
                chain.push({ t: H[k].t, u: pick.x, v: pick.y, dia: pick.dia });
                miss = 0;
              } else miss++;
            }
            // 아직 이어지고 있는(마지막 점이 최근인) 사슬만, 8점 이상
            const lastT = H[H.length - 1].t;
            if (chain.length >= 8 && lastT - chain[chain.length - 1].t < 0.05 && steadySpeed(chain)) {
              const far = Math.hypot(chain[chain.length - 1].u - rest.u, chain[chain.length - 1].v - rest.v);
              if (far < 4 * bp) continue;
              // 사슬 전체가 골대 쪽으로
              const ex = chain[chain.length - 1].u - chain[0].u;
              const ey = chain[chain.length - 1].v - chain[0].v;
              if ((ex * this.dir[0] + ey * this.dir[1]) / (Math.hypot(ex, ey) || 1) < this.cosCone) continue;
              if (!best || chain.length > best.length || (chain.length === best.length && chain[0].t < best[0].t)) best = chain;
            }
          }
        }
      }
    }
    return best;
  }

  private trackStep(c: Crop) {
    const last = this.pts[this.pts.length - 1];
    if (c.t <= last.t + 1e-6) return; // 사슬로 이미 들어간 프레임
    if (c.t - this.setup.tStart > 3.0) {
      this.mode = 'done';
      this.reason = '3초 경과';
      return;
    }
    const n = this.pts.length;
    const [px, py] = polyPredict(n - this.acqAt < 6 ? this.pts.slice(-3) : this.pts, c.t);
    const a = this.pts[n - 2];
    const vpx = Math.hypot(last.u - a.u, last.v - a.v) / Math.max(1e-3, last.t - a.t);
    const rr = Math.max(14 * this.s, 0.3 * this.bp, 0.6 * vpx * this.dtFrame) + 6 * this.s * this.miss;
    if (px < c.ox - rr || py < c.oy - rr || px > c.ox + c.width + rr || py > c.oy + c.height + rr) {
      this.mode = 'done';
      this.reason = '화면(관심 영역) 밖으로 나감';
      return;
    }
    const blobs = blobsIn(c, this.buf[0], this.buf[6], px - rr - c.ox, py - rr - c.oy, px + rr - c.ox, py + rr - c.oy, this.minGray).filter(
      (b) => this.sizeOk(b) && b.dia >= Math.max(2, 0.12 * this.bp),
    );
    let pick: Blob | null = null;
    let pd = Infinity;
    for (const b of blobs) {
      const d = Math.hypot(b.x - px, b.y - py);
      if (d <= rr && d < pd) {
        pd = d;
        pick = b;
      }
    }
    if (!pick) {
      this.miss++;
      if (this.miss > 6) {
        this.mode = 'done';
        this.reason = '공을 놓침';
      }
      return;
    }
    this.miss = 0;
    this.pts.push({ t: c.t, u: pick.x, v: pick.y, dia: pick.dia });
  }

  /** 추적 끝: 자유 비행 구간만, 킥 직후 발과 겹친 점은 뺀 결과 */
  result(): TrackPoint[] {
    const { rest } = this.setup;
    const bp = this.bp;
    let pts = this.pts;
    // 킥 직후 0.2초 안에서 다리·몸과 붙어 크게 잡힌 점은 위치가 틀어져 있다 (첫 속도를 부풀린다)
    if (pts.length) {
      const t0 = pts[0].t;
      pts = pts.filter((p) => p.t - t0 > 0.2 || p.dia <= 1.4 * bp);
    }
    pts = despike(pts, 8 * this.s);
    pts = flightPart(pts, 15, this.s);
    // 멈춘 자리에서 공 지름 2.5배 넘게 떨어진 뒤부터 (발과 겹친 구간 제외)
    while (pts.length > 12 && Math.hypot(pts[0].u - rest.u, pts[0].v - rest.v) < 2.5 * bp) pts = pts.slice(1);
    return pts.slice(0, 150);
  }
}

/**
 * 튀는 점 빼기: 각 점을 앞뒤 3점씩(자기 제외)으로 맞춘 2차 곡선과 비교해 tol px 넘게 벗어나면 뺀다.
 * 킥 직후 공 조각·다리를 잘못 잡은 점이 첫 속도를 크게 틀어 놓기 때문에 맞추기 전에 걸러낸다.
 */
export function despike(pts: TrackPoint[], tol: number): TrackPoint[] {
  if (pts.length < 7) return pts;
  // 튀는 점 하나가 이웃의 판정까지 흐리므로, 가장 크게 벗어난 것부터 하나씩 빼며 다시 본다
  let out = pts;
  for (let round = 0; round < 10; round++) {
    let worst = -1;
    let wd = tol;
    for (let i = 0; i < out.length; i++) {
      const nb: TrackPoint[] = [];
      for (let j = Math.max(0, i - 4); j <= Math.min(out.length - 1, i + 4); j++) if (j !== i) nb.push(out[j]);
      if (nb.length < 5) continue;
      const [pu, pv] = polyAt(nb, out[i].t);
      const d = Math.hypot(pu - out[i].u, pv - out[i].v);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst < 0) break;
    out = out.filter((_, i) => i !== worst);
  }
  return out;
}

/** 점들에 맞춘 2차 곡선의 t 에서의 값 */
function polyAt(a: TrackPoint[], t: number): [number, number] {
  const t0 = t;
  const fit = (vals: number[]) => {
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const b = [0, 0, 0];
    a.forEach((p, i) => {
      const x = p.t - t0;
      const pw = [1, x, x * x];
      for (let r = 0; r < 3; r++) {
        b[r] += pw[r] * vals[i];
        for (let c = 0; c < 3; c++) A[r][c] += pw[r] * pw[c];
      }
    });
    // 크라메르: 상수항만 필요 (t 에서의 값)
    const det = (M: number[][]) =>
      M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-18) return vals.reduce((s, v) => s + v, 0) / vals.length;
    const A0 = A.map((row, i) => [b[i], row[1], row[2]]);
    return det(A0) / D;
  };
  return [fit(a.map((p) => p.u)), fit(a.map((p) => p.v))];
}

/** 첫 바운드·골망·키퍼 접촉 전까지만: 화면 속도가 갑자기 바뀌는 첫 지점에서 자른다 */
export function flightPart(pts: TrackPoint[], minN = 15, scale = 1): TrackPoint[] {
  for (let k = minN; k < pts.length - 2; k++) {
    const d0 = Math.max(1e-3, pts[k].t - pts[k - 1].t);
    const d1 = Math.max(1e-3, pts[k + 1].t - pts[k].t);
    const v1x = (pts[k].u - pts[k - 1].u) / d0;
    const v1y = (pts[k].v - pts[k - 1].v) / d0;
    const v2x = (pts[k + 1].u - pts[k].u) / d1;
    const v2y = (pts[k + 1].v - pts[k].v) / d1;
    const dv = Math.hypot(v2x - v1x, v2y - v1y);
    if (dv > 0.8 * Math.hypot(v1x, v1y) + 120 * scale) return pts.slice(0, k + 1);
    if (pts[k].t - pts[0].t > 2.0) return pts.slice(0, k + 1);
  }
  return pts;
}
