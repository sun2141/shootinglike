# WORKLOG — Claude · Codex 협업 로그

> 코덱스와 함께 작업하는 프로젝트입니다. **작업을 마칠 때마다 이 문서 맨 위에 새 항목을 추가**해 양쪽이 최신 변경을 공유합니다.
> 형식: 날짜 / 작업자 / 변경 요약 / 영향 파일 / 후속 필요사항.

---

## 2026-08-05 (3) · Claude — 레퍼런스 보정 신뢰도 게이트 + 배포 준비

### 배경
기존에는 레퍼런스가 **1건만 있어도** 보정 계수가 전체 사용자에게 적용됐다(`enabled: factors.length > 0`).
표본 수가 아니라 **측정 신뢰도**로 게이트를 걸도록 변경.

### 스키마 (마이그레이션 필요)
- `prisma/migrations/20260805120000_add_reference_measurement_quality/migration.sql`
- `ReferenceVideo`에 `measurementUncertainty Float?`, `measurementGrade String?`, `trajectoryPoints Int?` 추가.
- 기존 행은 NULL → **품질 미기록으로 간주해 보정에서 자동 제외**. 별도 삭제 작업 없이 옛 레코드가 무력화된다.

### 게이트 로직 (`lib/analysis/reference-calibration.ts`)
1. 개별 샘플 필터: `measurementUncertainty > 0.3`(=grade low) 또는 미기록이면 제외.
2. 통과한 샘플로 계수의 **상대 표준오차** 계산. 두 추정치 중 **큰 쪽**을 채택:
   - propagated: 각 샘플이 주장하는 정밀도의 가중 합성 `1/√Σ(1/u²)`
   - empirical: 샘플 간 실제 산포 `sd/√n / mean`
   - → 서로 값이 어긋나는 클립들이 "각자 자신 있다"고 주장하는 것만으로는 게이트를 못 연다.
3. `factorUncertainty ≤ 0.08`(8%)일 때만 `enabled: true`.
4. 거리 스케일(`metersPerPixel`)도 속도 보정이 켜진 뒤에만 제공.

예: 신뢰도 ±15% 클립이 4개 일치하면 8%/합격. 같은 4개라도 계수가 흩어지면 불합격. 1개는 아무리 좋아도 불합격.

### 수정
- `app/api/admin/references/route.ts`: 품질 필드 수신·검증·저장.
- `app/api/reference-calibration/route.ts`: 명시적 `select` 제거(스키마 변경 시 클라이언트 미재생성으로 빌드가 깨지는 것을 방지).
- `app/admin/references/page.tsx`: 저장 시 파이프라인 신뢰도 전달. 상단에 **보정 적용 여부 / 계수 불확실도 / 기준 대비 진행바 / 제외 건수** 표시, 목록에 행별 측정 신뢰도 컬럼 추가.
- `package.json`: `build`를 `prisma migrate deploy && next build --webpack`로 변경 → **배포 시 마이그레이션 자동 적용**. 원치 않으면 되돌리고 수동으로 `npx prisma migrate deploy` 실행할 것.
- `scripts/test-analysis.mjs`: 게이트 테스트 20건 추가 (총 60 assertion).

### 검증
- `npx tsc --noEmit`, `npx eslint .`, `npm test`(60 assertion) 통과.
- 이 환경에서는 Prisma 엔진 다운로드가 차단되어 `prisma generate` 실행 불가. 로컬 `npm install`(postinstall)에서 자동 생성됨.

## 2026-08-05 (2) · Claude — 분석 코어 통합 + 정확도 수정 + 레퍼런스 배치 자동화

> **Codex 주의**: `app/analyze/page.tsx`와 `app/admin/references/page.tsx`를 전면 교체했습니다.
> 추적/속도 로직은 이제 두 화면 어디에도 없고 `lib/analysis/pipeline/`에만 있습니다.

### 신규
- `lib/analysis/pipeline/` — 공용 분석 코어.
  - `frame-source.ts`: `fastSeek` 제거. `requestVideoFrameCallback`의 `mediaTime`으로 **실제 표시 프레임 시각**을 반환. 기존에는 요청 시각(`targetTime*1000`)으로 dt를 계산해 25fps 클립에서 ±10%+ 오차.
  - `kick-tracker.ts`: 프레임별 추적 상태. 임계값을 픽셀 상수 → **키커 신장 비율**로 전환(0.9 height/s, 0.65 height/s). person track ID 고정으로 골키퍼 오추적 차단. 씬 컷 시 트래커 리셋. 폼 계산 프레임을 임팩트 최근접으로 고정.
  - `trajectory.ts`: 결정적 exhaustive RANSAC + 최소자승 재적합. **2점(시작/끝) 계산 폐기**.
  - `confidence.ts`: 타이밍 양자화·피팅 잔차·스케일·카메라 이동·씬 컷·깊이 이동 의심을 제곱합으로 전파해 `± 구간`과 high/medium/low 등급 산출.
  - `vision-workers.ts`: 워커 메시지를 Promise로 감싼 공용 브리지.
  - `run-analysis.ts`: 프레임 루프 + 결과 조립. `/analyze`와 admin이 동일 경로 사용.
- `lib/analysis/reference-batch.ts` — 파일명/CSV 정답 파싱, MAE·편향·MAPE·P90·권장 계수 산출.
- `scripts/test-analysis.mjs` + `npm test` — 순수 로직 회귀 테스트 40 assertion.
- `docs/VIDEO_ANALYSIS_AUTOMATION.md` — 진단 및 로드맵(같은 날 1차 항목).

### 수정
- `lib/analysis/speed.ts`: 코–발목 span이 실제 키의 0.88배임을 반영(`NOSE_TO_ANKLE_HEIGHT_RATIO`). 기존 코드는 px/m를 약 12% 과소평가해 **속도를 상시 약 14% 과대평가**하고 있었음 → 이번 수정으로 **측정값이 약 12% 낮아짐**. `pixelSpeedToKmh` / `getPixelsPerMeter` 신규 export.
  - 이 편향은 2D 투영에 의한 과소평가와 방향이 반대라 서로 상쇄되고 있었음. 정면 촬영 클립은 이제 더 낮은 값이 나온다.
- `lib/analysis/form.ts`: `calculateFormScoreFromWorld` 추가(worldLandmarks 3D 각도 → 촬영각 무관). `FormResult.source`로 2d/world 구분.
- `lib/workers/pose.worker.ts`: `worldLandmarks` 전달.
- `lib/workers/ball.worker.ts`: 모션 분석 폭 420 → **640**(11m 거리 공이 5px로 뭉개지던 문제). 전역 변화 픽셀 비율로 **씬 컷 감지 + 카메라 이동 지표** 반환. 블롭 크기 임계값을 폭 기준으로 스케일.
- `app/analyze/page.tsx`: 1,515줄 → 749줄. 추적 ref 20여 개 제거, 코어 호출로 대체. 속도 카드에 `± 범위 · 신뢰도` 표시, 저신뢰 시 경고 배너. 촬영 안내를 "측면 촬영" 중심으로 변경.
- `app/admin/references/page.tsx`: 3,472줄 → 760줄. **클립 다중 선택 → 정답 자동 매칭 → 전체 분석 → 정확도 리포트 → DB 일괄 저장** 4단계로 재구성.
- `lib/analysis/client-video-analyzer.ts`: 709줄 → 130줄. 중복 추적 로직 제거, 코어 위임.
- `package.json`: `@ffmpeg/*` 의존성과 `setup-ffmpeg` postinstall 제거, `test` 스크립트 추가.
- `next.config.ts`, `eslint.config.mjs`: FFmpeg 관련 주석/ignore 제거.

### 삭제
- `app/api/admin/references/analyze-video-segments/route.ts`, `analyze-link/route.ts` (Gemini 기반. `GEMINI_API_KEY` 미설정 상태라 실사용 불가였음)
- `public/ffmpeg/worker.js`, `scripts/setup-ffmpeg.mjs` (브라우저 컷 기능 폐지)

### 검증
- `npx tsc --noEmit` 통과.
- `npx eslint .` 통과.
- `npm test` — 40 assertion 통과(궤적 피팅 이상치 제거, 스케일 환산, 신뢰도 등급, 정답표 파싱, 배치 지표).
- `npm run build`는 이 환경(Linux arm64 + macOS용 node_modules)에서 SWC 바이너리가 없어 실행 불가. **로컬에서 `npm install` 후 `npm run build` 확인 필요.**

### 후속 필요 (중요)
1. `npm install` 실행 — `@ffmpeg/*` 제거 반영.
2. **기존 ReferenceVideo 레코드는 폐기 후 재측정 권장.** 0.88 스케일 보정과 RANSAC 도입으로 measured 값 기준이 바뀌어 기존 `calibrationFactor`가 무효.
3. 실제 클립으로 `/admin/references` 배치를 돌려 MAE/편향 baseline을 남길 것. 이후 알고리즘 수정은 이 수치 대비로 판단.
4. 남은 구조적 오차(2D 투영, 카메라 에고모션)는 미해결 — `docs/VIDEO_ANALYSIS_AUTOMATION.md` Step 3 참조.

## 2026-08-05 · Claude — 영상분석 파이프라인 진단 및 자동화 개선 로드맵 정리

### 추가
- `docs/VIDEO_ANALYSIS_AUTOMATION.md` 신규 작성. 코드 변경 없음(분석/문서만).

### 핵심 진단
- **타임스탬프 신뢰 불가**: `app/analyze/page.tsx`의 `waitForVideoSeek()`가 `video.fastSeek()`(키프레임 스냅 허용)을 쓰면서 속도 계산 시각은 요청값 `targetTime*1000`을 사용 → 25fps 클립에서 dt 오차 ±10%+.
- **2D 투영 거리로 3D 속도 추정**(`lib/analysis/speed.ts`): 깊이 방향 비행에서 구조적 과소평가. global scalar 보정으로 교정 불가.
- **카메라 에고모션 미보정**: 패닝이 모션 차분 검출과 픽셀 변위 양쪽을 오염.
- **공 검출 해상도 손실**: 1080p → 960 → 420px. 11m 거리 공이 5~6px로 블롭 임계값 경계에 걸림.
- **속도 2점 계산**: 시작/끝 한 쌍만 사용해 단일 오검출에 취약.
- **신체 스케일 편향**: 코–발목(실제 키의 약 0.88배)을 전신 키로 나눠 속도를 상시 ~11% 과소평가.
- **절대 픽셀 임계값**(300/220 px/s)이 해상도·줌에 종속.
- **신뢰도가 사실상 이진**: `finalSpeed > 0`이면 `high` → 틀린 값에 high가 붙음.
- **검증 자동화 부재**: 회귀 지표(MAE/bias/실패율)가 없어 개선 여부를 수치로 판단 불가.
- **데이터 루프 단절**: `app/api/dataset/upload`가 `process.cwd()/.data/uploads`에 기록 → Vercel 서버리스에서 미동작.
- **로직 이원화**: `/analyze`와 `lib/analysis/client-video-analyzer.ts`가 분석 로직을 중복 보유.

### 제안 순서
1. Step 0: 분석 코어를 `lib/analysis/pipeline/`으로 추출하고 `/analyze`·admin 분석기를 통합 (모든 후속 작업의 전제).
2. Step 1: `fastSeek` 제거 + RVFC `mediaTime`, 궤적 RANSAC 피팅, 임계값 정규화, 0.88 계수 보정, 씬 컷 감지, person track 고정, 신뢰도 구간(±).
3. Step 2: fixture 클립 + headless eval + CI 회귀 게이트 (Step 1과 같은 스프린트).
4. Step 3~4: 에고모션 보정, ROI 2단계 검출, 공 지름 기반 깊이 추정, WebCodecs, 학습형 검출기, 조건별 calibration set.

### 후속 필요
- Codex와 Step 0 리팩터링 범위 합의 필요(`app/analyze/page.tsx` 1,515줄 분해 대상 확정).
- 문서 6장의 열린 질문 3건(촬영 조건 제한 여부 / 서버 정밀 분석 모드 / 레퍼런스 클립 커밋 가능 여부) 결정 필요.

## 2026-06-18 (4) · Codex — 레퍼런스DB 컷 추출 → 앱 분석 연결

### 수정
- `lib/analysis/client-video-analyzer.ts` 추가:
  - `/analyze`의 클라이언트 포즈/공 워커 기반 분석 로직을 재사용 가능한 `BrowserVideoAnalyzer`로 분리.
  - 로컬/Blob 영상 URL을 숨은 video/canvas로 샘플링해 앱 분석 속도, 공 이동 px, 키커 스케일 px, confidence, frame 수를 반환.
  - 20fps/최대 280프레임, 다중 포즈 발 추적, 발 주변 공 후보 랭킹, 임팩트 후 650ms 추적 윈도우를 적용.
- `app/admin/references/page.tsx`:
  - Manual Segments에서 `Cut + Analyze` 버튼을 추가해 FFmpeg 클립 추출 후 즉시 앱 분석을 실행.
  - 이미 잘라낸 클립도 `Analyze Existing Clips`로 재분석 가능하게 함.
  - 분석 결과를 클립별 `ACTUAL / APP / ERROR`로 표시하고, 성공한 앱 속도를 해당 배치 row의 `App km/h`에 자동 반영.
  - 단일 클립 분석 성공 시 현재 레퍼런스 폼의 실제 속도/앱 속도/구간/픽셀 측정값도 채움.
  - Segment Helper를 접힘 영역으로 바꾸고, 핵심 작업 버튼을 `Reset / Save / Cut / Cut + Analyze` 중심으로 단순화.

### 검증
- `npm run lint` 통과.
- `npm run build` 통과. 기존 MediaPipe dynamic dependency 경고만 유지.

### 후속 필요
- 브라우저에서 실제 `/admin/references` 페이지에 레퍼런스 영상을 올려 `Cut + Analyze` 런타임 결과를 확인하고, Nicky 89km/h 클립의 보정 계수 분포를 저장해야 함.

## 2026-06-18 (3) · Codex — 방송/레퍼런스 영상 자동 분석 안정화

### 수정
- `lib/workers/pose.worker.ts`: MediaPipe Pose `numPoses` 를 1→3으로 변경해 골키퍼/키커가 같이 보이는 영상에서 키커 포즈를 놓칠 가능성을 낮춤.
- `app/analyze/page.tsx`:
  - 분석 샘플링을 12fps/168프레임에서 20fps/280프레임으로 상향해 25fps 방송 클립의 짧은 임팩트 구간을 더 촘촘히 봄.
  - 임팩트 후 공 추적 윈도우를 360ms→650ms로 늘려 0.4~0.5초짜리 페널티킥 비행 구간을 놓치지 않게 함.
  - 다중 포즈 결과에서 사람 간 발 샘플이 섞이지 않도록 pose index + foot side 별로 이전 발 위치를 추적.
  - 프레임별 가장 빠른 발을 전역으로 선택하되, 이미 잡은 발에서 너무 멀리 튀는 대상 전환은 감점.
  - 공 후보 선택을 임팩트 전에는 active foot 주변 후보 중심으로 재랭킹하고, 큰 신체/그래픽 움직임 후보를 감점.
  - 기존의 너무 이른 ball-only 임팩트 확정을 제거하고, 발 주변 확인 또는 포즈가 전혀 없을 때의 강한 공 이동만 임팩트로 인정.
  - 폼 계산용 관절이 부족해도 공 궤적 + 신체 스케일이 있으면 구속은 산출하도록 완화.

### 검증
- `npm run lint` 통과.
- `npm run build` 통과. 기존 MediaPipe dynamic dependency 경고만 유지.
- 로컬 dev 서버 `http://localhost:3001/analyze` 브라우저 로드 확인, 콘솔 error/warn 없음.

### 한계
- 실제 Nicky MP4 업로드 전체 런타임 분석은 브라우저 파일 선택/모델 로딩 자동화까지 수행하지 못함. 사용자 환경에서 하드 리로드 후 재분석 필요.
- 근본적으로 정확도를 더 올리려면 학습된 공 detector 또는 ROI/크롭 기반 분석 모드가 다음 단계.

## 2026-06-18 (2) · Codex — Nicky 55mph MP4 분석 실패 원인 추가 진단

### 확인 결과
- `/Users/sun/Downloads/01_input_Nicky_55mph_89kmh.mp4` 는 정상 MP4: H.264, 1920x1080, 25fps, 12.4초, 약 7.2MB.
- 파일 형식/용량은 `/analyze` 및 어드민 비디오 입력 조건을 통과함. 이전 JPEG 문제와는 다름.
- 문제는 영상 내용/알고리즘 적합성:
  - 방송 편집본이라 인트로, 블러 전환, 그래픽 오버레이, 레이더 화면 컷이 포함됨.
  - 골키퍼와 키커가 동시에 움직여 `numPoses: 1` 포즈 분석이 키커가 아닌 골키퍼를 잡거나 중간에 대상이 바뀔 수 있음.
  - 공 추적은 학습 모델이 아니라 프레임 차분 기반이라 실제 공보다 골키퍼/키커/그래픽 움직임이 상위 후보로 잡히는 프레임이 많음.
  - 25fps이고 실제 임팩트~도착 구간이 약 0.4~0.5초로 짧아 12fps 샘플링에서 안정적인 궤적 산출이 어렵다.
  - 카메라가 대각선/원근 방향이라 바디 픽셀 스케일 기반 속도 추정은 실제 55mph(약 89km/h)를 크게 과소/오검출할 가능성이 높음.

### 후속 권장
- 이 클립은 일반 `/analyze` 자동 구속 산출용보다 어드민 레퍼런스용으로 다루는 것이 적합.
- 레퍼런스 등록 시 `knownSpeedKmh=89`, 페널티 거리 `knownDistanceMeters=11` 전후, 임팩트~골라인/키퍼 도착 타이밍을 수동으로 잡아 timing 기반 measured speed를 쓰는 쪽이 안정적.
- 자동 분석을 개선하려면 최소한 키커 ROI 지정/크롭, 편집 컷 제거, 다중 포즈 중 키커 선택, 또는 학습된 공 detector가 필요.

## 2026-06-18 · Codex — 영상 분석 실패 원인 진단

### 확인 결과
- 사용자가 공유한 파일 경로는 비디오가 아니라 `JPEG image data`, `576x323` 정지 이미지임.
- `/analyze` 및 `/admin/references` 업로드 흐름은 `video/*` 또는 영상 확장자만 허용하므로 해당 파일은 정상 분석 대상이 아님.
- 사용자 분석 파이프라인은 여러 프레임의 포즈/공 이동량을 샘플링해 임팩트와 속도를 추정한다. 정지 이미지 또는 1프레임 영상으로는 속도/궤적 산출이 불가능.
- 현재 공 추적 워커는 학습된 공 객체 모델이 아니라 프레임 간 움직임 차분 기반이라, 저해상도 방송 클립/자막/카메라 패닝/작게 보이는 공에 취약함.

### 후속 권장
- Photos/앨범에서 스크린샷·Live Photo 정지 프레임이 아니라 원본 `.mov`/`.mp4` 영상을 내보내서 테스트.
- 원본 클립은 공과 전신이 크게 보이고, 임팩트 전후 1~2초 이상이 포함되며, 가능하면 60fps 이상인 파일을 사용.
- 방송/유튜브 레퍼런스는 현 공 추적 방식으로 자동 속도 산출보다 어드민 레퍼런스의 수동 구간/거리 보정 워크플로우가 더 안정적.

## 2026-06-14 (5) · Claude — cut 워커 import: ESM 소스 인라인으로 재수정

(4)의 self-host 가 실패: 같은 `Cannot find module 'blob:...'` 재발.

### 추가 진단 (확정)
- 배포된 vendored UMD 워커(`814.ffmpeg.js`) 내부를 디스어셈블해 보니 코어 로딩이
  `self.createFFmpegCore=(await r(454)(o)).default` — 즉 **@ffmpeg 가 배포한 UMD 워커
  자체가 webpack 빌드로 동적 import 가 `__webpack_require__`(r) 로 재작성된 채 깨져 있음**
  ("Cannot find module" 문자열도 번들에 박혀 있음). 그래서 UMD 워커를 self-host 해도 동일.
- @ffmpeg 워커는 `import(/* @vite-ignore */ coreURL)` 를 쓰는데 **webpack 용 무시 주석이
  없어** 어떤 webpack(@ffmpeg 빌드든 Next 빌드든)을 거치면 깨진다.

### 수정 (`scripts/setup-ffmpeg.mjs`, `public/ffmpeg/worker.js`)
- setup 스크립트가 **ESM 워커 *소스*** (`dist/esm/worker.js`, native `import()`)를
  `const.js`/`errors.js` 까지 인라인해 단일 정적 ESM 모듈로 생성. 정적 파일은 어떤 번들러도
  거치지 않으므로 `import(coreURL)` 가 네이티브로 동작 → blob 코어 정상 로드.
- 이 파일을 classWorkerURL 로 넘김(코드는 (4)에서 이미 적용됨). `node --check` 통과.

### 요청
- 배포 후 **시크릿 창**(또는 SW unregister)에서 cut 재시도.
- 그래도 실패 시 화면의 실제 ffmpeg 문구 공유.

---

## 2026-06-14 (4) · Claude — cut 진짜 원인 해결: webpack 워커 import 깨짐

실제 에러(사용자 보고): **`클립 생성 실패: Error: Cannot find module 'blob:https://...'`**

### 진단 (확정)
- `@ffmpeg/ffmpeg` 의 워커는 코어를 `import(coreURL)`(coreURL = blob)로 로드한다(`dist/esm/worker.js`).
- 그런데 `new Worker(new URL('./worker.js', import.meta.url))` 로 워커를 만들면 **Next(webpack)가 워커를 번들하면서 내부 동적 `import()` 를 재작성**한다. 런타임에 blob 코어 모듈을 webpack 모듈맵에서 못 찾아 `Cannot find module 'blob:...'` 로 실패. (앞선 COOP/COEP 제거로 로딩 자체는 시작되어 이 단계까지 도달하게 된 것.)

### 수정 (`app/admin/references/page.tsx`, `scripts/setup-ffmpeg.mjs`, `package.json`, `eslint.config.mjs`, `public/ffmpeg/worker.js`)
- **self-contained UMD 워커 번들을 classWorkerURL 로 사용**: `@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js` 를 `public/ffmpeg/worker.js` 로 복사(vendored)하고, 동일 출처에서 blob 으로 받아 `ffmpeg.load({ classWorkerURL, coreURL, wasmURL })` 에 전달. webpack 을 거치지 않으므로 워커의 `import(coreURL)` 가 네이티브로 동작 → blob 코어 정상 로드.
- `scripts/setup-ffmpeg.mjs`: dist/umd 의 워커 번들(파일명 버전마다 다름)을 자동 탐색해 `public/ffmpeg/worker.js` 로 복사. 실패해도 빌드 안 막음(커밋된 사본 사용).
- `package.json`: `postinstall` 에 `node scripts/setup-ffmpeg.mjs` 추가(버전 업 시 자동 갱신).
- `eslint.config.mjs`: `public/ffmpeg/**`(벤더 번들) lint 제외.

### 검증/요청
- `npm run lint` 통과. 런타임은 배포 후 확인 필요 → **하드 리로드/SW unregister 후** cut 재시도.
- 코어 자체(unpkg ESM)는 그대로 두되, 워커만 self-host. 코어까지 self-host 하려면 별도 작업(앞 항목 참고).

---

## 2026-06-14 (3) · Claude — cut "클립 생성에 실패했습니다" 후속

진전: COOP/COEP 제거로 FFmpeg 로딩은 성공(초기화 타임아웃 사라짐). 이제 실제 cut/인코딩 단계에서 실패.

### 진단
- 메시지 "클립 생성에 실패했습니다"는 `getClipCutErrorMessage`의 **fallback**(비-Error throw 시). `@ffmpeg/ffmpeg` worker는 내부 에러를 `e.toString()` **문자열**로 reject(`node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js`)하는데, 기존 코드가 `instanceof Error`가 아니라며 그 문자열(=진짜 ffmpeg 에러)을 버리고 있었음.
- 추정 원인: 매 클립을 `libx264`로 **강제 재인코딩**하던 변경 때문에 실제 고해상도 footage에서 wasm 메모리 초과/abort 가능성. (확정은 아래 에러 노출로 확인 예정.)

### 수정 (`app/admin/references/page.tsx`)
- **실제 에러 노출**: `getClipCutErrorMessage`가 문자열/객체 reject 값을 그대로 표면화 → 화면에 "클립 생성 실패: <실제 ffmpeg 메시지>" 표시.
- **copy 우선 + 재인코딩 fallback**(`cutClipData` 헬퍼 신설): 1) 먼저 `-c copy`로 가볍게 시도(H.264 mp4/mov는 빠르고 메모리 거의 안 씀) → 2) 실패/빈 결과면 `libx264 -preset ultrafast`로 재인코딩(webm/VP9·mkv·avi 대응). 매 클립 강제 재인코딩 제거로 OOM 회피.

### 한계/요청
- 브라우저 런타임 검증 불가(샌드박스). 배포 후 **하드 리로드/SW unregister** 뒤 재시도 필요.
- 그래도 실패하면 이제 화면에 **실제 ffmpeg 에러 문자열**이 보이므로, 그 문구를 공유해주면 정확히 특정 가능.

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
- **커밋 완료**: `26df3e5 fix: resolve reference cut-clip FFmpeg load timeout` (로컬). 샌드박스에 GitHub 인증이 없어 **push는 맥에서 `git push origin main`** 필요 → push 시 Vercel 자동 배포. 배포 후 SW 캐시 때문에 하드 리로드/Service Worker unregister 후 cut 재확인 권장.
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
