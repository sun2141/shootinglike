# 페이지 주소

배포 주소: https://shooting-like.vercel.app — 모든 화면은 휴대폰(가로 390px 기준)에서 쓰도록 맞춰 둠.
관리자 화면 안의 '페이지 주소' 목록(`app/admin/page.tsx` 의 `PAGES`)과 같이 고친다.

## 사용자
| 주소 | 화면 | 비고 |
|---|---|---|
| `/` | 홈 | 측정 시작·리더보드 |
| `/analyze` | 구속 측정 (옆에서 찍은 영상) | 서버 분석 `/api/analyze` |
| `/analyze/freekick` | 프리킥 측정 (대각선 뒤, 베타) | 분석은 전부 휴대폰 안에서 (서버 비용 없음) |
| `/leaderboard` | 구속 순위 | 60초 캐시 |

## 관리자 (링크 없음 · 저장·삭제는 `ADMIN_REFERENCE_TOKEN` 필요)
| 주소 | 화면 | 비고 |
|---|---|---|
| `/admin` | 관리자 입구 | 페이지 주소 목록 포함 |
| `/admin/refauto` | 프리킥 레퍼런스 자동 작업 | Mac 워커(`scripts/refauto`) 결과 확인·확정·제외·수정(골대·공·키커 클릭) |
| `/admin/references` | 레퍼런스 정답표 | 속도를 아는 클립 일괄 업로드·비교 (PC 권장: 브라우저 ffmpeg) |
| `/admin/records` | 기록 관리 | 리더보드 기록 삭제 |

## Mac 에서만 (로컬)
| 주소 / 명령 | 내용 |
|---|---|
| `npm run ref:auto -- <영상 폴더> --review` → http://localhost:8765 | refauto 로컬 확인 페이지 |
| `npm run ref:eject` / `scripts/refauto/USB 안전하게 빼기.command` | 분석을 멈추고 영상 USB 꺼내기 |

## API (참고)
`/api/analyze` · `/api/leaderboard` · `/api/reference-calibration` · `/api/dataset/upload`(기본 꺼짐) ·
`/api/admin/references[/id]` · `/api/admin/records` · `/api/admin/refauto` (`/sync` `/images` `/image/[id]` `/edits` `/register`)
