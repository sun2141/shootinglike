/**
 * 카메라 흔들림/패닝 보정 (평행이동만).
 *
 * 폰으로 손에 들고 찍으면 화면이 계속 흔들리고, 공을 따라 카메라를 돌리기도 한다.
 * 보정하지 않으면 카메라가 움직인 만큼이 공의 이동량에 더해지거나 빠져서
 * 속도가 통째로 틀어지고, 연직 위치가 포물선이 아니게 되어 중력 검산까지 망가진다.
 *
 * 회전/줌까지 풀면 좋지만 브라우저에서 매 프레임 호모그래피를 추정하는 건 무겁다.
 * 짧은 클립의 손떨림과 완만한 패닝은 평행이동 근사로 대부분 잡히므로,
 * 피라미드 블록매칭으로 프레임 간 이동량만 구한다.
 */
import type { Gray } from './types';

export function downscale(g: Gray, factor: number): Gray {
  const w = Math.max(1, Math.floor(g.width / factor));
  const h = Math.max(1, Math.floor(g.height / factor));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.height - 1, Math.round(y * factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.width - 1, Math.round(x * factor));
      out[y * w + x] = g.data[sy * g.width + sx];
    }
  }
  return { data: out, width: w, height: h };
}

/** (dx, dy) 만큼 옮겼을 때의 절대차 합. 겹치는 영역만 센다. */
function sad(a: Gray, b: Gray, dx: number, dy: number, step: number): number {
  const w = a.width;
  const h = a.height;
  let sum = 0;
  let cnt = 0;
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y += step) {
    const ra = y * w;
    const rb = (y + dy) * w + dx;
    for (let x = x0; x < x1; x += step) {
      const d = a.data[ra + x] - b.data[rb + x];
      sum += d < 0 ? -d : d;
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : Number.POSITIVE_INFINITY;
}

function search(a: Gray, b: Gray, cx: number, cy: number, radius: number, step: number) {
  let best = { dx: cx, dy: cy, cost: Number.POSITIVE_INFINITY };
  for (let dy = cy - radius; dy <= cy + radius; dy++) {
    for (let dx = cx - radius; dx <= cx + radius; dx++) {
      const c = sad(a, b, dx, dy, step);
      if (c < best.cost) best = { dx, dy, cost: c };
    }
  }
  return best;
}

export interface Shift {
  dx: number;
  dy: number;
  confident: boolean;
  /** 축별로 실제로 정합이 결정됐는지. 잔디 줄무늬처럼 한 방향으로 무늬가 없으면 그 축은 못 믿는다 */
  lockedX: boolean;
  lockedY: boolean;
}

/**
 * prev 를 (dx, dy) 만큼 옮기면 cur 과 맞는다 — 즉 화면 내용이 그만큼 움직였다는 뜻.
 * 좌표는 입력 Gray 의 해상도 기준.
 */
export function estimateShift(prev: Gray, cur: Gray): Shift {
  const f1 = 8;
  const f2 = 2;
  const p1 = downscale(prev, f1);
  const c1 = downscale(cur, f1);
  const coarse = search(c1, p1, 0, 0, 6, 1);
  const p2 = downscale(prev, f2);
  const c2 = downscale(cur, f2);
  const cx = Math.round((coarse.dx * f1) / f2);
  const cy = Math.round((coarse.dy * f1) / f2);
  const fine = search(c2, p2, cx, cy, 3, 2);
  const zero = sad(c2, p2, 0, 0, 2);

  // 축별 정합 선명도. 잔디의 세로 줄무늬처럼 한 방향으로 변화가 없는 장면에서는
  // 그 축의 이동량이 아무 값이나 될 수 있다. 그런 값을 누적하면 있지도 않은
  // 카메라 움직임을 만들어내서 연직 궤적을 망가뜨린다 — 중력 검산까지 같이 무너진다.
  const c0 = fine.cost + 1e-9;
  const dxCost = Math.min(sad(c2, p2, fine.dx - 1, fine.dy, 2), sad(c2, p2, fine.dx + 1, fine.dy, 2));
  const dyCost = Math.min(sad(c2, p2, fine.dx, fine.dy - 1, 2), sad(c2, p2, fine.dx, fine.dy + 1, 2));
  const sharpX = (dxCost - fine.cost) / c0;
  const sharpY = (dyCost - fine.cost) / c0;
  const lockedX = sharpX > 0.012;
  const lockedY = sharpY > 0.012;

  const confident = fine.cost < zero * 0.92 || (Math.abs(fine.dx) < 1 && Math.abs(fine.dy) < 1);
  return {
    dx: lockedX && confident ? fine.dx * f2 : 0,
    dy: lockedY && confident ? fine.dy * f2 : 0,
    confident,
    lockedX,
    lockedY,
  };
}

/** 이미지를 (dx, dy) 만큼 옮긴 사본. 바깥은 가장자리 값으로 채운다. */
export function shiftGray(g: Gray, dx: number, dy: number): Gray {
  if (dx === 0 && dy === 0) return g;
  const { width: w, height: h, data } = g;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy));
    const ro = y * w;
    const rs = sy * w;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      out[ro + x] = data[rs + sx];
    }
  }
  return { data: out, width: w, height: h };
}
