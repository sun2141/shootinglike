<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 협업 로그
- 최신 변경 내역은 `WORKLOG.md` 를 먼저 확인하세요. **작업을 마칠 때마다 `WORKLOG.md` 맨 위에 새 항목을 추가**해 Claude·Codex 양쪽이 동기화합니다.
- `.env`, `.env.local` 내용은 노출 금지.

## Imported Claude Cowork project instructions

코덱스와 같이 작업하는 프로젝트야. 코덱스에서 파일을 변경할 수도 있어.

## TypeSafe / Jev
- Jev(TypeSafe System One) 관련 작업은 `typesafe-ai` 스킬을 따른다. (Codex: `npx skills add typesafe-ai/skills --skill typesafe-ai`)
- Jev는 텍스트 전용 판단 모델이다. 공 검출·궤적·구속 계산 등 영상/수치 처리에는 쓰지 않고, 수집 전 영상 메타데이터 선별 같은 의미 판단에만 쓴다.
- API 키는 `.env.local`의 `TYPESAFE_API_KEY`에서만 읽고 서버 측에만 둔다. 키가 없으면 Jev 없이 기존 동작을 유지한다.
