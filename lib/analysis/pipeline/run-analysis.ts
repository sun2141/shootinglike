"use client";

import { EMPTY_FORM_RESULT, type FormResult } from "../form";
import { getAnalysisFrameSizeFromDimensions } from "../frame-size";
import {
  applyReferenceCalibration,
  estimateReferenceDistanceMeters,
  type ReferenceCalibrationSummary,
} from "../reference-calibration";
import { MAX_REPORTABLE_SPEED_KMH } from "../speed";
import {
  DEFAULT_BALL_SIZE_ID,
  estimateBallScale,
  estimateBodyScale,
  fuseScales,
  getBallSpec,
  isBallSizePlausible,
  type BallSizeId,
  type FusedScale,
} from "../scale-reference";
import { generateFeedback } from "../feedback";
import { estimateSpeedUncertainty } from "./confidence";
import { seekToTime, waitForVideoData } from "./frame-source";
import { KickTracker } from "./kick-tracker";
import { fitTrajectorySpeed } from "./trajectory";
import type { FrameObservation, PipelineResult, TrackingSnapshot } from "./types";
import { VisionWorkers, type WorkerFrame } from "./vision-workers";

export const ANALYSIS_SAMPLE_FPS = 20;
export const MAX_ANALYSIS_SECONDS = 14;
export const MAX_ANALYSIS_FRAMES = 280;
export const DEFAULT_PLAYER_HEIGHT_CM = 175;

/** Trajectory outlier tolerance, as a fraction of the kicker's on-screen height. */
const TRAJECTORY_TOLERANCE_HEIGHTS = 0.05;
/** ~175cm / 22cm. Used to express a body height in ball diameters when no pose is found. */
const BALL_DIAMETERS_PER_BODY_HEIGHT = 8;

export interface RunAnalysisOptions {
  video: HTMLVideoElement;
  workers: VisionWorkers;
  playerHeightCm?: number | null;
  /** True when the height came from the user rather than the default. */
  playerHeightProvided?: boolean;
  /**
   * Regulation size of the ball in play. Its diameter is a fixed-size metric
   * reference that needs no user input, so it carries the scale when the
   * kicker's height is unknown.
   */
  ballSizeId?: BallSizeId | null;
  /** Set false to fall back to the body-only scale (diagnostics, A/B runs). */
  useBallScale?: boolean;
  calibration?: ReferenceCalibrationSummary | null;
  isCancelled?: () => boolean;
  onProgress?: (progress: { current: number; total: number; progress: number }) => void;
  onFrame?: (frame: {
    observation: FrameObservation;
    snapshot: TrackingSnapshot;
    frameWidth: number;
    frameHeight: number;
  }) => void;
}

async function createWorkerFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): Promise<WorkerFrame> {
  if (width <= 0 || height <= 0) throw new Error("Video frame has no drawable dimensions.");

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create frame capture canvas.");

  ctx.drawImage(video, 0, 0, width, height);

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(canvas);
    } catch {
      // Fall through for browsers without transferable ImageBitmap support.
    }
  }

  return ctx.getImageData(0, 0, width, height);
}

/** Same conversion `pixelSpeedToKmh` does, but against a fused scale. */
function pixelSpeedToKmhWithScale(pxPerSecond: number, scale: FusedScale) {
  if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return 0;
  if (scale.pixelsPerMeter <= 0) return 0;

  const speedKmh = (pxPerSecond / scale.pixelsPerMeter) * 3.6;
  return Math.min(Math.round(speedKmh), MAX_REPORTABLE_SPEED_KMH);
}

function resolvePlayerHeightM(playerHeightCm?: number | null) {
  const parsed = Number(playerHeightCm);
  if (!Number.isFinite(parsed)) return DEFAULT_PLAYER_HEIGHT_CM / 100;
  return Math.min(2.2, Math.max(1.2, parsed / 100));
}

export function buildEmptyResult(framesAnalyzed = 0): PipelineResult {
  return {
    framesAnalyzed,
    poseFrames: 0,
    ballFrames: 0,
    sceneCuts: 0,
    cameraMotionRatio: 0,
    impactDetected: false,
    impactTimeMs: null,
    estimatedSpeedKmh: 0,
    rawSpeedKmh: 0,
    speedUncertainty: null,
    trajectoryPoints: 0,
    formResult: EMPTY_FORM_RESULT,
    feedbacks: ["임팩트를 명확히 찾지 못했습니다. 공과 전신이 잘 보이는 짧은 영상을 다시 업로드해 주세요."],
    kickType: "Instep Power",
    footSide: null,
    confidence: "failed",
  };
}

/**
 * Runs the full frame loop and turns the tracker output into a report.
 *
 * Speed now comes from a robust fit over the whole trajectory rather than the
 * first and last detected ball position, and every estimate carries an explicit
 * uncertainty band.
 */
export async function runVideoAnalysis(options: RunAnalysisOptions): Promise<PipelineResult> {
  const { video, workers, onProgress, onFrame, calibration } = options;
  const isCancelled = options.isCancelled ?? (() => false);

  await waitForVideoData(video);
  video.pause();

  const frameSize = getAnalysisFrameSizeFromDimensions(
    video.videoWidth || video.clientWidth,
    video.videoHeight || video.clientHeight
  );
  const frameWidth = frameSize.width;
  const frameHeight = frameSize.height;
  if (frameWidth <= 0 || frameHeight <= 0) {
    throw new Error("Video has no readable dimensions.");
  }

  const captureCanvas = document.createElement("canvas");
  const tracker = new KickTracker({ frameWidth, frameHeight });

  const sourceDuration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : MAX_ANALYSIS_SECONDS;
  const analysisDuration = Math.min(sourceDuration, MAX_ANALYSIS_SECONDS);
  const sampleInterval = Math.max(1 / ANALYSIS_SAMPLE_FPS, analysisDuration / MAX_ANALYSIS_FRAMES);
  const totalFrames = Math.max(
    1,
    Math.min(MAX_ANALYSIS_FRAMES, Math.floor(analysisDuration / sampleInterval) + 1)
  );

  workers.reset();
  await seekToTime(video, 0);

  let framesAnalyzed = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (isCancelled()) break;

    const targetTime = Math.min(analysisDuration, frameIndex * sampleInterval);
    // The resolved value is the *actual* presented frame time, not the request.
    const actualTimeMs = await seekToTime(video, targetTime);
    if (isCancelled()) break;

    const poseFrame = await createWorkerFrame(video, captureCanvas, frameWidth, frameHeight);
    const ballFrame = await createWorkerFrame(video, captureCanvas, frameWidth, frameHeight);
    if (isCancelled()) break;

    const detection = await workers.detect(poseFrame, ballFrame, actualTimeMs);
    framesAnalyzed += 1;

    const observation: FrameObservation = {
      frameIndex,
      timeMs: actualTimeMs,
      frameWidth,
      frameHeight,
      landmarks: detection.landmarks,
      worldLandmarks: detection.worldLandmarks,
      balls: detection.balls,
      sceneChanged: detection.sceneChanged,
      changedRatio: detection.changedRatio,
    };

    const snapshot = tracker.ingest(observation);
    onFrame?.({ observation, snapshot, frameWidth, frameHeight });
    onProgress?.({
      current: frameIndex + 1,
      total: totalFrames,
      progress: Math.round(((frameIndex + 1) / totalFrames) * 100),
    });

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  const outcome = tracker.finish();
  const playerHeightM = resolvePlayerHeightM(options.playerHeightCm);

  const base = buildEmptyResult(framesAnalyzed);
  base.poseFrames = outcome.poseFrames;
  base.ballFrames = outcome.ballFrames;
  base.sceneCuts = outcome.sceneCuts;
  base.cameraMotionRatio = Math.round(outcome.cameraMotionRatio * 1000) / 1000;
  base.impactDetected = outcome.impactTimeMs !== null;
  base.impactTimeMs = outcome.impactTimeMs;
  base.footSide = outcome.footSide;
  base.kickType =
    outcome.footSide === "left"
      ? "Left-foot Instep"
      : outcome.footSide === "right"
        ? "Right-foot Instep"
        : "Instep Power";
  base.trajectoryPoints = outcome.trajectory.length;
  if (outcome.kickerHeightPx > 0) base.kickerHeightPx = outcome.kickerHeightPx;

  // Two independent rulers, combined by how much each can be trusted. The body
  // span needs a height we often do not have; the ball's diameter is fixed by
  // regulation but is only a handful of pixels across.
  const ballSpec = getBallSpec(options.ballSizeId ?? DEFAULT_BALL_SIZE_ID);
  const bodyScale = estimateBodyScale(
    outcome.kickerHeightPx,
    playerHeightM,
    options.playerHeightProvided ?? false
  );
  // Sanity-check the ball against the kicker's on-screen size before trusting
  // it. A box that is far too small or too large belongs to something at a
  // different distance, and blending it in would corrupt the speed outright.
  const ballSizePlausible =
    outcome.ballScale.diameterPx > 0 &&
    isBallSizePlausible(outcome.ballScale.diameterPx, outcome.kickerHeightPx);

  const ballScale =
    options.useBallScale === false || !ballSizePlausible
      ? null
      : estimateBallScale({
          diameterPx: outcome.ballScale.diameterPx,
          diameterCm: ballSpec.diameterCm,
          sampleCount: outcome.ballScale.sampleCount,
          relativeSpread: outcome.ballScale.relativeSpread,
        });

  const scale = fuseScales(bodyScale, ballScale);

  /*
   * Outlier tolerance is a fraction of the subject's on-screen size. The body
   * span is preferred, but a clip with no usable pose still has the ball: an
   * adult is roughly eight ball-diameters tall, so that converts cleanly.
   */
  const toleranceReferencePx =
    outcome.kickerHeightPx > 0
      ? outcome.kickerHeightPx
      : outcome.ballScale.diameterPx * BALL_DIAMETERS_PER_BODY_HEIGHT;
  const tolerance = Math.max(2, toleranceReferencePx * TRAJECTORY_TOLERANCE_HEIGHTS);
  const fit = outcome.trajectory.length >= 3 ? fitTrajectorySpeed(outcome.trajectory, tolerance) : null;

  // A missing pose is no longer fatal — the ball alone can carry the scale.
  if (!fit || !scale || scale.pixelsPerMeter <= 0) {
    const formResult: FormResult | null = outcome.formResult;
    if (formResult) {
      base.confidence = "partial";
      base.formResult = formResult;
      base.feedbacks = [
        "자세는 분석했지만 공의 이동 구간이 짧아 구속은 산출하지 않았습니다.",
        ...generateFeedback(formResult, 0).slice(0, 2),
      ];
    } else if (outcome.ballFrames > 0) {
      base.confidence = "partial";
      base.feedbacks = [
        `공 후보 ${outcome.ballFrames}개 프레임을 추적했지만, 크기 기준을 잡지 못해 구속은 산출하지 않았습니다.`,
        "공이 멈춰 있는 장면이 잠깐이라도 담기도록, 또는 키커 전신이 함께 보이도록 촬영하면 속도 산출이 안정적입니다.",
      ];
    }
    return base;
  }

  if (outcome.ballScale.diameterPx > 0) {
    base.ballDiameterPx = outcome.ballScale.diameterPx;
  }
  base.scale = {
    pixelsPerMeter: Math.round(scale.pixelsPerMeter * 100) / 100,
    relativeUncertainty: Math.round(scale.relativeUncertainty * 1000) / 1000,
    source: scale.source,
    ballDiameterCm: ballScale ? ballSpec.diameterCm : null,
    ballSampleCount: outcome.ballScale.sampleCount,
    disagreement: scale.disagreement === null ? null : Math.round(scale.disagreement * 1000) / 1000,
  };

  const rawSpeed = pixelSpeedToKmhWithScale(fit.pxPerSecond, scale);
  if (rawSpeed <= 0) return base;

  const finalSpeed = applyReferenceCalibration(rawSpeed, calibration ?? null);
  const uncertainty = estimateSpeedUncertainty({
    speedKmh: finalSpeed,
    durationSeconds: fit.durationSeconds,
    frameIntervalSeconds: sampleInterval,
    residualPx: fit.residualPx,
    displacementPx: fit.displacementPx,
    kickerHeightPx: outcome.kickerHeightPx,
    playerHeightProvided: options.playerHeightProvided ?? false,
    scaleUncertainty: scale.relativeUncertainty,
    inlierCount: fit.inlierCount,
    cameraMotionRatio: outcome.cameraMotionRatio,
    sceneCuts: outcome.sceneCuts,
  });

  base.rawSpeedKmh = rawSpeed;
  base.estimatedSpeedKmh = finalSpeed;
  base.speedUncertainty = uncertainty;
  base.ballDisplacementPx = Math.round(fit.displacementPx * 10) / 10;
  base.trajectoryFitR2 = Math.round(fit.rSquared * 1000) / 1000;
  base.confidence = uncertainty.grade === "low" ? "partial" : "high";
  base.estimatedDistanceMeters =
    estimateReferenceDistanceMeters(fit.displacementPx, calibration ?? null) ?? undefined;

  const feedbacks: string[] = [];

  if (scale.source === "ball") {
    feedbacks.push(
      `공 지름(${ballSpec.diameterCm}cm)을 기준으로 거리를 환산했습니다. 키 입력 없이도 계산됩니다.`
    );
  } else if (scale.source === "body+ball") {
    feedbacks.push(`신체 비율과 공 지름(${ballSpec.diameterCm}cm)을 함께 사용해 거리를 환산했습니다.`);
  }
  if (outcome.ballScale.diameterPx > 0 && !ballSizePlausible && options.useBallScale !== false) {
    feedbacks.push(
      "검출된 공 크기가 키커 대비 비정상적이라 크기 기준에서 제외했습니다. 공과 키커가 비슷한 거리에 있도록 촬영하면 정확해집니다."
    );
  }
  feedbacks.push(...scale.reasons);

  if (calibration?.enabled && calibration.sampleCount > 0) {
    base.referenceCalibration = { factor: calibration.factor, sampleCount: calibration.sampleCount };
    feedbacks.push(`레퍼런스 영상 ${calibration.sampleCount}개 기준으로 구속을 보정했습니다.`);
  }

  if (base.estimatedDistanceMeters !== undefined && calibration?.distanceEnabled && calibration.metersPerPixel) {
    base.referenceDistance = {
      metersPerPixel: calibration.metersPerPixel,
      sampleCount: calibration.distanceSampleCount,
    };
    feedbacks.push(
      `레퍼런스 거리 기준으로 공 이동거리를 ${base.estimatedDistanceMeters.toFixed(1)}m로 추정했습니다.`
    );
  }

  feedbacks.push(
    `측정 구속 ${finalSpeed}km/h (추정 범위 ${uncertainty.lowKmh}~${uncertainty.highKmh}km/h).`
  );
  feedbacks.push(...uncertainty.reasons);

  if (outcome.formResult) {
    base.formResult = outcome.formResult;
    feedbacks.push(...generateFeedback(outcome.formResult, finalSpeed));
  } else {
    feedbacks.push("자세 기준점이 부족해 폼 점수는 표시하지 않았습니다.");
  }

  base.feedbacks = feedbacks;
  return base;
}
