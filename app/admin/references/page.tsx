"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Database,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  Scissors,
  Shield,
  Trash2,
  Upload,
} from "lucide-react";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { getAnalysisFrameSize } from "@/lib/analysis/frame-size";
import { calculateDistance, type Point } from "@/lib/analysis/math";

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

interface AiSegmentDraftRow {
  label: string;
  player: string | null;
  kickType: string | null;
  startSeconds: number;
  endSeconds: number;
  visibleSpeedValue: number | null;
  visibleSpeedUnit: string | null;
  visibleSpeedKmh: number | null;
  confidence: number;
  evidence: string;
  needsReview: boolean;
}

interface AiSegmentDraft {
  summary: string;
  distanceCueMeters: number | null;
  warnings: string[];
  segments: AiSegmentDraftRow[];
}

interface AiSegmentAnalysisResponse {
  provider?: string;
  model?: string;
  draft?: AiSegmentDraft;
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

interface BatchSampleState {
  id: string;
  labelSuffix: string;
  knownSpeedKmh: string;
  measuredSpeedKmh: string;
  timingStartSeconds: string;
  timingEndSeconds: string;
  notes: string;
}

interface BatchClipRow {
  index: number;
  sample: BatchSampleState;
  startSeconds: number;
  endSeconds: number;
  knownSpeedKmh: number | null;
}

interface CutClipResult {
  id: string;
  name: string;
  url: string;
  sizeBytes: number;
  startSeconds: number;
  endSeconds: number;
}

interface ClipCutProgress {
  current: number;
  total: number;
  label: string;
}

type MeasureMode = "none" | "height" | "ball";

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

const YARD_TO_METER = 0.9144;
const DEFAULT_BATCH_SAMPLE_COUNT = 5;
const REFERENCE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;
const REMOTE_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm)(\?.*)?$/i;
const FFMPEG_CORE_VERSION = "0.12.9";
const FFMPEG_CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;
const FFMPEG_ASSET_TIMEOUT_MS = 30000;
const FFMPEG_LOAD_TIMEOUT_MS = 45000;
const GEMINI_SEGMENT_PROMPT = `이 영상은 축구 슈팅/페널티킥/프리킥 분석용 레퍼런스 데이터베이스를 만들기 위한 원본 영상입니다.

목표:
1. 속도 표시, 스피드건, 자막, 화면 숫자 등 실제 속도 근거가 보이는 킥 장면을 찾습니다.
2. 각 킥마다 짧게 자를 수 있는 시작/끝 타임스탬프를 제안합니다.
3. 레퍼런스 DB에서 실제 속도와 앱 분석 속도를 비교해 보정할 수 있도록, 사람이 검수하기 쉬운 JSON만 출력합니다.

구간 선택 기준:
- startSeconds: 킥 직전 준비/런업이 조금 포함되도록 잡습니다.
- endSeconds: 공 궤적과 속도 표시가 확인될 때까지 포함합니다.
- 속도 값이 mph로 보이면 visibleSpeedUnit은 "mph", visibleSpeedKmh는 mph * 1.609344로 환산합니다.
- 속도 값이 km/h로 보이면 visibleSpeedUnit은 "km/h", visibleSpeedKmh는 같은 값을 넣습니다.
- 숫자가 불확실하거나 가려져 있으면 visibleSpeedValue와 visibleSpeedKmh는 null로 두고 needsReview를 true로 둡니다.
- 실제 거리 기준이 확실히 보일 때만 distanceCueMeters를 넣고, 아니면 null로 둡니다.
- 확신도를 confidence 0~1로 넣습니다.

반드시 아래 JSON 형식만 출력하세요. 설명 문장, 마크다운 코드블록, 표는 넣지 마세요.

{
  "summary": "짧은 분석 요약",
  "distanceCueMeters": null,
  "warnings": ["검수자가 확인해야 할 점"],
  "segments": [
    {
      "label": "Nicky normal kick 1 55mph",
      "player": "Nicky",
      "kickType": "normal kick 1",
      "startSeconds": 114.0,
      "endSeconds": 125.0,
      "visibleSpeedValue": 55,
      "visibleSpeedUnit": "mph",
      "visibleSpeedKmh": 88.5,
      "confidence": 0.82,
      "evidence": "화면 우측 속도 오버레이에 55 mph가 보임",
      "needsReview": true
    }
  ]
}`;

function createBatchSample(index: number, id = `batch-${index}`): BatchSampleState {
  return {
    id,
    labelSuffix: `Clip ${index + 1}`,
    knownSpeedKmh: "",
    measuredSpeedKmh: "",
    timingStartSeconds: "",
    timingEndSeconds: "",
    notes: "",
  };
}

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

function parseTimeSeconds(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!trimmed.includes(":")) return parseFormNumber(trimmed);

  const parts = trimmed.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) return null;

  const parsedParts = parts.map(Number);
  if (parsedParts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  if (parsedParts.length === 2) {
    const [minutes, seconds] = parsedParts;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = parsedParts;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimestamp(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00.000";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.round((seconds - Math.floor(seconds)) * 1000);

  return [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    wholeSeconds.toString().padStart(2, "0"),
  ].join(":") + `.${milliseconds.toString().padStart(3, "0")}`;
}

function sanitizeFilePart(value: string, fallback: string) {
  const sanitized = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

  return sanitized || fallback;
}

function getInputFileName(file: File) {
  const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? ".mp4";
  return `input${extension}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: number | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

async function fetchAssetAsObjectUrl(url: string, mimeType: string, timeoutMessage: string) {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => abortController.abort(), FFMPEG_ASSET_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "force-cache",
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`${timeoutMessage} (${response.status})`);
    }

    const blob = new Blob([await response.arrayBuffer()], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(timeoutMessage);
    }

    throw error instanceof Error ? error : new Error(timeoutMessage);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadFfmpegCore(
  ffmpeg: FFmpeg,
  setProgressLabel: (label: string) => void
) {
  const objectUrls: string[] = [];

  try {
    setProgressLabel("FFmpeg core 준비 중");
    const coreURL = await fetchAssetAsObjectUrl(
      `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`,
      "text/javascript",
      "FFmpeg core 파일을 불러오지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요."
    );
    objectUrls.push(coreURL);

    setProgressLabel("FFmpeg WASM 준비 중");
    const wasmURL = await fetchAssetAsObjectUrl(
      `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`,
      "application/wasm",
      "FFmpeg WASM 파일을 불러오지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요."
    );
    objectUrls.push(wasmURL);

    const abortController = new AbortController();
    setProgressLabel("FFmpeg 초기화 중");

    await withTimeout(
      ffmpeg.load({ coreURL, wasmURL }, { signal: abortController.signal }),
      FFMPEG_LOAD_TIMEOUT_MS,
      "FFmpeg 초기화가 시간 안에 끝나지 않았습니다. 브라우저를 새로고침한 뒤 다시 시도해 주세요.",
      () => abortController.abort()
    );
  } finally {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

function getCutOutputName(baseLabel: string, row: BatchClipRow) {
  const index = String(row.index + 1).padStart(2, "0");
  const label = sanitizeFilePart(row.sample.labelSuffix || `Clip ${row.index + 1}`, `Clip_${index}`);
  const speed = row.knownSpeedKmh !== null ? `_${Math.round(row.knownSpeedKmh)}kmh` : "";
  const prefix = sanitizeFilePart(baseLabel, "Reference");

  return `${index}_${prefix}_${label}${speed}.mp4`;
}

function getAiSpeedLabel(segment: AiSegmentDraftRow) {
  if (segment.visibleSpeedValue !== null && segment.visibleSpeedUnit) {
    return `${formatNumber(segment.visibleSpeedValue)} ${segment.visibleSpeedUnit}`;
  }

  if (segment.visibleSpeedKmh !== null) return `${formatNumber(segment.visibleSpeedKmh)} km/h`;

  return "speed check needed";
}

function getAiDraftBatchLabel(segment: AiSegmentDraftRow, index: number) {
  const speedLabel = getAiSpeedLabel(segment);
  const identityParts = [segment.player, segment.kickType]
    .filter((part) => part && part !== "speed check needed")
    .map((part) => String(part).trim());

  if (identityParts.length > 0) {
    return [...identityParts, speedLabel !== "speed check needed" ? speedLabel : null].filter(Boolean).join(" ");
  }

  if (segment.label) return segment.label;

  return speedLabel !== "speed check needed" ? speedLabel : `Clip ${index + 1}`;
}

function parseUnknownNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUnknownBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  return ["true", "yes", "y", "1", "review", "needs review", "확인", "검수"].includes(normalized);
}

function getTextValue(value: unknown, maxLength = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function normalizeSpeedUnit(value: string | null) {
  if (!value) return null;

  const normalized = value.toLowerCase().replace(/[^a-z/]/g, "");
  if (normalized === "mph") return "mph";
  if (["kmh", "kph", "km/h"].includes(normalized)) return "km/h";
  if (["ms", "m/s", "mps"].includes(normalized)) return "m/s";
  return value.slice(0, 16);
}

function getVisibleSpeedKmh(value: number | null, unit: string | null, fallback: number | null) {
  if (fallback !== null && fallback > 0 && fallback < 300) return fallback;
  if (value === null || value <= 0) return null;

  const normalized = normalizeSpeedUnit(unit);
  if (normalized === "mph") return value * 1.609344;
  if (normalized === "m/s") return value * 3.6;
  if (normalized === "km/h") return value;

  return null;
}

function parseSpeedCell(value: unknown) {
  if (typeof value === "number") {
    return { visibleSpeedValue: value, visibleSpeedUnit: null, visibleSpeedKmh: null };
  }

  if (typeof value !== "string") {
    return { visibleSpeedValue: null, visibleSpeedUnit: null, visibleSpeedKmh: null };
  }

  const unitMatches = Array.from(value.matchAll(/(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|m\/s|mps|ms)\b/gi));
  const match =
    unitMatches.length > 0
      ? unitMatches[unitMatches.length - 1]
      : value.match(/(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|m\/s|mps|ms)?/i);
  if (!match) return { visibleSpeedValue: null, visibleSpeedUnit: null, visibleSpeedKmh: null };

  const visibleSpeedValue = parseUnknownNumber(match[1]);
  const visibleSpeedUnit = normalizeSpeedUnit(match[2] ?? null);

  return {
    visibleSpeedValue,
    visibleSpeedUnit,
    visibleSpeedKmh: getVisibleSpeedKmh(visibleSpeedValue, visibleSpeedUnit, null),
  };
}

function normalizeAiSegment(input: unknown, index: number): AiSegmentDraftRow | null {
  if (!input || typeof input !== "object") return null;

  const row = input as Record<string, unknown>;
  const startSeconds =
    parseUnknownNumber(row.startSeconds) ??
    parseUnknownNumber(row.start) ??
    parseTimeSeconds(String(row.startTime ?? row.start_time ?? ""));
  const endSeconds =
    parseUnknownNumber(row.endSeconds) ??
    parseUnknownNumber(row.end) ??
    parseTimeSeconds(String(row.endTime ?? row.end_time ?? ""));

  if (startSeconds === null || endSeconds === null || startSeconds < 0 || endSeconds <= startSeconds) {
    return null;
  }

  const speedFromCell = parseSpeedCell(row.speed ?? row.visibleSpeed ?? row.visible_speed);
  const visibleSpeedValue =
    parseUnknownNumber(row.visibleSpeedValue) ?? parseUnknownNumber(row.speedValue) ?? speedFromCell.visibleSpeedValue;
  const visibleSpeedUnit =
    normalizeSpeedUnit(getTextValue(row.visibleSpeedUnit ?? row.speedUnit, 16)) ?? speedFromCell.visibleSpeedUnit;
  const visibleSpeedKmh = getVisibleSpeedKmh(
    visibleSpeedValue,
    visibleSpeedUnit,
    parseUnknownNumber(row.visibleSpeedKmh) ?? parseUnknownNumber(row.speedKmh) ?? speedFromCell.visibleSpeedKmh
  );
  const player = getTextValue(row.player ?? row.선수, 60);
  const kickType = getTextValue(row.kickType ?? row.type ?? row["킥 유형"], 80);
  const explicitLabel = getTextValue(row.label ?? row.clip ?? row.name, 80);
  const derivedLabel = [
    player,
    kickType,
    visibleSpeedValue && visibleSpeedUnit ? `${visibleSpeedValue}${visibleSpeedUnit}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const label = explicitLabel ?? (derivedLabel || `Clip ${index + 1}`);

  return {
    label,
    player,
    kickType,
    startSeconds,
    endSeconds,
    visibleSpeedValue,
    visibleSpeedUnit,
    visibleSpeedKmh,
    confidence: Math.max(0, Math.min(1, parseUnknownNumber(row.confidence) ?? 0.65)),
    evidence: getTextValue(row.evidence ?? row.notes ?? row.note, 240) ?? "Pasted AI draft row.",
    needsReview: parseUnknownBoolean(row.needsReview ?? row.review ?? row.needs_review) || true,
  };
}

function normalizeAiDraft(input: unknown, sourceLabel: string): AiSegmentDraft | null {
  if (Array.isArray(input)) {
    const segments = input
      .map((segment, index) => normalizeAiSegment(segment, index))
      .filter((segment): segment is AiSegmentDraftRow => Boolean(segment));

    if (segments.length === 0) return null;

    return {
      summary: `${sourceLabel}에서 ${segments.length}개 구간을 가져왔습니다.`,
      distanceCueMeters: null,
      warnings: ["붙여넣은 결과입니다. 저장/커팅 전 타임스탬프와 속도를 확인하세요."],
      segments,
    };
  }

  if (!input || typeof input !== "object") return null;

  const raw = input as Record<string, unknown>;
  const rawSegments = Array.isArray(raw.segments)
    ? raw.segments
    : Array.isArray(raw.clips)
      ? raw.clips
      : Array.isArray(raw.rows)
        ? raw.rows
        : [];
  const segments = rawSegments
    .map((segment, index) => normalizeAiSegment(segment, index))
    .filter((segment): segment is AiSegmentDraftRow => Boolean(segment));

  if (segments.length === 0) return null;

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.map((warning) => getTextValue(warning, 180)).filter((warning): warning is string => Boolean(warning))
    : [];

  return {
    summary: getTextValue(raw.summary, 300) ?? `${sourceLabel}에서 ${segments.length}개 구간을 가져왔습니다.`,
    distanceCueMeters: parseUnknownNumber(raw.distanceCueMeters),
    warnings,
    segments,
  };
}

function parseJsonDraft(text: string) {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.includes("{") ? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1) : null,
    trimmed.includes("[") ? trimmed.slice(trimmed.indexOf("["), trimmed.lastIndexOf("]") + 1) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next extraction shape.
    }
  }

  return null;
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
}

function getMappedCell(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value) return value;
  }

  return "";
}

function parseTableDraft(text: string) {
  const tableLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|") && !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line));

  if (tableLines.length < 2) return null;

  const headers = tableLines[0]
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(normalizeHeader);
  const rows = tableLines.slice(1).map((line) => {
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    return headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = cells[index] ?? "";
      return acc;
    }, {});
  });

  const segments = rows
    .map((row, index) => {
      const segmentRange = getMappedCell(row, ["영상구간시작-끝", "영상구간", "구간", "time", "timerange", "segment"]);
      const [rangeStart = "", rangeEnd = ""] = segmentRange.split(/\s*(?:-|~|–|—|to)\s*/i);
      const speedCell = getMappedCell(row, ["속도mph", "속도", "speedmph", "speed", "actualspeed"]);
      const speed = parseSpeedCell(speedCell);
      const unitFromHeader = Object.keys(row).find((key) => key.includes("mph"))
        ? "mph"
        : Object.keys(row).find((key) => key.includes("kmh") || key.includes("km/h"))
          ? "km/h"
          : null;
      const visibleSpeedUnit = speed.visibleSpeedUnit ?? unitFromHeader;
      const visibleSpeedValue = speed.visibleSpeedValue;
      const visibleSpeedKmh = getVisibleSpeedKmh(visibleSpeedValue, visibleSpeedUnit, speed.visibleSpeedKmh);
      const player = getTextValue(getMappedCell(row, ["선수", "player"]), 60);
      const kickType = getTextValue(getMappedCell(row, ["킥유형", "유형", "kicktype", "type"]), 80);

      return normalizeAiSegment(
        {
          label: getMappedCell(row, ["label", "clip", "name"]) || [player, kickType].filter(Boolean).join(" "),
          player,
          kickType,
          startSeconds: parseTimeSeconds(getMappedCell(row, ["startseconds", "start", "시작"]) || rangeStart),
          endSeconds: parseTimeSeconds(getMappedCell(row, ["endseconds", "end", "끝"]) || rangeEnd),
          visibleSpeedValue,
          visibleSpeedUnit,
          visibleSpeedKmh,
          confidence: parseUnknownNumber(getMappedCell(row, ["confidence", "확신도"])) ?? 0.65,
          evidence: getMappedCell(row, ["evidence", "근거", "notes", "note"]) || "Pasted Markdown table row.",
          needsReview: true,
        },
        index
      );
    })
    .filter((segment): segment is AiSegmentDraftRow => Boolean(segment));

  if (segments.length === 0) return null;

  return {
    summary: `Markdown 표에서 ${segments.length}개 구간을 가져왔습니다.`,
    distanceCueMeters: null,
    warnings: ["표에서 가져온 결과입니다. 속도 단위와 시작/끝 시간을 확인하세요."],
    segments,
  };
}

function parseFfmpegDraft(text: string) {
  const segments = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ffmpeg "))
    .map((line, index) => {
      const start = line.match(/\s-ss\s+(\S+)/)?.[1] ?? "";
      const end = line.match(/\s-to\s+(\S+)/)?.[1] ?? "";
      const duration = line.match(/\s-t\s+(\S+)/)?.[1] ?? "";
      const output = line.match(/\s([^\s]+\.mp4)\s*$/i)?.[1] ?? `Clip ${index + 1}`;
      const startSeconds = parseTimeSeconds(start);
      const endSeconds =
        parseTimeSeconds(end) ??
        (startSeconds !== null && parseTimeSeconds(duration) !== null
          ? startSeconds + (parseTimeSeconds(duration) ?? 0)
          : null);
      const speed = parseSpeedCell(output.replace(/_/g, " "));
      const label = output.replace(/\.mp4$/i, "").replace(/^\d+_?/, "").replace(/_/g, " ");

      return normalizeAiSegment(
        {
          label,
          startSeconds,
          endSeconds,
          visibleSpeedValue: speed.visibleSpeedValue,
          visibleSpeedUnit: speed.visibleSpeedUnit,
          visibleSpeedKmh: speed.visibleSpeedKmh,
          confidence: 0.7,
          evidence: "Pasted FFmpeg cut command.",
          needsReview: true,
        },
        index
      );
    })
    .filter((segment): segment is AiSegmentDraftRow => Boolean(segment));

  if (segments.length === 0) return null;

  return {
    summary: `FFmpeg 명령어에서 ${segments.length}개 구간을 가져왔습니다.`,
    distanceCueMeters: null,
    warnings: ["FFmpeg 명령어에서 가져온 결과입니다. 실제 속도와 선수명을 확인하세요."],
    segments,
  };
}

function parsePastedAiDraft(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const json = parseJsonDraft(trimmed);
  const jsonDraft = json ? normalizeAiDraft(json, "JSON") : null;
  if (jsonDraft) return jsonDraft;

  return parseTableDraft(trimmed) ?? parseFfmpegDraft(trimmed);
}

function getBatchClipRows(samples: BatchSampleState[]) {
  const rows: BatchClipRow[] = [];
  let error: string | null = null;

  samples.forEach((sample, index) => {
    if (error) return;

    const hasAnyValue = [
      sample.knownSpeedKmh,
      sample.measuredSpeedKmh,
      sample.timingStartSeconds,
      sample.timingEndSeconds,
      sample.notes,
    ].some((value) => value.trim().length > 0);

    if (!hasAnyValue) return;

    const startSeconds = parseTimeSeconds(sample.timingStartSeconds);
    const endSeconds = parseTimeSeconds(sample.timingEndSeconds);

    if (startSeconds === null || endSeconds === null) {
      error = `Row ${index + 1}: 클립을 자르려면 시작/끝 시간을 모두 입력해 주세요.`;
      return;
    }

    if (startSeconds < 0 || endSeconds <= startSeconds) {
      error = `Row ${index + 1}: 끝 시간은 시작 시간보다 커야 합니다.`;
      return;
    }

    rows.push({
      index,
      sample,
      startSeconds,
      endSeconds,
      knownSpeedKmh: parseFormNumber(sample.knownSpeedKmh),
    });
  });

  return { rows, error };
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
  const start = parseTimeSeconds(startSeconds);
  const end = parseTimeSeconds(endSeconds);

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
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const analysisRequestRef = useRef(0);
  const lastAnalyzedSourceUrlRef = useRef("");
  const nextBatchSampleIdRef = useRef(DEFAULT_BATCH_SAMPLE_COUNT);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [batchSamples, setBatchSamples] = useState<BatchSampleState[]>(() =>
    Array.from({ length: DEFAULT_BATCH_SAMPLE_COUNT }, (_, index) => createBatchSample(index))
  );
  const [distanceYards, setDistanceYards] = useState("12");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
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
  const [isBatchSaving, setIsBatchSaving] = useState(false);
  const [isCuttingClips, setIsCuttingClips] = useState(false);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none");
  const [heightPoints, setHeightPoints] = useState<Point[]>([]);
  const [ballPoints, setBallPoints] = useState<Point[]>([]);
  const [cutClips, setCutClips] = useState<CutClipResult[]>([]);
  const [clipCutProgress, setClipCutProgress] = useState<ClipCutProgress>({
    current: 0,
    total: 0,
    label: "",
  });
  const [pastedAiDraftText, setPastedAiDraftText] = useState("");
  const [aiSegmentDraft, setAiSegmentDraft] = useState<AiSegmentDraft | null>(null);
  const [aiSegmentError, setAiSegmentError] = useState<string | null>(null);
  const [isAnalyzingVideoSegments, setIsAnalyzingVideoSegments] = useState(false);
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
  const filledBatchSampleCount = useMemo(
    () =>
      batchSamples.filter((sample) =>
        [
          sample.knownSpeedKmh,
          sample.measuredSpeedKmh,
          sample.timingStartSeconds,
          sample.timingEndSeconds,
          sample.notes,
        ].some((value) => value.trim().length > 0)
      ).length,
    [batchSamples]
  );
  const timedBatchSampleCount = useMemo(
    () =>
      batchSamples.filter((sample) => {
        const start = parseTimeSeconds(sample.timingStartSeconds);
        const end = parseTimeSeconds(sample.timingEndSeconds);
        return start !== null && end !== null && end > start;
      }).length,
    [batchSamples]
  );

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

  const releaseCutClips = useCallback(() => {
    setCutClips((current) => {
      current.forEach((clip) => URL.revokeObjectURL(clip.url));
      return [];
    });
  }, []);

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

  useEffect(() => {
    return () => {
      cutClips.forEach((clip) => URL.revokeObjectURL(clip.url));
    };
  }, [cutClips]);

  useEffect(() => {
    return () => {
      ffmpegRef.current?.terminate();
    };
  }, []);

  const syncOverlayCanvasSize = useCallback(() => {
    const video = videoRef.current;
    const canvas = overlayCanvasRef.current;
    if (!video || !canvas) return false;

    const frameSize = getAnalysisFrameSize(video);
    const elementWidth = video.clientWidth;
    const elementHeight = video.clientHeight;

    if (frameSize.width <= 0 || frameSize.height <= 0 || elementWidth <= 0 || elementHeight <= 0) {
      return false;
    }

    if (canvas.width !== frameSize.width) canvas.width = frameSize.width;
    if (canvas.height !== frameSize.height) canvas.height = frameSize.height;

    const sourceAspect = frameSize.width / frameSize.height;
    const elementAspect = elementWidth / elementHeight;
    let contentWidth = elementWidth;
    let contentHeight = elementHeight;
    let contentLeft = 0;
    let contentTop = 0;

    if (elementAspect > sourceAspect) {
      contentWidth = elementHeight * sourceAspect;
      contentLeft = (elementWidth - contentWidth) / 2;
    } else if (elementAspect < sourceAspect) {
      contentHeight = elementWidth / sourceAspect;
      contentTop = (elementHeight - contentHeight) / 2;
    }

    canvas.style.left = `${contentLeft}px`;
    canvas.style.top = `${contentTop}px`;
    canvas.style.width = `${contentWidth}px`;
    canvas.style.height = `${contentHeight}px`;
    return true;
  }, []);

  const drawMeasurementOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !syncOverlayCanvasSize()) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawPoints = (points: Point[], color: string, labels: [string, string]) => {
      if (points.length === 0) return;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(2, canvas.width / 480);
      ctx.font = `${Math.max(12, Math.round(canvas.width / 70))}px ui-monospace, monospace`;
      ctx.textBaseline = "bottom";

      if (points.length === 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();

        const distance = calculateDistance(points[0], points[1]);
        const midX = (points[0].x + points[1].x) / 2;
        const midY = (points[0].y + points[1].y) / 2;
        ctx.fillText(`${distance.toFixed(1)} px`, Math.min(midX + 10, canvas.width - 120), Math.max(18, midY - 8));
      }

      points.forEach((point, index) => {
        const radius = Math.max(5, canvas.width / 160);
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(point.x - radius * 1.7, point.y);
        ctx.lineTo(point.x + radius * 1.7, point.y);
        ctx.moveTo(point.x, point.y - radius * 1.7);
        ctx.lineTo(point.x, point.y + radius * 1.7);
        ctx.stroke();

        const labelX = Math.min(point.x + radius + 8, canvas.width - 150);
        const labelY = Math.max(18, point.y - radius - 4);
        ctx.fillText(labels[index] ?? `P${index + 1}`, labelX, labelY);
      });

      ctx.restore();
    };

    drawPoints(heightPoints, "#39FF14", ["HEAD", "ANKLE"]);
    drawPoints(ballPoints, "#04d9ff", ["BALL START", "BALL END"]);
  }, [ballPoints, heightPoints, syncOverlayCanvasSize]);

  useEffect(() => {
    drawMeasurementOverlay();
  }, [drawMeasurementOverlay, playableVideoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playableVideoUrl) return;

    const resizeObserver = new ResizeObserver(() => {
      drawMeasurementOverlay();
    });
    resizeObserver.observe(video);
    window.addEventListener("resize", drawMeasurementOverlay);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", drawMeasurementOverlay);
    };
  }, [drawMeasurementOverlay, playableVideoUrl]);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateBatchSample = <K extends keyof BatchSampleState>(
    id: string,
    field: K,
    value: BatchSampleState[K]
  ) => {
    setBatchSamples((current) =>
      current.map((sample) => (sample.id === id ? { ...sample, [field]: value } : sample))
    );
  };

  const addBatchSample = () => {
    setBatchSamples((current) => {
      const nextIndex = nextBatchSampleIdRef.current;
      nextBatchSampleIdRef.current += 1;
      return [...current, createBatchSample(current.length, `batch-${nextIndex}`)];
    });
  };

  const removeBatchSample = (id: string) => {
    setBatchSamples((current) =>
      current.length > 1 ? current.filter((sample) => sample.id !== id) : current
    );
  };

  const resetBatchSamples = () => {
    nextBatchSampleIdRef.current = DEFAULT_BATCH_SAMPLE_COUNT;
    setBatchSamples(Array.from({ length: DEFAULT_BATCH_SAMPLE_COUNT }, (_, index) => createBatchSample(index)));
  };

  const applyYardDistance = () => {
    const yards = parseFormNumber(distanceYards);

    if (yards === null || yards <= 0 || yards > 120) {
      setError("유효한 yard 거리를 입력해 주세요.");
      return;
    }

    const meters = yards * YARD_TO_METER;

    setForm((current) => ({
      ...current,
      knownDistanceMeters: meters.toFixed(4),
      notes: current.notes || `거리 기준: ${yards} yards (${meters.toFixed(4)} m)`,
    }));
    setMessage(`${yards} yards 거리 기준을 적용했습니다.`);
    setError(null);
  };

  const startMeasurementMode = (mode: Exclude<MeasureMode, "none">) => {
    if (!playableVideoUrl) {
      setError("정확한 픽셀 측정은 로컬 영상 미리보기나 직접 재생 가능한 영상 URL에서만 가능합니다.");
      return;
    }

    setError(null);
    drawMeasurementOverlay();

    if (measureMode === mode) {
      setMeasureMode("none");
      return;
    }

    if (mode === "height") {
      if (heightPoints.length >= 2) setHeightPoints([]);
      setMeasureMode("height");
      setMessage("머리 위치를 클릭한 뒤 디딤발 발목 위치를 클릭하세요.");
      return;
    }

    if (ballPoints.length >= 2) setBallPoints([]);
    setMeasureMode("ball");
    setMessage(
      ballPoints.length === 0
        ? "임팩트 프레임에서 공 위치를 클릭하세요."
        : "끝 프레임으로 이동한 뒤 공 위치를 클릭하세요."
    );
  };

  const clearMeasurementMarks = () => {
    setMeasureMode("none");
    setHeightPoints([]);
    setBallPoints([]);
  };

  const handleMeasurementCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (measureMode === "none") return;

    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const point: Point = {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };

    if (point.x < 0 || point.y < 0 || point.x > canvas.width || point.y > canvas.height) {
      setError("영상 영역 안쪽을 클릭해 주세요.");
      return;
    }

    if (measureMode === "height") {
      const nextPoints = heightPoints.length >= 2 ? [point] : [...heightPoints, point];
      setHeightPoints(nextPoints);

      if (nextPoints.length === 2) {
        const distance = calculateDistance(nextPoints[0], nextPoints[1]);
        updateForm("bodyHeightPx", distance.toFixed(1));
        setMeasureMode("none");
        setMessage(`신체 높이 ${distance.toFixed(1)} px를 입력했습니다.`);
      } else {
        setMessage("디딤발 발목 위치를 클릭하세요.");
      }
      return;
    }

    const nextPoints = ballPoints.length >= 2 ? [point] : [...ballPoints, point];
    setBallPoints(nextPoints);

    if (nextPoints.length === 1) {
      setMeasureMode("none");
      setMessage("공 시작점을 저장했습니다. 끝 프레임으로 이동한 뒤 Ball Travel을 다시 눌러 끝점을 찍으세요.");
      return;
    }

    const distance = calculateDistance(nextPoints[0], nextPoints[1]);
    updateForm("ballDisplacementPx", distance.toFixed(1));
    setMeasureMode("none");
    setMessage(`공 이동량 ${distance.toFixed(1)} px를 입력했습니다.`);
  };

  const copyCurrentFormToBatch = () => {
    const nextSample = (index: number, id: string): BatchSampleState => ({
      id,
      labelSuffix: `Clip ${index + 1}`,
      knownSpeedKmh: form.knownSpeedKmh,
      measuredSpeedKmh: form.measuredSpeedKmh,
      timingStartSeconds: form.timingStartSeconds,
      timingEndSeconds: form.timingEndSeconds,
      notes: "",
    });

    setBatchSamples((current) => {
      const emptyIndex = current.findIndex(
        (sample) =>
          !sample.knownSpeedKmh.trim() &&
          !sample.measuredSpeedKmh.trim() &&
          !sample.timingStartSeconds.trim() &&
          !sample.timingEndSeconds.trim()
      );

      if (emptyIndex >= 0) {
        return current.map((sample, index) =>
          index === emptyIndex ? nextSample(index, sample.id) : sample
        );
      }

      const nextIndex = nextBatchSampleIdRef.current;
      nextBatchSampleIdRef.current += 1;
      return [...current, nextSample(current.length, `batch-${nextIndex}`)];
    });

    setMessage("현재 입력값을 배치 샘플에 복사했습니다.");
    setError(null);
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
    setVideoFile(file);
    releaseCutClips();
    setClipCutProgress({ current: 0, total: 0, label: "" });
    setAiSegmentDraft(null);
    setAiSegmentError(null);
    setPastedAiDraftText("");
    setForm((current) => ({
      ...current,
      label: current.label || file.name.replace(/\.[^.]+$/, ""),
      sourceFilename: file.name,
      sourceMimeType: file.type,
      sourceSizeBytes: file.size,
    }));
    setMessage(null);
    setError(null);
    setMeasureMode("none");
    setHeightPoints([]);
    setBallPoints([]);
  };

  const updateSourceUrl = (value: string) => {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
    }

    setVideoFile(null);
    releaseCutClips();
    setClipCutProgress({ current: 0, total: 0, label: "" });
    setAiSegmentDraft(null);
    setAiSegmentError(null);
    setPastedAiDraftText("");
    setForm((current) => ({
      ...current,
      sourceUrl: value,
    }));
    setLinkAnalysis(null);
    setLinkAnalysisError(null);
    setIsVideoPlaying(false);
    setMeasureMode("none");
    setHeightPoints([]);
    setBallPoints([]);
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
    window.requestAnimationFrame(drawMeasurementOverlay);
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
    setVideoFile(null);
    setForm(EMPTY_FORM);
    resetBatchSamples();
    releaseCutClips();
    setClipCutProgress({ current: 0, total: 0, label: "" });
    setAiSegmentDraft(null);
    setAiSegmentError(null);
    setPastedAiDraftText("");
    setMeasureMode("none");
    setHeightPoints([]);
    setBallPoints([]);
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
          timingStartSeconds: parseTimeSeconds(form.timingStartSeconds),
          timingEndSeconds: parseTimeSeconds(form.timingEndSeconds),
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

  const saveBatchSamples = async () => {
    const distanceMeters = parseFormNumber(form.knownDistanceMeters);

    if (distanceMeters === null || distanceMeters <= 0) {
      setError("배치 저장에는 공통 거리 기준이 필요합니다. yard 값을 적용하거나 meter 값을 입력해 주세요.");
      return;
    }

    const baseLabel = (form.label || linkAnalysis?.suggestedLabel || "Reference").trim();
    const rows: Array<{
      index: number;
      sample: BatchSampleState;
      knownSpeedKmh: number;
      measuredSpeedKmh: number;
      timingStartSeconds: number | null;
      timingEndSeconds: number | null;
    }> = [];
    let validationError: string | null = null;

    batchSamples.forEach((sample, index) => {
      if (validationError) return;

      const hasAnyValue = [
        sample.knownSpeedKmh,
        sample.measuredSpeedKmh,
        sample.timingStartSeconds,
        sample.timingEndSeconds,
        sample.notes,
      ].some((value) => value.trim().length > 0);

      if (!hasAnyValue) return;

      const knownSpeedKmh = parseFormNumber(sample.knownSpeedKmh);
      const measuredInputKmh = parseFormNumber(sample.measuredSpeedKmh);
      const timingStartSeconds = parseTimeSeconds(sample.timingStartSeconds);
      const timingEndSeconds = parseTimeSeconds(sample.timingEndSeconds);
      const hasPartialTiming =
        (timingStartSeconds === null && timingEndSeconds !== null) ||
        (timingStartSeconds !== null && timingEndSeconds === null);
      const timingSpeedKmh = getTimingSpeedKmh(
        form.knownDistanceMeters,
        sample.timingStartSeconds,
        sample.timingEndSeconds
      );
      const measuredSpeedKmh = measuredInputKmh ?? timingSpeedKmh;

      if (knownSpeedKmh === null) {
        validationError = `Row ${index + 1}: 실제 속도를 입력해 주세요.`;
        return;
      }

      if (hasPartialTiming) {
        validationError = `Row ${index + 1}: 시작/끝 시간을 모두 입력해 주세요.`;
        return;
      }

      if (measuredSpeedKmh === null) {
        validationError = `Row ${index + 1}: 앱 분석 속도를 입력하거나 유효한 시작/끝 시간을 입력해 주세요.`;
        return;
      }

      rows.push({
        index,
        sample,
        knownSpeedKmh,
        measuredSpeedKmh,
        timingStartSeconds,
        timingEndSeconds,
      });
    });

    if (validationError) {
      setError(validationError);
      return;
    }

    if (rows.length === 0) {
      setError("저장할 배치 샘플을 하나 이상 입력해 주세요.");
      return;
    }

    setIsBatchSaving(true);
    setError(null);
    setMessage(null);

    try {
      for (const row of rows) {
        const labelSuffix = row.sample.labelSuffix.trim() || `Clip ${row.index + 1}`;
        const notes = [
          form.notes.trim(),
          row.sample.notes.trim(),
          `Batch sample: ${labelSuffix}`,
          `Distance: ${distanceMeters.toFixed(4)} m`,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500);

        const res = await fetch("/api/admin/references", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(adminToken ? { "x-admin-token": adminToken } : {}),
          },
          body: JSON.stringify({
            label: `${baseLabel} - ${labelSuffix}`,
            knownSpeedKmh: row.knownSpeedKmh,
            measuredSpeedKmh: row.measuredSpeedKmh,
            knownDistanceMeters: distanceMeters,
            ballDisplacementPx: parseFormNumber(form.ballDisplacementPx),
            bodyHeightPx: parseFormNumber(form.bodyHeightPx),
            videoWidth: parseFormNumber(form.videoWidth),
            videoHeight: parseFormNumber(form.videoHeight),
            durationSeconds: parseFormNumber(form.durationSeconds),
            fps: parseFormNumber(form.fps),
            timingStartSeconds: row.timingStartSeconds,
            timingEndSeconds: row.timingEndSeconds,
            playerHeightCm: parseFormNumber(form.playerHeightCm),
            cameraAngle: form.cameraAngle,
            notes,
            sourceFilename: form.sourceFilename,
            sourceMimeType: form.sourceMimeType,
            sourceSizeBytes: form.sourceSizeBytes,
            sourceUrl: form.sourceUrl,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          setError(data.error ?? `${labelSuffix} 샘플을 저장하지 못했습니다.`);
          return;
        }
      }

      resetBatchSamples();
      setMessage(`${rows.length}개 배치 샘플을 저장했습니다.`);
      await loadReferences();
    } catch {
      setError("배치 샘플을 저장하지 못했습니다.");
    } finally {
      setIsBatchSaving(false);
    }
  };

  const copyGeminiSegmentPrompt = async () => {
    try {
      await navigator.clipboard.writeText(GEMINI_SEGMENT_PROMPT);
      setMessage("Gemini 분석 프롬프트를 복사했습니다.");
      setError(null);
    } catch {
      setError("프롬프트를 복사하지 못했습니다.");
    }
  };

  const applyAiSegmentDraftRows = (draft: AiSegmentDraft, successMessage: string) => {
    nextBatchSampleIdRef.current = draft.segments.length;
    setBatchSamples(
      draft.segments.map((segment, index) => ({
        id: `ai-${index}-${segment.startSeconds}`,
        labelSuffix: getAiDraftBatchLabel(segment, index),
        knownSpeedKmh: segment.visibleSpeedKmh !== null ? segment.visibleSpeedKmh.toFixed(1) : "",
        measuredSpeedKmh: "",
        timingStartSeconds: segment.startSeconds.toFixed(3),
        timingEndSeconds: segment.endSeconds.toFixed(3),
        notes: [
          `AI evidence: ${segment.evidence}`,
          `Confidence: ${Math.round(segment.confidence * 100)}%`,
          segment.needsReview ? "Needs timestamp review" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }))
    );
    releaseCutClips();
    setClipCutProgress({ current: 0, total: 0, label: "" });
    setMessage(successMessage);
    setError(null);
  };

  const parsePastedAiSegments = () => {
    const draft = parsePastedAiDraft(pastedAiDraftText);

    if (!draft) {
      setAiSegmentError("코드에서 구간을 찾지 못했습니다. FFmpeg 명령어, JSON, Markdown 표 형식을 확인해 주세요.");
      return;
    }

    setAiSegmentDraft(draft);
    setAiSegmentError(null);

    if (draft.distanceCueMeters && !form.knownDistanceMeters.trim()) {
      updateForm("knownDistanceMeters", draft.distanceCueMeters.toFixed(3));
    }

    applyAiSegmentDraftRows(
      draft,
      `${draft.segments.length}개 코드 구간을 Manual Segments에 적용했습니다. 저장/커팅 전에 시간을 확인하세요.`
    );
  };

  const analyzeVideoSegments = async () => {
    if (!videoFile) {
      setError("AI 구간 분석은 로컬로 불러온 영상 파일에서만 가능합니다.");
      return;
    }

    setIsAnalyzingVideoSegments(true);
    setAiSegmentError(null);
    setAiSegmentDraft(null);
    setError(null);
    setMessage(null);

    const context = [
      form.label ? `Label: ${form.label}` : null,
      form.sourceUrl ? `Source URL: ${form.sourceUrl}` : null,
      form.knownDistanceMeters ? `Known distance meters: ${form.knownDistanceMeters}` : null,
      distanceYards ? `Common distance yards: ${distanceYards}` : null,
      "Goal: detect candidate kick clips, visible speed overlays, and reviewable timestamps for reference calibration.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const payload = new FormData();
      payload.append("video", videoFile);
      payload.append("context", context);

      const res = await fetch("/api/admin/references/analyze-video-segments", {
        method: "POST",
        headers: {
          ...(adminToken ? { "x-admin-token": adminToken } : {}),
        },
        body: payload,
      });
      const data = (await res.json()) as AiSegmentAnalysisResponse;

      if (!res.ok || !data.draft) {
        setAiSegmentError(data.error ?? "AI 구간 분석에 실패했습니다.");
        return;
      }

      setAiSegmentDraft(data.draft);

      if (data.draft.distanceCueMeters && !form.knownDistanceMeters.trim()) {
        updateForm("knownDistanceMeters", data.draft.distanceCueMeters.toFixed(3));
      }

      applyAiSegmentDraftRows(
        data.draft,
        `${data.draft.segments.length}개 AI 구간을 Manual Segments에 적용했습니다. 저장/커팅 전에 시간을 확인하세요.`
      );
    } catch {
      setAiSegmentError("AI 구간 분석에 실패했습니다.");
    } finally {
      setIsAnalyzingVideoSegments(false);
    }
  };

  const cutBatchClips = async () => {
    if (!videoFile) {
      setError("클립 생성은 로컬로 불러온 영상 파일에서만 가능합니다.");
      return;
    }

    const { rows, error: clipRowsError } = getBatchClipRows(batchSamples);

    if (clipRowsError) {
      setError(clipRowsError);
      return;
    }

    if (rows.length === 0) {
      setError("자를 배치 구간의 시작/끝 시간을 하나 이상 입력해 주세요.");
      return;
    }

    setIsCuttingClips(true);
    setError(null);
    setMessage(null);
    releaseCutClips();
    setClipCutProgress({ current: 0, total: rows.length, label: "FFmpeg 로드 중" });

    const inputName = getInputFileName(videoFile);
    const baseLabel = (form.label || linkAnalysis?.suggestedLabel || "Reference").trim();

    try {
      const [{ FFmpeg }, { fetchFile }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);

      let ffmpeg = ffmpegRef.current;

      if (!ffmpeg) {
        ffmpeg = new FFmpeg();
        ffmpegRef.current = ffmpeg;
      }

      if (!ffmpeg.loaded) {
        await loadFfmpegCore(ffmpeg, (label) => {
          setClipCutProgress({ current: 0, total: rows.length, label });
        });
      }

      setClipCutProgress({ current: 0, total: rows.length, label: "영상 파일 준비 중" });
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      const nextClips: CutClipResult[] = [];

      for (const [clipIndex, row] of rows.entries()) {
        const outputName = getCutOutputName(baseLabel, row);
        const durationSeconds = row.endSeconds - row.startSeconds;

        setClipCutProgress({
          current: clipIndex + 1,
          total: rows.length,
          label: row.sample.labelSuffix || `Clip ${row.index + 1}`,
        });

        const exitCode = await ffmpeg.exec([
          "-ss",
          formatTimestamp(row.startSeconds),
          "-i",
          inputName,
          "-t",
          durationSeconds.toFixed(3),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          outputName,
        ]);

        if (exitCode !== 0) {
          throw new Error(`${outputName} 생성에 실패했습니다.`);
        }

        const data = await ffmpeg.readFile(outputName);

        if (!(data instanceof Uint8Array)) {
          throw new Error(`${outputName} 결과를 읽지 못했습니다.`);
        }

        const blob = new Blob([new Uint8Array(data)], { type: "video/mp4" });
        nextClips.push({
          id: `${row.index}-${row.startSeconds}-${row.endSeconds}`,
          name: outputName,
          url: URL.createObjectURL(blob),
          sizeBytes: blob.size,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds,
        });

        await ffmpeg.deleteFile(outputName).catch(() => undefined);
      }

      await ffmpeg.deleteFile(inputName).catch(() => undefined);

      setCutClips(nextClips);
      setMessage(`${nextClips.length}개 클립을 생성했습니다. 아래 다운로드 링크를 사용하세요.`);
    } catch (cutError) {
      ffmpegRef.current?.terminate();
      ffmpegRef.current = null;
      setError(cutError instanceof Error ? cutError.message : "클립 생성에 실패했습니다.");
      setClipCutProgress({ current: 0, total: rows.length, label: "" });
    } finally {
      setIsCuttingClips(false);
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
                <div className="mb-4 flex min-h-64 flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-white/20 bg-black/30">
                  {playableVideoUrl ? (
                    <div className="relative flex w-full items-center justify-center">
                      <video
                        ref={videoRef}
                        src={playableVideoUrl}
                        className="block max-h-[48vh] w-full object-contain"
                        controls
                        muted
                        playsInline
                        onLoadedMetadata={handleVideoMetadata}
                        onLoadedData={() => drawMeasurementOverlay()}
                        onCanPlay={() => drawMeasurementOverlay()}
                        onPlay={() => setIsVideoPlaying(true)}
                        onPause={() => setIsVideoPlaying(false)}
                      />
                      <canvas
                        ref={overlayCanvasRef}
                        onClick={handleMeasurementCanvasClick}
                        className={`absolute z-10 ${
                          measureMode !== "none" ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
                        }`}
                        aria-label="Measurement overlay"
                      />
                    </div>
                  ) : (
                    <label className="flex min-h-64 w-full cursor-pointer flex-col items-center justify-center gap-3 text-gray-400 transition-colors hover:text-white">
                      <Upload size={34} className="text-[var(--color-neon-green)]" />
                      <span className="text-sm font-bold text-white">Load local preview</span>
                      <input type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
                    </label>
                  )}
                </div>

                {playableVideoUrl && (
                  <label className="mb-4 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-sm font-bold text-gray-300 transition-colors hover:bg-white/10 hover:text-white">
                    <Upload size={16} />
                    Load different local preview
                    <input type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
                  </label>
                )}

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

                <details className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div>
                      <div className="font-mono text-[10px] tracking-widest text-gray-500">ADVANCED MEASUREMENT</div>
                      <div className="mt-1 text-sm font-bold text-white">Pixel capture</div>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 font-mono text-[10px] tracking-widest ${
                        playableVideoUrl
                          ? "border-[var(--color-neon-green)]/40 text-[var(--color-neon-green)]"
                          : "border-white/15 text-gray-500"
                      }`}
                    >
                      {playableVideoUrl ? "READY" : "LOCAL VIDEO NEEDED"}
                    </span>
                  </summary>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => startMeasurementMode("height")}
                      disabled={!playableVideoUrl}
                      className={`rounded-lg border px-3 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        measureMode === "height"
                          ? "border-[var(--color-neon-green)] bg-[var(--color-neon-green)] text-black"
                          : "border-white/15 hover:bg-white/10"
                      }`}
                    >
                      Body Height
                    </button>
                    <button
                      type="button"
                      onClick={() => startMeasurementMode("ball")}
                      disabled={!playableVideoUrl}
                      className={`rounded-lg border px-3 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        measureMode === "ball"
                          ? "border-[var(--color-neon-blue)] bg-[var(--color-neon-blue)] text-black"
                          : "border-white/15 hover:bg-white/10"
                      }`}
                    >
                      Ball Travel
                    </button>
                    <button
                      type="button"
                      onClick={clearMeasurementMarks}
                      disabled={heightPoints.length === 0 && ballPoints.length === 0}
                      className="rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-400">
                    <div className="rounded-lg bg-black/20 p-3">
                      <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">BODY PX</div>
                      {form.bodyHeightPx || "-"}
                    </div>
                    <div className="rounded-lg bg-black/20 p-3">
                      <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">BALL PX</div>
                      {form.ballDisplacementPx || "-"}
                    </div>
                  </div>

                  {youtubeVideoId && !playableVideoUrl && (
                    <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-100/80">
                      YouTube iframe은 정확한 픽셀 좌표계를 보장하지 않습니다. 같은 원본 영상을 로컬 미리보기로 올린 뒤 측정하세요.
                    </div>
                  )}
                </details>
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

                <details className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <summary className="cursor-pointer list-none font-mono text-[10px] tracking-widest text-gray-500">
                    OPTIONAL SOURCE METADATA
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
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
                </details>

                <div className="rounded-xl border border-[var(--color-neon-blue)]/25 bg-[var(--color-neon-blue)]/5 p-4">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-[10px] tracking-widest text-[var(--color-neon-blue)]">
                        MANUAL SEGMENTS
                      </div>
                      <div className="mt-1 text-sm font-bold text-white">Same source batch</div>
                    </div>
                    <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-[10px] tracking-widest text-gray-400">
                      {filledBatchSampleCount} READY · {timedBatchSampleCount} CUT
                    </span>
                  </div>

                  <div className="mb-4 rounded-xl border border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/5 p-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-[10px] tracking-widest text-[var(--color-neon-green)]">
                          GEMINI / FFMPEG CODE
                        </div>
                        <div className="mt-1 text-sm font-bold text-white">Paste commands and fill rows</div>
                      </div>
                      <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-[10px] tracking-widest text-gray-400">
                        {aiSegmentDraft?.segments.length ?? 0} FOUND
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
                      <button
                        type="button"
                        onClick={copyGeminiSegmentPrompt}
                        className="flex items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                      >
                        <Copy size={14} />
                        Copy Prompt
                      </button>
                      <button
                        type="button"
                        onClick={parsePastedAiSegments}
                        disabled={!pastedAiDraftText.trim()}
                        className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-neon-green)] px-3 py-2 text-sm font-black text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <PlayCircle size={15} />
                        Run Code
                      </button>
                    </div>

                    <textarea
                      value={pastedAiDraftText}
                      onChange={(event) => setPastedAiDraftText(event.target.value)}
                      rows={7}
                      placeholder="ffmpeg -i input.mp4 -ss 00:01:54 -to 00:02:05 -c copy 01_Nicky_55mph.mp4"
                      className="mt-3 w-full resize-y rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-xs leading-relaxed text-gray-200 outline-none placeholder:text-gray-600 focus:border-[var(--color-neon-green)]"
                    />

                    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                      <summary className="cursor-pointer list-none font-mono text-[10px] tracking-widest text-gray-500">
                        API VIDEO ANALYSIS
                      </summary>
                      <button
                        type="button"
                        onClick={analyzeVideoSegments}
                        disabled={!videoFile || isAnalyzingVideoSegments || isSaving || isBatchSaving || isCuttingClips}
                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isAnalyzingVideoSegments ? (
                          <Loader2 className="animate-spin" size={16} />
                        ) : (
                          <Activity size={16} />
                        )}
                        Analyze Local Video
                      </button>
                    </details>

                    {aiSegmentError && (
                      <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-100">
                        {aiSegmentError}
                      </div>
                    )}

                    {aiSegmentDraft && (
                      <div className="mt-3 space-y-3">
                        <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-gray-300">
                          {aiSegmentDraft.summary}
                          {aiSegmentDraft.distanceCueMeters !== null && (
                            <div className="mt-2 font-mono text-[10px] tracking-widest text-gray-500">
                              DISTANCE CUE {formatNumber(aiSegmentDraft.distanceCueMeters, 2)} M
                            </div>
                          )}
                        </div>

                        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                          {aiSegmentDraft.segments.map((segment, index) => (
                            <div key={`${segment.startSeconds}-${segment.endSeconds}-${index}`} className="rounded-lg border border-white/10 bg-black/20 p-3">
                              <div className="mb-2 flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-bold text-white">
                                    {getAiDraftBatchLabel(segment, index)}
                                  </div>
                                  <div className="mt-1 font-mono text-[10px] tracking-widest text-gray-500">
                                    {formatTimestamp(segment.startSeconds)} - {formatTimestamp(segment.endSeconds)}
                                  </div>
                                </div>
                                <span
                                  className={`shrink-0 rounded-full border px-2 py-1 font-mono text-[10px] tracking-widest ${
                                    segment.needsReview
                                      ? "border-amber-300/30 text-amber-100"
                                      : "border-[var(--color-neon-green)]/40 text-[var(--color-neon-green)]"
                                  }`}
                                >
                                  {Math.round(segment.confidence * 100)}%
                                </span>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
                                <div className="rounded bg-white/5 p-2">
                                  <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">
                                    SPEED
                                  </div>
                                  {getAiSpeedLabel(segment)}
                                </div>
                                <div className="rounded bg-white/5 p-2">
                                  <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">
                                    ACTUAL
                                  </div>
                                  {formatNumber(segment.visibleSpeedKmh)} km/h
                                </div>
                              </div>

                              <p className="mt-2 text-xs leading-relaxed text-gray-500">{segment.evidence}</p>
                            </div>
                          ))}
                        </div>

                        {aiSegmentDraft.warnings.length > 0 && (
                          <div className="space-y-1 text-xs leading-relaxed text-amber-100/80">
                            {aiSegmentDraft.warnings.map((warning) => (
                              <div key={warning}>- {warning}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="mb-3 font-mono text-[10px] tracking-widest text-gray-500">DISTANCE BASELINE</div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                          Distance yd
                        </span>
                        <input
                          inputMode="decimal"
                          value={distanceYards}
                          onChange={(event) => setDistanceYards(event.target.value)}
                          className="min-w-0 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                        />
                      </label>
                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                          Distance m
                        </span>
                        <input
                          inputMode="decimal"
                          value={form.knownDistanceMeters}
                          onChange={(event) => updateForm("knownDistanceMeters", event.target.value)}
                          className="min-w-0 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={applyYardDistance}
                      className="mt-2 w-full rounded-lg border border-[var(--color-neon-blue)]/40 px-3 py-2 text-sm font-black text-[var(--color-neon-blue)] transition-colors hover:bg-[var(--color-neon-blue)]/10"
                    >
                      Apply Yards
                    </button>
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={copyCurrentFormToBatch}
                      className="flex items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                    >
                      <Copy size={14} />
                      Copy Current
                    </button>
                    <button
                      type="button"
                      onClick={addBatchSample}
                      className="flex items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                    >
                      <Plus size={14} />
                      Add Row
                    </button>
                  </div>

                  <div className="space-y-3">
                    {batchSamples.map((sample, index) => {
                      const rowTimingSpeedKmh = getTimingSpeedKmh(
                        form.knownDistanceMeters,
                        sample.timingStartSeconds,
                        sample.timingEndSeconds
                      );

                      return (
                        <div key={sample.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <label className="flex flex-col gap-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                Clip label
                              </span>
                              <input
                                value={sample.labelSuffix}
                                onChange={(event) =>
                                  updateBatchSample(sample.id, "labelSuffix", event.target.value)
                                }
                                className="min-w-0 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => removeBatchSample(sample.id)}
                              disabled={batchSamples.length <= 1}
                              className="self-end rounded-lg border border-red-400/30 px-3 py-2 text-red-200 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`Remove row ${index + 1}`}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <label className="flex flex-col gap-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                Actual km/h
                              </span>
                              <input
                                inputMode="decimal"
                                value={sample.knownSpeedKmh}
                                onChange={(event) =>
                                  updateBatchSample(sample.id, "knownSpeedKmh", event.target.value)
                                }
                                className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                              />
                            </label>
                            <label className="flex flex-col gap-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                App km/h
                              </span>
                              <input
                                inputMode="decimal"
                                value={sample.measuredSpeedKmh}
                                onChange={(event) =>
                                  updateBatchSample(sample.id, "measuredSpeedKmh", event.target.value)
                                }
                                className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                              />
                            </label>
                          </div>

                          <div className="mt-2 grid grid-cols-3 gap-2">
                            <label className="flex flex-col gap-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                Start
                              </span>
                              <input
                                inputMode="decimal"
                                value={sample.timingStartSeconds}
                                onChange={(event) =>
                                  updateBatchSample(sample.id, "timingStartSeconds", event.target.value)
                                }
                                className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                              />
                            </label>
                            <label className="flex flex-col gap-2">
                              <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                                End
                              </span>
                              <input
                                inputMode="decimal"
                                value={sample.timingEndSeconds}
                                onChange={(event) =>
                                  updateBatchSample(sample.id, "timingEndSeconds", event.target.value)
                                }
                                className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                              />
                            </label>
                            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                              <div className="mb-1 font-mono text-[10px] tracking-widest text-gray-500">
                                TIMING
                              </div>
                              <div className="text-lg font-black text-white">
                                {formatNumber(rowTimingSpeedKmh)}
                              </div>
                            </div>
                          </div>

                          <label className="mt-2 flex flex-col gap-2">
                            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
                              Row notes
                            </span>
                            <input
                              value={sample.notes}
                              onChange={(event) => updateBatchSample(sample.id, "notes", event.target.value)}
                              className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-[var(--color-neon-blue)]"
                            />
                          </label>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
                    <button
                      type="button"
                      onClick={resetBatchSamples}
                      className="rounded-lg border border-white/15 px-3 py-2 text-sm font-bold transition-colors hover:bg-white/10"
                    >
                      Reset Rows
                    </button>
                    <button
                      type="button"
                      onClick={saveBatchSamples}
                      disabled={isBatchSaving || isSaving}
                      className="flex items-center justify-center gap-2 rounded-lg bg-[var(--color-neon-blue)] px-3 py-2 text-sm font-black text-black transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBatchSaving ? <Loader2 className="animate-spin" size={16} /> : <Activity size={16} />}
                      Save Batch
                    </button>
                    <button
                      type="button"
                      onClick={cutBatchClips}
                      disabled={!videoFile || timedBatchSampleCount === 0 || isCuttingClips || isBatchSaving || isSaving}
                      className="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-neon-green)]/40 px-3 py-2 text-sm font-black text-[var(--color-neon-green)] transition-colors hover:bg-[var(--color-neon-green)]/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isCuttingClips ? <Loader2 className="animate-spin" size={16} /> : <Scissors size={16} />}
                      Cut Clips
                    </button>
                  </div>

                  {(isCuttingClips || cutClips.length > 0) && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="font-mono text-[10px] tracking-widest text-gray-500">CUT OUTPUTS</div>
                        <div className="text-xs text-gray-400">
                          {isCuttingClips
                            ? `${clipCutProgress.current}/${clipCutProgress.total}`
                            : `${cutClips.length} files`}
                        </div>
                      </div>

                      {isCuttingClips && (
                        <div>
                          <div className="mb-2 truncate text-xs text-gray-300">
                            {clipCutProgress.label || "Processing"}
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-white/10">
                            <div
                              className="h-full bg-[var(--color-neon-green)] transition-all"
                              style={{
                                width:
                                  clipCutProgress.total > 0
                                    ? `${Math.round((clipCutProgress.current / clipCutProgress.total) * 100)}%`
                                    : "8%",
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {cutClips.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {cutClips.map((clip) => (
                            <a
                              key={clip.id}
                              href={clip.url}
                              download={clip.name}
                              className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs transition-colors hover:bg-white/10"
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-bold text-white">{clip.name}</span>
                                <span className="mt-1 block font-mono text-[10px] text-gray-500">
                                  {formatTimestamp(clip.startSeconds)} - {formatTimestamp(clip.endSeconds)} ·{" "}
                                  {formatFileSize(clip.sizeBytes)}
                                </span>
                              </span>
                              <Download size={16} className="shrink-0 text-[var(--color-neon-green)]" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

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
