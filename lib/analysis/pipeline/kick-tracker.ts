import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { calculateDistance, type Point } from "../math";
import { calculateFormScore, calculateFormScoreFromWorld, type FormResult, type Point3 } from "../form";
import type {
  BallPrediction,
  FootSide,
  FrameObservation,
  TimedPoint,
  TrackingSnapshot,
} from "./types";

const LANDMARK = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftFoot: 31,
  rightFoot: 32,
} as const;

const PLANT_LANDMARKS_BY_KICKING_FOOT: Record<
  FootSide,
  { hip: number; knee: number; ankle: number; shoulder: number }
> = {
  left: { hip: LANDMARK.rightHip, knee: LANDMARK.rightKnee, ankle: LANDMARK.rightAnkle, shoulder: LANDMARK.rightShoulder },
  right: { hip: LANDMARK.leftHip, knee: LANDMARK.leftKnee, ankle: LANDMARK.leftAnkle, shoulder: LANDMARK.leftShoulder },
};

/*
 * Thresholds are expressed in kicker heights per second instead of raw pixels.
 * The old absolute values (300 px/s, 220 px/s) silently changed meaning with
 * resolution, zoom and shooting distance.
 */
const FOOT_VELOCITY_HEIGHTS_PER_SECOND = 0.9;
const BALL_VELOCITY_HEIGHTS_PER_SECOND = 0.65;
const IMPACT_FOOT_RADIUS_HEIGHTS = 0.55;
const PRE_IMPACT_BALL_RADIUS_HEIGHTS = 0.7;
const TRACK_ASSOCIATION_RADIUS_HEIGHTS = 0.6;

export const BALL_TRACKING_WINDOW_AFTER_IMPACT_MS = 650;
const MAX_TRAIL_POINTS = 90;

/*
 * Ball-diameter sampling for the metric scale reference.
 *
 * Only pre-impact frames count. Once the ball is in flight its box is smeared
 * by motion blur and it is receding from the camera, so its apparent size is no
 * longer the size of a ball sitting where the kicker is standing — which is the
 * only depth plane we can compare against the body reference.
 */
/** Reject boxes this far from square; a round ball should not be elongated. */
const BALL_MAX_ASPECT_FOR_SCALE = 1.35;
/** Movement above this fraction of a diameter means it is no longer at rest. */
const BALL_REST_MOTION_DIAMETERS = 0.6;
const MAX_BALL_DIAMETER_SAMPLES = 60;
/** Fraction of changed pixels above which a frame is treated as an edit cut. */
export const SCENE_CUT_CHANGED_RATIO = 0.45;

function isVisible(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  return Boolean(landmark && (landmark.visibility === undefined || landmark.visibility > 0.5));
}

function toFramePoint(
  landmark: NormalizedLandmark | undefined,
  frameWidth: number,
  frameHeight: number
): Point | null {
  if (!isVisible(landmark)) return null;
  return { x: landmark.x * frameWidth, y: landmark.y * frameHeight };
}

function toPoint3(landmark: NormalizedLandmark | undefined): Point3 | null {
  if (!landmark) return null;
  const { x, y, z } = landmark;
  if (![x, y, z].every((value) => Number.isFinite(value))) return null;
  return { x, y, z: z ?? 0 };
}

export function getBallCenter(ball: BallPrediction): Point | null {
  if (!ball.bbox || ball.bbox.length < 4) return null;
  const [x, y, width, height] = ball.bbox;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x: x + width / 2, y: y + height / 2 };
}

interface PoseCandidate {
  index: number;
  landmarks: NormalizedLandmark[];
  worldLandmarks: NormalizedLandmark[] | null;
  nose: Point | null;
  anklePoint: Point | null;
  centroid: Point | null;
  heightPx: number;
  feet: Array<{ side: FootSide; point: Point }>;
}

function buildPoseCandidate(
  landmarks: NormalizedLandmark[],
  worldLandmarks: NormalizedLandmark[] | null,
  index: number,
  frameWidth: number,
  frameHeight: number
): PoseCandidate {
  const nose = toFramePoint(landmarks[LANDMARK.nose], frameWidth, frameHeight);
  const leftAnkle = toFramePoint(landmarks[LANDMARK.leftAnkle], frameWidth, frameHeight);
  const rightAnkle = toFramePoint(landmarks[LANDMARK.rightAnkle], frameWidth, frameHeight);
  const leftHip = toFramePoint(landmarks[LANDMARK.leftHip], frameWidth, frameHeight);
  const rightHip = toFramePoint(landmarks[LANDMARK.rightHip], frameWidth, frameHeight);

  const anklePoint =
    leftAnkle && rightAnkle
      ? { x: (leftAnkle.x + rightAnkle.x) / 2, y: Math.max(leftAnkle.y, rightAnkle.y) }
      : (leftAnkle ?? rightAnkle);

  const centroid =
    leftHip && rightHip
      ? { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 }
      : (leftHip ?? rightHip ?? nose);

  const feet: Array<{ side: FootSide; point: Point }> = [];
  const leftFoot = toFramePoint(landmarks[LANDMARK.leftFoot], frameWidth, frameHeight);
  const rightFoot = toFramePoint(landmarks[LANDMARK.rightFoot], frameWidth, frameHeight);
  if (leftFoot) feet.push({ side: "left", point: leftFoot });
  if (rightFoot) feet.push({ side: "right", point: rightFoot });

  return {
    index,
    landmarks,
    worldLandmarks,
    nose,
    anklePoint,
    centroid,
    heightPx: nose && anklePoint ? calculateDistance(nose, anklePoint) : 0,
    feet,
  };
}

export interface KickTrackerOptions {
  frameWidth: number;
  frameHeight: number;
}

/** Ball-size measurement taken while the ball was still at rest. */
export interface BallScaleObservation {
  /** Median diameter across accepted samples, px. 0 when unusable. */
  diameterPx: number;
  sampleCount: number;
  /** Interquartile range over the median — how much the samples disagreed. */
  relativeSpread: number;
}

export interface TrackingOutcome {
  impactTimeMs: number | null;
  /** Ball centres sampled from just before impact through the flight window. */
  trajectory: TimedPoint[];
  kickerHeightPx: number;
  /** Known-size reference recovered from the stationary ball. */
  ballScale: BallScaleObservation;
  footSide: FootSide | null;
  formResult: FormResult | null;
  poseFrames: number;
  ballFrames: number;
  sceneCuts: number;
  /** Mean fraction of changed pixels per frame — a camera-motion proxy. */
  cameraMotionRatio: number;
  framesIngested: number;
}

/**
 * Stateful per-frame tracker shared by the user-facing analyser and the admin
 * reference batch runner. Previously both maintained their own copy of this
 * logic, so fixes only ever landed on one side.
 */
export class KickTracker {
  private readonly frameWidth: number;
  private readonly frameHeight: number;

  private lockedCentroid: Point | null = null;
  private lockedHeightPx = 0;
  private previousFeet: Partial<Record<FootSide, TimedPoint>> = {};
  private previousBall: TimedPoint | null = null;

  private activeFoot: Point | null = null;
  private footSide: FootSide | null = null;
  private impactTimeMs: number | null = null;

  private trajectory: TimedPoint[] = [];
  private trail: Point[] = [];
  private ballDiameterSamples: number[] = [];

  private impactPose: PoseCandidate | null = null;
  private impactPoseTimeMs: number | null = null;
  private fallbackPose: PoseCandidate | null = null;

  private poseFrames = 0;
  private ballFrames = 0;
  private sceneCuts = 0;
  private changedRatioSum = 0;
  private framesIngested = 0;

  constructor(options: KickTrackerOptions) {
    this.frameWidth = options.frameWidth;
    this.frameHeight = options.frameHeight;
  }

  /** Best available subject scale; falls back to a fraction of the frame. */
  private get referenceHeightPx() {
    if (this.lockedHeightPx > 0) return this.lockedHeightPx;
    return Math.max(60, this.frameHeight * 0.4);
  }

  private handleSceneCut() {
    this.sceneCuts += 1;
    this.previousFeet = {};
    this.previousBall = null;
    this.trail = [];

    // Before impact the whole track is worthless after a cut; afterwards we keep
    // the flight samples already collected and simply stop extending them.
    if (this.impactTimeMs === null) {
      this.lockedCentroid = null;
      this.lockedHeightPx = 0;
      this.activeFoot = null;
      this.trajectory = [];
      // Samples from before a cut may come from a different shot entirely, at a
      // different zoom — averaging across the cut would corrupt the scale.
      this.ballDiameterSamples = [];
    }
  }

  /**
   * Records the ball's on-screen diameter while it is still sitting on the
   * ground. Elongated boxes (motion blur, partial occlusion) and boxes from a
   * ball that has already started moving are discarded rather than averaged in.
   */
  private sampleBallDiameter(ball: BallPrediction, center: Point) {
    if (this.impactTimeMs !== null) return;
    if (this.ballDiameterSamples.length >= MAX_BALL_DIAMETER_SAMPLES) return;
    if (!ball.bbox || ball.bbox.length < 4) return;
    // Motion-derived boxes trace a blob of changed pixels, not the ball itself.
    if (ball.source === "motion") return;

    const [, , width, height] = ball.bbox;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const maxSide = Math.max(width, height);
    const minSide = Math.min(width, height);
    if (maxSide / minSide > BALL_MAX_ASPECT_FOR_SCALE) return;

    // The short side survives blur better than the long one.
    const diameterPx = minSide;

    const previous = this.previousBall;
    if (previous) {
      const travelled = calculateDistance(center, previous);
      if (travelled > diameterPx * BALL_REST_MOTION_DIAMETERS) return;
    }

    this.ballDiameterSamples.push(diameterPx);
  }

  private buildBallScale(): BallScaleObservation {
    const samples = [...this.ballDiameterSamples].sort((a, b) => a - b);
    if (samples.length === 0) return { diameterPx: 0, sampleCount: 0, relativeSpread: 0 };

    const at = (fraction: number) =>
      samples[Math.min(samples.length - 1, Math.max(0, Math.round(fraction * (samples.length - 1))))];

    const diameterPx = at(0.5);
    if (diameterPx <= 0) return { diameterPx: 0, sampleCount: 0, relativeSpread: 0 };

    // IQR rather than standard deviation: a couple of bad boxes should not be
    // able to inflate the reported spread on an otherwise steady measurement.
    const relativeSpread = samples.length >= 4 ? (at(0.75) - at(0.25)) / diameterPx : 0.15;

    return {
      diameterPx: Math.round(diameterPx * 100) / 100,
      sampleCount: samples.length,
      relativeSpread: Math.round(Math.max(0, relativeSpread) * 1000) / 1000,
    };
  }

  private selectPose(observation: FrameObservation): PoseCandidate | null {
    const candidates = observation.landmarks.map((landmarks, index) =>
      buildPoseCandidate(
        landmarks,
        observation.worldLandmarks[index] ?? null,
        index,
        observation.frameWidth,
        observation.frameHeight
      )
    );

    if (candidates.length === 0) return null;

    // Keep following the same person once locked: a diving keeper used to steal
    // the track mid-flight because selection was independent per frame.
    if (this.lockedCentroid) {
      const gate = this.referenceHeightPx * TRACK_ASSOCIATION_RADIUS_HEIGHTS;
      let best: PoseCandidate | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const candidate of candidates) {
        if (!candidate.centroid) continue;
        const distance = calculateDistance(candidate.centroid, this.lockedCentroid);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }

      if (best && bestDistance <= gate) return best;
      if (this.impactTimeMs !== null) return null; // never re-lock mid flight
    }

    // Not locked yet: prefer the person whose foot is nearest a ball candidate,
    // otherwise the largest person in frame.
    const ballCenters = observation.balls
      .map(getBallCenter)
      .filter((center): center is Point => center !== null);

    let best: PoseCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      if (candidate.heightPx <= 0) continue;

      let proximity = 0;
      if (ballCenters.length > 0 && candidate.feet.length > 0) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const foot of candidate.feet) {
          for (const center of ballCenters) {
            nearest = Math.min(nearest, calculateDistance(foot.point, center));
          }
        }
        proximity = Math.max(0, 1 - nearest / Math.max(1, candidate.heightPx));
      }

      const score = candidate.heightPx / Math.max(1, this.frameHeight) + proximity;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  private selectBall(balls: BallPrediction[]): BallPrediction | null {
    const heightPx = this.referenceHeightPx;
    const footRadius = heightPx * PRE_IMPACT_BALL_RADIUS_HEIGHTS;
    const hasImpactStarted = this.impactTimeMs !== null;
    const activeFoot = this.activeFoot;
    const previousBall = this.previousBall;

    const activeTrackIsNearFoot =
      !activeFoot || !previousBall || calculateDistance(previousBall, activeFoot) < footRadius * 1.2;

    let selected: BallPrediction | null = null;
    let selectedScore = Number.NEGATIVE_INFINITY;

    for (const ball of balls) {
      const center = getBallCenter(ball);
      if (!center) continue;

      const [, , width, height] = ball.bbox;
      if (width <= 0 || height <= 0) continue;

      const maxSide = Math.max(width, height);
      const minSide = Math.min(width, height);
      const aspect = maxSide / Math.max(minSide, 1);
      const distToFoot = activeFoot ? calculateDistance(center, activeFoot) : Number.POSITIVE_INFINITY;

      if (!hasImpactStarted && activeFoot && !activeTrackIsNearFoot && distToFoot > footRadius) continue;
      if (!hasImpactStarted && activeFoot && !previousBall && distToFoot > footRadius) continue;

      const modelScore = ball.score ?? 0.5;
      const previousDistancePenalty = previousBall
        ? Math.min(1.8, calculateDistance(center, previousBall) / (heightPx * 0.4))
        : 0;
      const footDistancePenalty =
        activeFoot && !hasImpactStarted ? Math.min(1.4, distToFoot / footRadius) : 0;
      const footProximityBonus =
        activeFoot && !hasImpactStarted ? Math.max(0, 0.9 * (1 - distToFoot / footRadius)) : 0;
      // A real ball is small relative to the kicker; large blobs are limbs or graphics.
      const largeMotionPenalty = Math.max(0, (maxSide - heightPx * 0.16) / (heightPx * 0.2));
      const shapePenalty = Math.max(0, aspect - 1.8) * 0.25;

      const rankingScore =
        modelScore +
        footProximityBonus -
        previousDistancePenalty -
        footDistancePenalty -
        largeMotionPenalty -
        shapePenalty;

      if (rankingScore > selectedScore) {
        selected = ball;
        selectedScore = rankingScore;
      }
    }

    return selected;
  }

  private trackFeet(pose: PoseCandidate, timeMs: number) {
    let fastest: { side: FootSide; point: Point; velocity: number } | null = null;

    for (const foot of pose.feet) {
      const previous = this.previousFeet[foot.side];
      if (previous) {
        const dtSeconds = Math.max((timeMs - previous.timeMs) / 1000, 1 / 240);
        const velocity = calculateDistance(foot.point, previous) / dtSeconds;
        if (!fastest || velocity > fastest.velocity) {
          fastest = { side: foot.side, point: foot.point, velocity };
        }
      }
      this.previousFeet[foot.side] = { ...foot.point, timeMs };
    }

    if (!fastest) return;

    this.activeFoot = fastest.point;

    const threshold = this.referenceHeightPx * FOOT_VELOCITY_HEIGHTS_PER_SECOND;
    if (fastest.velocity > threshold) {
      this.footSide = fastest.side;
      this.fallbackPose = pose;
    }
  }

  ingest(observation: FrameObservation): TrackingSnapshot {
    this.framesIngested += 1;
    this.changedRatioSum += Number.isFinite(observation.changedRatio) ? observation.changedRatio : 0;

    if (observation.sceneChanged) {
      this.handleSceneCut();
      return { ball: null, ballCenter: null, trail: [], activeFoot: null, impactJustDetected: false };
    }

    const pose = this.selectPose(observation);
    if (pose) {
      this.poseFrames += 1;
      if (pose.centroid) this.lockedCentroid = pose.centroid;
      if (pose.heightPx > 0) {
        this.lockedHeightPx =
          this.lockedHeightPx > 0 ? this.lockedHeightPx * 0.7 + pose.heightPx * 0.3 : pose.heightPx;
      }
      this.trackFeet(pose, observation.timeMs);

      // Keep the pose closest to impact for the form score, rather than
      // whichever frame happened to have the fastest foot.
      if (this.impactTimeMs !== null) {
        const currentGap =
          this.impactPoseTimeMs === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(this.impactPoseTimeMs - this.impactTimeMs);
        const nextGap = Math.abs(observation.timeMs - this.impactTimeMs);
        if (nextGap < currentGap) {
          this.impactPose = pose;
          this.impactPoseTimeMs = observation.timeMs;
        }
      } else {
        this.impactPose = pose;
        this.impactPoseTimeMs = observation.timeMs;
      }
    }

    const ball = this.selectBall(observation.balls);
    const ballCenter = ball ? getBallCenter(ball) : null;
    let impactJustDetected = false;

    if (ball && ballCenter) {
      this.ballFrames += 1;
      this.trail.push(ballCenter);
      if (this.trail.length > MAX_TRAIL_POINTS) this.trail.shift();

      // Must run before `previousBall` is overwritten below — the rest check
      // compares this frame against the last one.
      this.sampleBallDiameter(ball, ballCenter);

      const previous = this.previousBall;
      if (previous && this.impactTimeMs === null) {
        const dtSeconds = Math.max((observation.timeMs - previous.timeMs) / 1000, 1 / 240);
        const velocity = calculateDistance(ballCenter, previous) / dtSeconds;
        const threshold = this.referenceHeightPx * BALL_VELOCITY_HEIGHTS_PER_SECOND;

        if (velocity > threshold) {
          const footRadius = this.referenceHeightPx * IMPACT_FOOT_RADIUS_HEIGHTS;
          const distToFoot = this.activeFoot
            ? Math.min(
                calculateDistance(ballCenter, this.activeFoot),
                calculateDistance(previous, this.activeFoot)
              )
            : Number.POSITIVE_INFINITY;

          const confirmedByFoot = this.activeFoot ? distToFoot < footRadius : false;
          const confirmedByBallOnly =
            !this.activeFoot && this.ballFrames >= 3 && velocity > threshold * 1.6;

          if (confirmedByFoot || confirmedByBallOnly) {
            this.impactTimeMs = observation.timeMs;
            this.trajectory = [{ ...previous }];
            impactJustDetected = true;
          }
        }
      }

      if (
        this.impactTimeMs !== null &&
        observation.timeMs <= this.impactTimeMs + BALL_TRACKING_WINDOW_AFTER_IMPACT_MS
      ) {
        const last = this.trajectory[this.trajectory.length - 1];
        if (!last || observation.timeMs > last.timeMs) {
          this.trajectory.push({ ...ballCenter, timeMs: observation.timeMs });
        }
      }

      this.previousBall = { ...ballCenter, timeMs: observation.timeMs };
    }

    return {
      ball,
      ballCenter,
      trail: this.trail,
      activeFoot: this.activeFoot,
      impactJustDetected,
    };
  }

  private buildFormResult(): FormResult | null {
    const pose = this.impactPose ?? this.fallbackPose;
    if (!pose) return null;

    const side = this.footSide ?? "right";
    const plant = PLANT_LANDMARKS_BY_KICKING_FOOT[side];

    if (pose.worldLandmarks) {
      const hip = toPoint3(pose.worldLandmarks[plant.hip]);
      const knee = toPoint3(pose.worldLandmarks[plant.knee]);
      const ankle = toPoint3(pose.worldLandmarks[plant.ankle]);
      const shoulder = toPoint3(pose.worldLandmarks[plant.shoulder]);
      if (hip && knee && ankle && shoulder) {
        return calculateFormScoreFromWorld(hip, knee, ankle, shoulder);
      }
    }

    const hip = toFramePoint(pose.landmarks[plant.hip], this.frameWidth, this.frameHeight);
    const knee = toFramePoint(pose.landmarks[plant.knee], this.frameWidth, this.frameHeight);
    const ankle = toFramePoint(pose.landmarks[plant.ankle], this.frameWidth, this.frameHeight);
    const shoulder = toFramePoint(pose.landmarks[plant.shoulder], this.frameWidth, this.frameHeight);
    if (hip && knee && ankle && shoulder) {
      return calculateFormScore(hip, knee, ankle, shoulder);
    }

    return null;
  }

  finish(): TrackingOutcome {
    const pose = this.impactPose ?? this.fallbackPose;

    return {
      impactTimeMs: this.impactTimeMs,
      trajectory: [...this.trajectory],
      kickerHeightPx: this.lockedHeightPx > 0 ? this.lockedHeightPx : (pose?.heightPx ?? 0),
      ballScale: this.buildBallScale(),
      footSide: this.footSide,
      formResult: this.buildFormResult(),
      poseFrames: this.poseFrames,
      ballFrames: this.ballFrames,
      sceneCuts: this.sceneCuts,
      cameraMotionRatio: this.framesIngested > 0 ? this.changedRatioSum / this.framesIngested : 0,
      framesIngested: this.framesIngested,
    };
  }
}
