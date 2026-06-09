export interface ReferenceCalibrationSample {
  id?: string;
  label?: string;
  knownSpeedKmh: number;
  measuredSpeedKmh: number;
  calibrationFactor?: number | null;
  knownDistanceMeters?: number | null;
  ballDisplacementPx?: number | null;
  metersPerPixel?: number | null;
}

export interface ReferenceCalibrationSummary {
  enabled: boolean;
  factor: number;
  sampleCount: number;
  minFactor: number | null;
  maxFactor: number | null;
  spreadPercent: number | null;
  distanceEnabled: boolean;
  metersPerPixel: number | null;
  distanceSampleCount: number;
  minMetersPerPixel: number | null;
  maxMetersPerPixel: number | null;
  distanceSpreadPercent: number | null;
}

const DEFAULT_CALIBRATION_FACTOR = 1;
const MIN_VALID_SPEED_KMH = 1;
const MIN_VALID_PIXEL_DISTANCE = 5;
const MAX_SAFE_CALIBRATION_FACTOR = 1.6;
const MIN_SAFE_CALIBRATION_FACTOR = 0.5;
const MAX_SAFE_METERS_PER_PIXEL = 1;
const MIN_SAFE_METERS_PER_PIXEL = 0.001;

function roundTo(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

export function getReferenceCalibrationFactor(sample: ReferenceCalibrationSample) {
  const providedFactor = Number(sample.calibrationFactor);
  if (Number.isFinite(providedFactor) && providedFactor > 0) {
    return providedFactor;
  }

  const knownSpeed = Number(sample.knownSpeedKmh);
  const measuredSpeed = Number(sample.measuredSpeedKmh);
  if (
    !Number.isFinite(knownSpeed) ||
    !Number.isFinite(measuredSpeed) ||
    knownSpeed < MIN_VALID_SPEED_KMH ||
    measuredSpeed < MIN_VALID_SPEED_KMH
  ) {
    return null;
  }

  return knownSpeed / measuredSpeed;
}

export function getReferenceMetersPerPixel(sample: ReferenceCalibrationSample) {
  const providedScale = Number(sample.metersPerPixel);
  if (Number.isFinite(providedScale) && providedScale > 0) {
    return providedScale;
  }

  const knownDistanceMeters = Number(sample.knownDistanceMeters);
  const ballDisplacementPx = Number(sample.ballDisplacementPx);
  if (
    !Number.isFinite(knownDistanceMeters) ||
    !Number.isFinite(ballDisplacementPx) ||
    knownDistanceMeters <= 0 ||
    ballDisplacementPx < MIN_VALID_PIXEL_DISTANCE
  ) {
    return null;
  }

  return knownDistanceMeters / ballDisplacementPx;
}

export function buildReferenceCalibrationSummary(
  samples: ReferenceCalibrationSample[]
): ReferenceCalibrationSummary {
  const factors = samples
    .map(getReferenceCalibrationFactor)
    .filter((factor): factor is number => factor !== null && Number.isFinite(factor) && factor > 0)
    .map((factor) => Math.min(MAX_SAFE_CALIBRATION_FACTOR, Math.max(MIN_SAFE_CALIBRATION_FACTOR, factor)));

  const distanceScales = samples
    .map(getReferenceMetersPerPixel)
    .filter((scale): scale is number => scale !== null && Number.isFinite(scale) && scale > 0)
    .map((scale) => Math.min(MAX_SAFE_METERS_PER_PIXEL, Math.max(MIN_SAFE_METERS_PER_PIXEL, scale)));

  const factor = factors.length > 0 ? median(factors) : DEFAULT_CALIBRATION_FACTOR;
  const minFactor = factors.length > 0 ? Math.min(...factors) : null;
  const maxFactor = factors.length > 0 ? Math.max(...factors) : null;
  const spreadPercent =
    factor > 0 && minFactor !== null && maxFactor !== null ? ((maxFactor - minFactor) / factor) * 100 : null;

  const metersPerPixel = distanceScales.length > 0 ? median(distanceScales) : null;
  const minMetersPerPixel = distanceScales.length > 0 ? Math.min(...distanceScales) : null;
  const maxMetersPerPixel = distanceScales.length > 0 ? Math.max(...distanceScales) : null;
  const distanceSpreadPercent =
    metersPerPixel && minMetersPerPixel !== null && maxMetersPerPixel !== null
      ? ((maxMetersPerPixel - minMetersPerPixel) / metersPerPixel) * 100
      : null;

  return {
    enabled: factors.length > 0,
    factor: roundTo(factor, 4),
    sampleCount: factors.length,
    minFactor: minFactor === null ? null : roundTo(minFactor, 4),
    maxFactor: maxFactor === null ? null : roundTo(maxFactor, 4),
    spreadPercent: spreadPercent === null ? null : roundTo(spreadPercent, 1),
    distanceEnabled: metersPerPixel !== null,
    metersPerPixel: metersPerPixel === null ? null : roundTo(metersPerPixel, 5),
    distanceSampleCount: distanceScales.length,
    minMetersPerPixel: minMetersPerPixel === null ? null : roundTo(minMetersPerPixel, 5),
    maxMetersPerPixel: maxMetersPerPixel === null ? null : roundTo(maxMetersPerPixel, 5),
    distanceSpreadPercent: distanceSpreadPercent === null ? null : roundTo(distanceSpreadPercent, 1),
  };
}

export function applyReferenceCalibration(speedKmh: number, summary: ReferenceCalibrationSummary | null) {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return 0;
  if (!summary?.enabled || summary.sampleCount === 0) return Math.round(speedKmh);

  const factor = Math.min(MAX_SAFE_CALIBRATION_FACTOR, Math.max(MIN_SAFE_CALIBRATION_FACTOR, summary.factor));
  return Math.min(200, Math.max(0, Math.round(speedKmh * factor)));
}

export function estimateReferenceDistanceMeters(
  displacementPx: number,
  summary: ReferenceCalibrationSummary | null
) {
  if (!Number.isFinite(displacementPx) || displacementPx < MIN_VALID_PIXEL_DISTANCE) return null;
  if (!summary?.distanceEnabled || !summary.metersPerPixel || summary.distanceSampleCount === 0) return null;

  const metersPerPixel = Math.min(
    MAX_SAFE_METERS_PER_PIXEL,
    Math.max(MIN_SAFE_METERS_PER_PIXEL, summary.metersPerPixel)
  );
  return roundTo(displacementPx * metersPerPixel, 1);
}
