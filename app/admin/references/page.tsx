"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Database,
  ExternalLink,
  Link2,
  Loader2,
  PauseCircle,
  PlayCircle,
  Shield,
  Trash2,
  Upload,
} from "lucide-react";

interface ReferenceRecord {
  id: string;
  label: string;
  sourceFilename: string | null;
  sourceMimeType: string | null;
  sourceSizeBytes: number | null;
  sourceUrl: string | null;
  knownSpeedKmh: number;
  measuredSpeedKmh: number;
  knownDistanceMeters: number | null;
  ballDisplacementPx: number | null;
  bodyHeightPx: number | null;
  metersPerPixel: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  durationSeconds: number | null;
  fps: number | null;
  timingStartSeconds: number | null;
  timingEndSeconds: number | null;
  timingSpeedKmh: number | null;
  playerHeightCm: number | null;
  cameraAngle: string | null;
  calibrationFactor: number;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
}

interface CalibrationSummary {
  enabled: boolean;
  factor: number;
  sampleCount: number;
  minFactor: number | null;
  maxFactor: number | null;
  spreadPercent: number | null;
  distanceEnabled: boolean;
  metersPerPixel: number | null;
  distanceSampleCount: number;
  minMetersPerPixel: number | null;
  maxMetersPerPixel: number | null;
  distanceSpreadPercent: number | null;
}

interface ReferencesResponse {
  auth: {
    configured: boolean;
    developmentOpen: boolean;
  };
  calibration: CalibrationSummary;
  references: ReferenceRecord[];
  error?: string;
}

interface LinkAnalysisQuestion {
  field: string;
  label: string;
  prompt: string;
  required: boolean;
}

interface LinkAnalysisDraft {
  sourceUrl: string;
  platform: string;
  providerName: string;
  title: string | null;
  authorName: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
  sourceFilename: string | null;
  sourceMimeType: string | null;
  sourceSizeBytes: number | null;
  durationSeconds: number | null;
  suggestedLabel: string;
  suggestedNotes: string;
  suggestedTags: string[];
  questions: LinkAnalysisQuestion[];
  warnings: string[];
}

interface LinkAnalysisResponse {
  analysis?: LinkAnalysisDraft;
  error?: string;
}

interface FormState {
  label: string;
  knownSpeedKmh: string;
  measuredSpeedKmh: string;
  knownDistanceMeters: string;
  ballDisplacementPx: string;
  bodyHeightPx: string;
  videoWidth: string;
  videoHeight: string;
  durationSeconds: string;
  fps: string;
  timingStartSeconds: string;
  timingEndSeconds: string;
  playerHeightCm: string;
  cameraAngle: string;
  notes: string;
  sourceFilename: string;
  sourceMimeType: string;
  sourceSizeBytes: number | null;
  sourceUrl: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  knownSpeedKmh: "",
  measuredSpeedKmh: "",
  knownDistanceMeters: "",
  ballDisplacementPx: "",
  bodyHeightPx: "",
  videoWidth: "",
  videoHeight: "",
  durationSeconds: "",
  fps: "",
  timingStartSeconds: "",
  timingEndSeconds: "",
  playerHeightCm: "",
  cameraAngle: "",
  notes: "",
  sourceFilename: "",
  sourceMimeType: "",
  sourceSizeBytes: null,
  sourceUrl: "",
};

const REFERENCE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;
const REMOTE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm)(\?.*)?$/i;

function formatNumber(value: number | null | undefined, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSeconds(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "-";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function getBackgroundImage(url: string) {
  return `url("${url.replace(/"/g, '\\"')}")`;
}

function parseFormNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSpeedErrorPercent(knownSpeedKmh: number | null | undefined, measuredSpeedKmh: number | null | undefined) {
  if (
    typeof knownSpeedKmh !== "number" ||
    typeof measuredSpeedKmh !== "number" ||
    !Number.isFinite(knownSpeedKmh) ||
    !Number.isFinite(measuredSpeedKmh) ||
    knownSpeedKmh <= 0
  ) {
    return null;
  }

  return ((measuredSpeedKmh - knownSpeedKmh) / knownSpeedKmh) * 100;
}

function getYoutubeVideoId(sourceUrl: string) {
  if (!sourceUrl.trim()) return null;

  try {
    const url = new URL(sourceUrl.trim());
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/").filter(Boolean)[1] ?? null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getTimingSpeedKmh(distanceMeters: string, startSeconds: string, endSeconds: string) {
  const distance = parseFormNumber(distanceMeters);
  const start = parseFormNumber(startSeconds);
  const end = parseFormNumber(endSeconds);

  if (distance === null || start === null || end === null || distance <= 0 || end <= start) {
    return null;
  }

  return (distance / (end - start)) * 3.6;
}

function getMetersPerPixel(distanceMeters: string, ballDisplacementPx: string) {
  const distance = parseFormNumber(distanceMeters);
  const displacement = parseFormNumber(ballDisplacementPx);

  if (distance === null || displacement === null || distance <= 0 || displacement <= 0) {
    return null;
  }

  return distance / displacement;
}

export default function ReferenceAdminPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const analysisRequestRef = useRef(0);
  const lastAnalyzedSourceUrlRef = useRef("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem("referenceAdminToken") ?? "";
    } catch {
      return "";
    }
  });
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [calibration, setCalibration] = useState<CalibrationSummary | null>(null);
  const [authStatus, setAuthStatus] = useState<ReferencesResponse["auth"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [linkAnalysis, setLinkAnalysis] = useState<LinkAnalysisDraft | null>(null);
  const [linkAnalysisError, setLinkAnalysisError] = useState<string | null>(null);
  const [isAnalyzingLink, setIsAnalyzingLink] = useState(false);

  const youtubeVideoId = useMemo(() => getYoutubeVideoId(form.sourceUrl), [form.sourceUrl]);
  const remoteVideoUrl = useMemo(() => {
    const url = form.sourceUrl.trim();
    if (!url || youtubeVideoId || !isHttpUrl(url) || !REMOTE_VIDEO_EXTENSION_PATTERN.test(url)) return null;
    return url;
  }, [form.sourceUrl, youtubeVideoId]);

  const canAnalyzeSourceUrl = useMemo(() => isHttpUrl(form.sourceUrl), [form.sourceUrl]);

  const timingSpeedKmh = useMemo(
    () => getTimingSpeedKmh(form.knownDistanceMeters, form.timingStartSeconds, form.timingEndSeconds),
    [form.knownDistanceMeters, form.timingEndSeconds, form.timingStartSeconds]
  );

  const metersPerPixel = useMemo(
    () => getMetersPerPixel(form.knownDistanceMeters, form.ballDisplacementPx),
    [form.ballDisplacementPx, form.knownDistanceMeters]
  );

  const calibrationFactor = useMemo(() => {
    const knownSpeed = parseFormNumber(form.knownSpeedKmh);
    const measuredSpeed = parseFormNumber(form.measuredSpeedKmh);
    if (knownSpeed === null || measuredSpeed === null || measuredSpeed <= 0) return null;
    return knownSpeed / measuredSpeed;
  }, [form.knownSpeedKmh, form.measuredSpeedKmh]);

  const speedErrorPercent = useMemo(
    () => getSpeedErrorPercent(parseFormNumber(form.knownSpeedKmh), parseFormNumber(form.measuredSpeedKmh)),
    [form.knownSpeedKmh, form.measuredSpeedKmh]
  );

  const playableVideoUrl = videoUrl ?? remoteVideoUrl;
  const canControlVideoPreview = Boolean(playableVideoUrl) && (!youtubeVideoId || Boolean(videoUrl));

  const loadReferences = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/references", {
        cache: "no-store",
        headers: {
          ...(adminToken ? { "x-admin-token": adminToken } : {}),
        },
      });
      const data = (await res.json()) as ReferencesResponse;

      setReferences(data.references ?? []);
      setCalibration(data.calibration ?? null);
      setAuthStatus(data.auth ?? null);

      if (!res.ok) {
        setError(data.error ?? "레퍼런스 목록을 불러오지 못했습니다.");
      }
    } catch {
      setError("레퍼런스 목록을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadReferences();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadReferences]);

  useEffect(() => {
    try {
      if (adminToken) localStorage.setItem("referenceAdminToken", adminToken);
      else localStorage.removeItem("referenceAdminToken");
    } catch {
      // The token still works for the current session if storage is unavailable.
    }
  }, [adminToken]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const applyLinkAnalysisDraft = useCallback(
    (analysis: LinkAnalysisDraft, options: { notify?: boolean } = {}) => {
      setForm((current) => ({
        ...current,
        label: current.label || analysis.suggestedLabel,
        sourceFilename: current.sourceFilename || analysis.sourceFilename || current.sourceFilename,
        sourceMimeType: current.sourceMimeType || analysis.sourceMimeType || current.sourceMimeType,
        sourceSizeBytes: current.sourceSizeBytes ?? analysis.sourceSizeBytes,
        durationSeconds:
          current.durationSeconds ||
          (analysis.durationSeconds ? analysis.durationSeconds.toFixed(3) : current.durationSeconds),
        notes: current.notes || analysis.suggestedNotes || current.notes,
      }));

      if (options.notify) {
        setMessage("링크 분석 초안을 폼에 반영했습니다.");
      }
    },
    []
  );

  const analyzeSourceUrl = useCallback(
    async (sourceUrl: string, options: { force?: boolean; notify?: boolean } = {}) => {
      const trimmedUrl = sourceUrl.trim();

      if (!isHttpUrl(trimmedUrl)) {
        if (options.force) setLinkAnalysisError("분석할 수 있는 http 또는 https 링크를 입력해 주세요.");
        return;
      }

      if (!options.force && lastAnalyzedSourceUrlRef.current === trimmedUrl) return;

      const requestId = analysisRequestRef.current + 1;
      analysisRequestRef.current = requestId;
      lastAnalyzedSourceUrlRef.current = trimmedUrl;
      setIsAnalyzingLink(true);
      setLinkAnalysisError(null);

      try {
        const res = await fetch("/api/admin/references/analyze-link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(adminToken ? { "x-admin-token": adminToken } : {}),
          },
          body: JSON.stringify({ sourceUrl: trimmedUrl }),
        });
        const data = (await res.json()) as LinkAnalysisResponse;

        if (requestId !== analysisRequestRef.current) return;

        if (!res.ok || !data.analysis) {
          lastAnalyzedSourceUrlRef.current = "";
          setLinkAnalysis(null);
          setLinkAnalysisError(data.error ?? "링크를 분석하지 못했습니다.");
          return;
        }

        setLinkAnalysis(data.analysis);
        applyLinkAnalysisDraft(data.analysis, { notify: options.notify });
        if (!options.notify) setMessage(null);
      } catch {
        if (requestId !== analysisRequestRef.current) return;
        lastAnalyzedSourceUrlRef.current = "";
        setLinkAnalysis(null);
        setLinkAnalysisError("링크를 분석하지 못했습니다.");
      } finally {
        if (requestId === analysisRequestRef.current) {
          setIsAnalyzingLink(false);
        }
      }
    },
    [adminToken, applyLinkAnalysisDraft]
  );

  useEffect(() => {
    const sourceUrl = form.sourceUrl.trim();

    if (!sourceUrl) {
      lastAnalyzedSourceUrlRef.current = "";
      return;
    }

    if (!isHttpUrl(sourceUrl)) return;

    const timeoutId = window.setTimeout(() => {
      void analyzeSourceUrl(sourceUrl);
    }, 650);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [analyzeSourceUrl, form.sourceUrl]);

  const handleVideoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const isVideoFile =
      file.type.startsWith("video/") ||
      (!file.type && REFERENCE_VIDEO_EXTENSION_PATTERN.test(file.name));

    if (!isVideoFile) {
      setError("영상 파일만 업로드할 수 있습니다.");
      return;
    }

    if (videoUrl) URL.revokeObjectURL(videoUrl);

    const nextUrl = URL.createObjectURL(file);
    setVideoUrl(nextUrl);
    setForm((current) => ({
      ...current,
      label: current.label || file.name.replace(/\.[^.]+$/, ""),
      sourceFilename: file.name,
      sourceMimeType: file.type,
      sourceSizeBytes: file.size,
    }));
    setMessage(null);
    setError(null);
  };

  const updateSourceUrl = (value: string) => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }

    setForm((current) => ({
      ...current,
      sourceUrl: value,
    }));
    setLinkAnalysis(null);
    setLinkAnalysisError(null);
    setIsVideoPlaying(false);
  };

  const captureTime = (field: "timingStartSeconds" | "timingEndSeconds") => {
    const video = videoRef.current;
    if (!video) return;
    updateForm(field, video.currentTime.toFixed(3));
  };

  const handleVideoMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    setForm((current) => ({
      ...current,
      videoWidth: video.videoWidth > 0 ? String(video.videoWidth) : current.videoWidth,
      videoHeight: video.videoHeight > 0 ? String(video.videoHeight) : current.videoHeight,
      durationSeconds:
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration.toFixed(3)
          : current.durationSeconds,
    }));
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      await video.play();
      setIsVideoPlaying(true);
    } else {
      video.pause();
      setIsVideoPlaying(false);
    }
  };

  const resetForm = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setForm(EMPTY_FORM);
    setLinkAnalysis(null);
    setLinkAnalysisError(null);
    lastAnalyzedSourceUrlRef.current = "";
    setMessage(null);
    setError(null);
    setIsVideoPlaying(false);
  };

  const saveReference = async () => {
    const knownSpeed = parseFormNumber(form.knownSpeedKmh);
    const measuredSpeed = parseFormNumber(form.measuredSpeedKmh);

    if (knownSpeed === null || measuredSpeed === null) {
      setError("실제 속도와 앱 분석 속도를 입력해 주세요.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/references", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "x-admin-token": adminToken } : {}),
        },
        body: JSON.stringify({
          label: form.label,
          knownSpeedKmh: knownSpeed,
          measuredSpeedKmh: measuredSpeed,
          knownDistanceMeters: parseFormNumber(form.knownDistanceMeters),
          ballDisplacementPx: parseFormNumber(form.ballDisplacementPx),
          bodyHeightPx: parseFormNumber(form.bodyHeightPx),
          videoWidth: parseFormNumber(form.videoWidth),
          videoHeight: parseFormNumber(form.videoHeight),
          durationSeconds: parseFormNumber(form.durationSeconds),
          fps: parseFormNumber(form.fps),
          timingStartSeconds: parseFormNumber(form.timingStartSeconds),
          timingEndSeconds: parseFormNumber(form.timingEndSeconds),
          timingSpeedKmh,
          playerHeightCm: parseFormNumber(form.playerHeightCm),
          cameraAngle: form.cameraAngle,
          notes: form.notes,
          sourceFilename: form.sourceFilename,
          sourceMimeType: form.sourceMimeType,
          sourceSizeBytes: form.sourceSizeBytes,
          sourceUrl: form.sourceUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "레퍼런스를 저장하지 못했습니다.");
        return;
      }

      resetForm();
      setMessage("레퍼런스를 저장했습니다.");
      await loadReferences();
    } catch {
      setError("레퍼런스를 저장하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  const updateReferenceActive = async (reference: ReferenceRecord, isActive: boolean) => {
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/admin/references/${reference.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { "x-admin-token": adminToken } : {}),
        },
        body: JSON.stringify({ isActive }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "레퍼런스를 수정하지 못했습니다.");
        return;
      }

      await loadReferences();
    } catch {
      setError("레퍼런스를 수정하지 못했습니다.");
    }
  };

  const deleteReference = async (reference: ReferenceRecord) => {
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/admin/references/${reference.id}`, {
        method: "DELETE",
        headers: {
          ...(adminToken ? { "x-admin-token": adminToken } : {}),
        },
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "레퍼런스를 삭제하지 못했습니다.");
        return;
      }

      await loadReferences();
    } catch {
      setError("레퍼런스를 삭제하지 못했습니다.");
    }
  };

  return (
    <div className="min-h-screen p-4 sm:p-8">
      <header className="mx-auto mb-8 flex w-full max-w-6xl flex-col gap-5 border-b border-white/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/analyze" className="flex items-center gap-2 text-gray-400 transition-colors hover:text-white">
          <ArrowLeft size={20} />
          <span>Back to Analyzer</span>
        </Link>
        <div className="flex items-center gap-3 font-mono text-sm tracking-widest text-[var(--color-neon-green)]">
          <Database size={16} />
          REFERENCE ADMIN
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
        <section className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="glass-card p-5">
              <div className="mb-2 font-mono text-xs tracking-widest text-gray-500">ACTIVE REFERENCES</div>
              <div className="text-4xl font-black text-white">{calibration?.sampleCount ?? 0}</div>
            </div>
            <div className="glass-card p-5">
              <div className="mb-2 font-mono text-xs tracking-widest text-gray-500">CALIBRATION FACTOR</div>
              <div className="text-4xl font-black text-[var(--color-neon-green)]">
                {formatNumber(calibration?.factor, 3)}
              </div>
            </div>
            <div className="glass-card p-5">
              <div className="mb-2 font-mono text-xs tracking-widest text-gray-500">SPREAD</div>
              <div className="text-4xl font-black text-[var(--color-neon-blue)]">
                {formatNumber(calibration?.spreadPercent, 1)}
                <span className="text-base text-gray-500">%</span>
              </div>
            </div>
            <div className="glass-card p-5">
              <div className="mb-2 font-mono text-xs tracking-widest text-gray-500">DISTANCE SCALE</div>
              <div className="text-4xl font-black text-white">
                {formatNumber(calibration?.metersPerPixel, 4)}
              </div>
              <div className="mt-1 font-mono text-[10px] tracking-widest text-gray-500">
                {calibration?.distanceSampleCount ?? 0} DIST REF
              </div>
            </div>
          </div>

          <div className="glass-card overflow-hidden">
            <div className="border-b border-white/10 p-5">
              <div className="flex items-center gap-3">
                <Shield size={18} className="text-[var(--color-neon-green)]" />
                <h1 className="text-xl font-bold">Reference Set</h1>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div className="border-b border-white/10 p-5 lg:border-b-0 lg:border-r">
                <label className="mb-4 flex min-h-64 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-white/20 bg-black/30 transition-colors hover:border-[var(--color-neon-green)]/60">
                  {playableVideoUrl ? (
                    <video
                      ref={videoRef}
                      src={playableVideoUrl}
                      className="h-full max-h-[48vh] w-full object-contain"
                      controls
                      muted
                      playsInline
                      onLoadedMetadata={handleVideoMetadata}
                      onPlay={() => setIsVideoPlaying(true)}
                      onPause={() => setIsVideoPlaying(false)}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-gray-400">
                      <Upload size={34} className="text-[var(--color-neon-green)]" />
                      <span className="text-sm font-bold text-white">Load local preview</span>
                    </div>
                  )}
                  <input type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
                </label>

                {youtubeVideoId && (
                  <div className="mb-4 overflow-hidden rounded-xl border border-white/10 bg-black/30">
                    <iframe
                      title="Reference video preview"
                      src={`https://www.youtube.com/embed/${youtubeVideoId}`}
                      className="aspect-video w-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <button
                    type="button"
                    onClick={togglePlayback}
                    disabled={!canControlVideoPreview}
                    className="flex items-center justify-center gap-2 rounded-xl border border-white/20 px-4 py-3 font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isVideoPlaying ? <PauseCircle size={18} /> : <PlayCircle size={18} />}
                    {isVideoPlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    type="button"
                    onClick={() => captureTime("timingStartSeconds")}
                    disabled={!canControlVideoPreview}
                    className="rounded-xl border border-white/20 px-4 py-3 font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Set Start
                  </button>
                  <button
                    type="button"
                    onClick={() => captureTime("timingEndSeconds")}
                    disabled={!canControlVideoPreview}
                    className="rounded-xl border border-white/20 px-4 py-3 font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Set End
                  </button>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="rounded-xl border border-white/20 px-4 py-3 font-bold transition-colors hover:bg-white/10"
                  >
                    Reset
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-4 p-5">
                <label className="flex flex-col gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Admin token</span>
                  <input
                    type="password"
                    value={adminToken}
                    onChange={(event) => setAdminToken(event.target.value)}
                    className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                  />
                </label>

                <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-xs text-gray-400">
                  {authStatus?.configured
                    ? "Token configured"
                    : authStatus?.developmentOpen
                      ? "Development token bypass"
                      : "Token required"}
                </div>

                <label className="flex flex-col gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Label</span>
                  <input
                    value={form.label}
                    onChange={(event) => updateForm("label", event.target.value)}
                    className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                  />
                </label>

                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-500">
                    <Link2 size={13} />
                    Source URL
                  </span>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <input
                      inputMode="url"
                      value={form.sourceUrl}
                      onChange={(event) => updateSourceUrl(event.target.value)}
                      className="min-w-0 rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                    <button
                      type="button"
                      onClick={() => analyzeSourceUrl(form.sourceUrl, { force: true, notify: true })}
                      disabled={!canAnalyzeSourceUrl || isAnalyzingLink}
                      className="flex items-center justify-center gap-2 rounded-xl border border-white/20 px-4 py-3 text-sm font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isAnalyzingLink ? <Loader2 className="animate-spin" size={16} /> : <Activity size={16} />}
                      Analyze
                    </button>
                  </div>
                </div>

                {(linkAnalysis || isAnalyzingLink || linkAnalysisError) && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="font-mono text-[10px] tracking-widest text-gray-500">LINK ANALYSIS</div>
                        <div className="mt-1 text-sm font-bold text-white">
                          {linkAnalysis?.providerName ?? "Analyzing source"}
                        </div>
                      </div>
                      {isAnalyzingLink && <Loader2 className="animate-spin text-[var(--color-neon-green)]" size={18} />}
                    </div>

                    {linkAnalysis?.thumbnailUrl && (
                      <div
                        className="mb-3 aspect-video rounded-lg border border-white/10 bg-cover bg-center"
                        style={{ backgroundImage: getBackgroundImage(linkAnalysis.thumbnailUrl) }}
                        aria-label="Reference thumbnail"
                      />
                    )}

                    {linkAnalysis && (
                      <div className="space-y-3">
                        <div>
                          <div className="line-clamp-2 text-sm font-bold text-white">
                            {linkAnalysis.title ?? linkAnalysis.suggestedLabel}
                          </div>
                          <div className="mt-1 text-xs text-gray-500">
                            {[linkAnalysis.authorName, linkAnalysis.platform, formatSeconds(linkAnalysis.durationSeconds)]
                              .filter((item) => item && item !== "-")
                              .join(" · ")}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {linkAnalysis.suggestedTags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-gray-400"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
                          <div className="rounded-lg bg-black/20 p-3">
                            <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">TYPE</div>
                            {linkAnalysis.sourceMimeType ?? "-"}
                          </div>
                          <div className="rounded-lg bg-black/20 p-3">
                            <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">SIZE</div>
                            {formatFileSize(linkAnalysis.sourceSizeBytes)}
                          </div>
                        </div>

                        <div className="space-y-2">
                          {linkAnalysis.questions.map((question) => (
                            <div key={question.field} className="rounded-lg border border-white/10 bg-black/20 p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-bold text-white">{question.label}</span>
                                <span
                                  className={`font-mono text-[10px] tracking-widest ${
                                    question.required
                                      ? "text-[var(--color-neon-green)]"
                                      : "text-gray-500"
                                  }`}
                                >
                                  {question.required ? "REQUIRED" : "CHECK"}
                                </span>
                              </div>
                              <p className="mt-1 text-xs leading-relaxed text-gray-500">{question.prompt}</p>
                            </div>
                          ))}
                        </div>

                        {linkAnalysis.warnings.length > 0 && (
                          <div className="space-y-1 text-xs leading-relaxed text-amber-100/80">
                            {linkAnalysis.warnings.map((warning) => (
                              <div key={warning}>- {warning}</div>
                            ))}
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => applyLinkAnalysisDraft(linkAnalysis, { notify: true })}
                          className="w-full rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                        >
                          Apply Draft
                        </button>
                      </div>
                    )}

                    {linkAnalysisError && (
                      <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">
                        {linkAnalysisError}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Actual km/h</span>
                    <input
                      inputMode="decimal"
                      value={form.knownSpeedKmh}
                      onChange={(event) => updateForm("knownSpeedKmh", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Video km/h</span>
                    <input
                      inputMode="decimal"
                      value={form.measuredSpeedKmh}
                      onChange={(event) => updateForm("measuredSpeedKmh", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Distance m</span>
                    <input
                      inputMode="decimal"
                      value={form.knownDistanceMeters}
                      onChange={(event) => updateForm("knownDistanceMeters", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Clip start</span>
                    <input
                      inputMode="decimal"
                      value={form.timingStartSeconds}
                      onChange={(event) => updateForm("timingStartSeconds", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Clip end</span>
                    <input
                      inputMode="decimal"
                      value={form.timingEndSeconds}
                      onChange={(event) => updateForm("timingEndSeconds", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Ball px</span>
                    <input
                      inputMode="decimal"
                      value={form.ballDisplacementPx}
                      onChange={(event) => updateForm("ballDisplacementPx", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Body px</span>
                    <input
                      inputMode="decimal"
                      value={form.bodyHeightPx}
                      onChange={(event) => updateForm("bodyHeightPx", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">M/PX</div>
                    <div className="text-2xl font-black text-white">
                      {formatNumber(metersPerPixel, 4)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Height cm</span>
                    <input
                      inputMode="decimal"
                      value={form.playerHeightCm}
                      onChange={(event) => updateForm("playerHeightCm", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Camera angle</span>
                    <input
                      value={form.cameraAngle}
                      onChange={(event) => updateForm("cameraAngle", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Video W</span>
                    <input
                      inputMode="numeric"
                      value={form.videoWidth}
                      onChange={(event) => updateForm("videoWidth", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Video H</span>
                    <input
                      inputMode="numeric"
                      value={form.videoHeight}
                      onChange={(event) => updateForm("videoHeight", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Duration</span>
                    <input
                      inputMode="decimal"
                      value={form.durationSeconds}
                      onChange={(event) => updateForm("durationSeconds", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-gray-500">FPS</span>
                    <input
                      inputMode="decimal"
                      value={form.fps}
                      onChange={(event) => updateForm("fps", event.target.value)}
                      className="rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Notes</span>
                  <textarea
                    value={form.notes}
                    onChange={(event) => updateForm("notes", event.target.value)}
                    rows={3}
                    className="resize-none rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm outline-none focus:border-[var(--color-neon-green)]"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">TIMING SPEED</div>
                    <div className="text-2xl font-black text-[var(--color-neon-blue)]">
                      {formatNumber(timingSpeedKmh)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">FACTOR</div>
                    <div className="text-2xl font-black text-[var(--color-neon-green)]">
                      {formatNumber(calibrationFactor, 3)}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">SPEED ERROR</div>
                  <div className="text-2xl font-black text-white">
                    {formatNumber(speedErrorPercent, 1)}
                    <span className="text-sm text-gray-500">%</span>
                  </div>
                </div>

                {form.sourceFilename && (
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-gray-400">
                    {form.sourceFilename} · {formatFileSize(form.sourceSizeBytes)}
                  </div>
                )}

                {message && (
                  <div className="flex items-center gap-2 rounded-xl border border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/10 p-3 text-sm text-[var(--color-neon-green)]">
                    <CheckCircle2 size={16} />
                    {message}
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">
                    {error}
                  </div>
                )}

                <button
                  type="button"
                  onClick={saveReference}
                  disabled={isSaving}
                  className="flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-4 font-black text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="animate-spin" size={20} /> : <Activity size={20} />}
                  Save Reference
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="glass-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 p-5">
            <h2 className="text-lg font-bold">Saved References</h2>
            {isLoading && <Loader2 size={18} className="animate-spin text-[var(--color-neon-green)]" />}
          </div>

          <div className="divide-y divide-white/10">
            {references.length === 0 && !isLoading ? (
              <div className="p-8 text-center text-sm text-gray-500">No reference videos saved.</div>
            ) : (
              references.map((reference) => (
                <article key={reference.id} className="p-5">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-white">{reference.label}</h3>
                      <div className="mt-1 text-xs text-gray-500">
                        {new Date(reference.createdAt).toLocaleDateString()} ·{" "}
                        {reference.sourceUrl ? "linked source" : reference.sourceFilename ?? "metadata only"}
                      </div>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-bold ${
                        reference.isActive
                          ? "border-[var(--color-neon-green)]/40 text-[var(--color-neon-green)]"
                          : "border-white/15 text-gray-500"
                      }`}
                    >
                      {reference.isActive ? "ACTIVE" : "OFF"}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                    <div className="rounded-lg bg-white/5 p-3">
                      <div className="font-mono text-[10px] tracking-widest text-gray-500">ACTUAL</div>
                      <div className="font-black">{formatNumber(reference.knownSpeedKmh)}</div>
                    </div>
                    <div className="rounded-lg bg-white/5 p-3">
                      <div className="font-mono text-[10px] tracking-widest text-gray-500">VIDEO</div>
                      <div className="font-black">{formatNumber(reference.measuredSpeedKmh)}</div>
                    </div>
                    <div className="rounded-lg bg-white/5 p-3">
                      <div className="font-mono text-[10px] tracking-widest text-gray-500">FACTOR</div>
                      <div className="font-black text-[var(--color-neon-green)]">
                        {formatNumber(reference.calibrationFactor, 3)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-white/5 p-3">
                      <div className="font-mono text-[10px] tracking-widest text-gray-500">ERROR</div>
                      <div className="font-black text-white">
                        {formatNumber(getSpeedErrorPercent(reference.knownSpeedKmh, reference.measuredSpeedKmh), 1)}
                        <span className="text-xs text-gray-500">%</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
                    <div>Distance: {formatNumber(reference.knownDistanceMeters)} m</div>
                    <div>Ball: {formatNumber(reference.ballDisplacementPx, 0)} px</div>
                    <div>Segment: {formatNumber(reference.timingStartSeconds, 2)}-{formatNumber(reference.timingEndSeconds, 2)} s</div>
                    <div>M/PX: {formatNumber(reference.metersPerPixel, 4)}</div>
                  </div>

                  {reference.sourceUrl && (
                    <a
                      href={reference.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 flex items-center gap-2 truncate text-xs text-[var(--color-neon-blue)] hover:underline"
                    >
                      <ExternalLink size={13} />
                      <span className="truncate">{reference.sourceUrl}</span>
                    </a>
                  )}

                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => updateReferenceActive(reference, !reference.isActive)}
                      className="flex-1 rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                    >
                      {reference.isActive ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteReference(reference)}
                      className="rounded-lg border border-red-400/30 px-3 py-2 text-red-200 transition-colors hover:bg-red-400/10"
                      aria-label={`Delete ${reference.label}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
