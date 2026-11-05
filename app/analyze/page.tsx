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
import { type ReferenceCalibrationSummary } from "@/lib/analysis/reference-calibration";
import { getAnalysisFrameSize } from "@/lib/analysis/frame-size";
import { runVideoAnalysis, DEFAULT_PLAYER_HEIGHT_CM } from "@/lib/analysis/pipeline/run-analysis";
import {
  BALL_SPECS,
  DEFAULT_BALL_SIZE_ID,
  type BallSizeId,
} from "@/lib/analysis/scale-reference";
import { VisionWorkers } from "@/lib/analysis/pipeline/vision-workers";
import type { PipelineResult } from "@/lib/analysis/pipeline/types";
import { analyzeVideo } from "@/lib/ballspeed";
import type { Measurement } from "@/lib/ballspeed/types";
import { mergeMeasurement, measurementNotes, speedOnlyResult } from "@/lib/analysis/merge-measurement";
import { ShareCard } from "@/components/ShareCard";
import { KickRecorder } from "@/components/KickRecorder";
import html2canvas from "html2canvas";

const MAX_CLIENT_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;
const OPT_IN_STORAGE_KEY = "freekickDataOptIn";
/** 영상 원본 업로드(학습 데이터 동의). 서버 비용·한도 때문에 기본은 꺼 둔다 — app/api/dataset/upload 참고 */
const DATASET_UPLOAD_ENABLED = process.env.NEXT_PUBLIC_DATASET_UPLOAD === "1";
const PLAYER_HEIGHT_STORAGE_KEY = "freekickPlayerHeightCm";
const DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO = 16 / 9;
const MOBILE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;

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

const GRADE_LABEL: Record<string, string> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};

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
  const [isModelLoading, setIsModelLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResult, setAnalysisResult] = useState<PipelineResult | null>(null);
  // 속도 측정은 ballspeed(중력 검산) 모듈이 맡는다. 포즈 파이프라인은 자세 피드백·오버레이용.
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [impactDetected, setImpactDetected] = useState(false);
  const [isPersistingAnalysis, setIsPersistingAnalysis] = useState(false);
  const [referenceCalibration, setReferenceCalibration] = useState<ReferenceCalibrationSummary | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workersRef = useRef<VisionWorkers | null>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string | null>(null);
  const referenceCalibrationRef = useRef<ReferenceCalibrationSummary | null>(null);
  const analysisRunIdRef = useRef(0);

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
  const [playerHeightProvided, setPlayerHeightProvided] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(PLAYER_HEIGHT_STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  });
  const [ballSizeId, setBallSizeId] = useState<BallSizeId>(DEFAULT_BALL_SIZE_ID);
  const [videoFile, setVideoFile] = useState<File | null>(null);

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

  useEffect(() => {
    let disposed = false;
    let workers: VisionWorkers | null = null;

    try {
      workers = new VisionWorkers();
      workersRef.current = workers;
    } catch (error) {
      console.error("Worker creation failed", error);
      queueMicrotask(() => {
        if (disposed) return;
        setModelError("자세 분석 모델을 시작하지 못했습니다. 구속 측정은 그대로 됩니다.");
        setIsModelLoading(false);
      });
      return () => {
        disposed = true;
      };
    }

    workers.ready
      .then(() => {
        if (!disposed) setIsModelLoading(false);
      })
      .catch((error: Error) => {
        if (disposed) return;
        console.error("Model init failed", error);
        setModelError("자세 분석 모델을 불러오지 못했습니다(네트워크 확인). 구속 측정은 그대로 됩니다.");
        setIsModelLoading(false);
      });

    return () => {
      disposed = true;
      analysisRunIdRef.current += 1;
      workers?.terminate();
      workersRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      analysisRunIdRef.current += 1;
      revokeCurrentVideoUrl();
    };
  }, [revokeCurrentVideoUrl]);

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
    async (result: PipelineResult) => {
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

        if (DATASET_UPLOAD_ENABLED && optIn && videoFile) {
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

  const acceptVideoFile = useCallback(
    (file: File) => {
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
      revokeCurrentVideoUrl();

      const nextUrl = URL.createObjectURL(file);
      videoUrlRef.current = nextUrl;
      setVideoFile(file);
      setVideoUrl(nextUrl);
      setAnalysisResult(null);
      setMeasurement(null);
      setImpactDetected(false);
      setAnalysisProgress(0);
      setVideoPreviewAspectRatio(DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO);
      setVideoPreviewError(null);
      setIsAnalyzing(false);
      setIsPersistingAnalysis(false);
      workersRef.current?.reset();
    },
    [revokeCurrentVideoUrl]
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) acceptVideoFile(file);
    },
    [acceptVideoFile]
  );

  const resetVideo = useCallback(() => {
    analysisRunIdRef.current += 1;
    videoRef.current?.pause();
    revokeCurrentVideoUrl();
    setVideoFile(null);
    setVideoUrl(null);
    setVideoPreviewAspectRatio(DEFAULT_VIDEO_PREVIEW_ASPECT_RATIO);
    setVideoPreviewError(null);
    setAnalysisResult(null);
    setMeasurement(null);
    setImpactDetected(false);
    setAnalysisProgress(0);
    setIsAnalyzing(false);
    setIsPersistingAnalysis(false);
    workersRef.current?.reset();
  }, [revokeCurrentVideoUrl]);

  const reloadForAnotherVideo = useCallback(() => {
    if (isPersistingAnalysis) return;
    analysisRunIdRef.current += 1;
    videoRef.current?.pause();
    workersRef.current?.reset();
    revokeCurrentVideoUrl();
    window.location.reload();
  }, [isPersistingAnalysis, revokeCurrentVideoUrl]);

  const startAnalysis = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const workers = workersRef.current;

    // 자세 모델이 없어도 구속은 잴 수 있다. 모델 로딩 중일 때만 막는다.
    if (!video || !canvas || isModelLoading) return;
    const poseAvailable = Boolean(workers) && !modelError;

    const runId = analysisRunIdRef.current + 1;
    analysisRunIdRef.current = runId;

    setAnalysisResult(null);
    setMeasurement(null);
    setImpactDetected(false);
    setAnalysisProgress(0);
    setIsAnalyzing(true);

    try {
      const result = poseAvailable
        ? await runVideoAnalysis({
        video,
        workers: workers!,
        playerHeightCm: Number.parseFloat(playerHeightCm),
        playerHeightProvided,
        ballSizeId,
        calibration: referenceCalibrationRef.current,
        isCancelled: () => analysisRunIdRef.current !== runId,
        onProgress: ({ progress }) => {
          if (analysisRunIdRef.current === runId) setAnalysisProgress(Math.round(progress * 0.5));
        },
        onFrame: ({ observation, snapshot, frameWidth, frameHeight }) => {
          if (analysisRunIdRef.current !== runId) return;

          if (canvas.width !== frameWidth) canvas.width = frameWidth;
          if (canvas.height !== frameHeight) canvas.height = frameHeight;

          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          ctx.clearRect(0, 0, canvas.width, canvas.height);

          for (const landmarks of observation.landmarks) {
            drawLandmarks(ctx, landmarks);
            drawConnectors(ctx, landmarks, POSE_CONNECTIONS, {
              color: "rgba(0, 255, 0, 0.7)",
              lineWidth: 3,
            });
          }

          if (snapshot.ball) {
            const [x, y, width, height] = snapshot.ball.bbox;
            ctx.strokeStyle = "rgba(4, 217, 255, 0.9)";
            ctx.lineWidth = 3;
            ctx.strokeRect(x, y, width, height);
          }

          if (snapshot.trail.length > 1) {
            ctx.beginPath();
            ctx.strokeStyle = "rgba(255, 165, 0, 0.5)";
            ctx.lineWidth = 2;
            snapshot.trail.forEach((point, index) => {
              if (index === 0) ctx.moveTo(point.x, point.y);
              else ctx.lineTo(point.x, point.y);
            });
            ctx.stroke();
          }

          if (snapshot.impactJustDetected) setImpactDetected(true);
        },
          })
        : null;

      if (analysisRunIdRef.current !== runId) return;

      // 속도는 ballspeed 로 다시 잰다. 중력 검산을 통과한 값만 기록·공유된다.
      let measured: Measurement | null = null;
      if (videoFile) {
        try {
          measured = await analyzeVideo(videoFile, {
            ballSize: ballSizeId,
            onProgress: (p) => {
              if (analysisRunIdRef.current === runId) setAnalysisProgress(50 + Math.round(p * 50));
            },
          });
        } catch (error) {
          console.error("ballspeed measurement failed", error);
        }
      }
      if (analysisRunIdRef.current !== runId) return;

      if (!measured && !result) throw new Error("영상을 분석하지 못했습니다.");
      const finalResult = result
        ? (measured ? mergeMeasurement(result, measured) : result)
        : speedOnlyResult(measured!);
      setMeasurement(measured);
      setIsAnalyzing(false);
      setImpactDetected(finalResult.impactDetected);
      setAnalysisResult(finalResult);
      setIsPersistingAnalysis(true);
      persistAnalysis(finalResult).finally(() => {
        if (analysisRunIdRef.current === runId) setIsPersistingAnalysis(false);
      });
    } catch (error) {
      console.error("Analysis failed", error);
      if (analysisRunIdRef.current !== runId) return;
      setIsAnalyzing(false);
      alert("분석 중 오류가 발생했습니다. 다른 영상으로 다시 시도해 주세요.");
    }
  }, [ballSizeId, isModelLoading, modelError, persistAnalysis, playerHeightCm, playerHeightProvided, videoFile]);

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

  const modelStatusText = modelError ? "MODEL ERROR" : isModelLoading ? "LOADING MODELS" : "ANALYSIS READY";
  const uncertainty = analysisResult?.speedUncertainty ?? null;

  return (
    <div className="min-h-screen flex flex-col px-4 py-6 sm:p-8 relative">
      <header className="w-full max-w-4xl mx-auto flex flex-col gap-4 mb-12 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>홈으로</span>
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="font-mono text-sm tracking-widest text-[var(--color-neon-green)] flex items-center justify-center gap-2">
            {isModelLoading && <Loader2 size={14} className="animate-spin" />}
            {modelError && <AlertTriangle size={14} className="text-yellow-300" />}
            {modelStatusText}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto flex flex-col items-center">
        {isRecording ? (
          <div className="w-full max-w-2xl mt-6 flex flex-col gap-4">
            <h2 className="text-xl font-bold">킥 촬영</h2>
            <KickRecorder
              onRecorded={(file) => {
                setIsRecording(false);
                acceptVideoFile(file);
              }}
              onCancel={() => setIsRecording(false)}
            />
          </div>
        ) : !videoUrl ? (
          <div className="w-full max-w-2xl mt-12 flex flex-col gap-6">
            <div className="bg-white/5 backdrop-blur-sm border border-white/20 rounded-3xl p-8 flex flex-col items-center">
              <h2 className="text-2xl font-bold mb-2">프리킥 영상 올리기</h2>
              <p className="text-gray-400 text-sm max-w-sm text-center mb-4">
                아래 네 가지를 지키면 대부분 측정됩니다. 하나라도 어긋나면 속도를 내보내지 않고 이유를 알려드립니다.
              </p>
              <ul className="w-full max-w-md mb-8 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                {[
                  ["옆에서", "공이 날아가는 방향과 직각으로. 뒤나 앞에서 찍으면 못 잽니다"],
                  ["60fps 이상", "30fps 는 빠른 슛의 궤적이 남지 않습니다"],
                  ["폰 고정", "들고 따라가지 말고 세워두세요"],
                  ["킥 앞뒤 2~3초", "길게 찍을수록 엉뚱한 장면을 킥으로 볼 수 있습니다"],
                ].map(([title, desc]) => (
                  <li key={title} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                    <div className="font-bold text-white">{title}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
                  </li>
                ))}
              </ul>

              <div className="w-full max-w-md mb-6 flex flex-col gap-2">
                <label className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                  <span className="text-sm font-bold text-white">키 보정 (선택)</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="120"
                      max="220"
                      inputMode="decimal"
                      value={playerHeightCm}
                      onChange={(e) => {
                        setPlayerHeightCm(e.target.value);
                        setPlayerHeightProvided(true);
                      }}
                      className="w-24 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-right text-sm font-bold text-white outline-none focus:border-[var(--color-neon-green)]"
                      aria-label="Player height in centimeters"
                    />
                    <span className="text-xs font-mono text-gray-400">cm</span>
                  </div>
                </label>

                {/* The ball is a ruler of known size, so the height is optional. */}
                <label className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                  <span className="text-sm font-bold text-white">공 규격</span>
                  <select
                    value={ballSizeId}
                    onChange={(e) => setBallSizeId(e.target.value as BallSizeId)}
                    className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-bold text-white outline-none focus:border-[var(--color-neon-green)]"
                    aria-label="Ball size"
                  >
                    {BALL_SPECS.map((spec) => (
                      <option key={spec.id} value={spec.id} className="bg-black">
                        {spec.label}
                      </option>
                    ))}
                  </select>
                </label>

                <p className="px-1 text-xs text-gray-500">
                  구속은 규격이 고정된 <strong className="text-gray-300">공 크기</strong>로 환산하고, 공중의 공이 받는
                  중력(9.81 m/s²)과 맞는지 검산해 확인합니다. 키는 자세 분석에만 쓰이며 구속에는 영향을 주지 않습니다.
                </p>
              </div>

              {modelError && (
                <div className="w-full max-w-md mb-6 flex items-start gap-3 rounded-xl border border-yellow-300/30 bg-yellow-300/10 p-4 text-sm text-yellow-100">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                  <span>{modelError}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                <button
                  type="button"
                  onClick={() => setIsRecording(true)}
                  className="flex-1 flex flex-col items-center justify-center gap-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 transition-colors group"
                >
                  <Camera size={30} className="text-[var(--color-neon-green)] group-hover:scale-110 transition-transform" />
                  <span className="font-bold text-sm">여기서 바로 촬영</span>
                  <span className="text-[11px] text-gray-400">구도 안내 · 60fps 요청 · 4초 자동 정지</span>
                </button>

                <label className="flex-1 flex flex-col items-center justify-center gap-3 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 cursor-pointer transition-colors group">
                  <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
                  <ImageIcon size={30} className="text-[var(--color-neon-blue)] group-hover:scale-110 transition-transform" />
                  <span className="font-bold text-sm">앨범에서 선택</span>
                </label>
              </div>
            </div>

            <Link
              href="/analyze/freekick"
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-neon-blue)]/40 bg-[var(--color-neon-blue)]/10 p-4 text-sm hover:bg-[var(--color-neon-blue)]/20 transition-colors"
            >
              <span>
                <span className="block font-bold text-white">프리킥을 공 뒤 대각선에서 찍었나요?</span>
                <span className="block text-xs text-gray-400 mt-1">골대가 보이는 뒤쪽 구도는 프리킥 측정(베타)에서 잽니다</span>
              </span>
              <span className="shrink-0 font-bold text-[var(--color-neon-blue)]">프리킥 측정 →</span>
            </Link>

            {DATASET_UPLOAD_ENABLED && (
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
            )}
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
                  다른 영상
                </button>
                <button
                  onClick={startAnalysis}
                  disabled={isModelLoading}
                  className="px-8 py-3 rounded-full font-bold bg-white text-black hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isModelLoading ? <Loader2 className="animate-spin" size={20} /> : <Play size={20} />}
                  {isModelLoading ? "모델 불러오는 중" : "측정 시작"}
                </button>
              </div>
            )}

            {analysisResult && (
              <div className="w-full max-w-3xl flex flex-col gap-6 animate-in slide-in-from-bottom-8 fade-in duration-700">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-green)] hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(57,255,20,0.1)] hover:shadow-[0_0_30px_rgba(57,255,20,0.3)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">구속</div>
                    {analysisResult.confidence === "failed" ? (
                      <>
                        <div className="text-3xl font-black text-yellow-300">판정 보류</div>
                        <div className="mt-2 text-xs text-gray-300">스케일을 검증하지 못해 속도를 기록하지 않았습니다</div>
                        <div className="mt-3 text-[10px] font-mono tracking-widest text-gray-500">
                          아래 이유를 보고 다시 촬영해 주세요
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 drop-shadow-sm">{analysisResult.estimatedSpeedKmh}</div>
                        <div className="text-sm text-[var(--color-neon-green)] mt-2 font-mono font-bold tracking-widest">km/h</div>
                        {uncertainty && (
                          <div className="mt-2 text-xs font-mono text-gray-300">
                            {uncertainty.lowKmh}–{uncertainty.highKmh} km/h · 신뢰도 {GRADE_LABEL[uncertainty.grade]}
                          </div>
                        )}
                        <div className="mt-3 text-[10px] font-mono tracking-widest text-gray-500">
                          {measurement?.gravityCheck
                            ? `중력검산 통과 · 환산 x${measurement.gravityCheck.scaleFactor.toFixed(2)}`
                            : `FIT ${analysisResult.trajectoryPoints}PT`}
                        </div>
                      </>
                    )}
                    {analysisResult.referenceDistance && analysisResult.estimatedDistanceMeters !== undefined && (
                      <div className="mt-2 text-[10px] font-mono tracking-widest text-[var(--color-neon-blue)]">
                        DIST {analysisResult.estimatedDistanceMeters.toFixed(1)} m
                      </div>
                    )}
                  </div>

                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-blue)] hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(0,255,255,0.1)] hover:shadow-[0_0_30px_rgba(0,255,255,0.3)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">자세 점수</div>
                    <div className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 drop-shadow-sm">{analysisResult.formResult.score}</div>
                    <div className="text-sm text-[var(--color-neon-blue)] mt-2 font-mono font-bold tracking-widest">/ 100 pts</div>
                    <div className="mt-3 text-[10px] font-mono tracking-widest text-gray-500">
                      {analysisResult.framesAnalyzed} FRAMES · {analysisResult.formResult.source.toUpperCase()}
                    </div>
                  </div>

                  <div className="glass-card p-6 flex flex-col items-center justify-center text-center border-t-4 border-t-purple-500 hover:-translate-y-2 transition-transform duration-300 shadow-[0_0_20px_rgba(168,85,247,0.1)] hover:shadow-[0_0_30px_rgba(168,85,247,0.3)] relative group">
                    <div className="text-gray-400 text-sm mb-2 font-mono tracking-wider">킥 유형</div>
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

                {uncertainty?.grade === "low" && (
                  <div className="flex items-start gap-3 rounded-xl border border-yellow-300/30 bg-yellow-300/10 p-4 text-sm text-yellow-100">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                    <span>
                      측정 조건이 좋지 않아 이 구속은 참고용입니다. 아래 안내를 반영해 다시 촬영하면 정확도가 올라갑니다.
                    </span>
                  </div>
                )}

                {measurement && (
                  <div className={`glass-card p-6 border-t-4 ${measurement.verified ? "border-t-[var(--color-neon-blue)]/60" : "border-t-yellow-400/70"}`}>
                    <h3 className="text-lg font-bold mb-3 flex items-center gap-2">
                      <Activity size={20} className={measurement.verified ? "text-[var(--color-neon-blue)]" : "text-yellow-400"} />
                      {measurement.verified ? "측정 검증 통과" : "속도 판정 보류"}
                    </h3>
                    {measurement.verified ? (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                          <div>
                            <div className="text-[10px] font-mono tracking-widest text-gray-500">발사각</div>
                            <div className="text-xl font-bold">{measurement.launchAngleDeg !== null ? `${measurement.launchAngleDeg.toFixed(0)}°` : "—"}</div>
                          </div>
                          <div>
                            <div className="text-[10px] font-mono tracking-widest text-gray-500">체공시간</div>
                            <div className="text-xl font-bold">{measurement.flightTimeS !== null ? `${measurement.flightTimeS.toFixed(2)}초` : "—"}</div>
                          </div>
                          <div>
                            <div className="text-[10px] font-mono tracking-widest text-gray-500">비행거리</div>
                            <div className="text-xl font-bold">{measurement.straightDistanceM !== null ? `${measurement.straightDistanceM.toFixed(1)}m` : "—"}</div>
                          </div>
                          <div>
                            <div className="text-[10px] font-mono tracking-widest text-gray-500">연직가속도</div>
                            <div className="text-xl font-bold">{measurement.gravityCheck ? `${measurement.gravityCheck.measuredVerticalAccel.toFixed(1)}` : "—"}</div>
                          </div>
                        </div>
                        <p className="mt-4 text-xs text-gray-400">
                          공중의 공은 연직 가속도가 9.81 m/s² 입니다. 측정값이 여기에 맞아야 화면의 픽셀이 실제 거리로 제대로 환산된 것이라,
                          이 검산을 통과한 기록만 저장·공유됩니다.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-gray-300 mb-3">
                          이 영상으로는 속도를 믿을 만하게 잴 수 없어 기록으로 남기지 않았습니다. 아래 이유를 참고해 다시 찍어 주세요.
                        </p>
                        <ul className="space-y-2">
                          {measurementNotes(measurement).slice(0, 4).map((note, index) => (
                            <li key={index} className="flex items-start gap-3 text-sm text-yellow-100/90">
                              <span className="text-yellow-400 mt-0.5">!</span>
                              <span>{note}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-4 text-xs text-gray-400">
                          잘 나오는 조건: 옆에서 · 60fps · 공이 화면에서 10px 이상 · 폰 고정 · 킥 앞뒤 2초만
                        </p>
                      </>
                    )}
                  </div>
                )}

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
