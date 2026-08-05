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
