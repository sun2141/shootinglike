"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  Database,
  ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Share2,
} from "lucide-react";
import Link from "next/link";
import { drawLandmarks, drawConnectors } from "@/lib/canvas-utils";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { estimateSpeedKmhFromSeconds } from "@/lib/analysis/speed";
import { calculateFormScore, type FormResult } from "@/lib/analysis/form";
import { generateFeedback } from "@/lib/analysis/feedback";
import {
  applyReferenceCalibration,
  estimateReferenceDistanceMeters,
  type ReferenceCalibrationSummary,
} from "@/lib/analysis/reference-calibration";
import { getAnalysisFrameSize } from "@/lib/analysis/frame-size";
import { calculateDistance, type Point } from "@/lib/analysis/math";
import { ShareCard } from "@/components/ShareCard";
import html2canvas from "html2canvas";

const MAX_CLIENT_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND = 300;
const BALL_VELOCITY_THRESHOLD_PX_PER_SECOND = 220;
const BALL_TRACKING_WINDOW_AFTER_IMPACT_MS = 360;
const MAX_TRAJECTORY_POINTS = 90;
const VIDEO_READY_TIMEOUT_MS = 12000;
const ANALYSIS_SAMPLE_FPS = 12;
const MAX_ANALYSIS_SECONDS = 14;
const MAX_ANALYSIS_FRAMES = 168;
const FRAME_WORKER_TIMEOUT_MS = 7000;
const OPT_IN_STORAGE_KEY = "freekickDataOptIn";
const PLAYER_HEIGHT_STORAGE_KEY = "freekickPlayerHeightCm";
const DEFAULT_PLAYER_HEIGHT_CM = 175;
const DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO = 16 / 9;
const MOBILE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;

type FootSide = "left" | "right";
type Confidence = "high" | "partial" | "failed";
type WorkerFrame = ImageBitmap | ImageData;

interface AnalysisResult {
  framesAnalyzed: number;
  estimatedSpeedKmh: number;
  rawSpeedKmh?: number;
  estimatedDistanceMeters?: number;
  ballDisplacementPx?: number;
  kickerHeightPx?: number;
  formResult: FormResult;
  feedbacks: string[];
  kickType: string;
  confidence: Confidence;
  referenceCalibration?: {
    factor: number;
    sampleCount: number;
  };
  referenceDistance?: {
    metersPerPixel: number;
    sampleCount: number;
  };
}

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

const POSE_CONNECTIONS: Array<{ start: number; end: number }> = [
  { start: 0, end: 1 },
  { start: 1, end: 2 },
  { start: 2, end: 3 },
  { start: 3, end: 7 },
  { start: 0, end: 4 },
  { start: 4, end: 5 },
  { start: 5, end: 6 },
  { start: 6, end: 8 },
  { start: 9, end: 10 },
  { start: 11, end: 12 },
  { start: 11, end: 13 },
  { start: 13, end: 15 },
  { start: 15, end: 17 },
  { start: 15, end: 19 },
  { start: 15, end: 21 },
  { start: 17, end: 19 },
  { start: 12, end: 14 },
  { start: 14, end: 16 },
  { start: 16, end: 18 },
  { start: 16, end: 20 },
  { start: 16, end: 22 },
  { start: 18, end: 20 },
  { start: 11, end: 23 },
  { start: 12, end: 24 },
  { start: 23, end: 24 },
  { start: 23, end: 25 },
  { start: 24, end: 26 },
  { start: 25, end: 27 },
  { start: 26, end: 28 },
  { start: 27, end: 29 },
  { start: 28, end: 30 },
  { start: 29, end: 31 },
  { start: 30, end: 32 },
  { start: 27, end: 31 },
  { start: 28, end: 32 },
];

const PLANT_LANDMARKS_BY_KICKING_FOOT: Record<
  FootSide,
  { hip: number; knee: number; ankle: number; shoulder: number }
> = {
  left: { hip: 24, knee: 26, ankle: 28, shoulder: 12 },
  right: { hip: 23, knee: 25, ankle: 27, shoulder: 11 },
};

function isVisible(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  return Boolean(landmark && (landmark.visibility === undefined || landmark.visibility > 0.5));
}

function toCanvasPoint(
  landmark: NormalizedLandmark | undefined,
  canvas: HTMLCanvasElement
): Point | null {
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
  previousBall: Point | null
): BallPrediction | null {
  let selected: BallPrediction | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  for (const ball of balls) {
    const center = getBallCenter(ball);
    if (!center) continue;

    const modelScore = ball.score ?? 0.5;
    const previousDistancePenalty = previousBall ? Math.min(1.5, calculateDistance(center, previousBall) * 0.004) : 0;
    const footDistancePenalty = !previousBall && activeFoot ? Math.min(0.8, calculateDistance(center, activeFoot) * 0.0015) : 0;
    const rankingScore = modelScore - previousDistancePenalty - footDistancePenalty;

    if (rankingScore > selectedScore) {
      selected = ball;
      selectedScore = rankingScore;
    }
  }

  return selected;
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

function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem("deviceId");
  if (existing) return existing;

  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const deviceId = `device_${suffix}`;
  localStorage.setItem("deviceId", deviceId);
  return deviceId;
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
    const handleError = () => {
      finish(new Error("Video data could not be loaded."));
    };
    const timeoutId = window.setTimeout(() => {
      finish(new Error("Video data load timed out."));
    }, timeoutMs);

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("canplay", handleLoaded);
    video.addEventListener("canplaythrough", handleLoaded);
    video.addEventListener("error", handleError);

    try {
      video.load();
    } catch {
      // Some browsers throw when load() is called on transient blob URLs.
    }

    if (hasCurrentFrame()) {
      finish();
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
  if ("close" in frame) {
    return [frame];
  }

  return [];
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas to Blob failed"));
    }, "image/png");
  });
}

export default function AnalyzePage() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoPreviewAspectRatio, setVideoPreviewAspectRatio] = useState(DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO);
  const [videoPreviewError, setVideoPreviewError] = useState<string | null>(null);
  const [isPoseLoading, setIsPoseLoading] = useState(true);
  const [isBallLoading, setIsBallLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const isModelLoading = isPoseLoading || isBallLoading;

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [impactDetected, setImpactDetected] = useState(false);
  const [isPersistingAnalysis, setIsPersistingAnalysis] = useState(false);
  const [referenceCalibration, setReferenceCalibration] = useState<ReferenceCalibrationSummary | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseWorkerRef = useRef<Worker | null>(null);
  const ballWorkerRef = useRef<Worker | null>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const frameCaptureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const referenceCalibrationRef = useRef<ReferenceCalibrationSummary | null>(null);

  const [isSharing, setIsSharing] = useState(false);
  const [optIn, setOptIn] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(OPT_IN_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [playerHeightCm, setPlayerHeightCm] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_PLAYER_HEIGHT_CM.toString();
    try {
      return localStorage.getItem(PLAYER_HEIGHT_STORAGE_KEY) ?? DEFAULT_PLAYER_HEIGHT_CM.toString();
    } catch {
      return DEFAULT_PLAYER_HEIGHT_CM.toString();
    }
  });
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const prevFootSamplesRef = useRef<Partial<Record<FootSide, TimedPoint>>>({});
  const prevBallSampleRef = useRef<TimedPoint | null>(null);

  const isPoseProcessingRef = useRef(false);
  const isBallProcessingRef = useRef(false);
  const analysisRunIdRef = useRef(0);
  const frameRequestIdRef = useRef(0);
  const pendingPoseRequestIdRef = useRef<number | null>(null);
  const pendingBallRequestIdRef = useRef<number | null>(null);

  const frameCounterRef = useRef(0);
  const impactFrameIndexRef = useRef(-1);
  const impactTimeMsRef = useRef<number | null>(null);
  const activeFootPosRef = useRef<Point | null>(null);
  const activeFootSideRef = useRef<FootSide | null>(null);
  const nosePosRef = useRef<Point | null>(null);
  const anklePosRef = useRef<Point | null>(null);
  const formResultRef = useRef<FormResult | null>(null);

  const ballStartPosRef = useRef<Point | null>(null);
  const ballStartTimeMsRef = useRef<number | null>(null);
  const ballEndPosRef = useRef<Point | null>(null);
  const ballEndTimeMsRef = useRef<number | null>(null);
  const ballTrajectoryRef = useRef<Point[]>([]);
  const poseDetectionsRef = useRef(0);
  const ballDetectionsRef = useRef(0);

  const resetTrackingRefs = useCallback(() => {
    prevFootSamplesRef.current = {};
    prevBallSampleRef.current = null;
    isPoseProcessingRef.current = false;
    isBallProcessingRef.current = false;
    pendingPoseRequestIdRef.current = null;
    pendingBallRequestIdRef.current = null;
    ballTrajectoryRef.current = [];

    frameCounterRef.current = 0;
    impactFrameIndexRef.current = -1;
    impactTimeMsRef.current = null;
    activeFootPosRef.current = null;
    activeFootSideRef.current = null;
    nosePosRef.current = null;
    anklePosRef.current = null;
    formResultRef.current = null;
    ballStartPosRef.current = null;
    ballStartTimeMsRef.current = null;
    ballEndPosRef.current = null;
    ballEndTimeMsRef.current = null;
    poseDetectionsRef.current = 0;
    ballDetectionsRef.current = 0;
  }, []);

  const revokeCurrentVideoUrl = useCallback(() => {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
  }, []);

  const syncVideoPreview = useCallback((video: HTMLVideoElement) => {
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (width > 0 && height > 0) {
      setVideoPreviewAspectRatio(width / height);
    }

    if (canvasRef.current) {
      const frameSize = getAnalysisFrameSize(video);
      canvasRef.current.width = frameSize.width || width || canvasRef.current.clientWidth || 1;
      canvasRef.current.height = frameSize.height || height || canvasRef.current.clientHeight || 1;
    }

    setVideoPreviewError(null);
  }, []);

  const processPoseResult = useCallback((landmarks: NormalizedLandmark[][], timestampMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || landmarks.length === 0) return;

    poseDetectionsRef.current += 1;

    for (const landmark of landmarks) {
      drawLandmarks(ctx, landmark);
      drawConnectors(ctx, landmark, POSE_CONNECTIONS, {
        color: "rgba(0, 255, 0, 0.7)",
        lineWidth: 3,
      });

      const footLandmarks: Array<{ side: FootSide; index: number }> = [
        { side: "left", index: 31 },
        { side: "right", index: 32 },
      ];

      let fastestFoot:
        | {
            side: FootSide;
            point: Point;
            velocityPxPerSecond: number;
          }
        | null = null;

      for (const foot of footLandmarks) {
        const point = toCanvasPoint(landmark[foot.index], canvas);
        if (!point) continue;

        const previous = prevFootSamplesRef.current[foot.side];
        if (previous) {
          const dtSeconds = Math.max((timestampMs - previous.timeMs) / 1000, 1 / 120);
          const velocityPxPerSecond = calculateDistance(point, previous) / dtSeconds;

          if (!fastestFoot || velocityPxPerSecond > fastestFoot.velocityPxPerSecond) {
            fastestFoot = {
              side: foot.side,
              point,
              velocityPxPerSecond,
            };
          }
        }

        prevFootSamplesRef.current[foot.side] = {
          ...point,
          timeMs: timestampMs,
        };
      }

      if (
        fastestFoot &&
        fastestFoot.velocityPxPerSecond > FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND
      ) {
        const plant = PLANT_LANDMARKS_BY_KICKING_FOOT[fastestFoot.side];
        const nose = toCanvasPoint(landmark[0], canvas);
        const plantHip = toCanvasPoint(landmark[plant.hip], canvas);
        const plantKnee = toCanvasPoint(landmark[plant.knee], canvas);
        const plantAnkle = toCanvasPoint(landmark[plant.ankle], canvas);
        const plantShoulder = toCanvasPoint(landmark[plant.shoulder], canvas);

        activeFootPosRef.current = fastestFoot.point;
        activeFootSideRef.current = fastestFoot.side;
        if (nose) nosePosRef.current = nose;
        if (plantAnkle) anklePosRef.current = plantAnkle;

        if (plantHip && plantKnee && plantAnkle && plantShoulder) {
          formResultRef.current = calculateFormScore(plantHip, plantKnee, plantAnkle, plantShoulder);
        }
      } else if (fastestFoot) {
        activeFootPosRef.current = fastestFoot.point;
        activeFootSideRef.current = fastestFoot.side;
      }
    }
  }, []);

  const processBallResult = useCallback((balls: BallPrediction[], timestampMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || balls.length === 0) return;

    const ball = selectBallCandidate(balls, activeFootPosRef.current, prevBallSampleRef.current);
    if (!ball) return;

    const center = getBallCenter(ball);
    if (!center || ball.bbox.length < 4) return;

    ballDetectionsRef.current += 1;

    const [x, y, width, height] = ball.bbox;
    ctx.strokeStyle = "rgba(4, 217, 255, 0.9)";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ballTrajectoryRef.current.push(center);
    if (ballTrajectoryRef.current.length > MAX_TRAJECTORY_POINTS) {
      ballTrajectoryRef.current.shift();
    }

    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 165, 0, 0.5)";
    ctx.lineWidth = 2;
    ballTrajectoryRef.current.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();

    const previous = prevBallSampleRef.current;
    if (previous) {
      const dtSeconds = Math.max((timestampMs - previous.timeMs) / 1000, 1 / 120);
      const ballVelocityPxPerSecond = calculateDistance(center, previous) / dtSeconds;

      if (
        ballVelocityPxPerSecond > BALL_VELOCITY_THRESHOLD_PX_PER_SECOND &&
        impactFrameIndexRef.current === -1
      ) {
        const activeFoot = activeFootPosRef.current;
        const distToFoot = activeFoot ? calculateDistance(center, activeFoot) : Number.POSITIVE_INFINITY;
        const impactDistanceThreshold = Math.max(100, Math.min(260, canvas.width * 0.22));
        const hasFootConfirmation = activeFoot ? distToFoot < impactDistanceThreshold : false;
        const hasBallOnlyConfirmation = !activeFoot || poseDetectionsRef.current < 3;
        const hasStrongBallConfirmation =
          ballDetectionsRef.current >= 3 &&
          ballVelocityPxPerSecond > BALL_VELOCITY_THRESHOLD_PX_PER_SECOND * 1.6;

        if (hasFootConfirmation || hasBallOnlyConfirmation || hasStrongBallConfirmation) {
          setImpactDetected(true);
          impactFrameIndexRef.current = frameCounterRef.current;
          impactTimeMsRef.current = timestampMs;
          ballStartPosRef.current = { x: previous.x, y: previous.y };
          ballStartTimeMsRef.current = previous.timeMs;
        }
      }
    }

    if (
      impactTimeMsRef.current !== null &&
      timestampMs <= impactTimeMsRef.current + BALL_TRACKING_WINDOW_AFTER_IMPACT_MS &&
      ballStartTimeMsRef.current !== null &&
      timestampMs > ballStartTimeMsRef.current
    ) {
      ballEndPosRef.current = center;
      ballEndTimeMsRef.current = timestampMs;
    }

    prevBallSampleRef.current = {
      ...center,
      timeMs: timestampMs,
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPT_IN_STORAGE_KEY, String(optIn));
    } catch {
      // Ignore storage failures; opt-in still works for the current page session.
    }
  }, [optIn]);

  useEffect(() => {
    try {
      localStorage.setItem(PLAYER_HEIGHT_STORAGE_KEY, playerHeightCm);
    } catch {
      // Ignore storage failures; the current state remains usable.
    }
  }, [playerHeightCm]);

  useEffect(() => {
    let disposed = false;

    try {
      poseWorkerRef.current = new Worker(new URL("../../lib/workers/pose.worker.ts", import.meta.url));
      ballWorkerRef.current = new Worker(new URL("../../lib/workers/ball.worker.ts", import.meta.url));
    } catch (error) {
      console.error("Worker creation failed", error);
      queueMicrotask(() => {
        if (disposed) return;
        setModelError("브라우저에서 분석 워커를 시작하지 못했습니다.");
        setIsPoseLoading(false);
        setIsBallLoading(false);
      });
      return () => {
        disposed = true;
      };
    }

    poseWorkerRef.current.onmessage = (e: MessageEvent<VisionWorkerMessage>) => {
      if (disposed) return;
      const { type, landmarks = [], requestId, timestamp = performance.now(), error } = e.data;

      if (type === "INIT_SUCCESS") {
        setIsPoseLoading(false);
      } else if (type === "INIT_ERROR") {
        console.error("Pose Worker init error", error);
        setModelError("자세 분석 모델을 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.");
        setIsPoseLoading(false);
      } else if (type === "DETECT_RESULT") {
        if (requestId === undefined || requestId !== pendingPoseRequestIdRef.current) return;
        pendingPoseRequestIdRef.current = null;
        isPoseProcessingRef.current = false;
        processPoseResult(landmarks, timestamp);
      }
    };

    ballWorkerRef.current.onmessage = (e: MessageEvent<VisionWorkerMessage>) => {
      if (disposed) return;
      const { type, balls = [], requestId, timestamp = performance.now(), error } = e.data;

      if (type === "INIT_SUCCESS") {
        setIsBallLoading(false);
      } else if (type === "INIT_ERROR") {
        console.error("Ball Worker init error", error);
        setModelError("공 추적 모델을 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.");
        setIsBallLoading(false);
      } else if (type === "DETECT_RESULT") {
        if (requestId === undefined || requestId !== pendingBallRequestIdRef.current) return;
        pendingBallRequestIdRef.current = null;
        isBallProcessingRef.current = false;
        processBallResult(balls, timestamp);
      }
    };

    poseWorkerRef.current.postMessage({ type: "INIT" });
    ballWorkerRef.current.postMessage({ type: "INIT" });

    return () => {
      disposed = true;
      poseWorkerRef.current?.terminate();
      ballWorkerRef.current?.terminate();
      poseWorkerRef.current = null;
      ballWorkerRef.current = null;
    };
  }, [processBallResult, processPoseResult]);

  useEffect(() => {
    return () => {
      analysisRunIdRef.current += 1;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      revokeCurrentVideoUrl();
    };
  }, [revokeCurrentVideoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!videoUrl || !video) return;

    const frameId = requestAnimationFrame(() => {
      try {
        video.load();
      } catch {
        // Mobile browsers may reject explicit loads for transient blob URLs.
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [videoUrl]);

  useEffect(() => {
    referenceCalibrationRef.current = referenceCalibration;
  }, [referenceCalibration]);

  useEffect(() => {
    let disposed = false;

    fetch("/api/reference-calibration", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { calibration?: ReferenceCalibrationSummary } | null) => {
        if (disposed) return;
        setReferenceCalibration(data?.calibration ?? null);
      })
      .catch(() => {
        if (!disposed) setReferenceCalibration(null);
      });

    return () => {
      disposed = true;
    };
  }, []);

  const persistAnalysis = useCallback(
    async (result: AnalysisResult) => {
      if (result.estimatedSpeedKmh <= 0 || result.confidence === "failed") return;

      try {
        const deviceId = getOrCreateDeviceId();

        await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            nickname: "Guest Player",
            estimatedSpeedKmh: result.estimatedSpeedKmh,
            formScore: result.formResult.score,
            kickType: result.kickType,
            ballDisplacementPx: result.ballDisplacementPx,
            kickerHeightPx: result.kickerHeightPx,
          }),
        });

        if (optIn && videoFile) {
          const formData = new FormData();
          formData.append("video", videoFile);
          formData.append("deviceId", deviceId);
          formData.append("speed", result.estimatedSpeedKmh.toString());

          await fetch("/api/dataset/upload", {
            method: "POST",
            body: formData,
          });
        }
      } catch (error) {
        console.error("Failed to persist analysis", error);
      }
    },
    [optIn, videoFile]
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      const isVideoFile =
        file.type.startsWith("video/") ||
        (!file.type && MOBILE_VIDEO_EXTENSION_PATTERN.test(file.name));

      if (!isVideoFile) {
        alert("영상 파일만 업로드할 수 있습니다.");
        return;
      }

      if (file.size > MAX_CLIENT_VIDEO_SIZE_BYTES) {
        alert("100MB 이하의 짧은 영상을 업로드해 주세요.");
        return;
      }

      analysisRunIdRef.current += 1;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      revokeCurrentVideoUrl();
      resetTrackingRefs();

      const nextUrl = URL.createObjectURL(file);
      videoUrlRef.current = nextUrl;
      setVideoFile(file);
      setVideoUrl(nextUrl);
      setAnalysisResult(null);
      setImpactDetected(false);
      setAnalysisProgress(0);
      setVideoPreviewAspectRatio(DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO);
      setVideoPreviewError(null);
      setIsAnalyzing(false);
      setIsPersistingAnalysis(false);
      ballWorkerRef.current?.postMessage({ type: "RESET" });
    },
    [resetTrackingRefs, revokeCurrentVideoUrl]
  );

  const resetVideo = useCallback(() => {
    analysisRunIdRef.current += 1;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    videoRef.current?.pause();
    revokeCurrentVideoUrl();
    resetTrackingRefs();
    setVideoFile(null);
    setVideoUrl(null);
    setVideoPreviewAspectRatio(DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO);
    setVideoPreviewError(null);
    setAnalysisResult(null);
    setImpactDetected(false);
    setAnalysisProgress(0);
    setIsAnalyzing(false);
    setIsPersistingAnalysis(false);
    ballWorkerRef.current?.postMessage({ type: "RESET" });
  }, [resetTrackingRefs, revokeCurrentVideoUrl]);

  const reloadForAnotherVideo = useCallback(() => {
    if (isPersistingAnalysis) return;
    analysisRunIdRef.current += 1;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    videoRef.current?.pause();
    ballWorkerRef.current?.postMessage({ type: "RESET" });
    revokeCurrentVideoUrl();
    resetTrackingRefs();
    window.location.reload();
  }, [isPersistingAnalysis, resetTrackingRefs, revokeCurrentVideoUrl]);

  const buildFinalResult = useCallback((): AnalysisResult => {
    const formResult = formResultRef.current;
    const ballStartPos = ballStartPosRef.current;
    const ballEndPos = ballEndPosRef.current;
    const ballStartTimeMs = ballStartTimeMsRef.current;
    const ballEndTimeMs = ballEndTimeMsRef.current;
    const nosePos = nosePosRef.current;
    const anklePos = anklePosRef.current;
    const hasCompleteSpeedData =
      impactFrameIndexRef.current !== -1 &&
      ballStartPos &&
      ballEndPos &&
      ballStartTimeMs !== null &&
      ballEndTimeMs !== null &&
      nosePos &&
      anklePos &&
      formResult;

    let finalSpeed = 0;
    let rawSpeed = 0;
    let estimatedDistanceMeters: number | undefined;
    let ballDisplacementPx: number | undefined;
    let kickerHeightPx: number | undefined;
    let confidence: Confidence = "failed";
    let finalFormResult: FormResult = formResult ?? { score: 0, kneeAngle: 0, torsoLeanAngle: 0 };
    let feedbacks: string[] = [
      "임팩트를 명확히 찾지 못했습니다. 공과 전신이 잘 보이는 짧은 영상을 다시 업로드해 주세요.",
    ];
    let appliedReferenceCalibration: AnalysisResult["referenceCalibration"];
    let appliedReferenceDistance: AnalysisResult["referenceDistance"];

    if (hasCompleteSpeedData) {
      const elapsedSeconds = (ballEndTimeMs - ballStartTimeMs) / 1000;
      const parsedHeightCm = Number.parseFloat(playerHeightCm);
      const playerHeightM =
        Number.isFinite(parsedHeightCm)
          ? Math.min(2.2, Math.max(1.2, parsedHeightCm / 100))
          : DEFAULT_PLAYER_HEIGHT_CM / 100;
      ballDisplacementPx = calculateDistance(ballStartPos, ballEndPos);
      kickerHeightPx = calculateDistance(nosePos, anklePos);
      rawSpeed = estimateSpeedKmhFromSeconds(
        nosePos,
        anklePos,
        ballStartPos,
        ballEndPos,
        elapsedSeconds,
        playerHeightM
      );
      finalSpeed = applyReferenceCalibration(rawSpeed, referenceCalibrationRef.current);
      estimatedDistanceMeters = estimateReferenceDistanceMeters(ballDisplacementPx, referenceCalibrationRef.current) ?? undefined;

      if (finalSpeed > 0) {
        confidence = "high";
        finalFormResult = formResult;
        feedbacks = generateFeedback(formResult, finalSpeed);
        const referenceFeedbacks: string[] = [];

        if (referenceCalibrationRef.current?.enabled && referenceCalibrationRef.current.sampleCount > 0) {
          appliedReferenceCalibration = {
            factor: referenceCalibrationRef.current.factor,
            sampleCount: referenceCalibrationRef.current.sampleCount,
          };
          referenceFeedbacks.push(
            `레퍼런스 영상 ${referenceCalibrationRef.current.sampleCount}개 기준으로 구속을 보정했습니다.`
          );
        }

        if (
          estimatedDistanceMeters !== undefined &&
          referenceCalibrationRef.current?.distanceEnabled &&
          referenceCalibrationRef.current.metersPerPixel
        ) {
          appliedReferenceDistance = {
            metersPerPixel: referenceCalibrationRef.current.metersPerPixel,
            sampleCount: referenceCalibrationRef.current.distanceSampleCount,
          };
          referenceFeedbacks.push(
            `레퍼런스 거리 기준으로 공 이동거리를 ${estimatedDistanceMeters.toFixed(1)}m로 추정했습니다.`
          );
        }

        if (referenceFeedbacks.length > 0) {
          feedbacks = [...referenceFeedbacks, ...feedbacks];
        }
      }
    }

    if (confidence === "failed" && formResult) {
      confidence = "partial";
      finalFormResult = formResult;
      feedbacks = [
        "자세는 분석했지만 공의 이동 구간이 짧아 구속은 산출하지 않았습니다.",
        ...generateFeedback(formResult, 0).slice(0, 2),
      ];
    }

    if (confidence === "failed" && ballDetectionsRef.current > 0) {
      confidence = "partial";
      feedbacks = [
        `공 후보 ${ballDetectionsRef.current}개 프레임을 추적했지만, 전신 기준점이 부족해 구속은 산출하지 않았습니다.`,
        "공과 키커 전신이 같은 화면에 더 크게 보이도록 촬영하면 속도 산출이 안정적입니다.",
      ];
    }

    const kickType =
      activeFootSideRef.current === "left"
        ? "Left-foot Instep"
        : activeFootSideRef.current === "right"
          ? "Right-foot Instep"
          : "Instep Power";

    return {
      framesAnalyzed: frameCounterRef.current,
      estimatedSpeedKmh: finalSpeed,
      rawSpeedKmh: rawSpeed || undefined,
      estimatedDistanceMeters,
      ballDisplacementPx,
      kickerHeightPx,
      formResult: finalFormResult,
      feedbacks,
      kickType,
      confidence,
      referenceCalibration: appliedReferenceCalibration,
      referenceDistance: appliedReferenceDistance,
    };
  }, [playerHeightCm]);

  const waitForWorkerFrame = useCallback((runId: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const startedAt = performance.now();

      const check = () => {
        if (analysisRunIdRef.current !== runId) {
          resolve(false);
          return;
        }

        if (pendingPoseRequestIdRef.current === null && pendingBallRequestIdRef.current === null) {
          resolve(true);
          return;
        }

        if (performance.now() - startedAt > FRAME_WORKER_TIMEOUT_MS) {
          console.warn("Frame analysis timed out");
          isPoseProcessingRef.current = false;
          isBallProcessingRef.current = false;
          pendingPoseRequestIdRef.current = null;
          pendingBallRequestIdRef.current = null;
          resolve(false);
          return;
        }

        requestAnimationFrame(check);
      };

      check();
    });
  }, []);

  const startAnalysis = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const poseWorker = poseWorkerRef.current;
    const ballWorker = ballWorkerRef.current;

    if (!video || !canvas || !poseWorker || !ballWorker || isModelLoading || modelError) return;

    const runId = analysisRunIdRef.current + 1;
    analysisRunIdRef.current = runId;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    resetTrackingRefs();
    setAnalysisResult(null);
    setImpactDetected(false);
    setAnalysisProgress(0);
    setIsAnalyzing(true);

    try {
      await waitForVideoData(video);
      video.pause();
      video.currentTime = 0;
      await waitForVideoSeek(video, 0);
    } catch (error) {
      console.error("Failed to start video analysis", error);
      setIsAnalyzing(false);
      alert("영상 데이터를 불러오지 못했습니다. 짧은 MP4/MOV 파일로 다시 시도해 주세요.");
      return;
    }

    const analysisFrameSize = getAnalysisFrameSize(video);
    canvas.width = analysisFrameSize.width || video.videoWidth || canvas.clientWidth;
    canvas.height = analysisFrameSize.height || video.videoHeight || canvas.clientHeight;
    const frameCaptureCanvas = frameCaptureCanvasRef.current ?? document.createElement("canvas");
    frameCaptureCanvasRef.current = frameCaptureCanvas;

    const finishAnalysis = () => {
      if (analysisRunIdRef.current !== runId) return;
      setIsAnalyzing(false);
      isPoseProcessingRef.current = false;
      isBallProcessingRef.current = false;
      pendingPoseRequestIdRef.current = null;
      pendingBallRequestIdRef.current = null;

      const result = buildFinalResult();
      setAnalysisResult(result);
      setIsPersistingAnalysis(true);
      persistAnalysis(result).finally(() => {
        if (analysisRunIdRef.current === runId) {
          setIsPersistingAnalysis(false);
        }
      });
    };

    const processFrames = async () => {
      const ctx = canvas.getContext("2d");
      const sourceDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : MAX_ANALYSIS_SECONDS;
      const analysisDuration = Math.min(sourceDuration, MAX_ANALYSIS_SECONDS);
      const sampleInterval = Math.max(1 / ANALYSIS_SAMPLE_FPS, analysisDuration / MAX_ANALYSIS_FRAMES);
      const totalFrames = Math.max(1, Math.min(MAX_ANALYSIS_FRAMES, Math.floor(analysisDuration / sampleInterval) + 1));

      ballWorker.postMessage({ type: "RESET" });

      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        if (analysisRunIdRef.current !== runId) return;

        const targetTime = Math.min(analysisDuration, frameIndex * sampleInterval);
        await waitForVideoSeek(video, targetTime);

        if (analysisRunIdRef.current !== runId) return;

        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        frameCounterRef.current += 1;

        let poseFrame: WorkerFrame | null = null;
        let ballFrame: WorkerFrame | null = null;

        try {
          isPoseProcessingRef.current = true;
          isBallProcessingRef.current = true;

          const timestamp = targetTime * 1000;
          const frameRequestId = (frameRequestIdRef.current += 1);
          pendingPoseRequestIdRef.current = frameRequestId;
          pendingBallRequestIdRef.current = frameRequestId;

          poseFrame = await createWorkerFrame(video, frameCaptureCanvas, canvas.width, canvas.height);
          ballFrame = await createWorkerFrame(video, frameCaptureCanvas, canvas.width, canvas.height);

          if (analysisRunIdRef.current !== runId) {
            closeWorkerFrame(poseFrame);
            closeWorkerFrame(ballFrame);
            pendingPoseRequestIdRef.current = null;
            pendingBallRequestIdRef.current = null;
            return;
          }

          poseWorker.postMessage(
            {
              type: "DETECT",
              imageBitmap: poseFrame,
              timestamp,
              requestId: frameRequestId,
            },
            getFrameTransferList(poseFrame)
          );
          poseFrame = null;

          ballWorker.postMessage(
            {
              type: "DETECT",
              imageBitmap: ballFrame,
              timestamp,
              requestId: frameRequestId,
            },
            getFrameTransferList(ballFrame)
          );
          ballFrame = null;

          await waitForWorkerFrame(runId);
        } catch (error) {
          console.error("Frame dispatch failed", error);
          closeWorkerFrame(poseFrame);
          closeWorkerFrame(ballFrame);
          isPoseProcessingRef.current = false;
          isBallProcessingRef.current = false;
          pendingPoseRequestIdRef.current = null;
          pendingBallRequestIdRef.current = null;
        }

        setAnalysisProgress(Math.round(((frameIndex + 1) / totalFrames) * 100));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      finishAnalysis();
    };

    processFrames().catch((error) => {
      console.error("Analysis loop failed", error);
      if (analysisRunIdRef.current !== runId) return;
      setIsAnalyzing(false);
      isPoseProcessingRef.current = false;
      isBallProcessingRef.current = false;
      pendingPoseRequestIdRef.current = null;
      pendingBallRequestIdRef.current = null;
      alert("분석 중 오류가 발생했습니다. 다른 영상으로 다시 시도해 주세요.");
    });
  }, [buildFinalResult, isModelLoading, modelError, persistAnalysis, resetTrackingRefs, waitForWorkerFrame]);

  const handleShare = async () => {
    if (!shareCardRef.current || !analysisResult || analysisResult.confidence === "failed") return;
    setIsSharing(true);

    try {
      const canvas = await html2canvas(shareCardRef.current, {
        backgroundColor: "#000000",
        scale: 2,
      });
      const blob = await canvasToBlob(canvas);
      const file = new File([blob], "freekick-result.png", { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: "My Freekick Analysis",
            text: `I just hit ${analysisResult.estimatedSpeedKmh}km/h with a form score of ${analysisResult.formResult.score}!`,
            files: [file],
          });
        } catch (shareError) {
          const isAbort = shareError instanceof DOMException && shareError.name === "AbortError";
          if (!isAbort) triggerDownload(blob);
        }
      } else {
        triggerDownload(blob);
      }
    } catch (error) {
      console.error("Failed to generate share image", error);
      alert("결과 이미지를 만들지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setIsSharing(false);
    }
  };

  const triggerDownload = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "freekick-result.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const modelStatusText = modelError ? "MODEL ERROR" : isModelLoading ? "LOADING MODELS" : "ANALYSIS READY";

  return (
    <div className="min-h-screen flex flex-col p-8 relative">
      <header className="w-full max-w-4xl mx-auto flex flex-col gap-4 mb-12 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>Back to Home</span>
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/admin/references"
            className="flex items-center justify-center gap-2 rounded-full border border-[var(--color-neon-green)]/40 px-4 py-2 text-sm font-bold text-[var(--color-neon-green)] transition-colors hover:bg-[var(--color-neon-green)]/10"
          >
            <Database size={16} />
            Reference DB
          </Link>
          <div className="font-mono text-sm tracking-widest text-[var(--color-neon-green)] flex items-center justify-center gap-2">
            {isModelLoading && <Loader2 size={14} className="animate-spin" />}
            {modelError && <AlertTriangle size={14} className="text-yellow-300" />}
            {modelStatusText}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto flex flex-col items-center">
        {!videoUrl ? (
          <div className="w-full max-w-2xl mt-12 flex flex-col gap-6">
            <div className="bg-white/5 backdrop-blur-sm border border-white/20 rounded-3xl p-8 flex flex-col items-center">
              <h2 className="text-2xl font-bold mb-2">Upload your Freekick Video</h2>
              <p className="text-gray-400 text-sm max-w-sm text-center mb-8">
                Make sure your full body and the ball are visible. We recommend recording at 60fps or higher.
              </p>

              <label className="w-full max-w-md mb-6 flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                <span className="text-sm font-bold text-white">키 보정</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="120"
                    max="220"
                    inputMode="decimal"
                    value={playerHeightCm}
                    onChange={(e) => setPlayerHeightCm(e.target.value)}
                    className="w-24 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-right text-sm font-bold text-white outline-none focus:border-[var(--color-neon-green)]"
                    aria-label="Player height in centimeters"
                  />
                  <span className="text-xs font-mono text-gray-400">cm</span>
                </div>
              </label>

              {modelError && (
                <div className="w-full max-w-md mb-6 flex items-start gap-3 rounded-xl border border-yellow-300/30 bg-yellow-300/10 p-4 text-sm text-yellow-100">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                  <span>{modelError}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                <label className="flex-1 flex flex-col items-center justify-center gap-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 cursor-pointer transition-colors group">
                  <input type="file" accept="video/*" capture="environment" className="hidden" onChange={handleFileUpload} />
                  <Camera size={30} className="text-[var(--color-neon-green)] group-hover:scale-110 transition-transform" />
                  <span className="font-bold text-sm">카메라로 촬영</span>
                </label>

                <label className="flex-1 flex flex-col items-center justify-center gap-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 cursor-pointer transition-colors group">
                  <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
                  <ImageIcon size={30} className="text-[var(--color-neon-blue)] group-hover:scale-110 transition-transform" />
                  <span className="font-bold text-sm">앨범에서 선택</span>
                </label>
              </div>
            </div>

            <label className="flex items-start gap-3 p-4 bg-white/5 border border-white/10 rounded-xl cursor-pointer hover:bg-white/10 transition-colors">
              <input
                type="checkbox"
                className="mt-1 w-5 h-5 accent-[var(--color-neon-green)] cursor-pointer"
                checked={optIn}
                onChange={(e) => setOptIn(e.target.checked)}
              />
              <div className="flex flex-col">
                <span className="font-bold text-sm text-white">AI 학습 데이터 제공 동의 (선택)</span>
                <span className="text-xs text-gray-400 mt-1">
                  동의 시 업로드하신 영상이 안전하게 저장되며, 더 정확한 프리킥 전용 AI 모델을 훈련하는 데 사용됩니다.
                </span>
              </div>
            </label>
          </div>
        ) : (
          <div className="w-full flex flex-col items-center gap-8">
            <div
              className="relative w-full max-w-3xl max-h-[60svh] bg-black rounded-xl overflow-hidden border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.5)]"
              style={{ aspectRatio: videoPreviewAspectRatio }}
            >
              <video
                key={videoUrl}
                ref={videoRef}
                src={videoUrl}
                className="absolute inset-0 h-full w-full object-contain"
                controls
                playsInline
                muted
                preload="auto"
                onLoadedMetadata={(e) => {
                  syncVideoPreview(e.currentTarget);
                }}
                onLoadedData={(e) => {
                  syncVideoPreview(e.currentTarget);
                }}
                onCanPlay={(e) => {
                  syncVideoPreview(e.currentTarget);
                }}
                onError={() => {
                  setVideoPreviewError("이 브라우저에서 영상 미리보기를 불러오지 못했습니다.");
                }}
              >
                브라우저가 영상 미리보기를 지원하지 않습니다.
              </video>
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-contain pointer-events-none" />

              {videoPreviewError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-sm text-yellow-100">
                  {videoPreviewError}
                </div>
              )}

              {isAnalyzing && (
                <div className="absolute top-4 right-4 bg-black/50 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 border border-white/10 text-sm font-mono text-[var(--color-neon-green)]">
                  <Activity size={16} className="animate-pulse" />
                  ANALYZING {analysisProgress}%
                </div>
              )}

              {impactDetected && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[var(--color-neon-green)]/20 text-[var(--color-neon-green)] border border-[var(--color-neon-green)] px-6 py-2 rounded-full font-bold animate-bounce font-mono">
                  IMPACT DETECTED!
                </div>
              )}
            </div>

            {!isAnalyzing && !analysisResult && (
              <div className="flex flex-col sm:flex-row gap-4">
                <button onClick={resetVideo} className="px-6 py-3 rounded-full font-bold border border-white/20 hover:bg-white/10 transition-colors flex items-center justify-center gap-2">
                  <RefreshCw size={18} />
                  Choose Another
                </button>
                <button
                  onClick={startAnalysis}
                  disabled={isModelLoading || Boolean(modelError)}
                  className="px-8 py-3 rounded-full font-bold bg-white text-black hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isModelLoading ? <Loader2 className="animate-spin" size={20} /> : <Play size={20} />}
                  {isModelLoading ? "Loading AI Models" : "Start AI Analysis"}
                </button>
              </div>
            )}

            {analysisResult && (
              <div className="w-full max-w-3xl flex flex-col gap-6 animate-in slide-in-from-bottom-8 fade-in duration-700">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-green)] hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(57,255,20,0.1)] hover:shadow-[0_0_30px_rgba(57,255,20,0.3)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">ESTIMATED SPEED</div>
                    <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 drop-shadow-sm">{analysisResult.estimatedSpeedKmh}</div>
                    <div className="text-sm text-[var(--color-neon-green)] mt-2 font-mono font-bold tracking-widest">km/h</div>
                    <div className="mt-3 text-[10px] font-mono tracking-widest text-gray-500">
                      {analysisResult.referenceCalibration
                        ? `REF x${analysisResult.referenceCalibration.factor.toFixed(3)}`
                        : analysisResult.confidence === "high"
                          ? "TIME-BASED"
                          : "NOT ENOUGH BALL DATA"}
                    </div>
                    {analysisResult.referenceDistance && analysisResult.estimatedDistanceMeters !== undefined && (
                      <div className="mt-2 text-[10px] font-mono tracking-widest text-[var(--color-neon-blue)]">
                        DIST {analysisResult.estimatedDistanceMeters.toFixed(1)} m
                      </div>
                    )}
                  </div>

                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-blue)] hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(0,255,255,0.1)] hover:shadow-[0_0_30px_rgba(0,255,255,0.3)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">FORM SCORE</div>
                    <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 drop-shadow-sm">{analysisResult.formResult.score}</div>
                    <div className="text-sm text-[var(--color-neon-blue)] mt-2 font-mono font-bold tracking-widest">/ 100 pts</div>
                    <div className="mt-3 text-[10px] font-mono tracking-widest text-gray-500">
                      {analysisResult.framesAnalyzed} FRAMES
                    </div>
                  </div>

                  <div className="glass-card p-6 flex flex-col items-center justify-center text-center border-t-4 border-t-purple-500 hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(168,85,247,0.1)] hover:shadow-[0_0_30px_rgba(168,85,247,0.3)] relative group">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">KICK TYPE</div>
                    <div className="text-2xl font-bold text-white group-hover:text-purple-400 transition-colors">{analysisResult.kickType}</div>
                    <button
                      onClick={handleShare}
                      disabled={isSharing || analysisResult.confidence === "failed"}
                      className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors text-white disabled:opacity-50"
                      title="Share result"
                    >
                      {isSharing ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                    </button>
                  </div>
                </div>

                <div className="glass-card p-6 border-t-4 border-t-[var(--color-neon-green)]/50">
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <Activity size={20} className="text-[var(--color-neon-green)]" />
                    AI Feedback
                  </h3>
                  <ul className="space-y-3">
                    {analysisResult.feedbacks.map((feedback, index) => (
                      <li key={index} className="flex items-start gap-3 text-gray-300">
                        <span className="text-[var(--color-neon-green)] mt-1">✓</span>
                        <span>{feedback}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex justify-center mt-6">
                  <button
                    onClick={reloadForAnotherVideo}
                    disabled={isPersistingAnalysis}
                    className="px-8 py-4 rounded-full font-bold bg-gradient-to-r from-white/10 to-white/5 hover:from-[var(--color-neon-green)]/20 hover:to-[var(--color-neon-blue)]/20 border border-white/20 hover:border-white/40 transition-all hover:-translate-y-1 hover:shadow-[0_10px_40px_-10px_rgba(255,255,255,0.2)] flex items-center gap-3 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPersistingAnalysis ? <Loader2 size={20} className="animate-spin" /> : <ArrowLeft size={20} />}
                    {isPersistingAnalysis ? "결과 저장 중" : "다른 영상 분석하기"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <div className="absolute -left-[9999px] -top-[9999px]">
        {analysisResult && (
          <ShareCard
            ref={shareCardRef}
            speed={analysisResult.estimatedSpeedKmh}
            formScore={analysisResult.formResult.score}
            kickType={analysisResult.kickType}
          />
        )}
      </div>
    </div>
  );
}
