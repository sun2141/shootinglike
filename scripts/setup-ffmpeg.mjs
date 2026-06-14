// @ffmpeg/ffmpeg 의 self-contained UMD 워커 번들을 public/ffmpeg/worker.js 로 복사한다.
//
// 이유: Next(webpack) 환경에서 `new Worker(new URL('./worker.js', import.meta.url))`
// 로 번들된 워커는 내부 `import(coreURL)` 가 webpack 에 의해 재작성되어, 런타임에
// blob 코어를 "Cannot find module 'blob:...'" 로 못 찾는다. webpack 을 거치지 않는
// UMD 워커 번들을 동일 출처에서 받아 `classWorkerURL` 로 넘기면 워커의 import 가
// 네이티브로 동작해 코어 blob 을 정상 로드한다.
//
// 워커 번들 파일명(예: 814.ffmpeg.js)은 버전마다 바뀔 수 있으므로 dist/umd 에서
// 자동 탐색해 고정 경로(public/ffmpeg/worker.js)로 복사한다. 실패해도 빌드를 막지
// 않도록 항상 정상 종료한다(저장소에 커밋된 사본을 그대로 사용).

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const umdDir = join(root, "node_modules", "@ffmpeg", "ffmpeg", "dist", "umd");
  const workerFile = readdirSync(umdDir).find(
    (name) => /\.ffmpeg\.js$/.test(name) && name !== "ffmpeg.js"
  );

  if (!workerFile) {
    console.warn("[setup-ffmpeg] worker bundle not found in dist/umd; keeping existing public/ffmpeg/worker.js");
  } else {
    const outDir = join(root, "public", "ffmpeg");
    mkdirSync(outDir, { recursive: true });
    copyFileSync(join(umdDir, workerFile), join(outDir, "worker.js"));
    console.log(`[setup-ffmpeg] copied ${workerFile} -> public/ffmpeg/worker.js`);
  }
} catch (error) {
  console.warn("[setup-ffmpeg] skipped:", error?.message ?? error);
}
