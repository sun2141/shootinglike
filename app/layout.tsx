import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * 글꼴: 본문·한글은 Pretendard (CDN 의 동적 서브셋 — 화면에 쓰인 글자 조각만 받아 휴대폰 데이터가 적다),
 * 숫자·코드 표시는 JetBrains Mono, 홈 영문 제목은 Anton (app/page.tsx).
 */
const PRETENDARD = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Freekick Master",
  description: "AI-powered freekick analysis app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href={PRETENDARD} crossOrigin="anonymous" />
      </head>
      <body className={`${jetbrainsMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
