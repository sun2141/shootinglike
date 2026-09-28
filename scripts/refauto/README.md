# refauto — 프리킥 레퍼런스 자동 작업

영상 폴더에 영상을 넣고 명령 한 줄을 치면, 새 영상만 골라 **프리킥인지 판별 → 카메라 보정 → 공 추적 → 3D 궤적 맞춤**까지 하고
결과를 폴더 안 `_refauto/` 에 쌓는다. 자신 없는 킥은 확인 페이지에서 몇 번 클릭해 바로잡는다.

## 준비 (한 번)
```bash
pip3 install -r scripts/refauto/requirements.txt      # numpy, scipy, opencv
```
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
- 겹쳐 실행 방지: `_refauto/.cloud.lock` (3시간 지나면 자동 해제)

## DB 업로드
`/api/admin/references` 에 `isActive=false` 로 올린다 — 앱 측정값이 아직 없어서 보정 계수 계산에는 섞이지 않고 목록에만 보인다.
토큰은 `ADMIN_REFERENCE_TOKEN` 환경변수 또는 저장소 `.env.local` 에서 읽는다. 같은 킥은 한 번만 올라간다(원장에 id 기록).
수동 분석값이 있는 킥은 자동값 대신 수동값을 올린다.

## 구성
`refauto.py`(명령·원장) · `pipeline.py`(영상 1개 처리·판정) · `scan.py`(킥 찾기) · `detect.py`(멈춘 공·골대·더미·흰 선) ·
`calib.py`(카메라 보정) · `track.py`(원본 해상도 공 추적·흔들림 보정) · `physics.py`(중력+항력+회전 궤적 맞춤) ·
`review.py`(확인 페이지) · `upload.py`(DB 업로드) · `manual_refs.json`(수동 분석 레퍼런스)

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
