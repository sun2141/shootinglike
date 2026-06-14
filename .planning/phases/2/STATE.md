# Phase 2 State

## Tasks
- [x] `lib/workers/pose.worker.ts` 생성 및 MediaPipe 포팅
- [x] 메인 스레드 캔버스 오버레이 렌더링 및 `ImageBitmap` 전송 로직 구현
- [x] 휴리스틱 임팩트 탐지 알고리즘 (발끝 속도 기반) 구현
- [x] 공 위치 식별 (프레임 변화량 또는 휴리스틱) 기초 로직 작성

## Current Status
완료 (Completed). `lib/workers/pose.worker.ts`(MediaPipe Tasks Vision)와 `lib/workers/ball.worker.ts`(공/모션 휴리스틱) 구현, 임팩트 탐지 로직 포함.
