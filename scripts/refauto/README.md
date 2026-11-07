# refauto — 프리킥 레퍼런스 자동 작업

영상 폴더에 영상을 넣고 명령 한 줄을 치면, 새 영상만 골라 **프리킥인지 판별 → 카메라 보정 → 공 추적 → 3D 궤적 맞춤**까지 하고
결과를 폴더 안 `_refauto/` 에 쌓는다. 자신 없는 킥은 확인 페이지에서 몇 번 클릭해 바로잡는다.

## 준비 (한 번)
전용 가상환경을 쓴다 (conda base 등에 섞어 깔면 scipy 가 `liblapack.3.dylib` 를 못 찾는 식으로 깨질 수 있다).
```bash
/usr/bin/python3 -m venv scripts/refauto/.venv
scripts/refauto/.venv/bin/pip install -U pip
scripts/refauto/.venv/bin/pip install -r scripts/refauto/requirements.txt
```
**OpenCV 판은 `requirements.txt` 에 고정(5.0.0.93)** — 판마다 영상 디코더가 달라 프레임이 조금씩 다르고, 그 차이로 골대·멈춘 공 검출이 바뀐다
(4.12 에서는 08·09 가 확정에서 떨어짐). `install_launchd.sh` 가 가상환경 패키지를 이 판에 맞추고, 판이 바뀌면 워커가 전부 다시 계산한다
(원장의 `pipeline` 값에 OpenCV 판이 들어감). 관리자 화면은 판이 다르면 경고를 띄운다.
이후 실행은 `scripts/refauto/.venv/bin/python3 scripts/refauto/refauto.py ...`. `install_launchd.sh` 는 이 가상환경이 있으면 자동으로 쓴다
(다른 python 을 쓰려면 `REFAUTO_PYTHON=/경로/python3`).
ffmpeg(ffprobe)가 있으면 fps·회전 정보를 더 정확히 읽는다 (없어도 동작).

## 쓰는 법
```bash
npm run ref:auto -- /Volumes/64B/freekick              # 새 영상만 처리
npm run ref:auto -- /Volumes/64B/freekick --review     # 확인 페이지 (http://localhost:8765)
npm run ref:auto -- /Volumes/64B/freekick --upload --dry-run   # 앱 DB 에 올릴 내용 미리보기
npm run ref:auto -- /Volumes/64B/freekick --upload     # 확정분을 /admin/references 로 업로드
npm run ref:auto -- /Volumes/64B/freekick --all        # 전부 다시 계산
```
같은 영상이 이름만 바뀌어 들어와도(예: 05·10) 한 번만 처리한다.

## 영상 폴더 정리 (자동)
새 영상은 영상 폴더 **맨 위**에 넣는다. 분석이 끝나면 워커가 판정에 맞는 하위 폴더로 옮긴다 (옆의 같은 이름 `.json` 도 함께).
판정이 바뀌면(관리자 화면에서 확정·제외·수정) 다음 실행 때 다시 옮긴다. 폴더 안 `_안내.txt` 에 같은 설명이 있다.
```
<영상 폴더>/          ← 새 영상 넣는 곳
  1_확정/ 2_추정/ 3_확인필요/ 4_측정불가/ 5_프리킥아님/ 6_제외/ 7_오류/ 8_중복/
  _refauto/           ← 결과 (지우거나 옮기지 말 것)
```
- 킥이 여럿이면 가장 좋은 판정으로 분류. 이름만 다른 같은 영상은 `8_중복/`
- 원장은 영상마다 폴더 안 경로(`path`)를 기억한다. 손으로 다른 하위 폴더로 옮겨도 이름으로 다시 찾는다
- 옮기기는 같은 USB 안의 이름 바꾸기라 도중에 USB 가 빠져도 파일이 깨지지 않는다

## USB 안전하게 빼기
`scripts/refauto/USB 안전하게 빼기.command` 를 Finder 에서 두 번 클릭 (`install_launchd.sh` 가 바탕화면에 바로가기를 만든다)
또는 `npm run ref:eject`.
1. 분석 워커에 일시정지를 건다 (`~/.refauto/pause`) — 지금 영상까지만 마치고 멈추며, 올리기도 미룬다
2. USB 를 읽는 분석이 끝날 때까지 기다린 뒤 `diskutil eject`
3. 꺼낸 뒤 일시정지를 푼다 → USB 를 다시 꽂으면 워커가 알아서 이어 간다
- USB 이름이 바뀌어 붙어도(예: `64B 1`) `/Volumes/*/freekick/_refauto/ledger.json` 으로 같은 폴더를 찾는다
- 실행 중에 USB 가 그냥 빠져 잠금(`_refauto/.cloud.lock`)이 남아도, 그 프로세스가 없으면 바로 넘겨받는다
- 매 실행 끝에 작은 파일(원장·장면·수정 `.json`)을 Mac 의 `~/.refauto/backup/<폴더 이름>/` 에 복사해 둔다 (USB 분실 대비)
- 수정 요청 반영 중에 멈추면 요청은 '대기'로 남아 다음 실행에서 다시 반영된다

## 결과 (`<폴더>/_refauto/`)
| 파일 | 내용 |
|---|---|
| `ledger.json` | 전체 원장 — 영상별·킥별 보정값, 추적점, 궤적, 판정 이유 |
| `references.csv` | 사람이 보는 표 (엑셀로 열림). 수동 분석 레퍼런스(04·05·08·09·11 등)도 함께 |
| `overlays/*.jpg` | 표준 경기장 선(분홍)·추적점(초록)·궤적(주황)을 겹친 확인 이미지 |
| `frames/*.jpg` | 보정에 쓴 기준 장면 |
| `scenes.json` | 사람이 확정한 카메라(삼각대) — 같은 자리에서 찍은 다음 영상은 자동 재사용 |

## 판정
| 판정 | 뜻 |
|---|---|
| 확정 (A) | 골대·선·더미·사람 키가 서로 맞고, 1초 가까운 자유 비행 구간을 1~2px 로 맞춤 |
| 추정 (B) | 계산은 됐지만 사람 키 기준이 없음 — 경기장 선만 쓰면 초점거리가 몇 % 작게 잡히는 경향이 있어 속도가 5~10% 낮게 나올 수 있다 |
| 확인 필요 | 골대·공·추적 중 하나가 의심스러움. 이유가 함께 적힌다 |
| 측정 불가 | 골대가 안 보이거나 온전하지 않음 |
| 프리킥 아님 | 멈춘 공이 차여 날아가는 장면이 없음 |

## 영상별 정보 (선택)
기본값은 더미 160cm(받침 포함) · 성인 골대 · 5호 공 · 성인 규격 경기장 선. 다르면 영상 옆에 같은 이름의 `.json` 을 둔다
(확인 페이지에서 입력하면 자동으로 만들어진다).
```json
{"kicker_cm": 182, "goal": "youth", "ball": 4, "dummy_cm": 160, "pitch": "none"}
```
`goal`: adult(7.32×2.44) · youth(5×2) · futsal(3×2), `pitch`: adult(페널티 박스 선·아크 사용) · none

## 확인 페이지에서 하는 일
- **키커: 발 → 머리** — 가장 효과가 크다. 슬라이더로 키커가 곧게 선 장면을 골라 두 번 클릭하고 키를 입력.
  한 번 해 두면 같은 삼각대로 찍은 다른 영상은 자동 확정된다
- **골대 4모서리 / 멈춘 공** — 자동 검출이 틀렸을 때 (파이프 중심을 찍는다)
- **이 값으로 확정 / 제외** — 사람 판단으로 결정. 다시 계산해도 유지된다

## 외부에서 확인·수정 (관리자 화면 + Mac 자동 실행)

Mac 이 분석해 결과·확인 이미지를 앱 DB 로 올리고, https://shooting-like.vercel.app/admin/refauto 에서 어디서든 본다.

```
python3 scripts/refauto/refauto.py /Volumes/64B/freekick --cloud       # 한 번 돌기
bash scripts/refauto/install_launchd.sh /Volumes/64B/freekick         # 5분마다 + 폴더 변경 시 자동
bash scripts/refauto/install_launchd.sh --uninstall                   # 끄기
```
- 필요: `.env.local` 과 Vercel 환경변수에 같은 `ADMIN_REFERENCE_TOKEN`. 기록은 `~/Library/Logs/refauto.log`
- macOS 가 python3 의 외장 볼륨 접근을 물으면 허용 (안 되면 전체 디스크 접근 권한에 python3 추가)
- `--cloud` 한 번: ① 화면에서 남긴 수정 요청을 가져와 영상 옆 `.json` 에 반영 → ② 수정된 영상 재계산, 새 영상 계산
  → ③ 바뀐 영상만 결과·이미지 업로드(1280px JPEG, sha1 로 중복 제거) → ④ 요청 완료 표시, 워커 상태 기록
- 관리자 화면: 판정별 탭, 확정/제외(즉시 반영), 수정(후보 프레임에서 키커 발·머리, 골대 4점, 멈춘 공 클릭 + 키커 키 등 입력
  → 'Mac 반영 대기' → 다음 실행 때 재계산), A·수동 확정은 '정답표 등록'(ReferenceVideo, isActive=false)
- Mac 이 꺼져 있어도 보기·확정·제외·수정 요청은 된다. 재계산만 Mac 이 켜질 때
- DB: RefautoVideo / RefautoKick / RefautoImage(BYTEA) / RefautoEdit / RefautoState (마이그레이션 20260928000000_add_refauto)
- 겹쳐 실행 방지: `_refauto/.cloud.lock` (잡고 있던 프로세스가 없으면 바로 해제)

## 유튜브 레퍼런스 수집 (`collect.py`) — 정답을 아는 킥 영상 모으기

목적: **우리 측정이 진짜 속도와 얼마나 다른지** 확인할 정답 데이터를 모은다. 정답은 두 가지다.
- **레이더 숫자**: 영상 속 레이더 건·레이더 부스 숫자. 킥 하나당 ±6% 흔들리지만 평균 치우침은 작아서, 여럿의 평균으로 우리 치우침을 잰다
  (Loughborough 대학 비교 연구: 레이더 0.4 m/s 치우침 · ±1.5 m/s, 스마트볼 4.8 m/s · ±6 m/s)
- **페널티킥**: 페널티 지점~골라인 11 m 가 규격이라, 우리가 계산한 킥 거리가 11 m 와 얼마나 다른지가 곧 거리 축척(→ 속도) 오차
- 스마트볼·앱 숫자는 정답으로 쓰지 않는다(20% 넘게 틀릴 수 있음) → 받지 않는다 (페널티킥이면 예외)

```
python3 scripts/refauto/refauto.py /Volumes/64B/freekick --collect             # 한 번 돌기
python3 scripts/refauto/refauto.py /Volumes/64B/freekick --collect --dry-run   # 받지 않고 판단만
```
- 자동 실행: `install_launchd.sh` 가 6시간마다 실행 (`com.shootinglike.refcollect`, 기록 `~/Library/Logs/refcollect.log`). 수집만 빼려면 `REFCOLLECT=0 bash …`
- 한 번에: 검색어 4개(관련도순·최신순 번갈아) × 30개 → 이미 본 영상 제외 → 제목·설명을 Jev 로 판단
  (`content` 영상 종류 · `real_footage` · `device` 레이더/스마트볼·앱/추적 장비 · `penalty` · `full_goal`) → 통과한 것을 우선순위대로 하루 12개까지 받기
  → `~/.refauto/collect/inbox/yt_<id>.mp4` → USB 영상 폴더가 있으면 맨 위로 옮김 → refauto 가 분석·정리
- 판단 기준(`POLICY`, 실데이터로 아직 미조정): 실제 촬영 ≥ 0.5 · 킥 장면 영상 ≥ 0.5 · (레이더 ≥ 0.4 또는 페널티킥 ≥ 0.6) → 받기.
  확률은 `state.json` 에 그대로 남기므로 기준을 바꿔도 다시 물어볼 필요가 없다
- 상태 `~/.refauto/collect/`: `state.json`(본 영상·판단·받은 수), `sources.json`(받은 영상 → 출처·Jev 판단, 관리자 화면에 함께 올라감)
- 필요: `.env.local` 의 `TYPESAFE_API_KEY`, 가상환경의 `yt-dlp[default]`(install_launchd.sh 가 실행할 때마다 최신으로), 유튜브용 JS 실행기(deno 또는 node — node 를 자동으로 찾음)
- USB 를 빼는 중이면 옮기기를 미루고, 옮기는 도중이면 `usb_eject.sh` 가 끝날 때까지 기다린다
- 유튜브가 '로봇 확인'으로 막으면 그 영상은 3번까지 다시 시도하고 넘어간다 (로그·대시보드에 오류 표시)

### 정답 입력 → 오차 통계
- `/admin/refauto` 의 '유튜브 수집' 탭 → 킥마다 **정답 입력**: 영상 속 숫자(km/h·mph), 측정 장비, 페널티킥 여부.
  유튜브 링크가 카드에 있어 숫자를 보며 넣는다. 입력은 바로 DB 에 들어가고(다시 계산 없음), Mac 은 `_refauto/truth.json` 에 백업한다
  (다시 계산해 킥 번호가 바뀌어도 킥 순간 0.4초 안이면 같은 킥으로 이어 붙음)
- `/admin` 의 '측정 정확도': 레이더 정답 대비 평균 치우침·오차 중앙값(전체 / 확정만), 페널티킥 거리 오차. 구도별 20개가 목표

## DB 업로드
`/api/admin/references` 에 `isActive=false` 로 올린다 — 앱 측정값이 아직 없어서 보정 계수 계산에는 섞이지 않고 목록에만 보인다.
토큰은 `ADMIN_REFERENCE_TOKEN` 환경변수 또는 저장소 `.env.local` 에서 읽는다. 같은 킥은 한 번만 올라간다(원장에 id 기록).
수동 분석값이 있는 킥은 자동값 대신 수동값을 올린다.

## 구성
`refauto.py`(명령·원장) · `pipeline.py`(영상 1개 처리·판정) · `scan.py`(킥 찾기) · `detect.py`(멈춘 공·골대·더미·흰 선) ·
`calib.py`(카메라 보정) · `track.py`(원본 해상도 공 추적·흔들림 보정) · `physics.py`(중력+항력+회전 궤적 맞춤) ·
`review.py`(확인 페이지) · `upload.py`(DB 업로드) · `collect.py`(유튜브 수집) · `library.py`(폴더 정리·USB 안전 분리·백업) · `usb_eject.sh` · `manual_refs.json`(수동 분석 레퍼런스)

## 검증 (2026-09-27, 11개 영상)
| 영상 | 자동 | 수동 분석 | 차이 |
|---|---|---|---|
| 08 | 82.7 확정 (키커 1회 클릭) | 83.0 | −0.4% |
| 11 | 80.9 확정 (08 장면 재사용) | 81.9 | −1.2% |
| 09 | 85.4 (08 장면 재사용) | 88.0 | −3.0% |
| 05 | 72.2 확정 (키커 1회 클릭) | 68.4 | +5.6% |
| 04 | 86.3 확정 (05 장면 재사용) | 80.9 | +6.7% |
| 03·06·07 | 측정 불가 (골대 검출 실패·손떨림) | 03 보류, 06·07 추정 | — |
| kwonde3 | 프리킥 아님 | — | — |
자동과 수동의 차이는 주로 **어느 비행 구간까지 쓰느냐**(항력·회전 추정이 달라짐)에서 온다. 현재 방법의 불확실성은 ±7% 로 본다.

## 한계
- 손으로 들고 패닝한 영상, 정면 구도, 골대 일부가 화면 밖인 영상은 자동으로 거의 안 된다 → 확인 페이지 또는 제외
- 키커 키 없이 경기장 선만으로 보정하면 속도가 5~10% 낮게 나오는 경향 (그래서 추정 판정)
- 한 영상에 킥이 여러 번이면 스캔 점수 상위 몇 개만 본다
