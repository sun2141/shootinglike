import { NextResponse } from "next/server";
import { getAdminReferenceTokenStatus, verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import {
  buildReferenceCalibrationSummary,
  getReferenceCalibrationFactor,
  type ReferenceCalibrationSample,
} from "@/lib/analysis/reference-calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABEL_LENGTH = 80;
const MAX_NOTES_LENGTH = 500;
const MAX_SOURCE_URL_LENGTH = 500;

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalInteger(value: unknown) {
  const parsed = parseOptionalNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function parseRequiredNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeSourceUrl(value: unknown) {
  const text = sanitizeText(value, MAX_SOURCE_URL_LENGTH);
  if (!text) return { value: null };

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "Source URL must use http or https." };
    }

    return { value: url.toString() };
  } catch {
    return { error: "Source URL is not valid." };
  }
}

function validateReferencePayload(body: Record<string, unknown>) {
  const label = sanitizeText(body.label, MAX_LABEL_LENGTH) ?? "Untitled reference";
  const knownSpeedKmh = parseRequiredNumber(body.knownSpeedKmh);
  const measuredSpeedKmh = parseRequiredNumber(body.measuredSpeedKmh);
  const knownDistanceMeters = parseOptionalNumber(body.knownDistanceMeters);
  const ballDisplacementPx = parseOptionalNumber(body.ballDisplacementPx);
  const bodyHeightPx = parseOptionalNumber(body.bodyHeightPx);
  const videoWidth = parseOptionalInteger(body.videoWidth);
  const videoHeight = parseOptionalInteger(body.videoHeight);
  const durationSeconds = parseOptionalNumber(body.durationSeconds);
  const fps = parseOptionalNumber(body.fps);
  const timingStartSeconds = parseOptionalNumber(body.timingStartSeconds);
  const timingEndSeconds = parseOptionalNumber(body.timingEndSeconds);
  const playerHeightCm = parseOptionalNumber(body.playerHeightCm);
  const sourceSizeBytes = parseOptionalNumber(body.sourceSizeBytes);
  const sourceUrl = sanitizeSourceUrl(body.sourceUrl);

  if (knownSpeedKmh === null || measuredSpeedKmh === null) {
    return { error: "Known speed and measured speed are required." };
  }

  if ("error" in sourceUrl) {
    return { error: sourceUrl.error };
  }

  if (knownSpeedKmh <= 0 || knownSpeedKmh > 250 || measuredSpeedKmh <= 0 || measuredSpeedKmh > 250) {
    return { error: "Speed values must be between 0 and 250 km/h." };
  }

  if (knownDistanceMeters !== null && (knownDistanceMeters <= 0 || knownDistanceMeters > 120)) {
    return { error: "Distance must be between 0 and 120 meters." };
  }

  if (ballDisplacementPx !== null && (ballDisplacementPx < 5 || ballDisplacementPx > 20000)) {
    return { error: "Ball displacement must be between 5 and 20000 pixels." };
  }

  if (bodyHeightPx !== null && (bodyHeightPx < 20 || bodyHeightPx > 10000)) {
    return { error: "Body height must be between 20 and 10000 pixels." };
  }

  if (videoWidth !== null && (videoWidth < 1 || videoWidth > 12000)) {
    return { error: "Video width is outside the accepted range." };
  }

  if (videoHeight !== null && (videoHeight < 1 || videoHeight > 12000)) {
    return { error: "Video height is outside the accepted range." };
  }

  if (durationSeconds !== null && (durationSeconds <= 0 || durationSeconds > 1200)) {
    return { error: "Video duration is outside the accepted range." };
  }

  if (fps !== null && (fps <= 0 || fps > 240)) {
    return { error: "FPS must be between 0 and 240." };
  }

  if (
    (timingStartSeconds === null && timingEndSeconds !== null) ||
    (timingStartSeconds !== null && timingEndSeconds === null)
  ) {
    return { error: "Both segment start and segment end are required when saving a segment." };
  }

  if (timingStartSeconds !== null && timingEndSeconds !== null) {
    if (timingStartSeconds < 0 || timingEndSeconds < 0 || timingEndSeconds <= timingStartSeconds) {
      return { error: "Segment end must be greater than segment start." };
    }

    if (durationSeconds !== null && timingEndSeconds > durationSeconds + 0.25) {
      return { error: "Segment end cannot exceed the video duration." };
    }
  }

  if (playerHeightCm !== null && (playerHeightCm < 120 || playerHeightCm > 220)) {
    return { error: "Player height must be between 120 and 220 cm." };
  }

  const sample: ReferenceCalibrationSample = {
    knownSpeedKmh,
    measuredSpeedKmh,
  };
  const calibrationFactor = getReferenceCalibrationFactor(sample);

  if (!calibrationFactor || calibrationFactor < 0.4 || calibrationFactor > 2.5) {
    return { error: "Calibration factor is outside the accepted range." };
  }

  const metersPerPixel =
    knownDistanceMeters !== null && ballDisplacementPx !== null
      ? knownDistanceMeters / ballDisplacementPx
      : null;

  const timingSpeedKmh =
    knownDistanceMeters !== null && timingStartSeconds !== null && timingEndSeconds !== null
      ? (knownDistanceMeters / (timingEndSeconds - timingStartSeconds)) * 3.6
      : null;

  return {
    data: {
      label,
      sourceFilename: sanitizeText(body.sourceFilename, 140),
      sourceMimeType: sanitizeText(body.sourceMimeType, 80),
      sourceSizeBytes: sourceSizeBytes === null ? null : Math.round(sourceSizeBytes),
      sourceUrl: sourceUrl.value,
      knownSpeedKmh,
      measuredSpeedKmh,
      knownDistanceMeters,
      ballDisplacementPx,
      bodyHeightPx,
      metersPerPixel,
      videoWidth,
      videoHeight,
      durationSeconds,
      fps,
      timingStartSeconds,
      timingEndSeconds,
      timingSpeedKmh,
      playerHeightCm,
      cameraAngle: sanitizeText(body.cameraAngle, 80),
      notes: sanitizeText(body.notes, MAX_NOTES_LENGTH),
      calibrationFactor,
      isActive: body.isActive !== false,
    },
  };
}

export async function GET(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const prisma = getPrisma();
    const references = await prisma.referenceVideo.findMany({
      orderBy: { createdAt: "desc" },
    });

    const activeReferences = references.filter((reference) => reference.isActive);

    return NextResponse.json({
      auth: getAdminReferenceTokenStatus(),
      calibration: buildReferenceCalibrationSummary(activeReferences),
      references,
    });
  } catch (error) {
    console.error("Failed to fetch reference videos:", error);
    return NextResponse.json(
      {
        auth: getAdminReferenceTokenStatus(),
        calibration: buildReferenceCalibrationSummary([]),
        references: [],
        error: "Failed to fetch reference videos.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const parsed = validateReferencePayload(body);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const prisma = getPrisma();
    const reference = await prisma.referenceVideo.create({
      data: parsed.data,
    });

    const activeReferences = await prisma.referenceVideo.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      reference,
      calibration: buildReferenceCalibrationSummary(activeReferences),
    });
  } catch (error) {
    console.error("Failed to create reference video:", error);
    return NextResponse.json({ error: "Failed to create reference video." }, { status: 500 });
  }
}
