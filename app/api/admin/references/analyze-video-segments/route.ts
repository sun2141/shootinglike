import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.5-flash";
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;

type GeminiFileInfo = {
  file?: {
    name?: string;
    uri?: string;
    mimeType?: string;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type RawSegment = {
  label?: unknown;
  player?: unknown;
  kickType?: unknown;
  startSeconds?: unknown;
  endSeconds?: unknown;
  visibleSpeedValue?: unknown;
  visibleSpeedUnit?: unknown;
  visibleSpeedKmh?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  needsReview?: unknown;
};

type RawDraft = {
  summary?: unknown;
  warnings?: unknown;
  distanceCueMeters?: unknown;
  segments?: unknown;
};

const segmentResponseSchema = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    distanceCueMeters: { type: "NUMBER", nullable: true },
    warnings: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          player: { type: "STRING", nullable: true },
          kickType: { type: "STRING", nullable: true },
          startSeconds: { type: "NUMBER" },
          endSeconds: { type: "NUMBER" },
          visibleSpeedValue: { type: "NUMBER", nullable: true },
          visibleSpeedUnit: { type: "STRING", nullable: true },
          visibleSpeedKmh: { type: "NUMBER", nullable: true },
          confidence: { type: "NUMBER" },
          evidence: { type: "STRING" },
          needsReview: { type: "BOOLEAN" },
        },
        required: ["label", "startSeconds", "endSeconds", "confidence", "evidence", "needsReview"],
      },
    },
  },
  required: ["summary", "warnings", "segments"],
};

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || null;
}

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function parseNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function getVideoMimeType(file: File) {
  if (file.type.startsWith("video/")) return file.type;

  const filename = file.name.toLowerCase();
  if (filename.endsWith(".webm")) return "video/webm";
  if (filename.endsWith(".mov")) return "video/quicktime";
  if (filename.endsWith(".m4v")) return "video/x-m4v";
  if (filename.endsWith(".avi")) return "video/x-msvideo";
  if (filename.endsWith(".mkv")) return "video/x-matroska";
  return "video/mp4";
}

function getSpeedKmh(value: number | null, unit: string | null, modelValue: number | null) {
  if (modelValue !== null && modelValue > 0 && modelValue < 300) return modelValue;
  if (value === null || value <= 0) return null;

  const normalizedUnit = unit?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (normalizedUnit === "mph") return value * 1.609344;
  if (normalizedUnit === "mps" || normalizedUnit === "ms") return value * 3.6;
  if (normalizedUnit === "kmh" || normalizedUnit === "kph" || normalizedUnit === "kmh") return value;
  return null;
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as RawDraft;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced?.trim().startsWith("{")) return JSON.parse(fenced) as RawDraft;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as RawDraft;

  throw new Error("Gemini response did not include JSON.");
}

function normalizeDraft(raw: RawDraft) {
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.map((warning) => sanitizeText(warning, 180)).filter((warning): warning is string => Boolean(warning))
    : [];

  const segments = Array.isArray(raw.segments)
    ? raw.segments
        .map((segment, index) => normalizeSegment(segment as RawSegment, index))
        .filter((segment) => segment !== null)
    : [];

  return {
    summary: sanitizeText(raw.summary, 300) ?? "AI segment draft",
    distanceCueMeters: parseNumber(raw.distanceCueMeters),
    warnings,
    segments,
  };
}

function normalizeSegment(segment: RawSegment, index: number) {
  const startSeconds = parseNumber(segment.startSeconds);
  const endSeconds = parseNumber(segment.endSeconds);

  if (startSeconds === null || endSeconds === null || startSeconds < 0 || endSeconds <= startSeconds) {
    return null;
  }

  const visibleSpeedValue = parseNumber(segment.visibleSpeedValue);
  const visibleSpeedUnit = sanitizeText(segment.visibleSpeedUnit, 16);
  const visibleSpeedKmh = getSpeedKmh(visibleSpeedValue, visibleSpeedUnit, parseNumber(segment.visibleSpeedKmh));
  const player = sanitizeText(segment.player, 60);
  const kickType = sanitizeText(segment.kickType, 80);
  const fallbackLabel = [player, kickType].filter(Boolean).join(" ") || `Clip ${index + 1}`;

  return {
    label: sanitizeText(segment.label, 80) ?? fallbackLabel,
    player,
    kickType,
    startSeconds,
    endSeconds,
    visibleSpeedValue,
    visibleSpeedUnit,
    visibleSpeedKmh,
    confidence: Math.max(0, Math.min(1, parseNumber(segment.confidence) ?? 0.5)),
    evidence: sanitizeText(segment.evidence, 240) ?? "AI detected a candidate kick segment.",
    needsReview: parseBoolean(segment.needsReview),
  };
}

async function uploadGeminiFile(apiKey: string, file: File, bytes: Buffer, mimeType: string) {
  const startRes = await fetch(`${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file: {
        display_name: file.name || "reference-video",
      },
    }),
  });

  if (!startRes.ok) {
    const detail = await startRes.text();
    throw new Error(`Gemini file upload did not start: ${detail.slice(0, 240)}`);
  }

  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL.");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(bytes),
  });

  if (!uploadRes.ok) {
    const detail = await uploadRes.text();
    throw new Error(`Gemini file upload failed: ${detail.slice(0, 240)}`);
  }

  const fileInfo = (await uploadRes.json()) as GeminiFileInfo;
  if (!fileInfo.file?.uri) throw new Error("Gemini upload response did not include a file URI.");

  return fileInfo.file;
}

async function deleteGeminiFile(apiKey: string, name: string | undefined) {
  if (!name) return;

  await fetch(`${GEMINI_API_BASE}/v1beta/${name}`, {
    method: "DELETE",
    headers: {
      "x-goog-api-key": apiKey,
    },
  }).catch(() => undefined);
}

async function generateSegmentDraft(apiKey: string, fileUri: string, mimeType: string, context: string) {
  const model = process.env.GEMINI_VIDEO_MODEL?.trim() || DEFAULT_MODEL;
  const prompt = [
    "Analyze this soccer shooting, penalty kick, or free kick reference video.",
    "Find candidate kick clips that are useful for a reference calibration database.",
    "Prefer segments where a speed overlay, radar reading, or explicit speed number is visible.",
    "For each segment, choose a short cut range that includes the run-up, impact, ball flight, and speed display.",
    "Extract visible speed values and units if shown. If the speed is mph, also provide km/h conversion.",
    "If distance cues are visible or implied, estimate distanceCueMeters only when evidence is clear.",
    "Return JSON only. Do not invent exact speeds or players when they are not visible; use null and mark needsReview.",
    context ? `Operator context: ${context}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(`${GEMINI_API_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              file_data: {
                mime_type: mimeType,
                file_uri: fileUri,
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        response_mime_type: "application/json",
        response_schema: segmentResponseSchema,
      },
    }),
  });

  const payload = (await response.json()) as GeminiResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Gemini video analysis failed.");
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty video analysis.");

  return normalizeDraft(extractJson(text));
}

export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY or GOOGLE_API_KEY is not configured." },
      { status: 503 }
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get("video");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Video file is required." }, { status: 400 });
    }

    if (!file.type.startsWith("video/") && !VIDEO_EXTENSION_PATTERN.test(file.name)) {
      return NextResponse.json({ error: "Only video files can be analyzed." }, { status: 400 });
    }

    if (file.size <= 0 || file.size > MAX_VIDEO_BYTES) {
      return NextResponse.json(
        { error: "Video must be between 1 byte and 250 MB for browser upload analysis." },
        { status: 400 }
      );
    }

    const context = sanitizeText(formData.get("context"), 1000) ?? "";
    const mimeType = getVideoMimeType(file);
    const bytes = Buffer.from(await file.arrayBuffer());
    const geminiFile = await uploadGeminiFile(apiKey, file, bytes, mimeType);

    try {
      const draft = await generateSegmentDraft(apiKey, geminiFile.uri!, geminiFile.mimeType || mimeType, context);

      return NextResponse.json({
        provider: "Gemini",
        model: process.env.GEMINI_VIDEO_MODEL?.trim() || DEFAULT_MODEL,
        draft,
      });
    } finally {
      await deleteGeminiFile(apiKey, geminiFile.name);
    }
  } catch (error) {
    console.error("Failed to analyze video segments:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to analyze video segments." },
      { status: 500 }
    );
  }
}
