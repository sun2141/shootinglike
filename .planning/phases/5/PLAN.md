# Phase 5: Vercel 배포 및 Neon DB 연동

## 목적 (Objective)
완성된 프론트엔드/온디바이스 AI MVP 애플리케이션을 Vercel에 정적/동적으로 배포하고, Neon(Serverless Postgres) 데이터베이스와 연동하여 글로벌 리더보드 및 사용자 분석 기록 저장을 준비합니다.

## 개발자 작업 (Agent Tasks)
1. **Prisma 설정 보완**: `prisma/schema.prisma`의 `datasource db` 블록에 Vercel/Neon 환경 변수(`POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`) 연동 코드 추가.
2. **빌드 스크립트 수정**: Vercel 배포 시 Prisma Client가 생성되도록 `package.json`에 `postinstall` 스크립트 추가.
3. **API 라우트 점검**: `/api/leaderboard` 및 기타 엔드포인트 무결성 점검.

## 사용자 수동 작업 (User Manual Steps)
모든 코드 작업이 완료되면, 사용자는 다음 절차를 직접 진행하여 배포를 완료합니다.

### 1. GitHub에 소스코드 푸시
```bash
git add .
git commit -m "feat: Prepare Phase 5 Vercel and Neon DB"
git push origin main
```

### 2. Vercel 배포 설정
1. [Vercel](https://vercel.com)에 로그인 후 **[Add New Project]** 버튼 클릭.
2. GitHub 저장소(`shootinglike`) 연결(Import).
3. `Deploy` 버튼을 눌러 1차 배포 진행. (아직 DB가 없으므로 API 호출은 에러가 나거나 실패할 수 있으나, 빌드는 정상 통과됨)

### 3. Neon DB 연동 (Vercel 대시보드)
1. 배포가 완료된 Vercel 프로젝트 대시보드 진입.
2. 상단 메뉴 중 **[Storage]** 탭 클릭.
3. **[Create Database]** 클릭 후 **Postgres** 선택 (이때 내부적으로 Neon DB가 생성됨).
4. 생성이 완료되면 Vercel이 자동으로 `POSTGRES_PRISMA_URL` 등의 환경변수를 프로젝트에 주입함.

### 4. Prisma DB Push (스키마 반영)
로컬 터미널에서 아래 명령어로 Vercel의 환경변수를 가져와서 DB 테이블을 생성합니다:
```bash
# Vercel CLI로 로그인 및 프로젝트 연결
npx vercel login
npx vercel link

# Vercel 환경변수를 로컬 .env로 가져오기 (옵션)
npx vercel env pull .env.development.local

# 직접 로컬에서 DB Push 실행
npx dotenv -e .env.development.local -- npx prisma db push
```
*(또는 로컬 환경이 번거롭다면 Vercel 배포 명령어(`Build Command`)를 일시적으로 `prisma db push && next build`로 변경 후 재배포해도 무방합니다.)*
