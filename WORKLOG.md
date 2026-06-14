# WORKLOG — Claude · Codex 협업 로그

> 코덱스와 함께 작업하는 프로젝트입니다. **작업을 마칠 때마다 이 문서 맨 위에 새 항목을 추가**해 양쪽이 최신 변경을 공유합니다.
> 형식: 날짜 / 작업자 / 변경 요약 / 영향 파일 / 후속 필요사항.

---

## 2026-06-14 (2) · Claude — cut clip "FFmpeg 초기화 타임아웃" 진단/수정

증상(사용자 보고): cut 시 클립이 만들어지지 않고 **"FFmpeg 초기화가 시간 안에 끝나지 않았습니다. 네트워크 상태가 좋을 때 새로고침한 뒤 다시 시도해 주세요."** 발생.

### 진단
- 이 에러는 **cut 명령**이 아니라 `ffmpeg.load()`(워커 생성 + wasm 초기화) 단계에서 발생. 따라서 1차 수정(재인코딩)은 이 증상과 무관(여전히 유효한 개선이지만 원인 아님).
- 근본 원인: `next.config.ts`가 `/admin/references/*`에 **COOP `same-origin` + COEP `credentialless`**(cross-origin isolation)를 설정. 그런데 코드는 **단일 스레드** `@ffmpeg/core`(`/dist/esm`)를 사용 → SharedArrayBuffer/isolation 불필요. 코드 전역에 `SharedArrayBuffer`/`crossOriginIsolated`/멀티스레드 사용 없음(grep 확인).
- isolation이 켜지면 unpkg(약 30MB wasm) cross-origin 코어 fetch와 **Serwist service worker가 캐시에서 서빙하는 `@ffmpeg/ffmpeg` 워커 청크** 로딩이 막혀 `load()`가 멈추고 180초 후 타임아웃 → 위 메시지. 이 헤더는 `687c935`(Gemini segment 기능 커밋)에서 추가됨.

### 수정 (`next.config.ts`, `app/admin/references/page.tsx`)
- **COOP/COEP `headers()` 블록 제거** — 단일 스레드 코어에는 불필요하며 로딩을 막는 주범. (핵심 수정)
- FFmpeg asset fetch 타임아웃 30초→60초 (`FFMPEG_ASSET_TIMEOUT_MS`) — 느린 네트워크에서 30MB wasm 수신 여유.

### 검증/한계
- `npm run lint` 통과. 단, 브라우저 런타임 검증은 이 환경에서 불가 → **사용자 macOS에서 dev/build 후 cut 재시도 필요**. service worker가 이전 헤더/청크를 캐시했을 수 있으니 **하드 리로드 또는 SW unregister 후** 테스트 권장.
- 여전히 실패하면 다음 durable 픽스 권장(미적용, 논의 필요): **ffmpeg 코어 self-host** — `@ffmpeg/core@0.12.9`를 의존성에 추가하고 `dist/esm`의 `ffmpeg-core.js`/`.wasm`을 `public/ffmpeg/`로 복사해 동일 출처에서 로드(unpkg 의존 제거). 단, Serwist precache에서 해당 30MB 파일 제외 설정 필요.

---

## 2026-06-14 · Codex

### 이전 Codex 채팅 흡수 및 경로 호환 처리
- 이전 경로 `/Users/sun/Documents/shooting-like` 에 묶인 shooting-like 관련 Codex 스레드들을 확인하고 핵심 내용을 `.planning/IMPORTED_THREADS.md` 로 정리.
- `.planning/STATE.md`, `.planning/phases/6/PLAN.md`, `.planning/phases/6/STATE.md` 를 현재 이력에 맞게 갱신.
- `포장 완료 체크박스` 스레드는 다른 프로젝트 주제였고 변경 없음으로 확인되어 현재 프로젝트 계획에는 제외.
- 이전 스레드가 계속 실행될 때 파일 경로가 깨지지 않도록 `/Users/sun/Documents/shooting-like -> /Users/sun/shooting-like` symlink 생성.
- Phase 6 우선순위를 일반 사용자 수동 입력보다 레퍼런스 DB 운영 고도화, 세그먼트 컷 워크플로우 검증, 조건별 calibration set 쪽으로 정리.

## 2026-06-14 · Codex

### 이전 프로젝트 채팅 이관 방식 확인
- Codex 최근 스레드 목록에서 이전 경로 `/Users/sun/Documents/shooting-like` 에 묶인 shooting-like 채팅들이 확인됨.
- 예: "클로드용 상황 정리", "컷 클립 버튼 오류 수정", "레퍼런스 DB 기능", "모바일 동영상 업로드 수정", "앱 성능과 공 인식 점검" 등.
- 채팅 기록 자체는 Git 저장소 파일이 아니라 Codex 앱의 스레드 기록에 남아 있음. 현재 프로젝트로 이어받으려면 기존 스레드를 참고/요약하거나, 이전 경로를 새 경로로 연결하는 symlink 방식이 실용적임.

## 2026-06-14 · Codex

### 프로젝트 경로 이전 상태 확인
- 현재 작업 디렉터리와 Git 최상위 경로가 `/Users/sun/shooting-like` 로 정상 인식됨.
- `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json` 확인.
- 예전 `Documents`/iCloud 계열 절대경로 참조는 소스/설정 범위에서 발견되지 않음(`node_modules`, `.next`, lockfile 제외).
- `npm run lint` 통과.
- 참고: 이전 WORKLOG 권고대로 iCloud 동기화 폴더 밖으로 이동한 상태라 `.next` 충돌 사본 문제는 줄어들 것으로 예상. 기존 `.next` 캐시는 필요 시 삭제 후 재생성 권장.

## 2026-06-14 · Claude

### 1. 레퍼런스 cut 클립 버그 수정 (핵심)
- **파일**: `app/admin/references/page.tsx` (`cutBatchClips`)
- **문제**: cut 명령이 `-ss`(input seek) + `-c copy` 로 무조건 `.mp4` 에 remux 했음.
  - 입력 허용 형식은 `mp4/m4v/mov/webm/avi/mkv` 인데, webm(VP9/Opus)·mkv·avi 코덱은 mp4 로 스트림 복사가 안 되거나 깨진 파일이 생성됨.
  - `-c copy` 는 키프레임에서만 자를 수 있어 시작 지점이 어긋나거나 클립 앞부분이 손상됨.
- **수정**: 프레임 정확 재인코딩으로 변경 — `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart`.
  - 입력 코덱과 무관하게 어디서나 재생되는 H.264/AAC mp4 를 생성, 시작 지점이 프레임 단위로 정확함.
- **트레이드오프**: 단일 스레드 wasm 재인코딩이라 copy 보다 느림(짧은 클립 기준 클립당 수 초~수십 초). 어드민용 저빈도 도구라 정확도 우선이 타당. 진행률 UI는 클립별로 표시됨.
- **확인 필요(코덱스/사용자)**: 실제 증상이 "클립이 안 만들어짐/에러"였는지, "만들어지지만 깨짐/시작 어긋남"이었는지에 따라 추가 조정 가능. 후자라면 이번 수정으로 해결됨.

### 2. `.planning` 문서 상태 정리
- `phases/1~5/STATE.md` 를 실제 완료 상태로 갱신(체크박스/설명).
- `phases/6/` 신규: `PLAN.md`(2차 MVP 후보 4종 + 우선순위), `STATE.md`.
- 참고: 수동 공 좌표 보정은 **레퍼런스 보정 전용**으로 유지하기로 결정. 일반 사용자 대상 수동 입력 기능은 편의성 저해로 도입하지 않음. (Phase 6 PLAN 의 "수동 공 좌표 보정 UI" 후보는 보류/철회.)

### 3. service worker 중복 산출물 삭제
- `public/sw 2.js` ~ `public/sw 6.js` 5개 삭제. 이 파일들이 `public/` 에 있어 Serwist precache 목록에 포함되던 문제 해소(다음 빌드 시 precache 매니페스트가 정상 재생성됨). 실사용 파일은 gitignore 된 `public/sw.js` 하나.

### 일반 권고 (미적용 — 논의/결정 필요)
- **동기화 폴더 충돌 사본 (근본 원인)**: 프로젝트가 `~/Documents`(iCloud 추정) 동기화 폴더에 있어 ` 2`/` 3` 접미사 충돌 사본이 계속 생성됨. 현재 `.next` 에만 177개, `public/` 의 sw 사본도 동일 원인. `.next` 의 충돌 사본은 `tsc`/빌드에서 `TS6053` 류 노이즈를 유발함.
  - 권장: 프로젝트(최소 `.next`, `node_modules`)를 iCloud 동기화에서 제외하거나 동기화되지 않는 경로로 이전. 단기 정리: `.next` 삭제 후 클린 빌드.
- **빌드 경고**: `@mediapipe/tasks-vision/vision_bundle.mjs` dynamic dependency 경고는 빌드를 깨지 않음(기존과 동일).
- **버전 메모**: `@ffmpeg/ffmpeg@0.12.15` + 코드의 `@ffmpeg/core@0.12.9`(최신 0.12.10) 조합은 0.12.x 호환 범위라 정상. 필요 시 core 를 0.12.10 으로 맞춰도 됨.

### 검증
- `npm run lint` 통과. 변경 파일(`references/page.tsx`) 타입 에러 없음.
- (참고) `tsc --noEmit` 의 `TS6053` 는 위 동기화 충돌 사본으로 인한 `.next` 잔여 캐시 노이즈이며 이번 변경과 무관.
- 전체 `npm run build` 는 macOS 호스트에서 실행 확인 권장(샌드박스는 플랫폼용 SWC 바이너리 미설치로 빌드 불가).
