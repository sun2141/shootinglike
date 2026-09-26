/** 공통 타입. 이 모듈은 외부 의존성이 없고 브라우저에서만 돈다. */

export interface Gray {
  /** 0~255 명도값, width*height */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Candidate {
  /** 검출 해상도 기준 좌표 */
  x: number;
  y: number;
  /** 겉보기 반지름 (검출 해상도 px) */
  r: number;
  conf: number;
}

export interface FrameObservation {
  /** 영상 자체의 시각(초). fps 가정이 아니라 실제 프레임 타임스탬프. */
  t: number;
  index: number;
  candidates: Candidate[];
}

export type BallSize = 'size5' | 'size4' | 'size3' | 'futsal4';

/** FIFA/경기 규격 지름(m) — 앱의 공 규격 선택과 1:1로 맞춘 값 */
export const BALL_DIAMETER_M: Record<BallSize, number> = {
  size5: 0.22,
  size4: 0.205,
  size3: 0.185,
  futsal4: 0.20,
};

export interface AnalyzeOptions {
  /** 공 규격 (기본 size5) */
  ballSize?: BallSize;
  /** 공 지름을 직접 줄 때 (m). 주면 ballSize 보다 우선 */
  ballDiameterM?: number;
  /**
   * 초점거리(원본 영상 px). 모르면 비워두면 폰 기본 화각으로 추정한다.
   * 요즘 폰 메인 카메라는 35mm 환산 26mm 근처 → 수평화각 약 68° → f ≈ 0.74 * 영상폭.
   */
  focalPx?: number;
  /** 화각 가정에 쓰는 계수 (기본 0.74) */
  focalWidthRatio?: number;
  /** 검출용 다운스케일 최대 가로 px (기본 720). 작을수록 빠르고 반지름 오차는 커진다 */
  detectWidth?: number;
  /** 재생 배속. 1.0 이 가장 안전하고, 올리면 빨라지지만 프레임이 누락될 수 있다 */
  playbackRate?: number;
  /** 중력 자기검산으로 스케일을 보정할지 (기본 true) */
  gravityCalibration?: boolean;
  /**
   * 중력 검산에 실패한 영상의 속도를 아예 내보내지 않을지 (기본 true).
   * 검증 못 한 값을 그대로 보여주면 몇 배 틀린 기록이 조용히 쌓인다.
   */
  requireGravityCheck?: boolean;
  /** 손떨림/패닝 보정 (기본 true). 삼각대로 고정해 찍은 영상이면 꺼도 된다 */
  stabilize?: boolean;
  /** 공기저항 계수 초기값 (a = -c|v|v). 축구공 0.006~0.013 */
  dragCoefficient?: number;
  /** 최대 처리 프레임 수. 지정하지 않으면 memoryBudgetMB 에서 자동 계산된다 */
  maxFrames?: number;
  /** 프레임을 담아두는 데 쓸 메모리 예산 (MB, 기본 96). 저사양 기기면 낮추세요 */
  memoryBudgetMB?: number;
  /** 재생 중 프레임이 많이 누락되면 탐색 기반으로 다시 담을지 (기본 true, 느리지만 정확) */
  recapture?: boolean;
  /** 진단용: 프레임별 후보와 선택된 궤적을 결과에 담는다 (용량이 크다) */
  collectDebug?: boolean;
  /** 진행률 콜백 0~1 */
  onProgress?: (p: number) => void;
}

export interface TrajectoryPoint {
  t: number;
  /** 원본 영상 좌표 */
  x: number;
  y: number;
  r: number;
  observed: boolean;
  /** 카메라 좌표계 3D (m). 보정 적용 후 */
  X: number;
  Y: number;
  Z: number;
  speedKmh: number;
}

export interface GravityCheck {
  /** 보정 전 측정된 연직 가속도 (m/s², 아래가 +). 정상이면 9.81 근처여야 한다 */
  measuredVerticalAccel: number;
  /** 공기저항의 연직 성분까지 고려한 기대값 */
  expectedVerticalAccel: number;
  /** 스케일 보정 배율. 1.0 이면 기존 스케일이 맞다는 뜻 */
  scaleFactor: number;
  /** 연직 위치의 2차 피팅 적합도 */
  fitR2: number;
  /** 중력을 실제로 얼마나 관측했는지 (2차항 크기 / 잔차). 4 미만이면 검산을 믿을 수 없다 */
  curvatureSnr?: number;
  applied: boolean;
  note: string;
}

export interface Measurement {
  ok: boolean;
  /**
   * 중력 검산으로 스케일이 검증됐는지. false 면 이 속도는 몇 배가 틀려 있을 수 있다.
   * 리더보드/DB 에는 이 값이 true 인 결과만 넣는 것을 권한다.
   */
  verified: boolean;
  /** 보정 후 초기 속도 (km/h) — 이 값을 쓰면 된다 */
  speedKmh: number | null;
  /**
   * 보정 전, 화면 2D 이동량만으로 낸 속도 (km/h).
   * 기존 앱 방식과 같은 계산이라 두 값을 비교하면 편향 배율이 바로 보인다.
   */
  speedRawKmh: number | null;
  peakSpeedKmh: number | null;
  launchAngleDeg: number | null;
  flightTimeS: number | null;
  pathDistanceM: number | null;
  straightDistanceM: number | null;
  /** 임팩트 시점의 공 지름(원본 px) — 스케일의 근거 */
  ballDiameterPxAtImpact: number | null;
  pxPerMeterAtImpact: number | null;
  gravityCheck: GravityCheck | null;
  confidence: number;
  confidenceParts: Record<string, number>;
  warnings: string[];
  /** 진단/오버레이용 */
  trajectory: TrajectoryPoint[];
  frames: number;
  observedFrames: number;
  fpsMeasured: number | null;
  durationS: number | null;
  focalPxUsed: number | null;
  /** 추적 구간 동안 카메라가 움직인 총 화면 이동량 (원본 px) */
  cameraMotionPx: number | null;
  /** 브라우저가 처리한 프레임 / 디코딩된 전체 프레임. 표본이 얼마나 줄었는지 알려준다 */
  processedFrames: number | null;
  decodedFrames: number | null;
  videoWidth: number;
  videoHeight: number;
  /** 이 영상이 애초에 잴 수 있는 영상인지 — 원리적 한계를 먼저 알려주기 위한 것 */
  quality: QualityCheck | null;
  /** collectDebug 일 때만. 무엇이 후보로 잡혔고 무엇이 선택됐는지 눈으로 보기 위한 것 */
  debug?: DebugInfo;
}

export interface QualityCheck {
  videoWidth: number;
  fps: number | null;
  /** 임팩트 때 공 지름 (원본 px). 4px 미만이면 어떤 방법으로도 못 잰다 */
  ballPx: number | null;
  /** side | away | unknown — 공이 카메라에서 멀어지는 구도인지 */
  geometry: 'side' | 'away' | 'unknown';
  usable: boolean;
  /** 사람이 읽는 한 줄 판정 */
  verdict: string;
}

export interface DebugInfo {
  /** 원본 영상 좌표 기준 */
  frames: Array<{ t: number; candidates: Array<{ x: number; y: number; r: number; conf: number }> }>;
  /** 선택된 궤적: [프레임 인덱스, 후보 인덱스] */
  picked: Array<[number, number]>;
  /** 탈락한 사슬들 — 왜 떨어졌는지 */
  rejected: Array<{ length: number; straightness: number; jitter: number; medStep: number; reason: string }>;
  scale: number;
}
