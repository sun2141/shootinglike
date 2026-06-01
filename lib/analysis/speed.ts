import { calculateDistance, type Point } from "./math";

// Assume standard height is 1.75m for MVP
const DEFAULT_HEIGHT_M = 1.75;

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
  // 1. Calculate pixels per meter based on user body
  const bodyPixels = calculateDistance(nose, ankle);
  if (bodyPixels === 0) return 0;

  const heightMeters = Number.isFinite(playerHeightM) && playerHeightM > 0 ? playerHeightM : DEFAULT_HEIGHT_M;
  const pixelsPerMeter = bodyPixels / heightMeters;
  
  // 2. Calculate ball/foot travel distance in pixels
  const travelPixels = calculateDistance(ballStart, ballEnd);
  
  // 3. Convert to meters
  const travelMeters = travelPixels / pixelsPerMeter;
  
  // 4. Calculate time elapsed in seconds
  if (!Number.isFinite(timeSeconds) || timeSeconds <= 0) return 0;
  
  // 5. Calculate speed in m/s, then convert to km/h
  const speedMs = travelMeters / timeSeconds;
  const speedKmh = speedMs * 3.6;
  
  return Math.min(Math.round(speedKmh), 200); // cap at 200 km/h
}
