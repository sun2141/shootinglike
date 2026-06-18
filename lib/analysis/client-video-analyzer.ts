"use client";

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { getAnalysisFrameSizeFromDimensions } from "./frame-size";
import { calculateFormScore, type FormResult } from "./form";
import { calculateDistance, type Point } from "./math";
import { estimateSpeedKmhFromSeconds } from "./speed";

const FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND = 300;
const BALL_VELOCITY_THRESHOLD_PX_PER_SECOND = 220;
const BALL_TRACKING_WINDOW_AFTER_IMPACT_MS = 650;
const VIDEO_READY_TIMEOUT_MS = 12000;
const ANALYSIS_SAMPLE_FPS = 20;
const MAX_ANALYSIS_SECONDS = 14;
const MAX_ANALYSIS_FRAMES = 280;
const FRAME_WORKER_TIMEOUT_MS = 7000;
const DEFAULT_PLAYER_HEIGHT_CM = 175;

type FootSide = "left" | "right";
type WorkerFrame = ImageBitmap | ImageData;

interface TimedPoint extends Point {
  timeMs: number;
}

interface BallPrediction {
  bbox: number[];
  score?: number;
  class?: string;
  source?: "motion";
}

interface VisionWorkerMessage {
  type: "INIT_SUCCESS" | "INIT_ERROR" | "DETECT_RESULT";
  error?: string;
  requestId?: number;
  timestamp?: number;
  landmarks?: NormalizedLandmark[][];
  balls?: BallPrediction[];
}

interface AnalysisState {
  prevFootSamples: Record<string, TimedPoint>;
  prevBallSample: TimedPoint | null;
  frameCounter: number;
  impactFrameIndex: number;
  impactTimeMs: number | null;
  activeFootPos: Point | null;
  activeFootSide: FootSide | null;
  nosePos: Point | null;
  anklePos: Point | null;
  formResult: FormResult | null;
  ballStartPos: Point | null;
  ballStartTimeMs: number | null;
  ballEndPos: Point | null;
  ballEndTimeMs: number | null;
  poseDetections: number;
  ballDetections: number;
}

export interface ClientVideoAnalysisResult {
  framesAnalyzed: number;
  estimatedSpeedKmh: number;
  rawSpeedKmh?: number;
  ballDisplacementPx?: number;
  kickerHeightPx?: number;
  formResult: FormResult;
  confidence: "high" | "partial" | "failed";
  kickType: string;
  feedbacks: string[];
}

export interface ClientVideoAnalysisProgress {
  current: number;
  total: number;
  progress: number;
  label: string;
}

export interface ClientVideoAnalysisOptions {
  playerHeightCm?: number | null;
  onProgress?: (progress: ClientVideoAnalysisProgress) => void;
}

const PLANT_LANDMARKS_BY_KICKING_FOOT: Record<
  FootSide,
  { hip: number; knee: number; ankle: number; shoulder: number }
> = {
  left: { hip: 24, knee: 26, ankle: 28, shoulder: 12 },
  right: { hip: 23, knee: 25, ankle: 27, shoulder: 11 },
};

function createInitialState(): AnalysisState {
  return {
    prevFootSamples: {},
    prevBallSample: null,
    frameCounter: 0,
    impactFrameIndex: -1,
    impactTimeMs: null,
    activeFootPos: null,
    activeFootSide: null,
    nosePos: null,
    anklePos: null,
    formResult: null,
    ballStartPos: null,
    ballStartTimeMs: null,
    ballEndPos: null,
    ballEndTimeMs: null,
    poseDetections: 0,
    ballDetections: 0,
  };
}

function isVisible(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  return Boolean(landmark && (landmark.visibility === undefined || landmark.visibility > 0.5));
}

function toCanvasPoint(landmark: NormalizedLandmark | undefined, canvas: HTMLCanvasElement): Point | null {
  if (!isVisible(landmark)) return null;
  return {
    x: landmark.x * canvas.width,
    y: landmark.y * canvas.height,
  };
}

function getBallCenter(ball: BallPrediction): Point | null {
  if (!ball.bbox || ball.bbox.length < 4) return null;
  const [x, y, width, height] = ball.bbox;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x: x + width / 2,
    y: y + height / 2,
  };
}

function selectBallCandidate(
  balls: BallPrediction[],
  activeFoot: Point | null,
  previousBall: Point | null,
  canvas: HTMLCanvasElement,
  hasImpactStarted: boolean
): BallPrediction | null {
  let selected: BallPrediction | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;
  const preImpactFootRadius = Math.max(90, Math.min(260, canvas.width * 0.24));
  const activeTrackIsNearFoot =
    !activeFoot || !previousBall || calculateDistance(previousBall, activeFoot) < preImpactFootRadius * 1.2;

  for (const ball of balls) {
    const center = getBallCenter(ball);
    if (!center) continue;

    const [x, y, width, height] = ball.bbox;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;

    const maxSide = Math.max(width, height);
    const minSide = Math.min(width, height);
    const aspect = maxSide / Math.max(minSide, 1);
    const distToFoot = activeFoot ? calculateDistance(center, activeFoot) : Number.POSITIVE_INFINITY;

    if (!hasImpactStarted && activeFoot && !activeTrackIsNearFoot && distToFoot > preImpactFootRadius) {
      continue;
    }

    if (!hasImpactStarted && activeFoot && !previousBall && distToFoot > preImpactFootRadius) {
      continue;
    }

    const modelScore = ball.score ?? 0.5;
    const previousDistancePenalty = previousBall
      ? Math.min(1.8, calculateDistance(center, previousBall) / Math.max(110, canvas.width * 0.14))
      : 0;
    const footDistancePenalty =
      activeFoot && !hasImpactStarted ? Math.min(1.4, distToFoot / preImpactFootRadius) : 0;
    const footProximityBonus =
      activeFoot && !hasImpactStarted ? Math.max(0, 0.9 * (1 - distToFoot / preImpactFootRadius)) : 0;
    const largeMotionPenalty = Math.max(
      0,
      (maxSide - Math.max(44, canvas.width * 0.065)) / Math.max(60, canvas.width * 0.08)
    );
    const shapePenalty = Math.max(0, aspect - 1.8) * 0.25;
    const rankingScore =
      modelScore + footProximityBonus - previousDistancePenalty - footDistancePenalty - largeMotionPenalty - shapePenalty;

    if (rankingScore > selectedScore) {
      selected = ball;
      selectedScore = rankingScore;
    }
  }

  return selected;
}

function waitForVideoData(video: HTMLVideoElement, timeoutMs = VIDEO_READY_TIMEOUT_MS): Promise<void> {
  const hasCurrentFrame = () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  if (hasCurrentFrame()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("canplay", handleLoaded);
      video.removeEventListener("canplaythrough", handleLoaded);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleLoaded = () => {
      if (!hasCurrentFrame()) return;
      finish();
    };
    const handleError = () => finish(new Error("Video data could not be loaded."));
    const timeoutId = window.setTimeout(() => finish(new Error("Video data load timed out.")), timeoutMs);

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("canplay", handleLoaded);
    video.addEventListener("canplaythrough", handleLoaded);
    video.addEventListener("error", handleError);

    try {
      video.load();
    } catch {
      // Ignore transient blob URL load errors; media events will decide the result.
    }

    if (hasCurrentFrame()) finish();
  });
}

function waitForVideoSeek(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  const targetTime = Math.max(0, Math.min(timeSeconds, Number.isFinite(video.duration) ? video.duration : timeSeconds));
  if (Math.abs(video.currentTime - targetTime) < 0.015 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleSeeked = () => finish();
    const handleError = () => finish(new Error("Video seek failed."));
    const timeoutId = window.setTimeout(() => finish(new Error("Video seek timed out.")), 5000);

    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);

    try {
      if ("fastSeek" in video && typeof video.fastSeek === "function") {
        video.fastSeek(targetTime);
      } else {
        video.currentTime = targetTime;
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Video seek failed."));
    }
  });
}

async function createWorkerFrame(
  video: HTMLVideoElement,
  fallbackCanvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number
): Promise<WorkerFrame> {
  const width = targetWidth || video.videoWidth || video.clientWidth;
  const height = targetHeight || video.videoHeight || video.clientHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("Video frame has no drawable dimensions.");
  }

  if (fallbackCanvas.width !== width) fallbackCanvas.width = width;
  if (fallbackCanvas.height !== height) fallbackCanvas.height = height;

  const ctx = fallbackCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create frame capture canvas.");

  ctx.drawImage(video, 0, 0, width, height);

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(fallbackCanvas);
    } catch {
      // Fall through to ImageData for browsers without transferable ImageBitmap support.
    }
  }

  return ctx.getImageData(0, 0, width, height);
}

function closeWorkerFrame(frame: WorkerFrame | null) {
  if (frame && "close" in frame && typeof frame.close === "function") {
    frame.close();
  }
}

function getFrameTransferList(frame: WorkerFrame): Transferable[] {
  if ("close" in frame) return [frame];
  return [];
}

function waitForWorkerInit(worker: Worker, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      window.clearTimeout(timeoutId);
    };
    const handleMessage = (event: MessageEvent<VisionWorkerMessage>) => {
      if (event.data.type === "INIT_SUCCESS") {
        cleanup();
        resolve();
      } else if (event.data.type === "INIT_ERROR") {
        cleanup();
        reject(new Error(event.data.error || `${label} worker failed to initialize.`));
      }
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`${label} worker initialization timed out.`));
    }, 20000);

    worker.addEventListener("message", handleMessage);
    worker.postMessage({ type: "INIT" });
  });
}

function detectFrame(
  worker: Worker,
  imageBitmap: WorkerFrame,
  timestamp: number,
  requestId: number,
  transfer: Transferable[]
): Promise<VisionWorkerMessage> {
  return new Promise((resolve) => {
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      window.clearTimeout(timeoutId);
    };
    const handleMessage = (event: MessageEvent<VisionWorkerMessage>) => {
      if (event.data.type !== "DETECT_RESULT" || event.data.requestId !== requestId) return;
      cleanup();
      resolve(event.data);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve({ type: "DETECT_RESULT", requestId, timestamp, landmarks: [], balls: [] });
    }, FRAME_WORKER_TIMEOUT_MS);

    worker.addEventListener("message", handleMessage);
    worker.postMessage({ type: "DETECT", imageBitmap, timestamp, requestId }, transfer);
  });
}

function processPoseResult(state: AnalysisState, canvas: HTMLCanvasElement, landmarks: NormalizedLandmark[][], timestampMs: number) {
  if (landmarks.length === 0) return;

  state.poseDetections += 1;
  const footLandmarks: Array<{ side: FootSide; index: number }> = [
    { side: "left", index: 31 },
    { side: "right", index: 32 },
  ];
  let fastestFoot:
    | {
        side: FootSide;
        point: Point;
        velocityPxPerSecond: number;
        landmark: NormalizedLandmark[];
      }
    | null = null;

  for (const [poseIndex, landmark] of landmarks.entries()) {
    for (const foot of footLandmarks) {
      const point = toCanvasPoint(landmark[foot.index], canvas);
      if (!point) continue;

      const footKey = `${poseIndex}:${foot.side}`;
      const previous = state.prevFootSamples[footKey];
      if (previous) {
        const dtSeconds = Math.max((timestampMs - previous.timeMs) / 1000, 1 / 120);
        const velocityPxPerSecond = calculateDistance(point, previous) / dtSeconds;
        const switchPenalty = state.activeFootPos ? Math.min(220, calculateDistance(point, state.activeFootPos) * 0.25) : 0;
        const rankingVelocity = velocityPxPerSecond - switchPenalty;

        if (!fastestFoot || rankingVelocity > fastestFoot.velocityPxPerSecond) {
          fastestFoot = {
            side: foot.side,
            point,
            velocityPxPerSecond: rankingVelocity,
            landmark,
          };
        }
      }

      state.prevFootSamples[footKey] = {
        ...point,
        timeMs: timestampMs,
      };
    }
  }

  if (fastestFoot && fastestFoot.velocityPxPerSecond > FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND) {
    const plant = PLANT_LANDMARKS_BY_KICKING_FOOT[fastestFoot.side];
    const landmark = fastestFoot.landmark;
    const nose = toCanvasPoint(landmark[0], canvas);
    const plantHip = toCanvasPoint(landmark[plant.hip], canvas);
    const plantKnee = toCanvasPoint(landmark[plant.knee], canvas);
    const plantAnkle = toCanvasPoint(landmark[plant.ankle], canvas);
    const plantShoulder = toCanvasPoint(landmark[plant.shoulder], canvas);

    state.activeFootPos = fastestFoot.point;
    state.activeFootSide = fastestFoot.side;
    if (nose) state.nosePos = nose;
    if (plantAnkle) state.anklePos = plantAnkle;

    if (plantHip && plantKnee && plantAnkle && plantShoulder) {
      state.formResult = calculateFormScore(plantHip, plantKnee, plantAnkle, plantShoulder);
    }
  } else if (fastestFoot) {
    state.activeFootPos = fastestFoot.point;
    state.activeFootSide = fastestFoot.side;
  }
}

function processBallResult(state: AnalysisState, canvas: HTMLCanvasElement, balls: BallPrediction[], timestampMs: number) {
  if (balls.length === 0) return;

  const ball = selectBallCandidate(balls, state.activeFootPos, state.prevBallSample, canvas, state.impactTimeMs !== null);
  if (!ball) return;

  const center = getBallCenter(ball);
  if (!center || ball.bbox.length < 4) return;

  state.ballDetections += 1;

  const previous = state.prevBallSample;
  if (previous) {
    const dtSeconds = Math.max((timestampMs - previous.timeMs) / 1000, 1 / 120);
    const ballVelocityPxPerSecond = calculateDistance(center, previous) / dtSeconds;

    if (ballVelocityPxPerSecond > BALL_VELOCITY_THRESHOLD_PX_PER_SECOND && state.impactFrameIndex === -1) {
      const activeFoot = state.activeFootPos;
      const distToFoot = activeFoot ? calculateDistance(center, activeFoot) : Number.POSITIVE_INFINITY;
      const previousDistToFoot = activeFoot ? calculateDistance(previous, activeFoot) : Number.POSITIVE_INFINITY;
      const impactDistanceThreshold = Math.max(100, Math.min(260, canvas.width * 0.22));
      const hasFootConfirmation = activeFoot ? Math.min(distToFoot, previousDistToFoot) < impactDistanceThreshold : false;
      const hasStrongBallConfirmation =
        !activeFoot &&
        state.ballDetections >= 3 &&
        ballVelocityPxPerSecond > BALL_VELOCITY_THRESHOLD_PX_PER_SECOND * 1.6;

      if (hasFootConfirmation || hasStrongBallConfirmation) {
        state.impactFrameIndex = state.frameCounter;
        state.impactTimeMs = timestampMs;
        state.ballStartPos = { x: previous.x, y: previous.y };
        state.ballStartTimeMs = previous.timeMs;
      }
    }
  }

  if (
    state.impactTimeMs !== null &&
    timestampMs <= state.impactTimeMs + BALL_TRACKING_WINDOW_AFTER_IMPACT_MS &&
    state.ballStartTimeMs !== null &&
    timestampMs > state.ballStartTimeMs
  ) {
    state.ballEndPos = center;
    state.ballEndTimeMs = timestampMs;
  }

  state.prevBallSample = {
    ...center,
    timeMs: timestampMs,
  };
}

function buildFinalResult(state: AnalysisState, playerHeightCm?: number | null): ClientVideoAnalysisResult {
  const formResult = state.formResult;
  const hasCompleteSpeedData =
    state.impactFrameIndex !== -1 &&
    state.ballStartPos &&
    state.ballEndPos &&
    state.ballStartTimeMs !== null &&
    state.ballEndTimeMs !== null &&
    state.nosePos &&
    state.anklePos;

  let estimatedSpeedKmh = 0;
  let rawSpeedKmh = 0;
  let ballDisplacementPx: number | undefined;
  let kickerHeightPx: number | undefined;
  let confidence: ClientVideoAnalysisResult["confidence"] = "failed";
  let finalFormResult: FormResult = formResult ?? { score: 0, kneeAngle: 0, torsoLeanAngle: 0 };
  let feedbacks: string[] = [
    "임팩트를 명확히 찾지 못했습니다. 공과 전신이 잘 보이는 짧은 영상을 다시 업로드해 주세요.",
  ];

  if (hasCompleteSpeedData) {
    const ballStartPos = state.ballStartPos;
    const ballEndPos = state.ballEndPos;
    const ballStartTimeMs = state.ballStartTimeMs;
    const ballEndTimeMs = state.ballEndTimeMs;
    const nosePos = state.nosePos;
    const anklePos = state.anklePos;

    if (!ballStartPos || !ballEndPos || ballStartTimeMs === null || ballEndTimeMs === null || !nosePos || !anklePos) {
      return {
        framesAnalyzed: state.frameCounter,
        estimatedSpeedKmh,
        rawSpeedKmh,
        ballDisplacementPx,
        kickerHeightPx,
        formResult: finalFormResult,
        confidence,
        kickType: "standard",
        feedbacks,
      };
    }

    const elapsedSeconds = (ballEndTimeMs - ballStartTimeMs) / 1000;
    const heightM =
      typeof playerHeightCm === "number" && Number.isFinite(playerHeightCm)
        ? Math.min(2.2, Math.max(1.2, playerHeightCm / 100))
        : DEFAULT_PLAYER_HEIGHT_CM / 100;

    ballDisplacementPx = calculateDistance(ballStartPos, ballEndPos);
    kickerHeightPx = calculateDistance(nosePos, anklePos);
    rawSpeedKmh = estimateSpeedKmhFromSeconds(
      nosePos,
      anklePos,
      ballStartPos,
      ballEndPos,
      elapsedSeconds,
      heightM
    );
    estimatedSpeedKmh = rawSpeedKmh;

    if (estimatedSpeedKmh > 0) {
      confidence = "high";
      if (formResult) {
        finalFormResult = formResult;
        feedbacks = ["앱 분석 엔진으로 구속과 폼 기준점을 산출했습니다."];
      } else {
        feedbacks = [
          "공 이동 구간을 기준으로 구속을 산출했습니다.",
          "자세 기준점이 부족해 폼 점수는 보수적으로 표시했습니다.",
        ];
      }
    }
  }

  if (confidence === "failed" && formResult) {
    confidence = "partial";
    finalFormResult = formResult;
    feedbacks = ["자세는 분석했지만 공의 이동 구간이 짧아 구속은 산출하지 않았습니다."];
  }

  if (confidence === "failed" && state.ballDetections > 0) {
    confidence = "partial";
    feedbacks = [
      `공 후보 ${state.ballDetections}개 프레임을 추적했지만, 전신 기준점이 부족해 구속은 산출하지 않았습니다.`,
    ];
  }

  const kickType =
    state.activeFootSide === "left"
      ? "Left-foot Instep"
      : state.activeFootSide === "right"
        ? "Right-foot Instep"
        : "Instep Power";

  return {
    framesAnalyzed: state.frameCounter,
    estimatedSpeedKmh,
    rawSpeedKmh: rawSpeedKmh || undefined,
    ballDisplacementPx,
    kickerHeightPx,
    formResult: finalFormResult,
    confidence,
    kickType,
    feedbacks,
  };
}

export class BrowserVideoAnalyzer {
  private poseWorker: Worker | null = null;
  private ballWorker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private requestId = 0;

  async init() {
    if (this.readyPromise) return this.readyPromise;

    this.poseWorker = new Worker(new URL("../workers/pose.worker.ts", import.meta.url));
    this.ballWorker = new Worker(new URL("../workers/ball.worker.ts", import.meta.url));
    this.readyPromise = Promise.all([
      waitForWorkerInit(this.poseWorker, "Pose"),
      waitForWorkerInit(this.ballWorker, "Ball"),
    ]).then(() => undefined);

    return this.readyPromise;
  }

  async analyzeSource(sourceUrl: string, options: ClientVideoAnalysisOptions = {}): Promise<ClientVideoAnalysisResult> {
    await this.init();
    if (!this.poseWorker || !this.ballWorker) {
      throw new Error("Analysis workers are not ready.");
    }

    const video = document.createElement("video");
    video.src = sourceUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    const frameCaptureCanvas = document.createElement("canvas");
    const state = createInitialState();

    try {
      await waitForVideoData(video);
      video.pause();
      await waitForVideoSeek(video, 0);

      const frameSize = getAnalysisFrameSizeFromDimensions(video.videoWidth, video.videoHeight);
      canvas.width = frameSize.width || video.videoWidth || 1;
      canvas.height = frameSize.height || video.videoHeight || 1;

      const sourceDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : MAX_ANALYSIS_SECONDS;
      const analysisDuration = Math.min(sourceDuration, MAX_ANALYSIS_SECONDS);
      const sampleInterval = Math.max(1 / ANALYSIS_SAMPLE_FPS, analysisDuration / MAX_ANALYSIS_FRAMES);
      const totalFrames = Math.max(1, Math.min(MAX_ANALYSIS_FRAMES, Math.floor(analysisDuration / sampleInterval) + 1));

      this.ballWorker.postMessage({ type: "RESET" });

      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        const targetTime = Math.min(analysisDuration, frameIndex * sampleInterval);
        await waitForVideoSeek(video, targetTime);

        state.frameCounter += 1;
        const timestamp = targetTime * 1000;
        const frameRequestId = (this.requestId += 1);
        let poseFrame: WorkerFrame | null = null;
        let ballFrame: WorkerFrame | null = null;

        try {
          poseFrame = await createWorkerFrame(video, frameCaptureCanvas, canvas.width, canvas.height);
          ballFrame = await createWorkerFrame(video, frameCaptureCanvas, canvas.width, canvas.height);

          const [poseResult, ballResult] = await Promise.all([
            detectFrame(this.poseWorker, poseFrame, timestamp, frameRequestId, getFrameTransferList(poseFrame)),
            detectFrame(this.ballWorker, ballFrame, timestamp, frameRequestId, getFrameTransferList(ballFrame)),
          ]);
          poseFrame = null;
          ballFrame = null;

          processPoseResult(state, canvas, poseResult.landmarks ?? [], timestamp);
          processBallResult(state, canvas, ballResult.balls ?? [], timestamp);
        } catch {
          closeWorkerFrame(poseFrame);
          closeWorkerFrame(ballFrame);
        }

        options.onProgress?.({
          current: frameIndex + 1,
          total: totalFrames,
          progress: Math.round(((frameIndex + 1) / totalFrames) * 100),
          label: "Analyzing clip",
        });
      }

      return buildFinalResult(state, options.playerHeightCm);
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  }

  dispose() {
    this.poseWorker?.terminate();
    this.ballWorker?.terminate();
    this.poseWorker = null;
    this.ballWorker = null;
    this.readyPromise = null;
  }
}

export async function analyzeVideoSource(sourceUrl: string, options: ClientVideoAnalysisOptions = {}) {
  const analyzer = new BrowserVideoAnalyzer();
  try {
    return await analyzer.analyzeSource(sourceUrl, options);
  } finally {
    analyzer.dispose();
  }
}
