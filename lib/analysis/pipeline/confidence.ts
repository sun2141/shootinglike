import {
  BODY_SCALE_BASE_UNCERTAINTY,
  BODY_SCALE_HEIGHT_GUESS_UNCERTAINTY,
} from "../scale-reference";
import type { SpeedUncertainty } from "./types";

export interface UncertaintyInput {
  speedKmh: number;
  /** Fitted flight window length, seconds. */
  durationSeconds: number;
  /** Interval between sampled frames, seconds (timing quantisation). */
  frameIntervalSeconds: number;
  /** RMS fit residual, px. */
  residualPx: number;
  /** Straight-line displacement used for the estimate, px. */
  displacementPx: number;
  /** Kicker nose-to-ankle span in px (metric scale reference). */
  kickerHeightPx: number;
  /** True when the user supplied their own height instead of the default. */
  playerHeightProvided: boolean;
  /**
   * Relative uncertainty of the metric scale actually used, from
   * `fuseScales`. When present it replaces the body-only assumption below —
   * a known-size reference such as the ball can beat it, and a disagreement
   * between references can be worse than it.
   */
  scaleUncertainty?: number | null;
  /** Trajectory samples that survived outlier rejection. */
  inlierCount: number;
  /** Mean fraction of pixels changing per frame (camera-motion proxy). */
  cameraMotionRatio: number;
  /** Scene cuts seen during the analysed window. */
  sceneCuts: number;
}

/*
 * Body-scale error terms live with the scale model itself so the two cannot
 * drift apart; these aliases keep the fallback path below readable.
 */
const SCALE_BASE_UNCERTAINTY = BODY_SCALE_BASE_UNCERTAINTY;
const SCALE_HEIGHT_GUESS_UNCERTAINTY = BODY_SCALE_HEIGHT_GUESS_UNCERTAINTY;
/**
 * The pipeline measures a 2D projection of a 3D flight. Until depth is
 * recovered this is an irreducible floor on accuracy.
 */
const PROJECTION_UNCERTAINTY = 0.15;

/*
 * The projection and body-scale terms alone put a ~19% floor under any
 * estimate, so "high" is calibrated just above that: it means "as good as this
 * method gets", not "accurate to a few percent".
 */
const HIGH_GRADE_MAX_RELATIVE = 0.22;
const MEDIUM_GRADE_MAX_RELATIVE = 0.35;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Propagates the known error sources into a ± band. Previously any non-zero
 * speed was reported as "high" confidence, which attached false authority to
 * badly conditioned measurements.
 */
export function estimateSpeedUncertainty(input: UncertaintyInput): SpeedUncertainty {
  const reasons: string[] = [];

  const timing =
    input.durationSeconds > 0
      ? clamp(input.frameIntervalSeconds / input.durationSeconds, 0, 1)
      : 1;
  if (timing > 0.12) {
    reasons.push("비행 구간이 짧아 프레임 단위 시간 오차가 큽니다. 더 높은 fps로 촬영하면 정확해집니다.");
  }

  const fit = input.displacementPx > 0 ? clamp(input.residualPx / input.displacementPx, 0, 1) : 1;
  if (fit > 0.15) {
    reasons.push("공 궤적이 일정하지 않아 검출이 흔들렸을 수 있습니다.");
  }

  // The measured scale uncertainty wins when we have one; the body-only
  // formula is the fallback for callers that have not been migrated.
  const measuredScale =
    typeof input.scaleUncertainty === "number" &&
    Number.isFinite(input.scaleUncertainty) &&
    input.scaleUncertainty > 0
      ? Math.min(1, input.scaleUncertainty)
      : null;

  const scale =
    measuredScale ??
    SCALE_BASE_UNCERTAINTY + (input.playerHeightProvided ? 0 : SCALE_HEIGHT_GUESS_UNCERTAINTY);

  // Only nag about the height when it would actually help — with a solid
  // ball-based scale the height barely moves the result.
  if (!input.playerHeightProvided && scale > SCALE_BASE_UNCERTAINTY) {
    reasons.push("키를 입력하면 거리 환산 오차가 줄어듭니다.");
  }

  const sampleShortage = input.inlierCount >= 6 ? 0 : (6 - input.inlierCount) * 0.04;
  if (input.inlierCount < 5) {
    reasons.push(`유효 궤적 샘플이 ${input.inlierCount}개로 적습니다.`);
  }

  const cameraMotion = clamp((input.cameraMotionRatio - 0.12) * 1.5, 0, 0.4);
  if (cameraMotion > 0.05) {
    reasons.push("카메라가 움직여 공 이동 픽셀에 화면 이동이 섞였습니다. 고정 촬영을 권장합니다.");
  }

  const sceneCutPenalty = input.sceneCuts > 0 ? 0.1 : 0;
  if (input.sceneCuts > 0) {
    reasons.push(`편집 컷 ${input.sceneCuts}개가 감지되어 추적이 끊겼습니다.`);
  }

  // Ball travelling mostly toward/away from the camera projects into a short
  // on-screen path; the resulting speed is systematically underestimated.
  const heightsPerSecond =
    input.kickerHeightPx > 0 && input.durationSeconds > 0
      ? input.displacementPx / input.kickerHeightPx / input.durationSeconds
      : 0;
  const depthSuspicion = heightsPerSecond > 0 && heightsPerSecond < 3 ? 0.3 : 0;
  if (depthSuspicion > 0) {
    reasons.push(
      "공이 카메라 정면 방향으로 날아가 화면상 이동이 짧습니다. 측면에서 촬영하면 구속 정확도가 크게 올라갑니다."
    );
  }

  const relative = Math.sqrt(
    timing ** 2 +
      fit ** 2 +
      scale ** 2 +
      sampleShortage ** 2 +
      cameraMotion ** 2 +
      sceneCutPenalty ** 2 +
      depthSuspicion ** 2 +
      PROJECTION_UNCERTAINTY ** 2
  );

  const grade =
    relative <= HIGH_GRADE_MAX_RELATIVE
      ? "high"
      : relative <= MEDIUM_GRADE_MAX_RELATIVE
        ? "medium"
        : "low";

  const margin = input.speedKmh * relative;

  return {
    relative: Math.round(relative * 1000) / 1000,
    lowKmh: Math.max(0, Math.round(input.speedKmh - margin)),
    highKmh: Math.round(input.speedKmh + margin),
    grade,
    reasons,
  };
}
