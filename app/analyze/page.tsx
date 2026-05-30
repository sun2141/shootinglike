"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Camera,
  ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Share2,
} from "lucide-react";
import Link from "next/link";
import { drawLandmarks, drawConnectors } from "@/lib/canvas-utils";
import { PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { estimateSpeedKmhFromSeconds } from "@/lib/analysis/speed";
import { calculateFormScore, type FormResult } from "@/lib/analysis/form";
import { generateFeedback } from "@/lib/analysis/feedback";
import { calculateDistance, type Point } from "@/lib/analysis/math";
import { ShareCard } from "@/components/ShareCard";
import html2canvas from "html2canvas";

const MAX_CLIENT_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND = 900;
const BALL_VELOCITY_THRESHOLD_PX_PER_SECOND = 600;
const BALL_TRACKING_WINDOW_AFTER_IMPACT_MS = 180;
const MAX_TRAJECTORY_POINTS = 90;

type FootSide = "left" | "right";
type Confidence = "high" | "partial" | "failed";

interface AnalysisResult {
  framesAnalyzed: number;
  estimatedSpeedKmh: number;
  formResult: FormResult;
  feedbacks: string[];
  kickType: string;
  confidence: Confidence;
}

interface TimedPoint extends Point {
  timeMs: number;
}

interface BallPrediction {
  bbox: number[];
  score?: number;
  class?: string;
}

interface VisionWorkerMessage {
  type: "INIT_SUCCESS" | "INIT_ERROR" | "DETECT_RESULT";
  error?: string;
  requestId?: number;
  timestamp?: number;
  landmarks?: NormalizedLandmark[][];
  balls?: BallPrediction[];
}

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

function selectBallCandidate(balls: BallPrediction[], activeFoot: Point | null): BallPrediction | null {
  let selected: BallPrediction | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  for (const ball of balls) {
    const center = getBallCenter(ball);
    if (!center) continue;

    const modelScore = ball.score ?? 0.5;
    const footDistancePenalty = activeFoot ? calculateDistance(center, activeFoot) * 0.003 : 0;
    const rankingScore = modelScore - footDistancePenalty;

    if (rankingScore > selectedScore) {
      selected = ball;
      selectedScore = rankingScore;
    }
  }

  return selected;
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

function waitForVideoData(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("error", handleError);
    };
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Video metadata could not be loaded."));
    };

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("error", handleError);
  });
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
  const [isPoseLoading, setIsPoseLoading] = useState(true);
  const [isBallLoading, setIsBallLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const isModelLoading = isPoseLoading || isBallLoading;

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [impactDetected, setImpactDetected] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseWorkerRef = useRef<Worker | null>(null);
  const ballWorkerRef = useRef<Worker | null>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  const [isSharing, setIsSharing] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const prevFootSamplesRef = useRef<Partial<Record<FootSide, TimedPoint>>>({});
  const prevBallSampleRef = useRef<TimedPoint | null>(null);

  const isPoseProcessingRef = useRef(false);
  const isBallProcessingRef = useRef(false);
  const analysisRunIdRef = useRef(0);

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

  const resetTrackingRefs = useCallback(() => {
    prevFootSamplesRef.current = {};
    prevBallSampleRef.current = null;
    isPoseProcessingRef.current = false;
    isBallProcessingRef.current = false;
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
  }, []);

  const revokeCurrentVideoUrl = useCallback(() => {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
  }, []);

  const processPoseResult = useCallback((landmarks: NormalizedLandmark[][], timestampMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || landmarks.length === 0) return;

    for (const landmark of landmarks) {
      drawLandmarks(ctx, landmark);
      drawConnectors(ctx, landmark, PoseLandmarker.POSE_CONNECTIONS, {
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
        fastestFoot.velocityPxPerSecond > FOOT_VELOCITY_THRESHOLD_PX_PER_SECOND &&
        impactFrameIndexRef.current === -1
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
      }
    }
  }, []);

  const processBallResult = useCallback((balls: BallPrediction[], timestampMs: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || balls.length === 0) return;

    const ball = selectBallCandidate(balls, activeFootPosRef.current);
    if (!ball) return;

    const center = getBallCenter(ball);
    if (!center || ball.bbox.length < 4) return;

    const [x, y, width, height] = ball.bbox;
    ctx.strokeStyle = "rgba(255, 165, 0, 0.9)";
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
        activeFootPosRef.current &&
        impactFrameIndexRef.current === -1
      ) {
        const distToFoot = calculateDistance(center, activeFootPosRef.current);
        const impactDistanceThreshold = Math.max(100, Math.min(260, canvas.width * 0.22));

        if (distToFoot < impactDistanceThreshold) {
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
        isPoseProcessingRef.current = false;
        if (requestId === analysisRunIdRef.current) {
          processPoseResult(landmarks, timestamp);
        }
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
        isBallProcessingRef.current = false;
        if (requestId === analysisRunIdRef.current) {
          processBallResult(balls, timestamp);
        }
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

  const persistAnalysis = useCallback(
    (result: AnalysisResult) => {
      if (result.estimatedSpeedKmh <= 0 || result.confidence === "failed") return;

      try {
        const deviceId = getOrCreateDeviceId();

        fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceId,
            nickname: "Guest Player",
            estimatedSpeedKmh: result.estimatedSpeedKmh,
            formScore: result.formResult.score,
            kickType: result.kickType,
          }),
        }).catch(console.error);

        if (optIn && videoFile) {
          const formData = new FormData();
          formData.append("video", videoFile);
          formData.append("deviceId", deviceId);
          formData.append("speed", result.estimatedSpeedKmh.toString());

          fetch("/api/dataset/upload", {
            method: "POST",
            body: formData,
          }).catch(console.error);
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

      if (!file.type.startsWith("video/")) {
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
      setIsAnalyzing(false);
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
    setAnalysisResult(null);
    setImpactDetected(false);
    setIsAnalyzing(false);
  }, [resetTrackingRefs, revokeCurrentVideoUrl]);

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
    let confidence: Confidence = "failed";
    let finalFormResult: FormResult = formResult ?? { score: 0, kneeAngle: 0, torsoLeanAngle: 0 };
    let feedbacks: string[] = [
      "임팩트를 명확히 찾지 못했습니다. 공과 전신이 잘 보이는 짧은 영상을 다시 업로드해 주세요.",
    ];

    if (hasCompleteSpeedData) {
      const elapsedSeconds = (ballEndTimeMs - ballStartTimeMs) / 1000;
      finalSpeed = estimateSpeedKmhFromSeconds(
        nosePos,
        anklePos,
        ballStartPos,
        ballEndPos,
        elapsedSeconds
      );

      if (finalSpeed > 0) {
        confidence = "high";
        finalFormResult = formResult;
        feedbacks = generateFeedback(formResult, finalSpeed);
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

    const kickType =
      activeFootSideRef.current === "left"
        ? "Left-foot Instep"
        : activeFootSideRef.current === "right"
          ? "Right-foot Instep"
          : "Instep Power";

    return {
      framesAnalyzed: frameCounterRef.current,
      estimatedSpeedKmh: finalSpeed,
      formResult: finalFormResult,
      feedbacks,
      kickType,
      confidence,
    };
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
    setIsAnalyzing(true);

    try {
      await waitForVideoData(video);
      video.currentTime = 0;
      await video.play();
    } catch (error) {
      console.error("Failed to start video analysis", error);
      setIsAnalyzing(false);
      alert("영상을 재생할 수 없습니다. 다른 파일을 선택해 주세요.");
      return;
    }

    canvas.width = video.videoWidth || canvas.clientWidth;
    canvas.height = video.videoHeight || canvas.clientHeight;

    const finishAnalysis = () => {
      if (analysisRunIdRef.current !== runId) return;
      setIsAnalyzing(false);
      isPoseProcessingRef.current = false;
      isBallProcessingRef.current = false;

      const result = buildFinalResult();
      setAnalysisResult(result);
      persistAnalysis(result);
    };

    const renderLoop = async () => {
      if (analysisRunIdRef.current !== runId) return;

      if (video.paused || video.ended) {
        finishAnalysis();
        return;
      }

      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      frameCounterRef.current += 1;

      if (!isPoseProcessingRef.current && !isBallProcessingRef.current) {
        try {
          isPoseProcessingRef.current = true;
          isBallProcessingRef.current = true;

          const timestamp = video.currentTime * 1000;
          const imageBitmap1 = await createImageBitmap(video);
          const imageBitmap2 = await createImageBitmap(video);

          if (analysisRunIdRef.current !== runId) {
            imageBitmap1.close();
            imageBitmap2.close();
            return;
          }

          poseWorker.postMessage(
            {
              type: "DETECT",
              imageBitmap: imageBitmap1,
              timestamp,
              requestId: runId,
            },
            [imageBitmap1]
          );

          ballWorker.postMessage(
            {
              type: "DETECT",
              imageBitmap: imageBitmap2,
              timestamp,
              requestId: runId,
            },
            [imageBitmap2]
          );
        } catch (error) {
          console.error("Frame dispatch failed", error);
          isPoseProcessingRef.current = false;
          isBallProcessingRef.current = false;
        }
      }

      animationFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animationFrameRef.current = requestAnimationFrame(renderLoop);
  }, [buildFinalResult, isModelLoading, modelError, persistAnalysis, resetTrackingRefs]);

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
      <header className="w-full max-w-4xl mx-auto flex items-center justify-between mb-12">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>Back to Home</span>
        </Link>
        <div className="font-mono text-sm tracking-widest text-[var(--color-neon-green)] flex items-center gap-2">
          {isModelLoading && <Loader2 size={14} className="animate-spin" />}
          {modelError && <AlertTriangle size={14} className="text-yellow-300" />}
          {modelStatusText}
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
            <div className="relative w-full max-w-3xl bg-black rounded-xl overflow-hidden border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.5)]">
              <video
                ref={videoRef}
                src={videoUrl}
                className="w-full h-auto max-h-[60vh] object-contain"
                crossOrigin="anonymous"
                playsInline
                muted
                onLoadedMetadata={(e) => {
                  if (canvasRef.current) {
                    canvasRef.current.width = e.currentTarget.videoWidth;
                    canvasRef.current.height = e.currentTarget.videoHeight;
                  }
                }}
              />
              <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full object-contain pointer-events-none" />

              {isAnalyzing && (
                <div className="absolute top-4 right-4 bg-black/50 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 border border-white/10 text-sm font-mono text-[var(--color-neon-green)]">
                  <Activity size={16} className="animate-pulse" />
                  ANALYZING...
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
                  Start AI Analysis
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
                      {analysisResult.confidence === "high" ? "TIME-BASED" : "NOT ENOUGH BALL DATA"}
                    </div>
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
                    onClick={resetVideo}
                    className="px-8 py-4 rounded-full font-bold bg-gradient-to-r from-white/10 to-white/5 hover:from-[var(--color-neon-green)]/20 hover:to-[var(--color-neon-blue)]/20 border border-white/20 hover:border-white/40 transition-all hover:-translate-y-1 hover:shadow-[0_10px_40px_-10px_rgba(255,255,255,0.2)] flex items-center gap-3"
                  >
                    <ArrowLeft size={20} />
                    다른 영상 분석하기
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
