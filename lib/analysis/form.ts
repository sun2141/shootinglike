import { calculateAngle, type Point } from "./math";

export interface FormResult {
  score: number;
  kneeAngle: number;
  torsoLeanAngle: number;
  /** "world" means the angles came from MediaPipe 3D landmarks (view independent). */
  source: "2d" | "world";
}

export interface Point3 extends Point {
  z: number;
}

/** Ideal plant-leg knee flexion window, degrees. */
const KNEE_MIN = 130;
const KNEE_MAX = 160;
/** Ideal torso lean window, degrees from vertical. */
const LEAN_MIN = 10;
const LEAN_MAX = 35;

function scoreForm(kneeAngle: number, torsoLeanAngle: number, source: FormResult["source"]): FormResult {
  let score = 100;

  if (kneeAngle < KNEE_MIN) {
    score -= (KNEE_MIN - kneeAngle) * 0.5; // too bent
  } else if (kneeAngle > KNEE_MAX) {
    score -= (kneeAngle - KNEE_MAX) * 0.8; // too straight
  }

  if (torsoLeanAngle < LEAN_MIN) {
    score -= (LEAN_MIN - torsoLeanAngle) * 1.5; // too upright
  } else if (torsoLeanAngle > LEAN_MAX) {
    score -= (torsoLeanAngle - LEAN_MAX) * 1.0; // too leaning
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    kneeAngle: Math.round(kneeAngle),
    torsoLeanAngle: Math.round(torsoLeanAngle),
    source,
  };
}

export function calculateFormScore(
  hip: Point,
  knee: Point,
  ankle: Point,
  shoulder: Point
): FormResult {
  const kneeAngle = calculateAngle(hip, knee, ankle);

  // Vertical reference directly above the hip (screen space, y grows downward).
  const hipVertical: Point = { x: hip.x, y: hip.y - 100 };
  const torsoLeanAngle = calculateAngle(shoulder, hip, hipVertical);

  return scoreForm(kneeAngle, torsoLeanAngle, "2d");
}

function angle3(a: Point3, b: Point3, c: Point3): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const magnitude = Math.hypot(v1.x, v1.y, v1.z) * Math.hypot(v2.x, v2.y, v2.z);
  if (magnitude === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / magnitude))) * 180) / Math.PI;
}

/**
 * Form score from MediaPipe world landmarks (metres, hip-centred). 2D joint
 * angles change with the camera position; world landmarks do not, so the same
 * kick scores the same from the side or from behind.
 */
export function calculateFormScoreFromWorld(
  hip: Point3,
  knee: Point3,
  ankle: Point3,
  shoulder: Point3
): FormResult {
  const kneeAngle = angle3(hip, knee, ankle);

  // Torso vector against world "up" (world landmarks use y-down, as in image space).
  const torso = { x: shoulder.x - hip.x, y: shoulder.y - hip.y, z: shoulder.z - hip.z };
  const torsoLength = Math.hypot(torso.x, torso.y, torso.z);
  const torsoLeanAngle =
    torsoLength === 0
      ? 0
      : (Math.acos(Math.min(1, Math.max(-1, -torso.y / torsoLength))) * 180) / Math.PI;

  return scoreForm(kneeAngle, torsoLeanAngle, "world");
}

export const EMPTY_FORM_RESULT: FormResult = {
  score: 0,
  kneeAngle: 0,
  torsoLeanAngle: 0,
  source: "2d",
};
