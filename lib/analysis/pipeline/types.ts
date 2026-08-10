import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Point } from "../math";
import type { FormResult } from "../form";

export type FootSide = "left" | "right";
export type Confidence = "high" | "partial" | "failed";
export type SpeedGrade = "high" | "medium" | "low";

export interface TimedPoint extends Point {
  timeMs: number;
}

export interface BallPrediction {
  bbox: number[];
  score?: number;
  class?: string;
  source?: "motion";
}

/** One sampled frame handed to the tracker. `timeMs` must be the *actual* presented frame time. */
export interface FrameObservation {
  frameIndex: number;
  timeMs: number;
  frameWidth: number;
  frameHeight: number;
  landmarks: NormalizedLandmark[][];
  worldLandmarks: NormalizedLandmark[][];
  balls: BallPrediction[];
  /** Ball worker reports a hard scene change (edit cut) for this frame. */
  sceneChanged: boolean;
  /** Fraction of pixels that changed vs. the previous frame (camera-motion proxy). */
  changedRatio: number;
}

export interface TrackingSnapshot {
  /** Selected ball for this frame, in frame pixel coordinates. */
  ball: BallPrediction | null;
  ballCenter: Point | null;
  /** Ball centres retained for the overlay trail. */
  trail: Point[];
  activeFoot: Point | null;
  impactJustDetected: boolean;
}

export interface SpeedUncertainty {
  relative: number;
  lowKmh: number;
  highKmh: number;
  grade: SpeedGrade;
  reasons: string[];
}

/**
 * How the pipeline turned pixels into metres for this clip. Recorded because
 * a speed is only as good as its ruler, and the two rulers available (kicker
 * body span, regulation ball diameter) fail in different situations.
 */
export interface ScaleReport {
  pixelsPerMeter: number;
  /** Relative 1-sigma uncertainty of `pixelsPerMeter` (0..1). */
  relativeUncertainty: number;
  source: "body" | "ball" | "body+ball";
  /** Assumed real ball diameter, cm. Null when the ball was not usable. */
  ballDiameterCm: number | null;
  /** Stationary frames that contributed to the ball measurement. */
  ballSampleCount: number;
  /** Relative gap between the two references, or null when only one existed. */
  disagreement: number | null;
}

export interface PipelineResult {
  framesAnalyzed: number;
  poseFrames: number;
  ballFrames: number;
  sceneCuts: number;
  cameraMotionRatio: number;

  impactDetected: boolean;
  impactTimeMs: number | null;

  estimatedSpeedKmh: number;
  rawSpeedKmh: number;
  speedUncertainty: SpeedUncertainty | null;

  ballDisplacementPx?: number;
  kickerHeightPx?: number;
  /** Median on-screen ball diameter while stationary, px. */
  ballDiameterPx?: number;
  /** Which metric reference(s) produced the pixels-per-metre used for speed. */
  scale?: ScaleReport;
  trajectoryPoints: number;
  trajectoryFitR2?: number;

  estimatedDistanceMeters?: number;
  formResult: FormResult;
  feedbacks: string[];
  kickType: string;
  footSide: FootSide | null;
  confidence: Confidence;

  referenceCalibration?: { factor: number; sampleCount: number };
  referenceDistance?: { metersPerPixel: number; sampleCount: number };
}
