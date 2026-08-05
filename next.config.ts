import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // NOTE: COOP/COEP 헤더는 설정하지 않는다. cross-origin isolation이 켜지면 MediaPipe WASM/
  // 모델을 CDN에서 받아오는 요청과 service worker가 서빙하는 워커 청크 로딩이 막힌다.
};

export default withSerwist(nextConfig);
