/**
 * 후보 점들을 하나의 궤적으로 엮는다.
 *
 * 프레임마다 후보가 여럿 나오고(사람 움직임, 잔디 반사, 그림자) 중간에 아예 안 잡히는
 * 프레임도 생긴다. 매 프레임 최근접으로 이으면 엉뚱한 물체로 새기 쉬우므로,
 * "가속도가 작은 사슬"을 점수로 골라낸다. 공중의 공은 중력 말고 받는 힘이 거의 없어서
 * 속도 변화가 작다는 성질이 가장 강한 단서다.
 */
import type { Candidate, FrameObservation } from './types';

export interface Track {
  idx: Array<{ f: number; c: number }>;
  score: number;
  straightness?: number;
  medStep?: number;
  jitter?: number;
}

export interface RejectedChain {
  length: number;
  straightness: number;
  jitter: number;
  medStep: number;
  reason: string;
}

export interface TrackOptions {
  maxGapFrames?: number;
  /** 프레임당 최대 이동 픽셀 (검출 해상도 기준) */
  maxStepPx?: number;
  /** 실측 프레임레이트. 공이 한 프레임에 갈 수 있는 거리를 물리적으로 제한하는 데 쓴다 */
  fps?: number | null;
  beam?: number;
  topK?: number;
  minLength?: number;
  /** 직진성 하한. 공중의 공은 0.9 근처, 흔들리는 팔다리는 0.3 아래다. */
  minStraightness?: number;
}

interface Partial {
  idx: Array<{ f: number; c: number }>;
  score: number;
  lastX: number;
  lastY: number;
  lastF: number;
  vx: number | null;
  vy: number | null;
}


/**
 * 사슬에서 '차인 뒤 날아가는 구간'만 잘라낸다.
 *
 * 키커는 영상 내내 있고 공 쪽으로 곧게 달려오기 때문에, 직진성만으로는 안 걸러진다.
 * 대신 속도가 다르다 — 달리는 사람은 프레임당 3~4px, 차인 공은 20px 이상이다.
 * 게다가 임팩트 순간 둘이 붙어 있어서 빔서치가 '달려오다가 공으로 갈아타는' 한 사슬을
 * 만들어 버린다. 그래서 사슬을 통째로 쓰지 않고, 빠르게 움직인 연속 구간만 남긴다.
 */
function ballisticSegment(
  idx: Array<{ f: number; c: number }>,
  cands: Candidate[][],
): { idx: Array<{ f: number; c: number }>; steps: number[] } {
  if (idx.length < 4) return { idx, steps: [] };
  const step: number[] = [];
  for (let i = 1; i < idx.length; i++) {
    const a = cands[idx[i - 1].f][idx[i - 1].c];
    const b = cands[idx[i].f][idx[i].c];
    const df = Math.max(1, idx[i].f - idx[i - 1].f);
    step.push(Math.hypot(b.x - a.x, b.y - a.y) / df);
  }
  const sorted = [...step].sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.9)];
  if (!(hi > 0)) return { idx, steps: step };
  const thr = Math.max(hi * 0.4, 1.2);

  let bestStart = 0;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= step.length; i++) {
    const fast = i < step.length && step[i] >= thr;
    if (fast) {
      if (curStart < 0) curStart = i;
    } else if (curStart >= 0) {
      const len = i - curStart;
      if (len > bestLen) { bestLen = len; bestStart = curStart; }
      curStart = -1;
    }
  }
  if (bestLen < 3) return { idx, steps: step };
  // step[i] 는 idx[i] -> idx[i+1] 구간이므로 점은 하나 더 포함된다
  const seg = idx.slice(bestStart, bestStart + bestLen + 1);
  return { idx: seg, steps: step.slice(bestStart, bestStart + bestLen) };
}


/**
 * 사슬 양 끝의 '튀는 한 걸음'을 떼어낸다.
 *
 * 임팩트 순간 공과 발이 붙어 있어서, 빔서치가 발 위의 후보에서 공으로 건너뛰는 사슬을
 * 만들기 쉽다. 그 건너뛰는 한 걸음은 나머지 걸음보다 훨씬 크다. 이 점 하나가 남으면
 * 초기 속도가 통째로 부풀어서(실측 90km/h 가 163km/h 로 나왔다) 반드시 떼어내야 한다.
 */
function trimJumpEnds(
  idx: Array<{ f: number; c: number }>,
  cands: Candidate[][],
  minLen: number,
): Array<{ f: number; c: number }> {
  const vecAt = (arr: Array<{ f: number; c: number }>, i: number) => {
    const a = cands[arr[i].f][arr[i].c];
    const b = cands[arr[i + 1].f][arr[i + 1].c];
    const df = Math.max(1, arr[i + 1].f - arr[i].f);
    return { x: (b.x - a.x) / df, y: (b.y - a.y) / df };
  };
  let cur = idx;
  for (let guard = 0; guard < 8; guard++) {
    if (cur.length <= minLen + 1) break;
    const vecs: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < cur.length - 1; i++) vecs.push(vecAt(cur, i));
    const mags = vecs.map((v) => Math.hypot(v.x, v.y));
    const inner = mags.slice(1, -1);
    if (inner.length < 3) break;
    const medStep = medianOf(inner);
    const radii = cur.map(({ f, c }) => cands[f][c].r);
    const medR = medianOf(radii.slice(1, -1));
    if (!(medStep > 0) || !(medR > 0)) break;

    // 가운데 구간의 평균 진행 방향. 날아가는 공은 방향이 거의 일정하다.
    let dx = 0;
    let dy = 0;
    for (const v of vecs.slice(1, -1)) { dx += v.x; dy += v.y; }
    const dn = Math.hypot(dx, dy) || 1;
    dx /= dn; dy /= dn;

    const bad = (i: number, r: number) => {
      const v = vecs[i];
      const m = Math.hypot(v.x, v.y) || 1e-9;
      const cos = (v.x * dx + v.y * dy) / m;
      // 크기가 튀거나, 공 크기와 다르거나, 진행 방향이 35도 넘게 어긋나면 공이 아니다.
      // 마지막 조건이 결정적이다 — 발은 아래로 휘두르고 공은 앞으로 나간다.
      return m > medStep * 1.6 || Math.abs(r - medR) / medR > 0.3 || cos < 0.82;
    };

    if (bad(0, radii[0])) { cur = cur.slice(1); continue; }
    if (bad(vecs.length - 1, radii[radii.length - 1])) { cur = cur.slice(0, -1); continue; }
    break;
  }
  return cur;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function medianOf(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function buildTrack(
  obs: FrameObservation[],
  opts: TrackOptions = {},
  rejectedOut?: RejectedChain[],
): Track | null {
  const maxGap = opts.maxGapFrames ?? 6;
  const maxStep = opts.maxStepPx ?? 260;
  // 공이 한 프레임에 갈 수 있는 거리에는 물리적 상한이 있다.
  // 가장 빠른 슛도 35 m/s 남짓이고 공 지름은 0.22 m 이므로 초당 약 160 지름,
  // 30fps 면 프레임당 5.3 지름이다. 여유를 둬서 8 지름(=240/fps)까지만 허용한다.
  // 이게 없으면 추적기가 화면을 가로질러 관중 머리 사이를 건너뛰는 '완벽한 직선'을 만든다 —
  // 실제 영상에서 이 현상을 확인했다.
  // 계수는 넉넉하게 잡는다. 반지름 자체가 모션블러로 흔들리는 값이라 빡빡하게 조이면
  // 진짜 공까지 끊어진다(실제로 그렇게 해봤다가 합성 클립 4개를 놓쳤다).
  // 목적은 '화면을 가로지르는 말도 안 되는 도약'만 막는 것이다.
  const maxDiametersPerFrame = 15;
  const minAbsStep = 25;
  const beam = opts.beam ?? 48;
  const topK = opts.topK ?? 8;
  const minLen = opts.minLength ?? 6;
  const minStraightness = opts.minStraightness ?? 0.62;

  const cands: Candidate[][] = obs.map((o) => o.candidates.slice(0, topK));
  let partials: Partial[] = [];
  const finished: Partial[] = [];

  for (let i = 0; i < cands.length; i++) {
    const next: Partial[] = [];
    for (let ci = 0; ci < cands[i].length; ci++) {
      const c = cands[i][ci];
      next.push({
        idx: [{ f: i, c: ci }], score: c.conf * 0.5,
        lastX: c.x, lastY: c.y, lastF: i, vx: null, vy: null,
      });
    }
    for (const p of partials) {
      const gap = i - p.lastF;
      if (gap <= 0) continue;
      if (gap > maxGap) { finished.push(p); continue; }
      for (let ci = 0; ci < cands[i].length; ci++) {
        const c = cands[i][ci];
        const dx = c.x - p.lastX;
        const dy = c.y - p.lastY;
        const d = Math.hypot(dx, dy);
        if (d > maxStep * gap) continue;
        const prevR = cands[p.idx[p.idx.length - 1].f][p.idx[p.idx.length - 1].c].r;
        const ballSpan = Math.max(2, prevR + c.r);      // 두 후보의 지름 추정
        const physLimit = Math.max(minAbsStep, ballSpan * maxDiametersPerFrame) * gap;
        if (d > physLimit) continue;
        const vx = dx / gap;
        const vy = dy / gap;
        let accelPen = 0;
        if (p.vx !== null && p.vy !== null) {
          const a = Math.hypot(vx - p.vx, vy - p.vy);
          accelPen = Math.min(a / 25, 3);
        }
        const gapPen = 0.35 * (gap - 1);
        next.push({
          idx: p.idx.concat([{ f: i, c: ci }]),
          score: p.score + c.conf + 0.45 - accelPen - gapPen,
          lastX: c.x, lastY: c.y, lastF: i, vx, vy,
        });
      }
      next.push(p);
    }
    // 같은 끝점으로 도달한 사슬은 최고점만 남긴다
    const bestByEnd = new Map<string, Partial>();
    for (const p of next) {
      const last = p.idx[p.idx.length - 1];
      const key = `${last.f}:${last.c}`;
      const cur = bestByEnd.get(key);
      if (!cur || p.score > cur.score) bestByEnd.set(key, p);
    }
    partials = Array.from(bestByEnd.values()).sort((a, b) => b.score - a.score).slice(0, beam);
  }
  finished.push(...partials);

  const scored = finished
    .filter((p) => p.idx.length >= minLen)
    .map((p) => {
      // 달려오는 구간을 떼어내고 '날아간 구간'만 평가·사용한다
      const seg = ballisticSegment(p.idx, cands);
      const idx = trimJumpEnds(seg.idx, cands, minLen);
      const span = idx[idx.length - 1].f - idx[0].f + 1;
      const density = idx.length / span;
      const pts = idx.map(({ f, c }) => cands[f][c]);

      // 공의 겉보기 크기는 천천히 매끄럽게 변한다. 경기장 라인 교차점이나 팔다리를
      // 이어붙인 사슬은 크기가 들쭉날쭉해서 여기서 걸린다.
      const radii = pts.map((c) => c.r);
      const med = medianOf(radii);
      const mad = medianOf(radii.map((r) => Math.abs(r - med)));
      const jitter = med > 0 ? mad / med : 1;

      // 직진성: 공은 한 방향으로 날아가고, 팔다리는 앞뒤로 흔들린다.
      let path = 0;
      const steps: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        const df = idx[i].f - idx[i - 1].f;
        path += d;
        if (df > 0) steps.push(d / df);
      }
      const net = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
      const straightness = path > 1e-6 ? net / path : 0;
      const medStep = steps.length ? medianOf(steps) : 0;

      return { p: { ...p, idx }, s: p.score * (idx.length / p.idx.length) + 2 * idx.length * density,
        jitter, straightness, medStep, len: idx.length };
    })
    .filter((e) => {
      const okJ = e.jitter <= 0.35;
      const okS = e.straightness >= minStraightness;
      const okL = e.len >= minLen;
      if ((!okJ || !okS || !okL) && rejectedOut && rejectedOut.length < 12) {
        rejectedOut.push({
          length: e.len,
          straightness: round3(e.straightness),
          jitter: round3(e.jitter),
          medStep: round3(e.medStep),
          reason: !okL ? '날아간 구간이 너무 짧음'
            : !okJ ? '크기가 들쭉날쭉함 (공이 아닌 물체일 가능성)'
              : '왔다갔다 움직임 (팔다리 등)',
        });
      }
      return okJ && okS && okL;
    });

  // 차인 공은 그 화면에서 가장 빠른 작은 물체다. 달려오는 몸통은 방향은 곧지만
  // 프레임당 이동이 공의 1/5 이하다. 그래서 속도에 큰 가중치를 준다.
  const fastest = Math.max(1e-6, ...scored.map((e) => e.medStep));
  for (const e of scored) {
    e.s += 9 * e.straightness + 16 * (e.medStep / fastest);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  if (rejectedOut) {
    for (const e of scored.slice(1, 6)) {
      rejectedOut.push({
        length: e.p.idx.length, straightness: round3(e.straightness),
        jitter: round3(e.jitter), medStep: round3(e.medStep),
        reason: `점수 낮음 (${e.s.toFixed(1)} < ${scored[0].s.toFixed(1)})`,
      });
    }
  }
  const best = scored[0];
  return { idx: best.p.idx, score: best.s, straightness: round3(best.straightness),
    medStep: round3(best.medStep), jitter: round3(best.jitter) };
}
