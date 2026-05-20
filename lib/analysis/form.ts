import { calculateAngle, type Point } from "./math";

export interface FormResult {
  score: number;
  kneeAngle: number;
  torsoLeanAngle: number;
}

export function calculateFormScore(
  hip: Point,
  knee: Point,
  ankle: Point,
  shoulder: Point
): FormResult {
  let score = 100;
  
  // 1. Plant leg knee angle
  // Ideal: slight bend, around 130-150 degrees
  const kneeAngle = calculateAngle(hip, knee, ankle);
  if (kneeAngle < 130) {
    score -= (130 - kneeAngle) * 0.5; // too bent
  } else if (kneeAngle > 160) {
    score -= (kneeAngle - 160) * 0.8; // too straight
  }

  // 2. Torso lean angle (shoulder relative to hip)
  // We check the vertical angle. We can create a fake point directly above the hip
  const hipVertical: Point = { x: hip.x, y: hip.y - 100 };
  const torsoLeanAngle = calculateAngle(shoulder, hip, hipVertical);
  
  // Ideal lean: around 15-25 degrees forward/sideways depending on angle, 
  // but let's say 20 degrees is ideal for instep.
  if (torsoLeanAngle < 10) {
    score -= (10 - torsoLeanAngle) * 1.5; // too upright
  } else if (torsoLeanAngle > 35) {
    score -= (torsoLeanAngle - 35) * 1.0; // too leaning
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    kneeAngle: Math.round(kneeAngle),
    torsoLeanAngle: Math.round(torsoLeanAngle)
  };
}
