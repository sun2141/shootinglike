/**
 * ballspeed(중력 검산) 측정값을 기존 파이프라인 결과에 합친다.
 *
 * 속도는 ballspeed 가 낸다. 기존 포즈 파이프라인은 자세 피드백·오버레이용으로 남는다.
 * 중력 검산을 통과하지 못한 값은 `confidence: "failed"` 로 내려 저장·공유·리더보드에서 빠진다
 * (`persistAnalysis` 가 failed 를 걸러낸다).
 */
import type { Measurement } from "@/lib/ballspeed/types";
import type { Confidence, PipelineResult } from "@/lib/analysis/pipeline/types";

export function speedConfidence(m: Measurement): Confidence {
  if (!m.verified || m.speedKmh === null) return "failed";
  return m.confidence >= 0.5 ? "high" : "partial";
}

/** 사용자에게 그대로 보여줄 한국어 안내. 못 쟀을 때 왜 그런지가 먼저 온다. */
export function measurementNotes(m: Measurement): string[] {
  const notes: string[] = [];
  if (m.quality && !m.quality.usable) notes.push(m.quality.verdict);
  if (!m.verified) {
    notes.push(
      m.gravityCheck
        ? "중력 검산을 통과하지 못했습니다. 공이 날아가는 구간이 짧거나 구도가 비스듬하면 스케일을 확인할 수 없어 속도를 내보내지 않습니다."
        : "공이 날아가는 궤적을 충분히 잡지 못했습니다.",
    );
  }
  for (const w of m.warnings) if (!notes.includes(w)) notes.push(w);
  return notes;
}

export function mergeMeasurement(result: PipelineResult, m: Measurement): PipelineResult {
  const confidence = speedConfidence(m);
  const verified = confidence !== "failed";
  return {
    ...result,
    estimatedSpeedKmh: verified ? Math.round(m.speedKmh! * 10) / 10 : 0,
    estimatedDistanceMeters: m.straightDistanceM ?? result.estimatedDistanceMeters,
    trajectoryPoints: m.trajectory.length || result.trajectoryPoints,
    confidence,
    feedbacks: verified ? result.feedbacks : [...measurementNotes(m), ...result.feedbacks],
  };
}

/**
 * 포즈 파이프라인(MediaPipe/YOLO) 없이 속도만 낸 결과.
 * 모바일에서 모델을 못 받아오는 일이 드물지 않은데, 그때 측정 자체를 막을 이유는 없다.
 * 속도는 ballspeed 만으로 나오고, 자세 점수만 비워 둔다.
 */
export function speedOnlyResult(m: Measurement): PipelineResult {
  const confidence = speedConfidence(m);
  const verified = confidence !== "failed";
  return {
    framesAnalyzed: m.frames,
    poseFrames: 0,
    ballFrames: m.observedFrames,
    sceneCuts: 0,
    cameraMotionRatio: 0,
    impactDetected: m.trajectory.length > 0,
    impactTimeMs: m.trajectory.length ? Math.round(m.trajectory[0].t * 1000) : null,
    estimatedSpeedKmh: verified ? Math.round(m.speedKmh! * 10) / 10 : 0,
    rawSpeedKmh: m.speedRawKmh ?? 0,
    speedUncertainty: null,
    trajectoryPoints: m.trajectory.length,
    estimatedDistanceMeters: m.straightDistanceM ?? undefined,
    formResult: { score: 0, kneeAngle: 0, torsoLeanAngle: 0, source: "2d" },
    feedbacks: verified
      ? ["자세 분석 모델을 불러오지 못해 구속만 측정했습니다."]
      : [...measurementNotes(m), "자세 분석 모델을 불러오지 못해 구속만 측정했습니다."],
    kickType: "-",
    footSide: null,
    confidence,
  };
}
