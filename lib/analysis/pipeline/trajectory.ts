import type { TimedPoint } from "./types";

export interface TrajectoryFit {
  /** Mean speed over the fitted window, in pixels per second. */
  pxPerSecond: number;
  /** Straight-line displacement of the fitted model over the window (px). */
  displacementPx: number;
  durationSeconds: number;
  /** Samples that survived outlier rejection. */
  inlierCount: number;
  sampleCount: number;
  /** RMS residual of the inliers against the fitted line (px). */
  residualPx: number;
  /** 0..1 goodness of fit. */
  rSquared: number;
  startPoint: TimedPoint;
  endPoint: TimedPoint;
}

interface LinearModel {
  x0: number;
  vx: number;
  y0: number;
  vy: number;
  t0: number;
}

const MIN_SAMPLES = 3;

function evaluate(model: LinearModel, timeMs: number) {
  const t = (timeMs - model.t0) / 1000;
  return {
    x: model.x0 + model.vx * t,
    y: model.y0 + model.vy * t,
  };
}

function residual(model: LinearModel, point: TimedPoint) {
  const predicted = evaluate(model, point.timeMs);
  return Math.hypot(point.x - predicted.x, point.y - predicted.y);
}

/** Ordinary least squares fit of a constant-velocity model. */
function fitLeastSquares(points: TimedPoint[], t0: number): LinearModel | null {
  const n = points.length;
  if (n < 2) return null;

  let sumT = 0;
  let sumTT = 0;
  let sumX = 0;
  let sumY = 0;
  let sumTX = 0;
  let sumTY = 0;

  for (const point of points) {
    const t = (point.timeMs - t0) / 1000;
    sumT += t;
    sumTT += t * t;
    sumX += point.x;
    sumY += point.y;
    sumTX += t * point.x;
    sumTY += t * point.y;
  }

  const denominator = n * sumTT - sumT * sumT;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null;

  const vx = (n * sumTX - sumT * sumX) / denominator;
  const vy = (n * sumTY - sumT * sumY) / denominator;

  return {
    t0,
    vx,
    vy,
    x0: (sumX - vx * sumT) / n,
    y0: (sumY - vy * sumT) / n,
  };
}

function fitThroughPair(a: TimedPoint, b: TimedPoint, t0: number): LinearModel | null {
  const dt = (b.timeMs - a.timeMs) / 1000;
  if (!Number.isFinite(dt) || Math.abs(dt) < 1e-4) return null;

  const vx = (b.x - a.x) / dt;
  const vy = (b.y - a.y) / dt;
  const ta = (a.timeMs - t0) / 1000;

  return {
    t0,
    vx,
    vy,
    x0: a.x - vx * ta,
    y0: a.y - vy * ta,
  };
}

/**
 * Robustly estimates ball speed from a trajectory.
 *
 * Replaces the previous two-point (start/end) estimate, which failed whenever
 * either endpoint was a false detection. Uses deterministic exhaustive RANSAC
 * over sample pairs, then refits least squares on the inlier set.
 *
 * `tolerancePx` should scale with the subject size so that the same relative
 * jitter is accepted at any resolution or zoom level.
 */
export function fitTrajectorySpeed(points: TimedPoint[], tolerancePx: number): TrajectoryFit | null {
  const sorted = [...points]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);

  if (sorted.length < MIN_SAMPLES) return null;

  const t0 = sorted[0].timeMs;
  const tolerance = Math.max(1.5, tolerancePx);

  let bestInliers: TimedPoint[] = [];
  let bestError = Number.POSITIVE_INFINITY;

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const model = fitThroughPair(sorted[i], sorted[j], t0);
      if (!model) continue;

      const inliers: TimedPoint[] = [];
      let error = 0;

      for (const point of sorted) {
        const distance = residual(model, point);
        if (distance <= tolerance) {
          inliers.push(point);
          error += distance * distance;
        }
      }

      if (
        inliers.length > bestInliers.length ||
        (inliers.length === bestInliers.length && error < bestError)
      ) {
        bestInliers = inliers;
        bestError = error;
      }
    }
  }

  // Nothing coherent found: fall back to using every sample rather than failing outright.
  if (bestInliers.length < MIN_SAMPLES) {
    bestInliers = sorted;
  }

  const refined = fitLeastSquares(bestInliers, t0) ?? fitLeastSquares(sorted, t0);
  if (!refined) return null;

  const first = bestInliers[0];
  const last = bestInliers[bestInliers.length - 1];
  const durationSeconds = (last.timeMs - first.timeMs) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  const pxPerSecond = Math.hypot(refined.vx, refined.vy);
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return null;

  let squaredResidual = 0;
  let totalVariance = 0;
  const meanX = bestInliers.reduce((sum, point) => sum + point.x, 0) / bestInliers.length;
  const meanY = bestInliers.reduce((sum, point) => sum + point.y, 0) / bestInliers.length;

  for (const point of bestInliers) {
    squaredResidual += residual(refined, point) ** 2;
    totalVariance += (point.x - meanX) ** 2 + (point.y - meanY) ** 2;
  }

  const residualPx = Math.sqrt(squaredResidual / bestInliers.length);
  const rSquared = totalVariance > 0 ? Math.max(0, Math.min(1, 1 - squaredResidual / totalVariance)) : 0;

  const startPoint = { ...evaluate(refined, first.timeMs), timeMs: first.timeMs };
  const endPoint = { ...evaluate(refined, last.timeMs), timeMs: last.timeMs };

  return {
    pxPerSecond,
    displacementPx: pxPerSecond * durationSeconds,
    durationSeconds,
    inlierCount: bestInliers.length,
    sampleCount: sorted.length,
    residualPx,
    rSquared,
    startPoint,
    endPoint,
  };
}
