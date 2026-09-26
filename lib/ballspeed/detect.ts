/**
 * 공 검출 — 위치보다 "크기"를 정확히 재는 게 이 파일의 존재 이유다.
 *
 * 공 지름(22cm)으로 픽셀↔미터 환산을 하는 방식에서는 반지름이 곧 자(尺)다.
 * 반지름을 2배로 잘못 재면 1m 가 0.5m 로 환산되고, 속도도 정확히 절반이 된다.
 *
 * 반지름이 부풀려지는 경로는 두 가지다.
 *  1) 2프레임 차분: |I(t) - I(t-1)| 에는 t 의 공과 t-1 의 공이 둘 다 남는다.
 *     둘이 겹치면 하나의 긴 덩어리가 되어 반지름이 배로 뛴다.
 *     → 3프레임 차분 min(|I(t)-I(t-1)|, |I(t)-I(t+1)|) 으로 "지금 여기 있는 공"만 남긴다.
 *  2) 모션블러: 공은 진행 방향으로만 늘어난다. 긴 변으로 재면 속도가 빠를수록
 *     반지름이 커지고, 그래서 빠른 슛일수록 더 느리게 측정되는 고약한 편향이 생긴다.
 *     → 짧은 변(단축)으로 재고, 마지막에 원본 밝기로 한 번 더 확인한다.
 */
import type { Candidate, Gray } from './types';

export interface DetectOptions {
  minRadius?: number;
  maxRadius?: number;
  /** 차분 임계 백분위 (기본 99.3) */
  percentile?: number;
  maxCandidates?: number;
}

/** 히스토그램으로 백분위를 구한다 (정렬보다 훨씬 빠르다) */
function percentileU8(data: Uint8Array, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const target = data.length * (p / 100);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function absDiffMin(cur: Gray, a: Gray, b: Gray | null): Uint8Array {
  const n = cur.data.length;
  const out = new Uint8Array(n);
  if (b) {
    for (let i = 0; i < n; i++) {
      const d1 = Math.abs(cur.data[i] - a.data[i]);
      const d2 = Math.abs(cur.data[i] - b.data[i]);
      out[i] = d1 < d2 ? d1 : d2;
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.abs(cur.data[i] - a.data[i]);
  }
  return out;
}

interface Blob {
  pixels: number[];
  sumX: number;
  sumY: number;
}

/** 4-이웃 연결요소. 스택 기반이라 재귀 깊이 문제가 없다. */
function components(mask: Uint8Array, w: number, h: number, minArea: number): Blob[] {
  const seen = new Uint8Array(mask.length);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pixels: number[] = [];
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      sumX += x;
      sumY += y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (pixels.length >= minArea) out.push({ pixels, sumX, sumY });
  }
  return out;
}

/** 픽셀 집합의 주축/단축 표준편차. 균일한 원판이면 표준편차 = 반지름/2 이다. */
function axes(pixels: number[], w: number, cx: number, cy: number) {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const i of pixels) {
    const dx = (i % w) - cx;
    const dy = ((i / w) | 0) - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const n = pixels.length;
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const s = Math.sqrt(disc);
  const l1 = tr / 2 + s;
  const l2 = Math.max(tr / 2 - s, 0);
  return { major: 2 * Math.sqrt(l1), minor: 2 * Math.sqrt(l2) };
}

/**
 * 원본 명도에서 반지름을 다시 잰다.
 * 차분 마스크는 위치를 찾는 데는 좋지만 경계가 번져 있어 크기 측정에는 못 쓴다.
 * 공은 잔디보다 밝으므로, 배경과 중심의 중간 밝기를 경계로 잡으면 실제 원판에 가깝다.
 */
export function refineRadius(gray: Gray, cx: number, cy: number, rGuess: number): number | null {
  const { data, width: w, height: h } = gray;
  const R = Math.max(4, Math.min(60, Math.round(rGuess * 2 + 3)));
  const x0 = Math.max(0, Math.round(cx - R));
  const x1 = Math.min(w - 1, Math.round(cx + R));
  const y0 = Math.max(0, Math.round(cy - R));
  const y1 = Math.min(h - 1, Math.round(cy + R));
  const pw = x1 - x0 + 1;
  const ph = y1 - y0 + 1;
  if (pw < 5 || ph < 5) return null;

  const patch = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) patch[y * pw + x] = data[(y0 + y) * w + (x0 + x)];
  }
  const center = patch[Math.round(cy - y0) * pw + Math.round(cx - x0)];
  const sorted = Uint8Array.from(patch).sort();
  const bg = sorted[Math.floor(sorted.length * 0.25)];
  if (center - bg < 12) return null;
  const thr = bg + 0.5 * (center - bg);

  const mask = new Uint8Array(pw * ph);
  for (let i = 0; i < patch.length; i++) mask[i] = patch[i] > thr ? 1 : 0;
  const blobs = components(mask, pw, ph, 3);
  if (!blobs.length) return null;

  const lx = cx - x0;
  const ly = cy - y0;
  let best: Blob | null = null;
  let bestD = Infinity;
  for (const b of blobs) {
    const bx = b.sumX / b.pixels.length;
    const by = b.sumY / b.pixels.length;
    const d = Math.hypot(bx - lx, by - ly);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best || bestD > Math.max(4, rGuess)) return null;
  const bx = best.sumX / best.pixels.length;
  const by = best.sumY / best.pixels.length;
  const { minor } = axes(best.pixels, pw, bx, by);
  const r = minor / 2;
  return r >= 0.8 && r <= 80 ? r : null;
}

/**
 * 3프레임 차분으로 공 후보를 찾는다.
 * prev/next 중 하나가 없으면(첫/마지막 프레임) 2프레임 차분으로 떨어진다.
 */
export function detectFrame(
  cur: Gray,
  prev: Gray | null,
  next: Gray | null,
  opts: DetectOptions = {},
): Candidate[] {
  const ref = prev ?? next;
  if (!ref) return [];
  const diff = absDiffMin(cur, ref, prev && next ? next : null);
  const thr = Math.max(10, percentileU8(diff, opts.percentile ?? 99.3));
  const mask = new Uint8Array(diff.length);
  for (let i = 0; i < diff.length; i++) mask[i] = diff[i] > thr ? 1 : 0;

  const minR = opts.minRadius ?? 1.0;
  const maxR = opts.maxRadius ?? 60;
  const blobs = components(mask, cur.width, cur.height, 3);
  const out: Candidate[] = [];
  for (const b of blobs) {
    const n = b.pixels.length;
    const cx = b.sumX / n;
    const cy = b.sumY / n;
    const { major, minor } = axes(b.pixels, cur.width, cx, cy);
    if (major < 1e-6) continue;
    const elong = minor / major;
    // 경기장 라인이나 그림자 경계처럼 극단적으로 가는 것은 버린다.
    if (elong < 0.10) continue;
    // 타원 면적 대비 채움률. 속이 빈 윤곽선은 공이 아니다.
    const fill = n / (Math.PI * (major / 2) * (minor / 2) + 1e-9);
    if (fill < 0.45) continue;

    let r = refineRadius(cur, cx, cy, Math.max(minor / 2, 1));
    if (r === null) r = Math.max(minor / 2, 1);
    if (r < minR || r > maxR) continue;

    // 밝기 가점: 공은 잔디보다 밝다.
    let bright = 0;
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    if (ix >= 0 && ix < cur.width && iy >= 0 && iy < cur.height) {
      bright = cur.data[iy * cur.width + ix] / 255;
    }
    const conf = Math.min(1, 0.45 * Math.min(elong * 1.6, 1) + 0.35 * Math.min(fill, 1) + 0.2 * bright);
    out.push({ x: cx, y: cy, r, conf });
  }
  out.sort((a, b) => b.conf - a.conf);
  return out.slice(0, opts.maxCandidates ?? 12);
}
