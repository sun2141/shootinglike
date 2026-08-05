export interface ReferenceCalibrationSample {
  id?: string;
  label?: string;
  knownSpeedKmh: number;
  measuredSpeedKmh: number;
  calibrationFactor?: number | null;
  knownDistanceMeters?: number | null;
  ballDisplacementPx?: number | null;
  metersPerPixel?: number | null;
  /** Relative 1-sigma uncertainty of the app measurement (0..1). */
  measurementUncertainty?: number | null;
  /** "high" | "medium" | "low", as reported by the pipeline. */
  measurementGrade?: string | null;
}

export interface ReferenceCalibrationSummary {
  /** True only when the factor is trustworthy enough to apply to real users. */
  enabled: boolean;
  factor: number;
  sampleCount: number;
  minFactor: number | null;
  maxFactor: number | null;
  spreadPercent: number | null;

  /** Samples that passed the per-sample quality filter. */
  qualifiedSampleCount: number;
  /** Samples rejected for missing or poor measurement quality. */
  rejectedSampleCount: number;
  /** Relative standard error of the combined factor (0..1). Lower is better. */
  factorUncertainty: number | null;
  /** Threshold `factorUncertainty` must reach before calibration turns on. */
  requiredUncertainty: number;
  /** Human-readable explanation of why calibration is on or off. */
  status: string;

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

/**
 * A single measurement worse than this is not allowed to influence the
 * calibration factor at all — it carries more noise than signal.
 */
export const MAX_SAMPLE_UNCERTAINTY = 0.3;

/**
 * Rows saved before quality tracking existed have no recorded uncertainty.
 * They are treated as unusable rather than assumed good, so a legacy reference
 * set cannot silently keep calibrating real users after the pipeline changes.
 */
export const LEGACY_SAMPLE_UNCERTAINTY = null;

/**
 * Calibration switches on only once the combined factor is known to within
 * this relative standard error. This is a confidence gate, not a count gate:
 * a few excellent side-view clips can qualify, while many poor clips never do.
 */
export const REQUIRED_FACTOR_UNCERTAINTY = 0.08;

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

/**
 * Per-sample uncertainty, or null when it cannot be established.
 * `measurementGrade` is used as a coarse fallback for rows that recorded a
 * grade but no numeric value.
 */
export function getSampleUncertainty(sample: ReferenceCalibrationSample): number | null {
  const value = Number(sample.measurementUncertainty);
  if (Number.isFinite(value) && value > 0) return value;

  const grade = typeof sample.measurementGrade === "string" ? sample.measurementGrade.toLowerCase() : null;
  if (grade === "high") return 0.2;
  if (grade === "medium") return 0.3;
  if (grade === "low") return 0.6;

  return LEGACY_SAMPLE_UNCERTAINTY;
}

interface QualifiedSample {
  factor: number;
  uncertainty: number;
}

function clampFactor(factor: number) {
  return Math.min(MAX_SAFE_CALIBRATION_FACTOR, Math.max(MIN_SAFE_CALIBRATION_FACTOR, factor));
}

/**
 * Combined relative standard error of the factor.
 *
 * Two estimates are compared and the larger (more pessimistic) one wins:
 *  - propagated: what the samples *claim* their precision is
 *  - empirical: how much the samples actually disagree with each other
 *
 * Taking the maximum means that clips which disagree cannot unlock calibration
 * just by each reporting a confident number.
 */
function computeFactorUncertainty(samples: QualifiedSample[], factor: number): number | null {
  if (samples.length === 0 || factor <= 0) return null;

  const weightSum = samples.reduce((sum, sample) => sum + 1 / sample.uncertainty ** 2, 0);
  if (weightSum <= 0) return null;
  const propagated = Math.sqrt(1 / weightSum);

  let empirical = 0;
  if (samples.length >= 2) {
    const mean = samples.reduce((sum, sample) => sum + sample.factor, 0) / samples.length;
    const variance =
      samples.reduce((sum, sample) => sum + (sample.factor - mean) ** 2, 0) / (samples.length - 1);
    empirical = Math.sqrt(variance / samples.length) / Math.max(mean, 1e-6);
  } else {
    // A single sample carries no independent evidence of consistency.
    empirical = samples[0].uncertainty;
  }

  return Math.max(propagated, empirical);
}

function buildStatus(
  qualified: number,
  rejected: number,
  factorUncertainty: number | null,
  enabled: boolean
) {
  if (qualified === 0) {
    return rejected > 0
      ? `측정 신뢰도를 만족하는 레퍼런스가 없습니다 (제외 ${rejected}건). 보정 미적용.`
      : "레퍼런스가 없어 보정을 적용하지 않습니다.";
  }

  const current = factorUncertainty === null ? "—" : `${roundTo(factorUncertainty * 100, 1)}%`;
  const required = `${roundTo(REQUIRED_FACTOR_UNCERTAINTY * 100, 1)}%`;

  if (enabled) {
    return `보정 적용 중 · 계수 불확실도 ${current} (기준 ${required} 이하) · 유효 샘플 ${qualified}건`;
  }

  return `계수 불확실도 ${current}로 기준 ${required}에 미달해 보정을 적용하지 않습니다 · 유효 샘플 ${qualified}건${
    rejected > 0 ? `, 제외 ${rejected}건` : ""
  }`;
}

export function buildReferenceCalibrationSummary(
  samples: ReferenceCalibrationSample[]
): ReferenceCalibrationSummary {
  const qualified: QualifiedSample[] = [];
  let rejectedSampleCount = 0;

  for (const sample of samples) {
    const factor = getReferenceCalibrationFactor(sample);
    if (factor === null || !Number.isFinite(factor) || factor <= 0) {
      rejectedSampleCount += 1;
      continue;
    }

    const uncertainty = getSampleUncertainty(sample);
    if (uncertainty === null || uncertainty > MAX_SAMPLE_UNCERTAINTY) {
      rejectedSampleCount += 1;
      continue;
    }

    qualified.push({ factor: clampFactor(factor), uncertainty });
  }

  const factors = qualified.map((sample) => sample.factor);
  const factor = factors.length > 0 ? median(factors) : DEFAULT_CALIBRATION_FACTOR;
  const minFactor = factors.length > 0 ? Math.min(...factors) : null;
  const maxFactor = factors.length > 0 ? Math.max(...factors) : null;
  const spreadPercent =
    factor > 0 && minFactor !== null && maxFactor !== null ? ((maxFactor - minFactor) / factor) * 100 : null;

  const factorUncertainty = computeFactorUncertainty(qualified, factor);
  const enabled =
    qualified.length > 0 &&
    factorUncertainty !== null &&
    factorUncertainty <= REQUIRED_FACTOR_UNCERTAINTY;

  // Distance scale is only offered alongside a trusted speed calibration.
  const distanceScales = enabled
    ? samples
        .map(getReferenceMetersPerPixel)
        .filter((scale): scale is number => scale !== null && Number.isFinite(scale) && scale > 0)
        .map((scale) => Math.min(MAX_SAFE_METERS_PER_PIXEL, Math.max(MIN_SAFE_METERS_PER_PIXEL, scale)))
    : [];

  const metersPerPixel = distanceScales.length > 0 ? median(distanceScales) : null;
  const minMetersPerPixel = distanceScales.length > 0 ? Math.min(...distanceScales) : null;
  const maxMetersPerPixel = distanceScales.length > 0 ? Math.max(...distanceScales) : null;
  const distanceSpreadPercent =
    metersPerPixel && minMetersPerPixel !== null && maxMetersPerPixel !== null
      ? ((maxMetersPerPixel - minMetersPerPixel) / metersPerPixel) * 100
      : null;

  return {
    enabled,
    factor: roundTo(factor, 4),
    sampleCount: qualified.length,
    minFactor: minFactor === null ? null : roundTo(minFactor, 4),
    maxFactor: maxFactor === null ? null : roundTo(maxFactor, 4),
    spreadPercent: spreadPercent === null ? null : roundTo(spreadPercent, 1),

    qualifiedSampleCount: qualified.length,
    rejectedSampleCount,
    factorUncertainty: factorUncertainty === null ? null : roundTo(factorUncertainty, 4),
    requiredUncertainty: REQUIRED_FACTOR_UNCERTAINTY,
    status: buildStatus(qualified.length, rejectedSampleCount, factorUncertainty, enabled),

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
  if (!summary?.enabled || summary.qualifiedSampleCount === 0) return Math.round(speedKmh);

  const factor = clampFactor(summary.factor);
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
