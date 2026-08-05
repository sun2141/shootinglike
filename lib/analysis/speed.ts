import { calculateDistance, type Point } from "./math";

// Assume standard height is 1.75m for MVP
const DEFAULT_HEIGHT_M = 1.75;

/**
 * The pose landmarks give us nose-to-ankle, not full stature. On an average
 * adult that span is ~0.88 of total height.
 *
 * Dividing the pixel span by the *full* height therefore under-stated
 * pixels-per-metre by ~12%, which inflated every distance — and so every
 * speed — by ~14%. Correcting it here removes that systematic bias, and makes
 * reported speeds ~12% lower than before this change.
 */
export const NOSE_TO_ANKLE_HEIGHT_RATIO = 0.88;

export const MAX_REPORTABLE_SPEED_KMH = 200;

function resolveHeightMeters(playerHeightM: number) {
  return Number.isFinite(playerHeightM) && playerHeightM > 0 ? playerHeightM : DEFAULT_HEIGHT_M;
}

/**
 * Pixels per metre implied by the kicker's on-screen nose-to-ankle span.
 */
export function getPixelsPerMeter(bodyPixels: number, playerHeightM: number = DEFAULT_HEIGHT_M) {
  if (!Number.isFinite(bodyPixels) || bodyPixels <= 0) return 0;
  const heightMeters = resolveHeightMeters(playerHeightM);
  return bodyPixels / (heightMeters * NOSE_TO_ANKLE_HEIGHT_RATIO);
}

/**
 * Converts a pixel velocity to km/h using the body-scale reference.
 */
export function pixelSpeedToKmh(
  pxPerSecond: number,
  bodyPixels: number,
  playerHeightM: number = DEFAULT_HEIGHT_M
): number {
  const pixelsPerMeter = getPixelsPerMeter(bodyPixels, playerHeightM);
  if (pixelsPerMeter <= 0 || !Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return 0;

  const speedKmh = (pxPerSecond / pixelsPerMeter) * 3.6;
  return Math.min(Math.round(speedKmh), MAX_REPORTABLE_SPEED_KMH);
}

export function estimateSpeedKmh(
  nose: Point,
  ankle: Point,
  ballStart: Point,
  ballEnd: Point,
  framesElapsed: number,
  fps: number = 30,
  playerHeightM: number = DEFAULT_HEIGHT_M
): number {
  const timeSeconds = framesElapsed / fps;
  return estimateSpeedKmhFromSeconds(nose, ankle, ballStart, ballEnd, timeSeconds, playerHeightM);
}

export function estimateSpeedKmhFromSeconds(
  nose: Point,
  ankle: Point,
  ballStart: Point,
  ballEnd: Point,
  timeSeconds: number,
  playerHeightM: number = DEFAULT_HEIGHT_M
): number {
  if (!Number.isFinite(timeSeconds) || timeSeconds <= 0) return 0;

  const bodyPixels = calculateDistance(nose, ankle);
  const travelPixels = calculateDistance(ballStart, ballEnd);

  return pixelSpeedToKmh(travelPixels / timeSeconds, bodyPixels, playerHeightM);
}
