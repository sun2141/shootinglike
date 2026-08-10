import { NOSE_TO_ANKLE_HEIGHT_RATIO } from "./speed";

/**
 * Metric scale recovery.
 *
 * Until now the only ruler in the pipeline was the kicker's nose-to-ankle span,
 * which requires knowing their height — a number we almost never have for
 * reference footage. The ball is a better ruler in one important respect: its
 * real-world size is fixed by regulation, so it needs no user input at all.
 *
 * It is worse in another respect: it is small, so a one-pixel error in the
 * bounding box is a large *relative* error. Neither reference dominates, which
 * is why the two are fused by inverse-variance weighting rather than one being
 * picked over the other.
 */

export type BallSizeId = "size5" | "size4" | "size3" | "futsal4";

export interface BallSpec {
  id: BallSizeId;
  label: string;
  /** Official diameter in centimetres (circumference / π, rounded to 0.1). */
  diameterCm: number;
}

/**
 * FIFA Law 2 fixes circumference, not diameter, so these are derived:
 * size 5 = 68–70cm circumference → 21.65–22.28cm diameter, midpoint 22.0.
 */
export const BALL_SPECS: BallSpec[] = [
  { id: "size5", label: "5호 (성인, 22cm)", diameterCm: 22 },
  { id: "size4", label: "4호 (U12, 20.5cm)", diameterCm: 20.5 },
  { id: "size3", label: "3호 (U8, 18.5cm)", diameterCm: 18.5 },
  { id: "futsal4", label: "풋살 4호 (20cm)", diameterCm: 20 },
];

export const DEFAULT_BALL_SIZE_ID: BallSizeId = "size5";

export function getBallSpec(id: BallSizeId | null | undefined): BallSpec {
  return BALL_SPECS.find((spec) => spec.id === id) ?? BALL_SPECS[0];
}

/**
 * Baseline scale error from using the nose-to-ankle span as a ruler: posture,
 * lean and perspective all distort it. Mirrors the term the confidence model
 * used to hardcode.
 */
export const BODY_SCALE_BASE_UNCERTAINTY = 0.12;
/** Extra error when the height is the pipeline default rather than user input. */
export const BODY_SCALE_HEIGHT_GUESS_UNCERTAINTY = 0.06;

/**
 * Detector boxes do not hug the ball perfectly — they include a little
 * background and clip the shaded edge. This is the irreducible part of the
 * ball-scale error, independent of how many frames we average.
 */
const BALL_BOX_SLACK_UNCERTAINTY = 0.08;
/** Below this the ball is too few pixels across for its box to mean anything. */
export const MIN_USABLE_BALL_DIAMETER_PX = 8;
/** Two references disagreeing by more than this is treated as a red flag. */
const SCALE_DISAGREEMENT_WARN = 0.25;

/*
 * Plausibility gate for the ball, expressed against the kicker's on-screen span
 * rather than against the assumed height.
 *
 * A ball is 22cm across and a nose-to-ankle span is 0.88 of stature, so for
 * every human from a small child (120cm) to a very tall adult (200cm) the ratio
 * ball/span lands between 0.125 and 0.21. The bounds below are that range with
 * slack on both sides.
 *
 * Deliberately *not* derived from the assumed player height: a wrong height
 * guess is exactly the failure this is meant to survive. A ball outside these
 * bounds is at a different depth or is a misdetection — either way it is not
 * measuring the plane the kicker is standing in.
 */
export const MIN_BALL_TO_SPAN_RATIO = 0.09;
export const MAX_BALL_TO_SPAN_RATIO = 0.27;

export type ScaleSource = "body" | "ball" | "body+ball";

export interface ScaleEstimate {
  pixelsPerMeter: number;
  /** Relative 1-sigma uncertainty of `pixelsPerMeter` (0..1). */
  relativeUncertainty: number;
}

export interface FusedScale extends ScaleEstimate {
  source: ScaleSource;
  body: ScaleEstimate | null;
  ball: ScaleEstimate | null;
  /** |ball − body| / body, or null when only one reference exists. */
  disagreement: number | null;
  reasons: string[];
}

function isPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Scale implied by the kicker's on-screen nose-to-ankle span.
 * `heightProvided` is about *trust*, not about whether a number exists: the
 * pipeline always has a fallback height, but a fallback deserves a wider band.
 */
export function estimateBodyScale(
  kickerHeightPx: number,
  playerHeightM: number,
  heightProvided: boolean
): ScaleEstimate | null {
  if (!isPositive(kickerHeightPx) || !isPositive(playerHeightM)) return null;

  const pixelsPerMeter = kickerHeightPx / (playerHeightM * NOSE_TO_ANKLE_HEIGHT_RATIO);
  if (!isPositive(pixelsPerMeter)) return null;

  return {
    pixelsPerMeter,
    relativeUncertainty:
      BODY_SCALE_BASE_UNCERTAINTY + (heightProvided ? 0 : BODY_SCALE_HEIGHT_GUESS_UNCERTAINTY),
  };
}

export interface BallScaleInput {
  /** Median ball diameter over the stationary pre-impact frames, px. */
  diameterPx: number;
  /** Real diameter of the ball in play, cm. */
  diameterCm: number;
  /** How many frames contributed to the median. */
  sampleCount: number;
  /** Relative spread of those samples (IQR / median), 0 when unknown. */
  relativeSpread: number;
}

/**
 * Scale implied by the ball's known diameter.
 *
 * The error budget has three parts: fixed box slack, a quantisation term that
 * shrinks as the ball gets bigger on screen, and the observed disagreement
 * between frames divided down by the sample count.
 */
/**
 * True when the ball's on-screen size is consistent with *some* human standing
 * at the same distance. Returns true when there is no body span to check
 * against — an unverifiable ball is still better than no scale at all.
 */
export function isBallSizePlausible(diameterPx: number, kickerSpanPx: number) {
  if (!isPositive(diameterPx)) return false;
  if (!isPositive(kickerSpanPx)) return true;

  const ratio = diameterPx / kickerSpanPx;
  return ratio >= MIN_BALL_TO_SPAN_RATIO && ratio <= MAX_BALL_TO_SPAN_RATIO;
}

export function estimateBallScale(input: BallScaleInput): ScaleEstimate | null {
  const { diameterPx, diameterCm, sampleCount } = input;

  if (!isPositive(diameterPx) || !isPositive(diameterCm)) return null;
  if (diameterPx < MIN_USABLE_BALL_DIAMETER_PX || sampleCount < 1) return null;

  const pixelsPerMeter = diameterPx / (diameterCm / 100);
  if (!isPositive(pixelsPerMeter)) return null;

  // A box edge is only localised to ~1px, and that error lands on both sides.
  const quantisation = 2 / diameterPx;
  const spread = Number.isFinite(input.relativeSpread) ? Math.max(0, input.relativeSpread) : 0;
  const sampling = spread / Math.sqrt(sampleCount);

  const relativeUncertainty = Math.min(
    1,
    Math.sqrt(BALL_BOX_SLACK_UNCERTAINTY ** 2 + quantisation ** 2 + sampling ** 2)
  );

  return { pixelsPerMeter, relativeUncertainty };
}

/**
 * Inverse-variance weighted combination.
 *
 * The weighting is what makes an unknown height tolerable: when the body
 * reference is downgraded to a guess its weight drops automatically and the
 * ball carries the estimate, with no special-casing anywhere.
 */
export function fuseScales(
  body: ScaleEstimate | null,
  ball: ScaleEstimate | null
): FusedScale | null {
  const reasons: string[] = [];

  if (!body && !ball) return null;

  if (!ball) {
    return {
      ...(body as ScaleEstimate),
      source: "body",
      body,
      ball: null,
      disagreement: null,
      reasons: ["공 크기를 안정적으로 측정하지 못해 신체 비율만으로 스케일을 잡았습니다."],
    };
  }

  if (!body) {
    return {
      ...ball,
      source: "ball",
      body: null,
      ball,
      disagreement: null,
      reasons: ["신체 기준점이 부족해 공 지름만으로 스케일을 잡았습니다."],
    };
  }

  const gap = Math.abs(ball.pixelsPerMeter - body.pixelsPerMeter) / body.pixelsPerMeter;

  const bodyWeight = 1 / body.relativeUncertainty ** 2;
  const ballWeight = 1 / ball.relativeUncertainty ** 2;
  const weightSum = bodyWeight + ballWeight;

  const pixelsPerMeter =
    (body.pixelsPerMeter * bodyWeight + ball.pixelsPerMeter * ballWeight) / weightSum;
  let relativeUncertainty = Math.sqrt(1 / weightSum);

  // Two rulers that disagree cannot both be right, and averaging them does not
  // make the answer more certain. Never report a band narrower than the gap.
  if (gap > SCALE_DISAGREEMENT_WARN) {
    relativeUncertainty = Math.max(relativeUncertainty, gap / 2);
    reasons.push(
      `신체 기준과 공 기준 스케일이 ${Math.round(gap * 100)}% 어긋납니다. 공이 카메라와 다른 거리에 있거나 키 입력이 실제와 다를 수 있습니다.`
    );
  }

  return {
    pixelsPerMeter,
    relativeUncertainty: Math.min(1, relativeUncertainty),
    source: "body+ball",
    body,
    ball,
    disagreement: gap,
    reasons,
  };
}
