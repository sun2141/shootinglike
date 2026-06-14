# Phase 1: 기반 설정 및 프론트엔드 환경 구성

## 목적 (Objective)
기본적인 Next.js 앱 뼈대에 오프라인/앱 구동을 위한 PWA 설정을 추가하고, 공통 UI 컴포넌트를 정의하며, 핵심 기능인 **영상 업로드**와 앱 진입 시 보이는 **촬영 가이드 화면**을 구현합니다.

## 작업 목록 (Tasks)

1. **PWA 플러그인 연동 및 서비스 워커 설정**
   - `@serwist/next` 패키지 설치 및 `next.config.ts` 설정
   - `public/manifest.json` 생성 (이름: Freekick Analysis 등)
   - 앱 아이콘 및 메타 태그 설정 (기본 로고 자리표시자 사용 가능)

2. **기본 UI 컴포넌트 환경 구성**
   - 현재 설치된 `clsx`, `tailwind-merge`를 활용하여 `lib/utils.ts` 유틸 함수 구성 (cn 등)
   - 주요 공통 컴포넌트(Button, Card 등) 스캐폴딩 생성
   - 전반적인 디자인 시스템의 기준 CSS Variable 설정 (`app/globals.css` 기반)

3. **촬영 가이드 화면(Guide View) 퍼블리싱**
   - `app/page.tsx` (메인 진입점) 수정
   - 앱 사용법 가이드: "5~10초 영상 업로드", "60fps 권장", "전신과 공이 보이게 촬영" 등
   - 촬영/업로드 버튼 노출 (Call to Action)

4. **로컬 비디오 선택 및 미리보기 구현**
   - 메인 화면의 버튼 클릭 시 모바일 브라우저의 카메라 호출 혹은 갤러리 영상 선택 지원 (`<input type="file" accept="video/*" capture="environment" />` 사용 가능)
   - 선택된 파일을 `URL.createObjectURL`로 변환하여 임시 URL 생성
   - `app/analyze/page.tsx` (또는 메인 내 상태 전환)에서 비디오 `<video>` 태그에 띄워 정상 재생되는지 확인하는 UI 구현

## 검증 방법 (Verification)
- `npm run dev` 실행 시 에러 없이 페이지가 로드되는가?
- Chrome DevTools > Application 탭에서 `manifest.json`과 Service Worker가 정상적으로 등록되었는지 확인 (`@serwist/next` 기준)
- 모바일 시뮬레이터 혹은 실기기에서 "홈 화면에 추가" 프로필이 뜨는지 확인
- 파일 첨부 버튼을 눌렀을 때 영상이 선택되며 화면에 렌더링(재생)되는지 확인
