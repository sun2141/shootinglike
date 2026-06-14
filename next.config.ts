import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // NOTE: 단일 스레드 @ffmpeg/core(/dist/esm)를 사용하므로 SharedArrayBuffer가 필요 없고,
  // 따라서 cross-origin isolation(COOP/COEP)도 불필요하다. 과거 추가된 COOP/COEP 헤더는
  // unpkg 코어 fetch와 service worker가 서빙하는 워커 청크 로딩을 막아 FFmpeg 초기화가
  // 멈추는 원인이 될 수 있어 제거했다. (레퍼런스 cut clip 로딩 타임아웃 대응)
};

export default withSerwist(nextConfig);
