# Project State

## Current Phase
- [x] 프로젝트 기획 단계 완료 (FREEKICK_ANALYSIS_APP_DESIGN.md 기준)
- [x] GSD 프로젝트 컨텍스트 초기화 (.planning 세팅)
- [x] 개발 Phase 1 완료 (기반 설정 및 프론트엔드 환경 구성)
- [x] 개발 Phase 2 완료 (온디바이스 AI 파이프라인)
- [x] 개발 Phase 3 완료 (분석 엔진 및 스코어링)
- [x] 개발 Phase 4 완료 (결과 화면 및 공유 기능)
- [x] 개발 Phase 5 완료 (데이터베이스 연동 및 API 구현)
- [ ] 개발 Phase 6 진행 예정 (향후 MVP 기능 확장)

## Decisions Log
- 초기 분석 엔진을 서버사이드가 아닌 온디바이스(모바일 웹/PWA 중심)로 가져가기로 결정.
- 영상 원본 저장은 비용 문제 및 프라이버시 보호 차원에서 하지 않는 것으로 합의됨.
- 신뢰성이 떨어지는 초기 단계의 공속도는 '신뢰도' 점수와 함께 제공하기로 함.
- (2026-06-14) 수동 공 좌표 보정은 **레퍼런스 보정 전용**으로 유지. 일반 사용자 대상 수동 입력 기능은 편의성 저해로 도입하지 않기로 결정.
- (2026-06-14) 이전 경로 `/Users/sun/Documents/shooting-like` 에 묶인 Codex 스레드 내용을 `.planning/IMPORTED_THREADS.md` 로 흡수. 해당 경로는 새 위치 `/Users/sun/shooting-like` 로 향하는 symlink로 유지.
- (2026-06-14) 정확도 개선의 우선순위는 일반 사용자 수동 입력보다 **관리자 레퍼런스 DB / calibration set 고도화**로 둔다.

## Next Steps
- Phase 6 (향후 MVP 확장) 기능 우선순위 확정: 레퍼런스 DB 운영 고도화 / 세그먼트 컷 워크플로우 검증 / 조건별 calibration set / 리더보드·기록 비교 / 코치 모드. 상세는 `.planning/phases/6/PLAN.md`.
- 이전 채팅에서 이관한 구현/운영 맥락은 `.planning/IMPORTED_THREADS.md` 참고.
- 최근 작업 내역 및 일반 권고는 `WORKLOG.md` 참고.
