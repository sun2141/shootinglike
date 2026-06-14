# Imported Codex Thread Context

> Imported on 2026-06-14 after moving the project from `/Users/sun/Documents/shooting-like` to `/Users/sun/shooting-like`.
> This file is a working summary of prior Codex threads, not a full transcript.

## Source Threads

- `019e8379-d860-7d11-ac36-302ef62eebbc` — 앱 성능과 공 인식 점검
- `019e88cd-348d-7e40-88d6-8cb355ca920e` — 모바일 동영상 업로드 수정 / 레퍼런스 DB 초기 구축
- `019ea277-20bc-71e0-ad6f-ae81996949a5` — 레퍼런스 DB 접근 버튼 및 필요사항
- `019eaf43-c031-77f0-a288-1abd8a7eff41` — 정확한 레퍼런스 DB 입력을 위한 픽셀 캡처
- `019ec0fd-bb54-70e0-8b9b-ed58814915ae` — Gemini/FFmpeg 세그먼트 가져오기 흐름
- `019ec4b1-672b-7971-a01d-ca89ec9b899e` — 컷 클립/FFmpeg load 오류 수정
- `019ec4dd-3e3b-7612-9c05-4671007827dd` — Claude 협업용 상황 정리
- `019e8871-d8af-79c2-afde-e6354a9a6331` — 다른 프로젝트 주제였고 변경 없음. 현재 프로젝트 문맥에서는 제외.

## Implemented History

### Analysis Stability And Performance

- 분석 프레임을 최대 960px 기준으로 제한해 고해상도 영상 처리 부담을 줄임.
- 프레임별 요청 ID를 분리해 늦게 도착한 이전 프레임 결과가 현재 분석을 오염시키지 않게 함.
- 공 워커의 hot path에서 무거운 COCO/TensorFlow 추론을 제거하고, 모션 기반 추적을 즉시 반환하도록 정리.
- 영상 변경/리셋 시 공 워커 상태를 `RESET`하도록 보완.
- 사용자가 한 영상을 분석한 뒤 `다른 영상 분석하기`를 누르면 새로고침으로 분석 세션을 깨끗하게 시작하도록 변경.
- AI 학습용 opt-in 업로드/결과 저장 중에는 다음 분석 버튼을 비활성화해 업로드가 끊기지 않도록 함.
- opt-in 상태와 키 보정값은 `localStorage`에 유지.
- 슈팅 속도 스케일 오차를 줄이기 위해 사용자 키 보정 입력을 추가.
- 앱 폴더 용량의 대부분은 `.next` 캐시와 `node_modules`이며, 런타임 앱이 그 전체를 내려받는 것은 아님. 다만 MediaPipe/분석 로직 때문에 분석 페이지의 CPU/GPU 부담은 실제로 존재.

### Mobile Upload Preview

- 모바일에서 업로드 직후 `<video>`의 intrinsic height가 잡히지 않아 화면이 비어 보이던 문제를 수정.
- 미리보기 wrapper에 안정적인 aspect ratio를 주고, metadata 로딩 여부와 무관하게 높이를 확보.
- 업로드 영상에 `playsInline`, native `controls`, 명시적 `load()` 호출을 적용.
- blob URL에는 불필요한 `crossOrigin`을 제거.
- 모바일 브라우저에서 file type이 비어 들어오는 경우를 확장자 기반으로 허용.
- 배포 검증에서 iPhone viewport 기준 실제 영상 프레임 디코딩까지 확인됨.

### Reference Calibration Admin

- 레퍼런스는 일반 사용자 분석 화면과 분리해 `/admin/references` 전용 페이지와 DB 모델로 운영하는 방향으로 확정.
- `ReferenceVideo` 모델, 관리자 API, 공개 보정 요약 API(`/api/reference-calibration`)를 추가.
- 사용자 분석 결과에 활성 레퍼런스들의 median 보정 계수를 적용하는 구조를 도입.
- 저장 기본 단위는 원본 영상이 아니라 실제값 + 앱 분석값 + 보정 메타데이터:
  - `knownSpeedKmh`
  - `measuredSpeedKmh`
  - `knownDistanceMeters`
  - `ballDisplacementPx`
  - `metersPerPixel`
  - 영상 크기/길이/FPS 등 선택 메타데이터
- 운영 환경의 관리자 조회/등록은 `ADMIN_REFERENCE_TOKEN`으로 보호. 개발 환경에서는 토큰 없이 열릴 수 있음.
- 외부 현장 등록까지 제대로 운영하려면 원본 영상은 Vercel Blob 또는 S3 같은 private storage에 저장하고, DB에는 `sourceUrl`/`blobPath`/파일 메타데이터를 남기는 방향이 권장됨.
- 홈과 분석 화면에 `Reference DB` 접근 버튼을 추가.

### Accurate Reference Pixel Capture

- `/analyze`와 `/admin/references`가 같은 분석 프레임 기준을 공유하도록 `lib/analysis/frame-size.ts`를 추가.
- 관리자 페이지에 `PIXEL CAPTURE` 측정 패널을 추가.
- YouTube iframe 위에서 눈대중으로 찍은 픽셀값은 분석 스케일과 일치하지 않을 수 있으므로 정확 측정을 허용하지 않음.
- 정확한 DB 입력은 로컬 원본 영상 업로드 또는 직접 재생 가능한 영상 URL에서만 수행.
- `Body Height`: 머리점과 디딤발 발목점을 찍어 신체 기준 px 산출.
- `Ball Travel`: 시작 프레임 공 위치와 끝 프레임 공 위치를 찍어 공 이동 px 산출.

### Gemini And FFmpeg Segment Workflow

- 레퍼런스 DB 페이지에 Gemini/FFmpeg 기반 segment draft workflow를 추가.
- Gemini가 만든 FFmpeg 명령, JSON, Markdown table 등의 구간 정보를 붙여넣어 batch/manual segment row로 변환하는 흐름을 도입.
- `ffmpeg -i input.mp4 -ss ... -to ... -c copy 01_Nicky_55mph.mp4` 형식을 지원.
- 파일명 앞 번호(`01_`)를 속도로 오인하지 않도록 `mph`, `km/h`, `m/s` 단위가 붙은 숫자를 우선 속도로 파싱.
- `55mph -> 88.5 km/h`, `42mph -> 67.6 km/h` 같은 환산을 검증.
- UI는 `Parse Paste`/`Apply Draft to Rows` 흐름에서 `Run Code` 실행 후 바로 Manual Segments가 채워지는 흐름으로 단순화.
- 링크 분석, API 영상 분석, 픽셀 측정 같은 보조 기능은 접힌 섹션으로 내려 화면을 정리.

### FFmpeg Cut And Load Stability

- `@ffmpeg/ffmpeg` 초기화에서 AbortSignal을 넘겨 `Message # 0 was aborted`가 노출되던 문제를 수정.
- 첫 WASM 초기화 제한 시간을 180초로 늘리고, abort 원문은 한국어 오류로 매핑.
- FFmpeg core를 명시적으로 로드하는 보강 커밋이 있음.
- 빈 clip row는 cutting 대상에서 제외.
- 이후 Claude 작업에서 `cutBatchClips`는 input seek + stream copy 대신 H.264/AAC mp4 재인코딩으로 변경되어 webm/mkv/avi 등 입력 코덱 차이에 덜 취약해짐. 자세한 내용은 `WORKLOG.md`의 2026-06-14 Claude 항목 참고.

## Decisions To Preserve

- 원본 영상은 기본적으로 서버에 저장하지 않는다. 데이터셋/레퍼런스 원본 저장은 사용자 또는 관리자 의도와 별도 저장소 구성이 있을 때만 한다.
- 정확도 개선은 "일반 사용자에게 수동 공 좌표 입력을 요구"하는 방향보다, 관리자 레퍼런스 DB와 검증된 calibration set을 고도화하는 방향이 우선이다.
- 수동 좌표 입력은 현재 기준으로 관리자 레퍼런스 보정 전용이다.
- 속도 정확도는 공 검출과 스케일 보정을 분리해서 개선한다. 공 검출은 모델/휴리스틱 문제이고, 속도는 촬영 각도/거리/FPS/신체 기준/골대 기준 같은 보정 문제다.
- 초기 레퍼런스 수가 적을 때는 global median 보정으로 시작하고, 레퍼런스가 쌓이면 촬영 각도/거리/FPS/기기/선수 키 조건별로 calibration set을 나눈다.
- 이전 경로 호환을 위해 `/Users/sun/Documents/shooting-like`는 `/Users/sun/shooting-like`로 향하는 symlink로 유지한다.

## Recommended Next Work

1. Reference DB 운영 고도화:
   - private Blob/S3 업로드
   - Draft/Active/Rejected 상태
   - CSV import/export
   - 조건별 calibration set
   - 이상치 factor 탐지와 비활성화 UX
2. Reference segment workflow 검증:
   - 실제 긴 원본 영상으로 `Run Code -> cut clips -> row 저장` 전체 흐름 확인
   - 브라우저/기기별 FFmpeg.wasm 초기화 실패 문구 정리
   - 재인코딩 속도와 진행률 UX 점검
3. Accuracy work:
   - 레퍼런스 데이터 최소 5~10개 확보 전에는 결과 라벨에 과신 방지 문구 유지
   - 동일 촬영 조건별 레퍼런스 묶음 설계
   - 골대 폭/공 크기/선수 키 기준 보정 후보 검토
4. Product expansion:
   - 사용자별 분석 기록 비교
   - 거리별/사용자별 리더보드 고도화
   - 코치 모드와 고급 리포트는 후순위
