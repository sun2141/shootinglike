# WORKLOG — Claude · Codex 협업 로그

> 코덱스와 함께 작업하는 프로젝트입니다. **작업을 마칠 때마다 이 문서 맨 위에 새 항목을 추가**해 양쪽이 최신 변경을 공유합니다.
> 형식: 날짜 / 작업자 / 변경 요약 / 영향 파일 / 후속 필요사항.

---

## 2026-11-06 (6) · Claude — 홈 문구·축구장 디자인

- 문구: '중력으로 측정하는 공속도' · 'HOW FAST YOUR FREEKICK' · '…공 속도를 측정합니다 … 측정 안 된 경우엔 이유를 알려드립니다'
- 배경을 그림 파일 없이 CSS·SVG 로 그린 축구장으로: 잔디 줄무늬 + 잔디 결(노이즈) + 흰 경기장 선 + 조명 빛, 가장자리 어둡게(글자 대비)
- 버튼: 구속 측정 = 형광 잔디색, 프리킥 측정 = 하늘색, 리더보드 = 트로피 금색. 안내 카드 아이콘도 색별로
- 휴대폰 제목 크기 조정 (HOW FAST YOUR 가 한 줄에)

---

## 2026-11-06 (5) · Claude — 관리자 대시보드 · 홈 바로가기

- `/admin` 을 대시보드로 다시 만듦 (`app/admin/AdminDashboard.tsx`, 휴대폰 우선): 지금 할 일(확인할 킥·Mac 반영 대기) →
  자동화(레퍼런스 자동 분석: 워커 실행 중/대기/꺼짐, 마지막 동기화, 판정 분포 막대·탭 바로가기 / 유튜브 수집: 지금은 Mac 명령뿐) →
  데이터베이스 현황(DB 용량·Neon 0.5GB 기준선, 기록·정답표·자동 분석·이미지 개수) → 관리 화면 → 사용자 화면 → 아직 없는 기능
- 새 API `/api/admin/overview` (토큰 필요): count 몇 번 + `pg_database_size` + 이미지 용량
- `/admin/refauto?tab=review` 처럼 탭 지정 (대시보드에서 바로 이동)
- 홈: 구속 측정(주) · 프리킥 측정(베타) · 리더보드 버튼, 휴대폰 여백·글자 크기 정리
- 확인: iPhone 13 화면 + 가짜 API 로 스크린샷, eslint 통과, 콘솔 오류 없음

---

## 2026-11-06 (4) · Claude — 폴더 정리 버그 수정 (한글 폴더 이름 정규화)

- 증상(로그): 모든 영상이 '이미 처리한 같은 영상 — 건너뜀', 이어서 `학성초 프리킥.mp4` 옮기기에서 FileNotFoundError 로 실행 전체가 멈춤 (11-06 02:17 이후 동기화 없음)
- 원인: macOS 가 한글 이름(`3_확인필요` 등)을 NFC 로 찾아도 열어 주지만 디스크의 실제 이름(NFD)과 경로 문자열이 달라
  같은 파일을 다른 경로로 비교(→ 전부 '중복')하고, NFC 경로로 이름 바꾸기를 하다 실패. 멈춘 덕분에 '8_중복' 으로 옮겨지지는 않음
- 수정 (`library.py`): `real()` 실제 디스크 이름으로 경로 맞춤, `same()` 은 samefile 로 비교, 옮기기 실패는 기록만 하고 계속,
  원장이 가리키는 파일은 절대 '중복' 으로 옮기지 않는 안전장치, `refauto.run` 은 정리 실패해도 저장·업로드 계속
- `calib.solve`: 초점거리 훑기 시작값이 경계(5W) 밖이면 least_squares 가 오류 → 경계 안으로 자름 (07 이 '오류' 로 떨어지던 것)
- NFD 이름 폴더로 시험: 중복 오판 없음, 판정 바뀌면 다시 옮김

---

## 2026-11-06 (3) · Claude — refauto-2 재계산에서 08·09 가 확정에서 빠진 원인: OpenCV 판

- 재계산 결과(17:17): 측정 불가 30→20, 확인 필요 4→6, 그런데 **확정 5→3** (08 '멈춘 공을 찾지 못함', 09 '골대를 찾지 못함')
- 원인: Mac 가상환경의 OpenCV 4.12 — 영상 디코더 차이로 프레임 픽셀이 평균 2(최대 12) 달라 검출 경계값을 넘나듦.
  옛 코드로 4.12 에서 돌려도 똑같이 실패(내 변경 탓 아님). 5.0.0.93 에서는 04·05·08·09·11 이 86.2·72.4·81.7·85.3·80.8 로 원래 원장과 같음
- 조치: `requirements.txt` 에 `opencv-python-headless==5.0.0.93` 고정, `install_launchd.sh` 가 가상환경 패키지를 맞춤,
  `pipeline.VERSION` 에 OpenCV 판을 붙여 판이 바뀌면 자동 재계산, 워커 상태에 판 기록 → 관리자 화면 경고
- 골대 2차 검색 보강: 더미 위로 짧게 보이는 기둥 조각도 후보(세로 최소 H/60), '가려짐' 기준 완화(아래 잔디 50% 미만),
  화면 가장자리·울타리(기둥 위로 끊김 없이 이어지는 흰 선) 거르기. 4.12 의 09 도 실제 골대(1386~1739)를 찾음
  (참고: 5.0 엄격 검색의 09 골대는 더미 조각을 왼쪽 기둥으로 잡지만, 08 장면 재사용으로 카메라는 맞음 — 그대로 둠)
- **Mac 에서 할 일**: `bash scripts/refauto/install_launchd.sh /Volumes/64B/freekick` 한 번 (패키지 맞춤 + 바탕화면 'USB 안전하게 빼기')

---

## 2026-11-06 (2) · Claude — 영상 폴더 자동 정리 · USB 안전 분리 · 모바일 화면

- **영상 폴더 자동 정리** (`scripts/refauto/library.py`): 새 영상은 폴더 맨 위에 넣고, 분석 후 판정별 하위 폴더
  `1_확정 2_추정 3_확인필요 4_측정불가 5_프리킥아님 6_제외 7_오류 8_중복` 로 옮김(옆 `.json` 함께). 판정이 바뀌면 다시 옮김.
  원장에 상대 경로(`path`) 기록, 없거나 틀리면 이름으로 찾음. 폴더에 `_안내.txt` 생성.
  기존 USB 원장(경로 없음)도 다음 실행 때 다시 계산 없이 정리됨 — 임시 폴더로 시험(이동·중복·확정 후 이동·일시정지)
- **USB 안전 분리**: `USB 안전하게 빼기.command`(바탕화면 바로가기는 `install_launchd.sh` 가 만듦) / `npm run ref:eject`
  → `~/.refauto/pause` 로 워커를 영상 사이에서 멈추고 업로드도 미룸 → 분석 프로세스가 끝나면 `diskutil eject` → 일시정지 해제.
  USB 이름이 바뀌어 붙어도 같은 폴더를 찾고, 그냥 빠져 남은 잠금은 pid 로 확인해 넘겨받음. 매 실행 끝에 원장·수정 `.json` 을 `~/.refauto/backup/` 에 복사
- **모바일**: `/admin/refauto` 수정 화면을 휴대폰용으로 다시 만듦 — 사진이 위에 붙어 있고, 누른 뒤 끌어서 돋보기로 맞춤,
  마지막 점 지우기, 저장 버튼 하단 고정, 세로 영상도 화면 절반 안. 목록은 12개씩(더 보기)으로 이미지 요청을 줄임, 탭 가로 스크롤.
  `/admin` 에 페이지 주소 목록, `docs/PAGES.md`. `/admin/records` 표가 잘려 삭제 버튼이 안 보이던 것, `/leaderboard` 표 줄바꿈, 여백 정리
- 확인: iPhone 13 화면으로 dev 서버 + 가짜 API 로 수정 화면을 눌러 저장 요청 좌표(1920 기준)가 맞는 것까지 확인. eslint 통과,
  tsc 는 Prisma 클라이언트 생성 없이 돌린 것이라 API 쪽 타입 오류만 남음(화면 코드는 오류 없음)

---

## 2026-11-06 · Claude — refauto 자동화 마무리: 측정 불가 줄이기 + 손으로 고치는 길 열기

운영 상태 확인: Mac 워커(launchd)가 5분마다 `/Volumes/64B/freekick` 을 돌려 `/admin/refauto` 에 동기화 중 (11-06 01:28 마지막).
36개 영상 · 킥 판정 A 5 · 확인 필요 4 · 수동 1 · 제외 2 · **측정 불가 30 (거의 다 '골대를 찾지 못함')**.

- **버그: 실패한 킥에 `coord_w` 가 없어 관리자 화면이 1920px 로 가정** → 1280·480px 영상에서 골대·공을 찍으면 좌표가 틀리게 저장됐다
  - `pipeline.py`: 기준 장면을 만든 직후 `coord_w` 기록 (측정 불가·멈춘 공 못 찾음·추적 실패 킥에도)
  - `cloud.py`: 예전 원장처럼 없으면 영상 크기에서 계산(`default_coord_w`, Reader 와 같은 1920 축소 규칙)
  - `app/admin/refauto/page.tsx`: 화면도 같은 규칙으로 대체값 계산 (배포 필요)
- **골대 검출 2차 시도** (`detect.goal`): 엄격한 검색이 실패할 때만, 한쪽 기둥이 더미·사람에 가려 짧게 보이는 골대까지 찾는다
  - 기둥 아래가 잔디인지는 field_edge 대신 '화면 아래에 닿는 잔디 덩어리'로 직접 확인 (앞사람이 화면 아래를 가려도 됨)
  - 가려진 기둥은 아래가 잔디가 아니어야(가림막) 하고, 꼭대기가 다른 기둥과 맞아야 함. 아래끝은 보이는 기둥 높이만큼 내려 잡고 큰 오차(σ20)로 보정
  - 울타리 오인 방지: 기둥이 크로스바 위로 이어지거나 크로스바가 양쪽 밖으로 길게 이어지면 버림, 화면 가장자리에 붙은 골대 버림
  - 엄격한 검색 결과는 그대로 → 04·05·08·09·11 등 기존 확정값 불변 (기준 장면 10개·_work 이미지 166장에서 기존과 비교해 확인)
  - 07: 측정 불가 → 골대 검출 성공(확인 필요로 넘어감). 03: 여전히 못 찾음(골대 대부분이 더미에 가림 — 손으로)
- `VERSION = refauto-2` → 다음 워커 실행 때 전체 재계산·재동기화 (사람이 남긴 확정·제외·클릭은 영상 옆 .json 에 있어 유지)
- 남은 일: page.tsx 배포(push), 측정 불가로 남은 킥은 관리자 화면 '수정'에서 골대 4점·멈춘 공 클릭 → Mac 재계산

---

## 2026-10-01 · Claude — 앱 프리킥 측정(대각선 뒤) `/analyze/freekick` + 서버 비용 정리

**원칙: 분석은 전부 사용자 기기(브라우저)에서.** 영상은 서버로 가지 않고, 사용자 수가 늘어도 서버 연산·트래픽이 늘지 않는다.
- `lib/rearview/` (브라우저·Node 공용, 외부 의존성 없음): refauto 파이썬 파이프라인의 앱용 이식
  - `calibrate.ts` 골대 4점 + 멈춘 공 크기 + 폰 화각 사전값(f ≈ 0.74×긴 변 ± 0.08) → 카메라, 초점거리 1σ 범위
  - `track.ts` 멈춘 공 원 맞춤, 킥 순간(공 자리 변화), 7프레임 버퍼 추적(사슬로 첫 포착 → 예측 추적), 튀는 점 제거
  - `physics.ts` 중력+항력+마그누스 궤적 맞춤(refauto 와 같은 모델, 같은 추적점으로 ±0.5% 일치), 마지막에 다중 시작값
  - `analyze.ts` 흐름·판정, `browser.ts` requestVideoFrameCallback + VideoFrame(그림·시각 일치), 처리 중 영상 일시정지
- 화면 `app/analyze/freekick/page.tsx`: 장면 고르기 → 골대 4모서리·공 탭(돋보기, 끌어서 수정, 공 원 자동 맞춤·크기 조절) → 측정
  → 속도·범위·거리·발사각·골라인 높이, 계산한 골대·궤적 겹쳐 그리기. `/analyze` 에 링크
- **판정은 '추정'** (범위 표시). 이 구도에선 골대·공·키커 키로 초점거리가 정해지지 않음을 확인(사전값 없이 ±25%) →
  키커 키 입력은 뺐다. 기기 화각을 레퍼런스로 확인해 `focalPrior` σ≤0.03 을 넘기면 '측정'
- 검증 `npm run rv:check -- /Volumes/64B/freekick` (ffmpeg 필요, refauto 원장과 비교):
  05 +1.7% · 08 −2.4% · 04 −0.5% · 11 −0.9% · IMG_0024 −12%(refauto 카메라의 골대 잔차가 7px 로 큼, 미해결) · 09 원장 골대 좌표 오류.
  브라우저(Chromium, 05) 72~75 km/h, 7초 영상 분석 약 25초
- 비용: 영상 원본 업로드(`/api/dataset/upload`) 기본 차단(410, `DATASET_UPLOAD=1`·`NEXT_PUBLIC_DATASET_UPLOAD=1` 로 켬 —
  Vercel 4.5MB 한도·서버리스 디스크 휘발로 원래도 동작 안 함), `/api/reference-calibration` CDN 5분 캐시,
  `/api/leaderboard` CDN 1분 캐시, `/leaderboard` 조회 60초 캐시(unstable_cache)
- 확인: tsc·eslint 통과, `next build --webpack` 통과(샌드박스라 폰트는 가짜 응답). 실제 폰에서는 아직 안 돌려 봄
- 후속: 폰 실기기(아이폰 Safari·안드로이드 Chrome) 속도·메모리 확인, 결과 저장/리더보드 연동(지금은 저장 안 함),
  레퍼런스로 기기 화각 사전값 좁히기

---

## 2026-09-28 · Claude — refauto 외부 확인·수정: `/admin/refauto` + Mac 자동 워커

- DB: 마이그레이션 `20260928000000_add_refauto` (RefautoVideo·Kick·Image·Edit·State). Vercel 빌드의 `prisma migrate deploy` 로 적용
- API `app/api/admin/refauto/`: GET 목록 · `sync`(워커 업로드) · `images`(누락 확인/업로드, ≤20장·장당 1.5MB) · `image/[id]`
  · `edits`(화면→수정 요청 POST, 워커 GET pending / PATCH 완료) · `register`(A·수동 확정 → ReferenceVideo isActive=false). 모두 x-admin-token
- 화면 `app/admin/refauto/page.tsx`: 판정 탭, 확정/제외/수정(후보 프레임 클릭 편집)/정답표 등록, 워커 마지막 실행 표시. `/admin` 에 링크 추가
- 워커 `scripts/refauto/cloud.py` (`refauto.py <폴더> --cloud`), 자동 실행 `install_launchd.sh` (5분 + 폴더 감시)
- pipeline: 후보 프레임 6장(`frames/<이름>_k<n>_f<i>.jpg`, 고정 카메라만), `coord_w` 기록
- 검증: tsc·eslint 통과. **실제 DB·배포 환경에서는 아직 안 돌려 봄**
- 09-30 수정: Mac conda base 의 scipy 가 liblapack 누락으로 깨짐 → 전용 venv(`scripts/refauto/.venv`) 권장, install_launchd.sh 가 venv 우선 사용. 실수로 커밋된 `__pycache__` 제거 + .gitignore
- 후속: 커밋·푸시 → Vercel 에 ADMIN_REFERENCE_TOKEN 확인 → Mac 에서 `--cloud` 1회 → `install_launchd.sh`. 이미지가 Postgres 에 쌓이므로 용량 확인

---

## 2026-09-27 · Claude — 프리킥 레퍼런스 자동 작업 `scripts/refauto/` (+ 수동 레퍼런스 저장)

영상 폴더에 넣고 `npm run ref:auto -- /Volumes/64B/freekick` → 새 영상만 판별·보정·추적·궤적 맞춤 → `<폴더>/_refauto/`.
- 판별: 축소 스캔으로 '멈춘 공이 차여 위로 날아가는' 매끄러운 궤적을 찾는다. 없으면 '프리킥 아님'
- 보정: 골대(굵은 흰 기둥+크로스바, 경기장 안쪽만) + 페널티 박스 선·아크 + 더미 160 + 멈춘 공 + (있으면) 키커 키
- 추적: 원본 해상도, 흔들리는 영상은 배경 정합. 궤적: 자유 비행 구간만 늘려 가며 맞춤
- 판정 A/B/확인 필요/측정 불가/프리킥 아님. **사람 키 없이 선만 쓰면 f 가 3~5% 작게 잡혀 속도가 낮게 나오는 경향**
  (05 크로스바 도착 시각으로 확인) → 키커 기준 없으면 B
- 확인 페이지(`--review`, localhost:8765): 키커 발·머리 / 골대 4점 / 멈춘 공 클릭, 영상 정보 입력 → 영상 옆 `<이름>.json` 저장 후 재계산
- 같은 삼각대 장면은 사람이 확정한 카메라를 자동 재사용(`scenes.json`)
- 업로드(`--upload`, `--dry-run`): /api/admin/references 에 isActive=false 로. 수동 분석값이 있는 킥은 수동값 우선
- 수동 분석 레퍼런스(04·05·08·09·11 확정, 06·07 추정)는 `manual_refs.json` → 원장·CSV·업로드에 포함
- 실행 결과(freekick 32개 짧은 영상): 확정 5(04 86.2·05 72.4·08 81.7·09 85.3·11 80.8), 확인 필요 6, 측정 불가·프리킥 아님 나머지.
  1~4.mp4(100초대)·학성초는 이 환경 시간 제한으로 미처리 — Mac 에서 같은 명령으로 돌리면 됨
- freekick 폴더에 04/05/08/09/11.json (키커 키, 05·08 은 키커 클릭 좌표) 추가
상세 `scripts/refauto/README.md`

---

## 2026-09-27 · Claude — 대각선 뒤 측정 6차: 더미 160 cm 정정 + 측정 불가 영상 추정

- 더미 175→160 (사용자 정정). 04 81 / 05 68 / 08 83 / 09 88 / 11 82 km/h. 더미·키커 불일치 해소
- 07: 85~102 km/h (크로스바 맞는 장면 + 벽 9.15 m 가정 시 ~100)
- 06: 유소년 5×2 골대 가정 43~50 km/h
- 03: 96~105 이지만 초등부라 규격 확인 전까지 보류. 01·02 미처리
상세 `scripts/rearview/README.md` 6차

---

## 2026-09-26 · Claude — 대각선 뒤 측정 5차: 06·07 측정 불가 판정

- 06: 패닝 폰·망원·라인 없음 → 초점거리 미결정. 키퍼 캐치 시각과 궤적이 어떤 보정에서도 안 맞음. 60~90 km/h 범위라 판정 불가
- 07: 정면 구도 + 공이 골대 위로 사라짐 → 보류
- 원본은 `ref-rear/06.mp4`, `07.mov` 로 복사. 상세 `scripts/rearview/README.md` 5차

---

## 2026-09-26 · Claude — 대각선 뒤 측정 4차: 08·09·11 (10=05 중복)

- 08(172 cm) 83~84 km/h 골 / 09(182 cm) 88~89 km/h 크로스바 위 / 11(172 cm) 82~83 km/h 바운드 후 골
- 08 한 장면으로 보정(골대+라인+더미+키커 3명), 키커만 써도 1% 이내로 같음
- 영상 원본: `/Volumes/64B/freekick/08~11.MP4` → `ref-rear/` 로 복사(gitignore). 스크립트 `calib.py`, `fit_clip.py`, `check_heights.py`
상세 `scripts/rearview/README.md` 4차

---

## 2026-09-26 · Claude — 대각선 뒤 측정 3차: 더미 높이 반영, 03 시도

- 04/05: 82~88 / 69~73 km/h. 더미(175)와 키커(182) 기준이 5~7% 어긋나는데 05 크로스바 도착은 키커 기준만 맞음
- 03: 26.8 m, 104~112 km/h (정면 구도라 불안정, 더미 빼면 176 으로 튐) — 참고값. 01·02 미처리
- 앱 촬영 가이드 후보: "골대와 페널티 박스 선이 보이게, 대각선 뒤에서"
상세 `scripts/rearview/README.md`

---

## 2026-09-26 · Claude — 대각선 뒤 측정 2차: 경기장 라인 보정으로 수치 수정

1차(골대만)의 초점거리가 틀려 속도가 약 20% 높게 나왔다. 페널티 박스 라인·아크(표준 규격)를
골대·키커 키(182 cm)와 함께 맞춰 카메라를 다시 보정 → f 1373, 카메라 높이 1.25 m.
- 04: 82 km/h(1차 100), 킥→골라인 20.7 m / 05: 69 km/h(1차 81), 20.6 m
- 검증: 투영한 표준 라인이 실제 선과 겹침, 키커 키 0.5% 이내, 05 크로스바 도착 시각·높이를 제약 없이 맞춤
- 01~03 은 미처리(정면에 가까운 구도·손떨림·왼쪽 포스트 가림). 페널티 라인·골에어리어 라인은 보여서 같은 방식 시도 가능
`scripts/rearview/README.md` 2차 항목 참고

---

## 2026-09-26 · Claude — 대각선 뒤 구도 측정 프로토타입 (`scripts/rearview/`)

골대를 기준으로 카메라 자세를 잡고, 멈춘 공을 시작점으로 3D 궤적(항력+회전)을 화면 궤적에 맞추는 방식.
영상: `ref-rear/01~05.mp4` (gitignore). 04·05 로 검증, 01~03 은 아직.
- 04: 킥→골라인 24.9 m, 초속 약 100 km/h, 발사각 18°, RMS 1.1 px. 크로스바 위 4.9 m 로 넘어가 뒤 펜스에 맞음 — 화면과 일치
- 05: 24.6 m, 약 81 km/h, 22°, RMS 1.4 px. 크로스바 윗면(2.66 m)에 떨어지는 시각이 관측과 1프레임 이내
- 최대 오차원 = 초점거리(±10%). 정답(레이더 등) 없이 자체 일관성만 확인한 상태
- 수작업: 골대 모서리 4점, 멈춘 공 위치, 추적 가이드 몇 점. 자동화 전 단계
자세한 내용 `scripts/rearview/README.md`

---

## 2026-09-26 · Claude — 폰 동영상 테스트 페이지 (`ballspeed-downloads/ballspeed-phone.html`)

앱 배포 없이 폰에서 실제 영상으로 측정을 확인하기 위한 단일 HTML.
- `lib/ballspeed/*` 를 esbuild 로 IIFE 번들(`BallSpeed.analyzeVideo`)해 인라인 → **앱과 같은 코어, 외부 의존성 0**
- 앨범 선택 / 카메라 촬영(파일 입력), 공 규격 선택, 진행률, 결과(속도 또는 판정 보류 + 이유),
  궤적 오버레이(추적 오류 눈으로 확인), 진단 수치(화면2D·배율·연직가속도·SNR·fps·공 px·구도), 결과 텍스트 복사
- claude.ai 아티팩트로도 게시(폰에서 링크로 열기). 로컬 파일은 Mac 에서 AirDrop 해도 열린다
- 헤드리스 크로미움 검증: 합성 측면 클립(79.2 km/h) → 81.3 km/h(+2.7%), 중력검산 통과

### 후속
- 폰에서 가이드대로 찍은 클립 10~20개로 통과율 확인 → 결과 복사 텍스트를 모아 공유
- 파일은 `public/` 이 아니라 `ballspeed-downloads/` 에 둠(Serwist precache 에 섞이지 않게)

---

## 2026-09-26 · Claude — `db:reset` 스크립트 Prisma 7 대응 수정

첫 버전이 `new PrismaClient()` 로 만들어 "needs to be constructed with a non-empty, valid
PrismaClientOptions" 로 죽었다. Prisma 7 은 드라이버 어댑터가 필수다. 두 가지를 고쳤다.
- `lib/prisma.ts` 와 같은 방식으로 `PrismaPg(new Pool({connectionString}))` 어댑터 전달,
  접속 문자열은 `.env.local` → `.env` (`prisma.config.ts` 와 같은 우선순위)
- **ESM 으로 `import { PrismaClient } from "@prisma/client"` 하면 생성된 설정이 비어 같은 오류가 난다.**
  번들러를 거치는 앱과 달리 스크립트는 node 가 직접 실행하므로 `createRequire` 로 CJS 로 불러온다.

이 환경에서는 Neon 도메인이 막혀 DNS 에서 멈추는 것까지 확인(= 클라이언트 생성은 정상).
실제 삭제는 Mac 에서 실행해야 한다.

---

## 2026-09-26 · Claude — 사용자 앱/관리자 모드 분리 + 앱 내 촬영 모드 + 기록 초기화 수단

### 사용자 화면 (3개로 정리)
- `/` 홈: Reference DB 링크 제거, 카피를 한국어로, 가이드 4칸을 실측에서 나온 기준으로 교체
  (**"후방 대각선 권장" 문구 삭제** — 후방 구도는 원리적으로 못 잰다. 실패 137건 중 56건이 이 구도였다)
- `/analyze`: 관리자 링크 제거, 라벨 한국어화
- `/leaderboard`: 속도 우선 정렬(기존엔 폼 점수 우선), 한국어화, "중력 검산을 통과한 측정만" 명시

### 앱 내 촬영 모드 (`components/KickRecorder.tsx`)
찍고 나서 보류라고 말하면 늦다. 찍기 전에 잡아준다.
- `getUserMedia` 로 후면 카메라 + **60fps 요청**(기기가 못 주면 실제 fps 를 배지로 보여주고 경고)
- 구도 가이드 오버레이(공 위치, 가로 진행 방향), **4초 자동 정지**, 촬영 전 체크리스트
- MediaRecorder 미지원/권한 거부 시 안내 후 '앨범에서 선택'으로 유도
- 녹화본은 파일 업로드와 같은 경로로 분석 (`acceptVideoFile` 로 분리)

### 자세 모델 없이도 측정 (`speedOnlyResult`)
모바일에서 MediaPipe/YOLO 를 못 받아오면 **분석 자체가 막혀 있었다**. 이제 모델 실패 시
구속만 측정하고 자세 점수만 비운다. 모델 오류 문구도 "구속 측정은 그대로 됩니다"로 수정.

### 관리자 모드 (사용자 화면에서 링크하지 않음, 주소로 직접 진입)
- `/admin` 신규: 입구 + 토큰 설정 상태 표시
- `/admin/references` 기존 유지 — **레퍼런스 정답표는 계속 필요하다**(보정·검증의 유일한 수단)
- `/admin/records` 신규 + `GET/DELETE /api/admin/records`: 기록 목록, 개별/전체 삭제 (x-admin-token 필요)

### 기록 초기화
`scripts/reset-leaderboard.mjs` — `npm run db:records`(확인) / `npm run db:reset -- --yes`(삭제).
DB 는 Neon 이라 이 환경에서 직접 지울 수 없다. **사용자가 실행해야 한다.**
User·ReferenceVideo 는 건드리지 않는다.

### 확인
`npx tsc --noEmit` 통과, eslint 오류 0(경고 3건은 복사해 온 `lib/ballspeed` 쪽 미사용 변수).
**Mac 에서 `npm run build` 와 폰 실기기 확인 필요** (촬영 모드는 https 또는 localhost 에서만 동작).

---

## 2026-09-26 · Claude — 한글 파일명 버그 수정 + 전체 재측정 보고서 + /analyze 화면 정리

### ballspeed
- `safeName` 에 NFC 정규화 추가. macOS 는 한글 파일명을 자모 분리(NFD)로 저장해서
  `학성초 프리킥.mp4` → 클립이 `__shot01.mp4` 로 생성되고 다른 한글 영상과 덮어쓰기 충돌했다.
  이제 `학성초_프리킥_shot01.mp4`. 빈 이름이면 `clip` 으로 대체
- out/ 재빌드 + 루트 사본 갱신 (`dist/` 는 tsc 필요해 그대로. 앱은 `lib/ballspeed` 사본 사용)

### 재측정 보고서
`/Volumes/64B/freekick/측정결과_2026-09-26.txt` — 클립 137개, 통과 3개.
후방·정면 구도 56 · 촬영조건 미달 43 · 추적 오류 의심 26 · 궤적 짧음 9.

추적 오류 26건을 들여다본 결과: 대부분 30fps 에 공이 4~8px, 화면 2D 속도가 100~450 km/h 로 이미 비현실적.
연직 가속도가 20~277 m/s² 로 나오는데, 이를 중력에 맞추려면 환산을 x0.03~x0.3 해야 한다.
그러려면 공 지름이 실제로는 화면의 수십 배여야 하므로 **공이 아닌 것을 따라간 것**이 맞다.
즉 현재 밴드(x0.3~x3.5) 거부가 옳은 판단이고, 숫자로 더 보정할 여지는 없다. 검출 단계 문제다.

### /analyze 화면
- 업로드 화면: 촬영 가이드를 문장 하나에서 **체크리스트 4개**(옆에서 / 60fps / 폰 고정 / 킥 앞뒤 2~3초)로
- 키 입력 설명 정정: 구속은 공 크기 + 중력 검산이 담당하고 키는 자세 분석에만 쓴다
- 속도 카드: 보류일 때 **`0 km/h` 대신 "판정 보류"** 와 안내 (기존엔 0 이 그대로 보였다)
- 통과 시 `중력검산 통과 · 환산 x1.02` 표시
- `npx tsc --noEmit`·eslint 통과. **Mac 에서 `npm run build` 확인 필요**

### 남은 일
- 리더보드 기존 DB 에 예전 방식으로 쌓인 미검증 기록(1~61 km/h)이 그대로 있다 → 정리 필요
- 검출 단계 개선(추적 오류 26건)은 별도 작업

---

## 2026-09-26 · Claude — 중력 검산 발산 버그 수정 + 깊이 성분 검증 추가 (ballspeed & 앱)

IMG_0020~0027 진단에서 시작. "촬영 조건은 측정에 적합합니다" 인데 보류되던 원인 두 가지를 찾아 고쳤다.

### 버그 1 — 항력 보정 반복이 발산 (`src/measure.ts`)
`k(다음) = (G + 항력(k)) / 측정가속도` 는 k 에 대해 2차라 그대로 반복하면 터진다.
IMG_0022 에서 expectedVerticalAccel 이 **2,896만** 까지 튀어, 측정 9.59 m/s²(거의 정확히 중력)를
"물리적 범위 밖"으로 버렸다.
→ 감쇠(0.5 혼합) + 12회 상한. expected 가 0.55G~1.75G 를 벗어나면 **한계값으로 자르지 않고
항력 보정을 포기하고 순수 중력으로 검산**한다(자르면 그 값이 그대로 배율이 되어 더 나쁜 보정이 된다 —
실측으로 확인: 자를 때 x1.79 로 200 km/h, 포기할 때 x1.02).

### 버그 2 — 깊이 성분이 커도 검증을 통과
공이 카메라 쪽/반대쪽으로 날아가면 속도의 대부분이 **공 반지름이 줄어드는 속도**에서 나온다.
반지름은 모션블러에 가장 취약한 값인데, 중력 검산은 화면 세로축만 보므로 통과해 버린다.
IMG_0021/0022 가 이 경로로 화면 2D 83~93 → 172~200 km/h 로 부풀었다.
→ `depthShare`(깊이 속도 / 전체 속도) > 0.5 또는 반지름 변화 > 0.35 면 **검증 실패** 처리하고,
촬영 조건 판정에도 "옆에서 찍어야 잴 수 있습니다" 를 넣는다. 세계기록(211) 초과·8km/h 미만도 검증 실패.

### 결과 (freekick 137개 클립 재측정)
- 검증 통과 3건: 1_shot04 94.3 (연직 10.7) / 3_shot18 92.0 (13.0) / Experiment-2_shot01 15.9 (8.9)
  — 전부 물리적으로 납득 가능한 값. 이전 "성공 7건" 중 169.9·61.6 같은 값은 사라짐(발산이 만든 우연)
- 실패 사유: 깊이 성분 과다 56 · 촬영조건 미달(공 4px 미만 등) 43 · 연직가속도 불일치(추적 오류 의심) 26 · 궤적 짧음 9
- **회귀 없음**: 합성 측면 클립 95/70 km/h → 100.8 / 70.2 (수정 전과 동일)

### 반영
- `ballspeed`: `src/measure.ts`, 재빌드한 `out/ballspeed.mjs`·`out/ballspeed.html`·루트 사본
  (이 환경에 esbuild 를 따로 깔아 빌드. `dist/` 는 tsc 가 필요해 그대로 둠 — 앱은 `lib/ballspeed` 사본을 쓰므로 무관)
- `shooting-like`: `lib/ballspeed/*` 동기화, `npx tsc --noEmit` 통과

### 남은 문제
- 이 데이터셋의 3분의 2가 후방 구도 또는 공 4px 미만 → 촬영 가이드로 막을 영역
- 연직가속도 불일치 26건은 추적 오류 의심. 다음 진단 대상
- 한글 파일명 클립이 `__shot01.mp4` 로 생성되는 버그는 아직 남아 있음

---

## 2026-09-26 · Claude — 실제 폰 클립 37개 측정 결과 판정 (출시 블로커 발견)

드라이브 freekick 폴더 37개 영상 · 킥 133개 → **측정 성공 7개(5%)**.

### 블로커: 조건이 적합한 영상도 전부 보류
IMG_0020~0027, IMG_0528 (**1920x1080 60fps, 킥 1개, 5~14초 — 앱이 노리는 딱 그 조건**) 8개가
전부 `판정 보류 — 촬영 조건은 측정에 적합합니다`. 즉 **촬영 문제가 아니라 측정·검산 단계 실패**인데
보고서에 이유가 안 나온다. 제대로 찍은 사용자도 결과를 못 받는다는 뜻 → 최우선 진단 대상.
(보고서가 quality verdict 만 찍고 gravityCheck/curvatureSnr 실패 사유를 안 보여주는 것도 같이 고칠 것)

### 나머지 보류는 대체로 정당
30fps 27개, 공 지름 4px 미만 다수(480x480·400x224 포함), 후방 구도 9개. 앱 촬영 가이드로 막을 영역.

### 의심스러운 성공값
`1_shot10` 169.9 km/h (30fps, 신뢰도 0.47) — 아마추어 영상에서 나오기 어려운 값.
`Experiment-2_shot01` 15.9 (이미 궤적 오버레이가 입혀진 데모 영상). 검증 통과 문턱이 느슨할 가능성.

### 부수 버그
한글 파일명(`학성초 프리킥.mp4`)의 클립이 `__shot01.mp4` 로 생성 — 이름이 뭉개져 다른 한글 영상과 충돌한다.

### 다음
IMG_0020~0027 을 `~/shooting-videos` 로 복사받아 `--debug` 로 실패 원인 확인 (궤적 길이 / curvatureSnr / 추적 대상)

---

## 2026-09-26 · Claude — 유튜브 정답 17건 입력 결과: 쓸 수 있는 쌍 0건

원장 81클립 중 검증 통과 3건, 정답 39건(화면 표시 17 + 이전 제목 주장 22).
**겹치는 게 하나도 없다** — 정답이 붙은 클립은 전부 판정 보류, 통과한 3건에는 정답이 없다.

원인: 한 영상이 5~20 클립으로 잘리는데 정답은 킥 하나의 값이다. 같은 값이 여러 클립에 붙어
어느 것이 그 킥인지 구분되지 않는다. raw 2D 대비 정답 비율이 x0.39~x3.04 로 흩어진 것도 같은 이유.

- 보강: 정답 입력 페이지에 "그 킥의 클립 한 곳에만" 경고 추가, `apply_truth.mjs` 가 같은 값이
  여러 클립에 붙으면 경고
- 판단: **방송·하이라이트 유튜브로는 보정 데이터를 못 만든다.** 10개 영상을 돌려 수확 0.
  ballspeed 는 중력 검산으로 영상마다 스스로 스케일을 잡으므로 출시에 정답표가 필수는 아니다.
- 다음: 사용자의 실제 폰 클립(드라이브 freekick 36개)을 로컬에서 ballspeed 로 돌려 통과율·경고를 본다.
  업로드 10MB 제한이 문제였는데 로컬 실행이면 제한이 없다

---

## 2026-09-23 · Claude — 스피드건 없이 레퍼런스 만들기 + 앱 측정 경로를 ballspeed 로 교체

### 정답 수집 방식 결정
스피드건 사용 불가 → **화면에 속도가 표시된 영상**만 정답으로 쓴다.
OCR 자동 판독은 실패(레이더 LCD 는 tesseract 가 못 읽음 — 106.5 표시 프레임에서 전부 오판독).
→ **사람이 숫자만 치는 반자동 방식**으로 전환.

- `scripts/truth_frames.py` — 영상 전 구간을 2초 간격 프레임 띠로 만들고, 클립별 측정값과 나란히 놓은
  `_truth/index.html` 생성. 값 입력 후 `truth.csv` 내려받기. `--no-ocr` 로 자동 판독 생략(기본 권장),
  OCR 을 켜면 방송 자막처럼 선명한 숫자에는 ● 표시가 붙는다
- `scripts/apply_truth.mjs` — truth.csv 를 원장에 기록하고 편향·중앙오차·제안 계수 출력
- 실행: 영상 10개 → 프레임 169장, `~/shooting-videos/_truth/index.html` (2.1MB)

### 앱 (`/analyze`)
- `lib/ballspeed/` 추가 (ballspeed src 에서 node 전용 파일 제외, 상대 import 의 `.js` 제거)
- 속도는 이제 **ballspeed 가 측정**한다. 기존 포즈 파이프라인은 자세 피드백·오버레이용으로 유지
- `lib/analysis/merge-measurement.ts` — 중력 검산 통과 못 하면 `confidence: "failed"` →
  기존 `persistAnalysis` 가 저장을 막으므로 **리더보드·공유에 미검증 값이 들어가지 않는다**
- 결과 화면에 발사각·체공시간·비행거리·연직가속도 카드 추가, 보류 시 이유와 재촬영 조건 안내
- 진행률: 포즈 0~50%, ballspeed 50~100%
- 확인: `npx tsc --noEmit` 통과, eslint 통과. **이 환경에선 next build 불가(네이티브 바이너리가 macOS용) → Mac에서 빌드·실물 확인 필요**

### 영향 파일
`lib/ballspeed/*`, `lib/analysis/merge-measurement.ts`, `app/analyze/page.tsx`,
`scripts/truth_frames.py`, `scripts/apply_truth.mjs`, `package.json`

---

## 2026-09-23 · Claude — 유튜브 실영상 10개 측정 결과 + jev-collect 정답 기록 방식 수정

### 결과 (keep 상위 10개 → ballspeed)
- 클립 81개로 분할, **검증 통과 3개(4%)**. 영상 하나가 5~20 클립으로 잘림 — 리플레이·카메라 전환·줌을 킥으로 봄
- 통과한 3개도 신뢰 어려움: Ronny 영상 115.8 km/h(제목 주장 200 km/h대의 절반), "221 km/h" 영상 61.1.
  방송 영상은 공이 카메라 쪽/반대쪽으로 날아가고 줌·팬이 있어 **공 크기 스케일 + 중력 검산이 통과해도 틀릴 수 있음**
- 결론: 유튜브 방송·하이라이트 영상은 폰 측면 촬영용 앱의 정답/보정 데이터로 **부적합**. Jev 필터는 제대로 작동했고, 문제는 소스 자체

### 수정 (`scripts/jev-collect.mjs`)
- 이전 실행이 제목 구속을 영상의 **모든 클립(31개)**에 정답으로 붙였음 → 잘못. 원장 오염
- 기본값을 "원장에 넣지 않음"으로 변경, 실행 시 이전 title-claim 정답 자동 삭제
- `--truth-from-title` 로 켜도 검증 통과 클립이 정확히 1개인 영상에만 붙임
- 이번 원장은 통과 클립과 정답이 겹친 게 없어 보정 계수에는 영향 없었음

---

## 2026-09-23 · Claude — Jev 선별 → ballspeed 측정 연결 (`scripts/jev-collect.mjs`)

- `jev-filter-out*/results.json`의 keep 영상(우선순위 순, 기본 상위 10) → yt-dlp(ballspeed와 같은 60fps 우선 포맷,
  `<videos>/<id>.mp4`, 이미 받은 건 건너뜀) → `~/ballspeed/out/ballspeed.mjs`로 선별·분할·측정·원장
- 제목 구속(30~215 km/h)을 ballspeed `--truth`로 원장에 기록, `truthSource: "title-claim"` 으로 표시(미검증 주장)
- 비교 보고 `collect-report.txt`: 영상별 킥 수, 측정값, 제목 대비 오차, 중앙 절대오차
- 기본 경로: 영상 `~/shooting-videos`, ballspeed `~/ballspeed/out/ballspeed.mjs`. ballspeed 코드는 수정 안 함
- 검증: 합성 영상 2개(95/70 km/h) → 100.8(+6.1%)/70.2, 파일 없는 영상은 "다운로드 실패"로 보고. 순수 로직 테스트 추가
- 영향: `scripts/jev-collect.mjs`, `scripts/test-jev-collect.mjs`, `package.json`(jev:collect, test:jev)
- 후속: Mac에서 실제 유튜브 영상으로 실행(yt-dlp·ffmpeg 필요)

---

## 2026-09-22 · Claude — Jev 필터 2차 실측 (코드 변경 없음)

- 영문 "free kick speed km/h" 20개: 질문 수정 후 **전부 keep**. 과장 제목 영상의 real_footage 0.28→0.52, 0.41→0.63 로 회복
- 국문 "프리킥" 30개: keep 19 / review 1 / reject 10. 강의·원리 설명 8개를 0.9 이상 확률로 reject,
  경기 하이라이트 1개 reject, 20분 초과 1개 규칙 reject. 눈으로 본 오분류 없음
- 경계: 10~14분짜리 "프리킥 대결" 브이로그가 shot_compilation 으로 keep(우선순위 0.28~0.32로 하위)
- 현재 임계값 유지. 후속: keep 영상을 받아 자동 선별·측정 파이프라인에 넣어 실제 킥 검출률 확인

---

## 2026-09-22 · Claude — Jev 필터 1차 실측 반영

실측(검색 "free kick speed km/h", 20개): keep 16 / review 3 / reject 1, 2.3s, 약 $0.0007.
- 문제: `real_footage`가 **과장된 속도 주장(230·266 km/h)을 보고 실제 영상도 가짜로 의심**
  (0.41~0.53, Hami Mandirali 실제 영상이 game으로 reject). → 질문에 "매체만 판단, 속도 주장 신빙성은 판단 말 것" 명시
- 제목 구속은 코드로 파싱(`parseTitleSpeed`: km/h·kph·kp/h·/H·mph) 후 215km/h 초과 → 비현실(?!) 표시.
  그럴듯한 keep 영상만 `reference-candidates.csv`(url, km/h, 제목) 로 출력 → 정답 레퍼런스 후보
- 중복 영상 제거(`dedupe`), priority 0~1 정규화
- 영향: `scripts/jev-filter.mjs`, `scripts/test-jev-filter.mjs`
- 후속: 재실행으로 real_footage 개선 확인. 제목 구속은 업로더 주장일 뿐 → 레퍼런스 투입 전 영상 속 표시와 대조 필요

---

## 2026-09-22 · Claude — Jev 수집 전 필터 스크립트 추가 (`scripts/jev-filter.mjs`)

### 무엇
유튜브 후보 영상을 **다운로드 전에** 제목·채널·길이·설명만 보고 TypeSafe Jev로 선별. 의존성 0 (HTTP API 직접 호출).
- 입력: `--search "검색어" --limit N`(yt-dlp 필요) / `--input 파일|-`(yt-dlp -J, JSON 배열, JSONL)
- 출력(`jev-filter-out/`): `results.json`(원시 확률 보존), `keep.txt`(→ `yt-dlp -a`), `review.txt`

### 판단 구조 (요청 1회에 질문 3개)
- `content`(choice): single_shot_clip / shot_compilation / match_highlights / tutorial_or_talk / not_football_kicks
- `real_footage`(noul): 실제 촬영 vs 게임(FIFA/EA FC)·애니메이션
- `speed_shown`(noul): 구속 표시 여부 → 정답 있는 레퍼런스 후보 우선순위
- 정책은 코드(`POLICY`): 20분 초과·제목 없음은 API 호출 없이 reject / 실제촬영 <0.3 reject /
  슛확률 ≥0.6 & 실제촬영 ≥0.5 keep / 슛확률 ≥0.3 review. **임계값은 실데이터로 아직 미검증.**
- 키 없으면 규칙만 적용하고 전부 keep. 401은 전체 중단, 429/5xx 지수 백오프, 기타 오류는 review.

### 영향 파일
`scripts/jev-filter.mjs`, `scripts/test-jev-filter.mjs`, `package.json`(jev:filter, test:jev), `.gitignore`

### 후속
- 실제 API 호출 테스트 미실시(작업 환경 네트워크 차단). Mac에서 `npm run jev:filter -- --search "free kick speed" --limit 20` 로 확인 필요
- 결과 20~50개를 사람이 라벨링해 임계값 조정

---

## 2026-09-22 · Codex — TypeSafe 스킬 설치

- 변경: 요청한 `npx skills add typesafe-ai/skills --skill typesafe-ai` 실행 완료. 프로젝트 범위에 `typesafe-ai` 스킬 설치.
- 영향 파일: `.agents/skills/typesafe-ai/SKILL.md`, `.agents/skills/typesafe-ai/LICENSE`, `skills-lock.json`, `WORKLOG.md`
- 검증: 설치 명령 종료 코드 0, 스킬 파일 및 잠금 파일 생성 확인.
- 후속: 다음 대화 턴부터 스킬 사용 가능. API 키 설정은 별도 작업.

---

## 2026-09-22 · Claude — AGENTS.md에 TypeSafe(Jev) 스킬 규칙 추가

- 변경: `AGENTS.md`에 "TypeSafe / Jev" 섹션 추가 (스킬 사용, 적용 범위, `TYPESAFE_API_KEY` 규칙)
- 영향 파일: `AGENTS.md`
- 후속: Codex 쪽 `typesafe-ai` 스킬 설치, `.env.local`에 `TYPESAFE_API_KEY` 추가(사용자)

---

## 2026-08-11 · Claude — 공 지름을 고정 크기 스케일 기준으로 추가 (키 없이 구속 산출)

### 배경
전날 작업으로 '키 미상'을 정직하게 기록하게 됐지만, 여전히 **유일한 자(ruler)는 키커의
nose-to-ankle 픽셀 span**이었다. 즉 키를 모르면 스케일 자체가 추정이었다.
공은 규격으로 크기가 고정(5호 지름 22cm)돼 있고 **이미 bbox로 검출 중**이므로,
추가 모델 없이 두 번째 기준으로 쓸 수 있다.

### 신규 `lib/analysis/scale-reference.ts`
- `BALL_SPECS`: 5호 22 / 4호 20.5 / 3호 18.5 / 풋살4호 20cm. (FIFA는 둘레 규정 → 지름 환산)
- `estimateBodyScale(spanPx, heightM, provided)` → px/m + 불확실도(0.12, 키 미상이면 +0.06)
- `estimateBallScale({diameterPx, diameterCm, sampleCount, relativeSpread})` → px/m + 불확실도
  = √(박스 여유 0.08² + 양자화 (2/D)² + 산포/√n)
- `fuseScales(body, ball)` → **역분산 가중평균**. 키를 모르면 몸 쪽 가중치가 자동으로 떨어지고
  공이 추정을 이끈다. 두 기준이 25% 넘게 어긋나면 밴드를 gap/2 이상으로 넓힌다.
- `isBallSizePlausible(diameterPx, spanPx)`: **비율 게이트 0.09~0.27.**
  사람 키 120~200cm 어디든 공/span 비는 0.125~0.21이므로, 이 범위를 벗어난 공은
  오검출이거나 전혀 다른 거리에 있는 것 → 기준에서 제외.
  **가정한 키가 아니라 화면상 span으로 검증**하는 게 핵심 — 틀린 키 가정이야말로 이 게이트가
  견뎌야 할 실패 모드이기 때문.

### 트래커 (`kick-tracker.ts`)
- **임팩트 이전, 정지 상태**의 공 bbox에서만 지름 표본 수집(최대 60개).
  비행 중에는 모션블러로 박스가 늘어나고 카메라에서 멀어져 크기가 변하므로 무의미.
- 필터: 종횡비 1.35 초과 제외, 직전 프레임 대비 지름의 0.6배 넘게 움직였으면 제외,
  motion 기반 박스 제외. 컷 발생 시(임팩트 전) 표본 초기화.
- `TrackingOutcome.ballScale = {diameterPx(중앙값), sampleCount, relativeSpread(IQR/중앙값)}`

### 파이프라인 (`run-analysis.ts`, `confidence.ts`, `types.ts`)
- 속도 = `pxPerSecond / 융합 px/m`. `pixelSpeedToKmh`(몸 전용)는 더 이상 이 경로에서 안 씀.
- `confidence.ts`가 하드코딩된 scale 항 대신 **실제 `scaleUncertainty`**를 받는다.
  공 기준이 튼튼하면 "키를 입력하세요" 안내도 뜨지 않는다.
- **포즈 검출 실패해도 구속 산출 가능해짐.** 기존 `kickerHeightPx <= 0` 즉시 실패 조건 제거,
  궤적 outlier tolerance도 포즈 없으면 공 지름×8로 환산.
- `PipelineResult.scale: ScaleReport{pixelsPerMeter, relativeUncertainty, source, ballDiameterCm,
  ballSampleCount, disagreement}`, `ballDiameterPx` 추가.
- 옵션: `ballSizeId`, `useBallScale`(A/B용 킬스위치).

### 검산 (1080p, span 600px, 실제 100km/h 기준)
| 시나리오 | 몸만 | 최종 | 밴드 |
|---|---|---|---|
| 키 정확 + 공 정상 | 100.0 | 100.0 | ±7% (기존 ±12%) |
| 키 미상, 실제 190cm | 92.1 | **98.4** | ±8% |
| 키 미상, 실제 160cm | 109.4 | **101.6** | ±8% |
| 키 미상, 실제 120cm 아동 | 145.8 | **105.9** | ±23% |
| 키 정확 + 공 2배 오검출 | 100.0 | 100.0 (공 제외) | ±12% |
| 키 미상 + 공이 먼 거리(30px) | 100.0 | 100.0 (공 제외) | ±18% |

키 미상 샘플의 측정 불확실도 하한이 **±23% → ±17%**로 내려가, 어제 언급한
`MAX_SAMPLE_UNCERTAINTY=0.3` 게이트에 여유가 크게 생겼다.

### 스키마 (마이그레이션 필요)
`prisma/migrations/20260811090000_add_reference_scale_source/migration.sql`
- `ReferenceVideo`에 `scaleSource`, `scaleUncertainty`, `ballDiameterPx`, `ballDiameterCm` 추가.
- 전부 nullable. 기존 행 NULL = "스케일 미기록(신체 기준)".

### UI
- 레퍼런스 배치 페이지 / `/analyze` 양쪽에 **공 규격 선택** 추가(기본 5호).
- 배치 표와 저장된 레퍼런스 표에 `스케일` 컬럼(신체 / 공 / 신체+공, 툴팁에 밴드·표본수).

### 후속 필요사항
- **로컬에서 `npx prisma migrate deploy` + `npx prisma generate` 실행 필요.**
  샌드박스는 Prisma 엔진/SWC 바이너리를 받을 수 없어 `tsc`·`eslint`까지만 검증했다.
  `create()`에 넘기는 객체는 변수라 초과 프로퍼티 검사가 안 걸리므로, generate 전에는
  타입체크가 통과해도 런타임에 `Unknown arg` 로 실패한다.
- 유스/풋살 클립을 섞어 저장할 거면 배치 단위로 공 규격을 나눠 돌려야 한다(현재 전체 공통 1개 값).
- 골대·페널티 마크 자동 검출은 이번에도 제외. 필요하면 선 검출(Hough) 도입 검토.

---

## 2026-08-10 · Claude — 레퍼런스 DB: 키커 키를 몰라도 작업 가능하도록 변경

### 배경
레퍼런스 클립은 대부분 타인의 영상이라 **키커의 키를 알 수 없다.** 그런데 기존 페이지는
전체 공통 키 입력이 `"175"`로 하드코딩 프리필되어 있어, `playerHeightProvided: true`가
**항상** 전달됐다. 즉 모르는 키를 아는 것처럼 저장했고, 그 결과 측정 불확실도가 실제보다
6%p 낮게 기록되어 보정 게이트를 부당하게 통과할 수 있었다.

### 변경 (`app/admin/references/page.tsx` 단독 · 스키마/API 변경 없음)
1. **‘미상’이 1급 상태**가 됨. 상단 입력은 `기본 키 (cm, 모르면 비움)`으로 바뀌고 기본값은 **빈 문자열**.
2. **행별 키 입력 추가.** 배치 표에 `키 cm` 컬럼 신설. 비우면 상단 기본값을 따르고, 둘 다 비면 미상.
   - `ClipRow.playerHeightInput: string` (raw 문자열로 보관 — 입력 중 값이 지워지지 않게)
   - `resolveHeightCm(row) = parseHeightCm(row.playerHeightInput) ?? fallbackHeightCm`
   - `parseHeightCm`는 120~220cm 범위 밖/공백을 전부 `null`로 접는다.
3. **정답표의 `키cm` 컬럼이 실제로 적용된다.** 기존엔 `parseAnswerSheet`가 파싱만 하고 버렸음.
4. **분석**: `playerHeightProvided`가 이제 진짜 입력 여부를 반영. 미상이면 파이프라인 기본값
   175cm로 계산하되 `confidence.ts`의 `SCALE_HEIGHT_GUESS_UNCERTAINTY(+0.06)`가 적용된다.
5. **저장**: `playerHeightCm: null` 그대로 POST(스키마가 이미 nullable). notes에 `height unknown` 기록.
6. **표시**: 저장된 레퍼런스 표에 `키` 컬럼 추가 — null이면 `미상` 배지.

### 보정 계수에 미치는 영향
키 미상 샘플은 **제외되지 않고 불확실도만 넓어진 채 포함**된다(사용자 선택).
불확실도 하한이 ±19% → ±23%로 오르지만 `MAX_SAMPLE_UNCERTAINTY = 0.3` 게이트는 통과하므로,
키를 몰라도 레퍼런스 축적은 계속 가능하다. 다만 `REQUIRED_FACTOR_UNCERTAINTY = 0.08`에
도달하려면 키 미상 클립은 더 많이 필요하다.

### 후속 필요사항
- **기존 DB 행은 신뢰도가 과대평가되어 있다.** 8/10 이전에 저장된 행은 키를 모르면서도
  `playerHeightProvided: true`로 계산됐으므로, 정밀하게 하려면 재분석 후 덮어쓰기 권장.
- 근본 해결책은 키 대신 **공 지름(≈22cm)이나 골대/페널티 마크 같은 고정 크기 기준**으로
  스케일을 잡는 것. 파이프라인 변경이라 이번 범위에서는 제외했다.

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
