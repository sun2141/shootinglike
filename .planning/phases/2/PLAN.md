# Phase 2: 온디바이스 AI 파이프라인

## 목적 (Objective)
모바일 웹 환경의 메인 스레드 끊김(Jank)을 방지하기 위해 MediaPipe 포즈 추정을 Web Worker로 분리하고, 프리킥의 '임팩트(Impact)' 시점을 찾기 위한 발끝(Ankle/Foot) 추적 및 공 검출(Heuristic 기반) 파이프라인을 구축합니다.

## 작업 목록 (Tasks)

1. **Web Worker 기반 MediaPipe 추론 구조 구축**
   - `lib/workers/pose.worker.ts` 생성
   - 메인 스레드의 비디오 요소에서 `OffscreenCanvas` 또는 `ImageBitmap`을 추출하여 Worker로 메시지(postMessage) 전달.
   - Worker 내부에서 `@mediapipe/tasks-vision`의 `PoseLandmarker`를 초기화하고 결과를 다시 메인 스레드로 반환.

2. **메인 스레드 UI 오버레이 개선**
   - `app/analyze/page.tsx` 내에서 Worker로부터 넘겨받은 좌표 데이터를 받아 캔버스에 `requestAnimationFrame` 주기로 부드럽게 스켈레톤(랜드마크/커넥터) 렌더링.
   - 렌더링을 담당하는 전용 `lib/canvas-utils.ts` 유틸리티 분리.

3. **초기 휴리스틱 기반 임팩트 타이밍 탐지**
   - 킥을 하는 발목(Ankle, 랜드마크 27/28) 및 발끝(Foot Index, 랜드마크 31/32)의 속도 변화(이전 프레임과의 픽셀 거리)를 추적.
   - 속도가 정점을 찍고 감속이 시작되는 지점, 혹은 공(또는 지면) 근처의 좌표를 지나는 특정 지점을 **임팩트 프레임(Impact Frame)** 으로 추정하여 콘솔/UI에 표시.

4. **공 위치 식별(Ball Detection) 준비**
   - 1차 MVP용 가벼운 휴리스틱 적용: 임팩트 시점 직전/직후의 발끝 위치 근처에서 일정 픽셀 내의 변화량(Background Subtraction or Color Thresholding 등)을 추적하거나, 단순히 '디딤발과 킥하는 발이 교차하는 지점 근처'를 공 위치로 가정하고 해당 궤적(프레임 차이) 추적 로직 추가.

## 검증 방법 (Verification)
- 메인 스레드가 차단되지 않아 (UI가 버벅이지 않고 부드럽게 스크롤 및 클릭 가능) MediaPipe 처리가 백그라운드에서 진행되는지 확인.
- 임의의 프리킥 영상 재생 시, 스켈레톤 랜드마크가 비디오 위에 오차 없이 매핑되어 렌더링되는지 확인.
- 영상을 돌렸을 때 콘솔에 "Impact Detected at frame N"과 같이 임팩트 시점이 정상적으로 포착되는지 영상과 대조 확인.
