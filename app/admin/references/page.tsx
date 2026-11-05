"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Play,
  Save,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { BrowserVideoAnalyzer } from "@/lib/analysis/client-video-analyzer";
import { DEFAULT_PLAYER_HEIGHT_CM } from "@/lib/analysis/pipeline/run-analysis";
import type { PipelineResult } from "@/lib/analysis/pipeline/types";
import {
  findAnswer,
  parseAnswerSheet,
  parseKnownSpeedKmh,
  summarizeBatch,
} from "@/lib/analysis/reference-batch";
import {
  MAX_SAMPLE_UNCERTAINTY,
  type ReferenceCalibrationSummary,
} from "@/lib/analysis/reference-calibration";
import {
  BALL_SPECS,
  DEFAULT_BALL_SIZE_ID,
  getBallSpec,
  type BallSizeId,
} from "@/lib/analysis/scale-reference";

const ADMIN_TOKEN_STORAGE_KEY = "freekickAdminReferenceToken";
const CAMERA_ANGLES = ["side", "diagonal", "front", "behind"] as const;

type CameraAngle = (typeof CAMERA_ANGLES)[number];
type ClipStatus = "pending" | "analyzing" | "done" | "failed" | "saved";

interface ClipRow {
  id: string;
  file: File;
  objectUrl: string;
  knownSpeedKmh: number | null;
  /**
   * Raw height input for this clip's kicker. Empty means "follow the batch
   * default", which itself may be unknown — an unknown height is a first-class
   * state here because most reference clips are other people's footage. Kept as
   * a string so half-typed values are not wiped while editing.
   */
  playerHeightInput: string;
  status: ClipStatus;
  progress: number;
  result: PipelineResult | null;
  error: string | null;
  savedId: string | null;
}

interface ReferenceRecord {
  id: string;
  label: string;
  knownSpeedKmh: number;
  measuredSpeedKmh: number;
  calibrationFactor: number;
  cameraAngle: string | null;
  playerHeightCm: number | null;
  scaleSource: string | null;
  scaleUncertainty: number | null;
  ballDiameterPx: number | null;
  measurementUncertainty: number | null;
  measurementGrade: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ReferencesResponse {
  auth?: { configured: boolean; developmentOpen: boolean };
  calibration?: ReferenceCalibrationSummary;
  references?: ReferenceRecord[];
  error?: string;
}

const VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;

const MIN_PLAYER_HEIGHT_CM = 120;
const MAX_PLAYER_HEIGHT_CM = 220;

const SCALE_SOURCE_LABEL: Record<string, string> = {
  body: "신체",
  ball: "공",
  "body+ball": "신체+공",
};

function isVideoFile(file: File) {
  return file.type.startsWith("video/") || VIDEO_EXTENSION_PATTERN.test(file.name);
}

/**
 * Returns the height only when it is a usable measurement. Anything blank or
 * out of range collapses to `null` — "we do not know" — instead of silently
 * becoming a number the pipeline would treat as user-supplied truth.
 */
function parseHeightCm(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_PLAYER_HEIGHT_CM || parsed > MAX_PLAYER_HEIGHT_CM) return null;
  return parsed;
}

function formatSigned(value: number | null, unit: string) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}${unit}`;
}

function errorPercent(row: ClipRow) {
  const measured = row.result?.estimatedSpeedKmh ?? 0;
  if (!row.knownSpeedKmh || measured <= 0) return null;
  return Math.round(((measured - row.knownSpeedKmh) / row.knownSpeedKmh) * 1000) / 10;
}

export default function ReferenceBatchPage() {
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
    } catch {
      // Storage can be unavailable in private mode; the field simply starts empty.
      return "";
    }
  });
  const [rows, setRows] = useState<ClipRow[]>([]);
  const [answerSheetText, setAnswerSheetText] = useState("");
  const [cameraAngle, setCameraAngle] = useState<CameraAngle>("side");
  // Blank on purpose: the kicker's height is usually unknown for reference
  // footage, and pre-filling 175 made every saved row claim a height we never
  // actually had.
  const [defaultHeightCm, setDefaultHeightCm] = useState("");
  const [ballSizeId, setBallSizeId] = useState<BallSizeId>(DEFAULT_BALL_SIZE_ID);
  const [distanceMeters, setDistanceMeters] = useState("");

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [calibration, setCalibration] = useState<ReferenceCalibrationSummary | null>(null);
  const [authStatus, setAuthStatus] = useState<ReferencesResponse["auth"] | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(true);

  const cancelRef = useRef(false);
  const analyzerRef = useRef<BrowserVideoAnalyzer | null>(null);
  const rowsRef = useRef<ClipRow[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      analyzerRef.current?.dispose();
      for (const row of rowsRef.current) URL.revokeObjectURL(row.objectUrl);
    };
  }, []);

  const authHeaders = useCallback(() => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken.trim()) headers["x-admin-token"] = adminToken.trim();
    return headers;
  }, [adminToken]);

  // No synchronous setState here: this runs straight from an effect, and an
  // eager state update would trigger a cascading render.
  const loadReferences = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/references", {
        headers: authHeaders(),
        cache: "no-store",
      });
      const data: ReferencesResponse = await response.json();

      setAuthStatus(data.auth ?? null);
      setReferences(data.references ?? []);
      setCalibration(data.calibration ?? null);
      setError(response.ok ? null : (data.error ?? "레퍼런스를 불러오지 못했습니다."));
    } catch {
      setError("레퍼런스를 불러오지 못했습니다.");
    } finally {
      setIsLoadingList(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    // Deferred so the initial fetch never updates state during the effect pass.
    queueMicrotask(() => {
      void loadReferences();
    });
  }, [loadReferences]);

  const answerEntries = useMemo(() => parseAnswerSheet(answerSheetText), [answerSheetText]);
  const fallbackHeightCm = useMemo(() => parseHeightCm(defaultHeightCm), [defaultHeightCm]);

  /** Row value wins, batch default fills in, `null` means genuinely unknown. */
  const resolveHeightCm = useCallback(
    (row: ClipRow) => parseHeightCm(row.playerHeightInput) ?? fallbackHeightCm,
    [fallbackHeightCm]
  );

  const applyAnswerSheet = useCallback(() => {
    setRows((previous) =>
      previous.map((row) => {
        const answer = findAnswer(row.file.name, answerEntries);
        if (!answer) return row;
        return {
          ...row,
          knownSpeedKmh: answer.knownSpeedKmh,
          playerHeightInput:
            answer.playerHeightCm === null ? row.playerHeightInput : String(answer.playerHeightCm),
        };
      })
    );
    setMessage(`정답표 ${answerEntries.length}건을 적용했습니다.`);
  }, [answerEntries]);

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;

      const accepted = Array.from(files).filter(isVideoFile);
      if (accepted.length === 0) {
        setError("영상 파일만 추가할 수 있습니다.");
        return;
      }

      const nextRows: ClipRow[] = accepted.map((file, index) => {
        const answer = findAnswer(file.name, answerEntries);
        return {
          id: `${Date.now()}-${index}-${file.name}`,
          file,
          objectUrl: URL.createObjectURL(file),
          knownSpeedKmh: answer?.knownSpeedKmh ?? parseKnownSpeedKmh(file.name),
          playerHeightInput:
            answer?.playerHeightCm != null ? String(answer.playerHeightCm) : "",
          status: "pending",
          progress: 0,
          result: null,
          error: null,
          savedId: null,
        };
      });

      setRows((previous) => [...previous, ...nextRows]);
      setError(null);
      setMessage(`${nextRows.length}개 클립을 추가했습니다.`);
    },
    [answerEntries]
  );

  const removeRow = useCallback((id: string) => {
    setRows((previous) => {
      const target = previous.find((row) => row.id === id);
      if (target) URL.revokeObjectURL(target.objectUrl);
      return previous.filter((row) => row.id !== id);
    });
  }, []);

  const clearRows = useCallback(() => {
    setRows((previous) => {
      for (const row of previous) URL.revokeObjectURL(row.objectUrl);
      return [];
    });
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<ClipRow>) => {
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const analyzeAll = useCallback(async () => {
    if (rows.length === 0 || isAnalyzing) return;

    cancelRef.current = false;
    setIsAnalyzing(true);
    setError(null);
    setMessage(null);

    const analyzer = analyzerRef.current ?? new BrowserVideoAnalyzer();
    analyzerRef.current = analyzer;

    const targets = rowsRef.current.filter((row) => row.status !== "saved");

    try {
      await analyzer.ready();
    } catch {
      setError("분석 모델을 불러오지 못했습니다. 네트워크 상태를 확인하세요.");
      setIsAnalyzing(false);
      return;
    }

    for (const target of targets) {
      if (cancelRef.current) break;

      updateRow(target.id, { status: "analyzing", progress: 0, error: null, result: null });

      // An unknown height still analyses fine — the pipeline falls back to its
      // default figure — but it must be flagged as a guess so the reported
      // uncertainty widens instead of pretending to a precision we lack.
      const resolvedHeightCm = resolveHeightCm(target);

      try {
        // Calibration is intentionally not applied here: reference clips must
        // record the *raw* measurement, otherwise the calibration factor would
        // be derived from already-calibrated numbers.
        const result = await analyzer.analyze(target.objectUrl, {
          playerHeightCm: resolvedHeightCm,
          playerHeightProvided: resolvedHeightCm !== null,
          ballSizeId,
          calibration: null,
          label: target.file.name,
          isCancelled: () => cancelRef.current,
          onProgress: ({ progress }) => updateRow(target.id, { progress }),
        });

        const measured = result.estimatedSpeedKmh;
        updateRow(target.id, {
          status: measured > 0 ? "done" : "failed",
          progress: 100,
          result,
          error: measured > 0 ? null : "구속을 산출하지 못했습니다.",
        });
      } catch (analysisError) {
        updateRow(target.id, {
          status: "failed",
          progress: 100,
          error: analysisError instanceof Error ? analysisError.message : "분석에 실패했습니다.",
        });
      }
    }

    setIsAnalyzing(false);
    setMessage(cancelRef.current ? "분석을 중단했습니다." : "일괄 분석을 완료했습니다.");
  }, [ballSizeId, isAnalyzing, resolveHeightCm, rows.length, updateRow]);

  const stopAnalysis = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const saveAll = useCallback(async () => {
    const savable = rowsRef.current.filter(
      (row) =>
        row.status === "done" &&
        row.result !== null &&
        row.result.estimatedSpeedKmh > 0 &&
        row.knownSpeedKmh !== null &&
        row.knownSpeedKmh > 0
    );

    if (savable.length === 0) {
      setError("저장할 수 있는 행이 없습니다. 실제 속도와 측정값이 모두 필요합니다.");
      return;
    }

    setIsSaving(true);
    setError(null);
    let saved = 0;
    let failed = 0;

    const parsedDistance = Number.parseFloat(distanceMeters);

    for (const row of savable) {
      const result = row.result as PipelineResult;
      const resolvedHeightCm = resolveHeightCm(row);

      try {
        const response = await fetch("/api/admin/references", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            label: row.file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80),
            sourceFilename: row.file.name,
            sourceMimeType: row.file.type || null,
            sourceSizeBytes: row.file.size,
            knownSpeedKmh: row.knownSpeedKmh,
            measuredSpeedKmh: result.estimatedSpeedKmh,
            knownDistanceMeters: Number.isFinite(parsedDistance) && parsedDistance > 0 ? parsedDistance : null,
            ballDisplacementPx: result.ballDisplacementPx ?? null,
            bodyHeightPx: result.kickerHeightPx ?? null,
            // Null is a meaningful value: the row is saved as "height unknown"
            // rather than inheriting a made-up figure.
            playerHeightCm: resolvedHeightCm,
            cameraAngle,
            // Quality of this measurement decides whether it may influence the
            // calibration factor at all.
            measurementUncertainty: result.speedUncertainty?.relative ?? null,
            measurementGrade: result.speedUncertainty?.grade ?? null,
            trajectoryPoints: result.trajectoryPoints,
            // Which ruler produced this number, so a later audit can tell a
            // ball-scaled row from a body-scaled one.
            scaleSource: result.scale?.source ?? null,
            scaleUncertainty: result.scale?.relativeUncertainty ?? null,
            ballDiameterPx: result.ballDiameterPx ?? null,
            ballDiameterCm: result.scale?.ballDiameterCm ?? null,
            notes: [
              `trajectory ${result.trajectoryPoints}pt`,
              result.trajectoryFitR2 !== undefined ? `r2 ${result.trajectoryFitR2}` : null,
              result.speedUncertainty ? `grade ${result.speedUncertainty.grade}` : null,
              result.sceneCuts > 0 ? `cuts ${result.sceneCuts}` : null,
              resolvedHeightCm === null ? "height unknown" : `height ${resolvedHeightCm}cm`,
              result.scale ? `scale ${result.scale.source}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            isActive: true,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          updateRow(row.id, { error: data.error ?? "저장에 실패했습니다." });
          failed += 1;
          continue;
        }

        const data = await response.json();
        updateRow(row.id, { status: "saved", savedId: data.reference?.id ?? null, error: null });
        saved += 1;
      } catch {
        updateRow(row.id, { error: "저장 요청이 실패했습니다." });
        failed += 1;
      }
    }

    setIsSaving(false);
    setMessage(`${saved}건 저장${failed > 0 ? `, ${failed}건 실패` : ""}.`);
    await loadReferences();
  }, [authHeaders, cameraAngle, distanceMeters, loadReferences, resolveHeightCm, updateRow]);

  const deleteReference = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/admin/references/${id}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (!response.ok) {
          setError("삭제에 실패했습니다.");
          return;
        }
        await loadReferences();
      } catch {
        setError("삭제 요청이 실패했습니다.");
      }
    },
    [authHeaders, loadReferences]
  );

  const summary = useMemo(
    () =>
      summarizeBatch(
        rows.map((row) => ({
          knownSpeedKmh: row.knownSpeedKmh,
          measuredSpeedKmh: row.result?.estimatedSpeedKmh ?? null,
        }))
      ),
    [rows]
  );

  const persistToken = useCallback((value: string) => {
    setAdminToken(value);
    try {
      if (value.trim()) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value.trim());
      else localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, []);

  return (
    <div className="min-h-screen p-4 sm:p-10">
      <header className="mx-auto mb-8 flex w-full max-w-6xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <Link href="/analyze" className="flex items-center gap-2 text-sm text-gray-400 hover:text-white">
            <ArrowLeft size={16} />
            분석 화면으로
          </Link>
          <h1 className="text-xl font-bold">Reference Batch</h1>
          <p className="text-sm text-gray-400">
            잘라둔 클립을 한 번에 올리고, 파일명 또는 정답표의 실제 속도와 비교합니다.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs font-mono uppercase tracking-widest text-gray-500">Admin token</label>
          <input
            type="password"
            value={adminToken}
            onChange={(event) => persistToken(event.target.value)}
            placeholder={authStatus?.developmentOpen ? "개발 모드에서는 생략 가능" : "x-admin-token"}
            className="w-64 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-green)]"
          />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {(message || error) && (
          <div
            className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${
              error
                ? "border-red-400/30 bg-red-400/10 text-red-100"
                : "border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/10 text-[var(--color-neon-green)]"
            }`}
          >
            {error ? <AlertTriangle size={18} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0" />}
            <span>{error ?? message}</span>
          </div>
        )}

        {/* Step 1 — inputs */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h2 className="mb-4 text-sm font-mono uppercase tracking-widest text-gray-400">1 · 클립과 정답</h2>

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/25 bg-black/20 p-8 text-center transition-colors hover:border-[var(--color-neon-green)]/60 hover:bg-white/5">
              <input
                type="file"
                accept="video/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Upload size={28} className="text-[var(--color-neon-green)]" />
              <span className="text-sm font-bold">클립 여러 개 선택</span>
              <span className="text-xs text-gray-500">
                파일명에 <code className="text-gray-300">89kmh</code> / <code className="text-gray-300">55mph</code>가
                있으면 실제 속도를 자동으로 읽습니다.
              </span>
            </label>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-mono uppercase tracking-widest text-gray-500">
                정답표 (파일명, 속도[, 거리m, 키cm, 메모])
              </label>
              <textarea
                value={answerSheetText}
                onChange={(event) => setAnswerSheetText(event.target.value)}
                rows={5}
                placeholder={"nicky_01.mp4, 89km/h, 11, 178\nclip_02.mp4, 55mph"}
                className="w-full rounded-xl border border-white/20 bg-black/30 p-3 font-mono text-xs outline-none focus:border-[var(--color-neon-green)]"
              />
              <button
                type="button"
                onClick={applyAnswerSheet}
                disabled={answerEntries.length === 0}
                className="self-start rounded-lg border border-white/20 px-3 py-1.5 text-xs font-bold transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                정답표 적용 ({answerEntries.length}건 인식)
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-mono uppercase tracking-widest text-gray-500">공 규격</span>
              <select
                value={ballSizeId}
                onChange={(event) => setBallSizeId(event.target.value as BallSizeId)}
                className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-green)]"
              >
                {BALL_SPECS.map((spec) => (
                  <option key={spec.id} value={spec.id} className="bg-black">
                    {spec.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-mono uppercase tracking-widest text-gray-500">촬영 각도</span>
              <select
                value={cameraAngle}
                onChange={(event) => setCameraAngle(event.target.value as CameraAngle)}
                className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-green)]"
              >
                {CAMERA_ANGLES.map((angle) => (
                  <option key={angle} value={angle} className="bg-black">
                    {angle}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-mono uppercase tracking-widest text-gray-500">
                기본 키 (cm, 모르면 비움)
              </span>
              <input
                type="number"
                min={MIN_PLAYER_HEIGHT_CM}
                max={MAX_PLAYER_HEIGHT_CM}
                value={defaultHeightCm}
                onChange={(event) => setDefaultHeightCm(event.target.value)}
                placeholder="미상"
                className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-green)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-mono uppercase tracking-widest text-gray-500">킥 거리 (m, 선택)</span>
              <input
                type="number"
                min="1"
                max="120"
                value={distanceMeters}
                onChange={(event) => setDistanceMeters(event.target.value)}
                placeholder="11"
                className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-green)]"
              />
            </label>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            키를 몰라도 분석·저장 모두 가능합니다. 공은 크기가 규격으로 고정돼 있어
            <strong className="text-gray-300"> 지름({getBallSpec(ballSizeId).diameterCm}cm)만으로 거리 환산</strong>이
            되기 때문입니다. 키를 함께 입력하면 두 기준을 가중 평균해 더 좁은 오차 범위가 나오고, 비워두면 공 쪽
            비중이 자동으로 커집니다. 기본 키를 비우면 파이프라인 기본값({DEFAULT_PLAYER_HEIGHT_CM}cm)이 쓰이되
            추정치로 기록됩니다.
          </p>
        </section>

        {/* Step 2 — run */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-mono uppercase tracking-widest text-gray-400">2 · 일괄 분석</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={analyzeAll}
                disabled={rows.length === 0 || isAnalyzing}
                className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-bold text-black transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
              >
                {isAnalyzing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {isAnalyzing ? "분석 중" : "전체 분석"}
              </button>
              {isAnalyzing && (
                <button
                  type="button"
                  onClick={stopAnalysis}
                  className="rounded-lg border border-white/20 px-4 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                >
                  중단
                </button>
              )}
              <button
                type="button"
                onClick={saveAll}
                disabled={isAnalyzing || isSaving || summary.comparable === 0}
                className="flex items-center gap-2 rounded-lg border border-[var(--color-neon-green)]/50 px-4 py-2 text-sm font-bold text-[var(--color-neon-green)] transition-colors hover:bg-[var(--color-neon-green)]/10 disabled:opacity-40"
              >
                {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                DB에 일괄 저장
              </button>
              <button
                type="button"
                onClick={clearRows}
                disabled={isAnalyzing || rows.length === 0}
                className="rounded-lg border border-white/20 px-4 py-2 text-sm font-bold transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                목록 비우기
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">아직 추가된 클립이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1060px] text-left text-sm">
                <thead className="text-xs font-mono uppercase tracking-widest text-gray-500">
                  <tr className="border-b border-white/10">
                    <th className="py-2 pr-3">파일</th>
                    <th className="py-2 pr-3">실제 km/h</th>
                    <th className="py-2 pr-3">키 cm</th>
                    <th className="py-2 pr-3">측정 km/h</th>
                    <th className="py-2 pr-3">오차</th>
                    <th className="py-2 pr-3">신뢰도</th>
                    <th className="py-2 pr-3">스케일</th>
                    <th className="py-2 pr-3">궤적</th>
                    <th className="py-2 pr-3">상태</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const measured = row.result?.estimatedSpeedKmh ?? 0;
                    const percent = errorPercent(row);
                    const grade = row.result?.speedUncertainty?.grade ?? null;
                    const rowHeight = resolveHeightCm(row);
                    const scale = row.result?.scale ?? null;

                    return (
                      <tr key={row.id} className="border-b border-white/5 align-top">
                        <td className="max-w-[220px] truncate py-3 pr-3" title={row.file.name}>
                          {row.file.name}
                        </td>
                        <td className="py-3 pr-3">
                          <input
                            type="number"
                            value={row.knownSpeedKmh ?? ""}
                            onChange={(event) =>
                              updateRow(row.id, {
                                knownSpeedKmh: event.target.value === "" ? null : Number(event.target.value),
                              })
                            }
                            className="w-20 rounded border border-white/20 bg-white/10 px-2 py-1 text-right text-sm outline-none focus:border-[var(--color-neon-green)]"
                          />
                        </td>
                        <td className="py-3 pr-3">
                          <input
                            type="number"
                            min={MIN_PLAYER_HEIGHT_CM}
                            max={MAX_PLAYER_HEIGHT_CM}
                            value={row.playerHeightInput}
                            placeholder={fallbackHeightCm === null ? "미상" : String(fallbackHeightCm)}
                            onChange={(event) =>
                              updateRow(row.id, { playerHeightInput: event.target.value })
                            }
                            title={
                              rowHeight === null
                                ? `키 미상 — 기본값 ${DEFAULT_PLAYER_HEIGHT_CM}cm로 추정 계산합니다`
                                : undefined
                            }
                            className={`w-20 rounded border bg-white/10 px-2 py-1 text-right text-sm outline-none focus:border-[var(--color-neon-green)] ${
                              rowHeight === null ? "border-white/10 text-gray-400" : "border-white/20"
                            }`}
                          />
                        </td>
                        <td className="py-3 pr-3 font-mono">{measured > 0 ? measured : "—"}</td>
                        <td
                          className={`py-3 pr-3 font-mono ${
                            percent === null ? "text-gray-500" : Math.abs(percent) <= 10 ? "text-[var(--color-neon-green)]" : "text-yellow-300"
                          }`}
                        >
                          {percent === null ? "—" : `${percent > 0 ? "+" : ""}${percent}%`}
                        </td>
                        <td className="py-3 pr-3 text-xs">
                          {grade ? (
                            <span
                              className={
                                grade === "high"
                                  ? "text-[var(--color-neon-green)]"
                                  : grade === "medium"
                                    ? "text-yellow-300"
                                    : "text-red-300"
                              }
                            >
                              {grade}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-3 pr-3 text-xs">
                          {scale ? (
                            <span
                              className={
                                scale.source === "body" ? "text-gray-400" : "text-[var(--color-neon-blue)]"
                              }
                              title={
                                scale.disagreement === null
                                  ? `±${(scale.relativeUncertainty * 100).toFixed(0)}% · 공 표본 ${scale.ballSampleCount}프레임`
                                  : `±${(scale.relativeUncertainty * 100).toFixed(0)}% · 두 기준 차이 ${(scale.disagreement * 100).toFixed(0)}% · 공 표본 ${scale.ballSampleCount}프레임`
                              }
                            >
                              {SCALE_SOURCE_LABEL[scale.source]}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-3 pr-3 font-mono text-xs text-gray-400">
                          {row.result ? `${row.result.trajectoryPoints}pt` : "—"}
                          {row.result && row.result.sceneCuts > 0 ? ` · cut ${row.result.sceneCuts}` : ""}
                        </td>
                        <td className="py-3 pr-3 text-xs">
                          {row.status === "analyzing" && (
                            <span className="flex items-center gap-1 text-gray-300">
                              <Loader2 size={12} className="animate-spin" />
                              {row.progress}%
                            </span>
                          )}
                          {row.status === "pending" && <span className="text-gray-500">대기</span>}
                          {row.status === "done" && <span className="text-[var(--color-neon-green)]">완료</span>}
                          {row.status === "saved" && <span className="text-[var(--color-neon-blue)]">저장됨</span>}
                          {row.status === "failed" && (
                            <span className="flex items-center gap-1 text-red-300" title={row.error ?? ""}>
                              <XCircle size={12} />
                              실패
                            </span>
                          )}
                          {row.error && row.status !== "failed" && (
                            <span className="block text-red-300">{row.error}</span>
                          )}
                        </td>
                        <td className="py-3">
                          <button
                            type="button"
                            onClick={() => removeRow(row.id)}
                            disabled={isAnalyzing}
                            className="rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-red-300 disabled:opacity-30"
                            aria-label="행 삭제"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Step 3 — regression report */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h2 className="mb-4 text-sm font-mono uppercase tracking-widest text-gray-400">3 · 정확도 리포트</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "클립", value: `${summary.measured}/${summary.total}` },
              { label: "MAE", value: summary.maeKmh === null ? "—" : `${summary.maeKmh} km/h` },
              { label: "편향", value: formatSigned(summary.biasKmh, " km/h") },
              { label: "MAPE", value: summary.mapePercent === null ? "—" : `${summary.mapePercent}%` },
              { label: "P90 오차", value: summary.p90Kmh === null ? "—" : `${summary.p90Kmh} km/h` },
              { label: "권장 계수", value: summary.suggestedFactor === null ? "—" : `x${summary.suggestedFactor}` },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-white/10 bg-black/20 p-4">
                <div className="text-[10px] font-mono uppercase tracking-widest text-gray-500">{item.label}</div>
                <div className="mt-1 text-lg font-bold">{item.value}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            편향이 음수면 앱이 실제보다 느리게 측정하고 있다는 뜻입니다. 알고리즘을 수정한 뒤 같은 클립 세트를 다시
            돌려 MAE가 줄었는지 확인하세요.
          </p>
        </section>

        {/* Saved references */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h2 className="mb-4 text-sm font-mono uppercase tracking-widest text-gray-400">저장된 레퍼런스</h2>

          {calibration && (
            <div
              className={`mb-5 rounded-xl border p-4 ${
                calibration.enabled
                  ? "border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/10"
                  : "border-white/15 bg-black/20"
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    calibration.enabled
                      ? "bg-[var(--color-neon-green)]/20 text-[var(--color-neon-green)]"
                      : "bg-white/10 text-gray-300"
                  }`}
                >
                  {calibration.enabled ? "보정 적용 중" : "보정 미적용"}
                </span>
                <span className="text-sm">{calibration.status}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div>
                  <div className="font-mono uppercase tracking-widest text-gray-500">계수</div>
                  <div className="mt-0.5 font-bold">x{calibration.factor}</div>
                </div>
                <div>
                  <div className="font-mono uppercase tracking-widest text-gray-500">계수 불확실도</div>
                  <div className="mt-0.5 font-bold">
                    {calibration.factorUncertainty === null
                      ? "—"
                      : `${(calibration.factorUncertainty * 100).toFixed(1)}%`}
                    <span className="ml-1 font-normal text-gray-500">
                      / 기준 {(calibration.requiredUncertainty * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                <div>
                  <div className="font-mono uppercase tracking-widest text-gray-500">유효 샘플</div>
                  <div className="mt-0.5 font-bold">{calibration.qualifiedSampleCount}건</div>
                </div>
                <div>
                  <div className="font-mono uppercase tracking-widest text-gray-500">품질 미달 제외</div>
                  <div className="mt-0.5 font-bold">{calibration.rejectedSampleCount}건</div>
                </div>
              </div>

              {/* Progress toward the gate: shrinking uncertainty fills the bar. */}
              {calibration.factorUncertainty !== null && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full ${
                      calibration.enabled ? "bg-[var(--color-neon-green)]" : "bg-yellow-300/70"
                    }`}
                    style={{
                      width: `${Math.max(
                        4,
                        Math.min(
                          100,
                          (calibration.requiredUncertainty / calibration.factorUncertainty) * 100
                        )
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {isLoadingList ? (
            <p className="py-6 text-center text-sm text-gray-500">불러오는 중…</p>
          ) : references.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">저장된 레퍼런스가 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="text-xs font-mono uppercase tracking-widest text-gray-500">
                  <tr className="border-b border-white/10">
                    <th className="py-2 pr-3">라벨</th>
                    <th className="py-2 pr-3">실제</th>
                    <th className="py-2 pr-3">측정</th>
                    <th className="py-2 pr-3">계수</th>
                    <th className="py-2 pr-3">측정 신뢰도</th>
                    <th className="py-2 pr-3">키</th>
                    <th className="py-2 pr-3">스케일</th>
                    <th className="py-2 pr-3">각도</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {references.map((reference) => {
                    const uncertainty = reference.measurementUncertainty;
                    const qualified = uncertainty !== null && uncertainty <= MAX_SAMPLE_UNCERTAINTY;

                    return (
                    <tr key={reference.id} className="border-b border-white/5">
                      <td className="max-w-[240px] truncate py-2 pr-3">{reference.label}</td>
                      <td className="py-2 pr-3 font-mono">{reference.knownSpeedKmh}</td>
                      <td className="py-2 pr-3 font-mono">{reference.measuredSpeedKmh}</td>
                      <td className="py-2 pr-3 font-mono">x{reference.calibrationFactor.toFixed(3)}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {uncertainty === null ? (
                          <span className="text-gray-500" title="품질 기록 이전에 저장된 행 — 보정에서 제외됩니다">
                            미기록 · 제외
                          </span>
                        ) : (
                          <span className={qualified ? "text-[var(--color-neon-green)]" : "text-red-300"}>
                            ±{(uncertainty * 100).toFixed(0)}%
                            {reference.measurementGrade ? ` (${reference.measurementGrade})` : ""}
                            {qualified ? "" : " · 제외"}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {reference.playerHeightCm == null ? (
                          <span className="text-gray-500" title="키 미상 — 기본값으로 추정해 계산한 행입니다">
                            미상
                          </span>
                        ) : (
                          `${reference.playerHeightCm}cm`
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {reference.scaleSource == null ? (
                          <span className="text-gray-500" title="스케일 기록 이전에 저장된 행 — 신체 기준으로 측정됐습니다">
                            미기록
                          </span>
                        ) : (
                          <span
                            className={
                              reference.scaleSource === "body"
                                ? "text-gray-400"
                                : "text-[var(--color-neon-blue)]"
                            }
                            title={
                              reference.ballDiameterPx == null
                                ? undefined
                                : `공 지름 ${reference.ballDiameterPx}px`
                            }
                          >
                            {SCALE_SOURCE_LABEL[reference.scaleSource] ?? reference.scaleSource}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-400">{reference.cameraAngle ?? "—"}</td>
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => deleteReference(reference.id)}
                          className="rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-red-300"
                          aria-label="레퍼런스 삭제"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
