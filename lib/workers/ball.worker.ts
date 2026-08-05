let previousMotionFrame: MotionFrame | null = null;
let motionCanvas: OffscreenCanvas | null = null;
let sourceMotionCanvas: OffscreenCanvas | null = null;

/**
 * Motion analysis width. Raised from 420px: at 420 a ball 11m away in a 1080p
 * clip collapsed to ~5px, right on the blob rejection threshold, so it competed
 * with sensor noise.
 */
const MOTION_ANALYSIS_WIDTH = 640;
const MOTION_DIFF_THRESHOLD = 22;
/** Above this fraction of changed pixels the frame is treated as an edit cut. */
const SCENE_CUT_CHANGED_RATIO = 0.45;
const REFERENCE_WIDTH = 420;

interface BallDetection {
  bbox: number[];
  class: string;
  score: number;
  source?: "motion";
}

interface MotionFrame {
  width: number;
  height: number;
  gray: Uint8Array;
}

interface MotionFrameData extends MotionFrame {
  scaleX: number;
  scaleY: number;
}

function closeImageSource(imageSource: ImageBitmap | ImageData | undefined) {
  if (imageSource && "close" in imageSource && typeof imageSource.close === "function") {
    imageSource.close();
  }
}

function getImageSourceSize(imageSource: ImageBitmap | ImageData) {
  return {
    width: imageSource.width,
    height: imageSource.height,
  };
}

function getMotionCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }

  if (!motionCanvas) {
    motionCanvas = new OffscreenCanvas(width, height);
  }

  if (motionCanvas.width !== width) motionCanvas.width = width;
  if (motionCanvas.height !== height) motionCanvas.height = height;
  return motionCanvas;
}

function getSourceMotionCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }

  if (!sourceMotionCanvas) {
    sourceMotionCanvas = new OffscreenCanvas(width, height);
  }

  if (sourceMotionCanvas.width !== width) sourceMotionCanvas.width = width;
  if (sourceMotionCanvas.height !== height) sourceMotionCanvas.height = height;
  return sourceMotionCanvas;
}

function toGray(data: Uint8ClampedArray, width: number, height: number) {
  const gray = new Uint8Array(width * height);

  for (let pixel = 0, source = 0; pixel < gray.length; pixel += 1, source += 4) {
    gray[pixel] = Math.round(
      data[source] * 0.299 +
      data[source + 1] * 0.587 +
      data[source + 2] * 0.114
    );
  }

  return gray;
}

function readMotionFrame(imageSource: ImageBitmap | ImageData): MotionFrameData | null {
  const sourceSize = getImageSourceSize(imageSource);
  if (sourceSize.width <= 0 || sourceSize.height <= 0) return null;

  const scale = sourceSize.width > MOTION_ANALYSIS_WIDTH ? MOTION_ANALYSIS_WIDTH / sourceSize.width : 1;
  const width = Math.max(1, Math.round(sourceSize.width * scale));
  const height = Math.max(1, Math.round(sourceSize.height * scale));

  if (imageSource instanceof ImageData && (typeof OffscreenCanvas === "undefined" || scale === 1)) {
    return {
      width: sourceSize.width,
      height: sourceSize.height,
      gray: toGray(imageSource.data, sourceSize.width, sourceSize.height),
      scaleX: 1,
      scaleY: 1,
    };
  }

  const canvas = getMotionCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, width, height);

  if (imageSource instanceof ImageData) {
    const sourceCanvas = getSourceMotionCanvas(sourceSize.width, sourceSize.height);
    if (!sourceCanvas) return null;
    const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceCtx) return null;

    sourceCtx.putImageData(imageSource, 0, 0);
    if (width !== sourceSize.width || height !== sourceSize.height) {
      ctx.drawImage(sourceCanvas, 0, 0, sourceSize.width, sourceSize.height, 0, 0, width, height);
    }
  } else {
    ctx.drawImage(imageSource, 0, 0, sourceSize.width, sourceSize.height, 0, 0, width, height);
  }

  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    width,
    height,
    gray: toGray(imageData.data, width, height),
    scaleX: sourceSize.width / width,
    scaleY: sourceSize.height / height,
  };
}

interface MotionResult {
  detections: BallDetection[];
  changedRatio: number;
  sceneChanged: boolean;
}

const EMPTY_MOTION_RESULT: MotionResult = { detections: [], changedRatio: 0, sceneChanged: false };

function detectMotionBalls(current: MotionFrameData): MotionResult {
  const previous = previousMotionFrame;
  previousMotionFrame = {
    width: current.width,
    height: current.height,
    gray: current.gray,
  };

  if (!previous || previous.width !== current.width || previous.height !== current.height) {
    // Dimension change means a brand new source: treat it as a cut.
    return { detections: [], changedRatio: 0, sceneChanged: Boolean(previous) };
  }

  const { width, height } = current;

  // Global change ratio doubles as an edit-cut detector and a camera-motion proxy.
  let changedPixels = 0;
  for (let index = 0; index < current.gray.length; index += 1) {
    if (Math.abs(current.gray[index] - previous.gray[index]) >= MOTION_DIFF_THRESHOLD) {
      changedPixels += 1;
    }
  }
  const changedRatio = changedPixels / Math.max(1, current.gray.length);

  if (changedRatio >= SCENE_CUT_CHANGED_RATIO) {
    // Blob extraction is meaningless across a cut and would flood the ranking.
    return { detections: [], changedRatio, sceneChanged: true };
  }

  const sizeScale = width / REFERENCE_WIDTH;
  const maxArea = 1800 * sizeScale * sizeScale;
  const maxSideLimit = 82 * sizeScale;
  const sizePenaltyStart = 42 * sizeScale;
  const sizePenaltyRange = 60 * sizeScale;

  const visited = new Uint8Array(width * height);
  const detections: BallDetection[] = [];

  for (let index = 0; index < current.gray.length; index += 1) {
    if (visited[index]) continue;

    const diff = Math.abs(current.gray[index] - previous.gray[index]);
    if (diff < MOTION_DIFF_THRESHOLD) continue;

    const stack = [index];
    visited[index] = 1;

    let area = 0;
    let diffSum = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (stack.length > 0) {
      const currentIndex = stack.pop() as number;
      const x = currentIndex % width;
      const y = Math.floor(currentIndex / width);
      const pixelDiff = Math.abs(current.gray[currentIndex] - previous.gray[currentIndex]);

      area += 1;
      diffSum += pixelDiff;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [
        currentIndex - 1,
        currentIndex + 1,
        currentIndex - width,
        currentIndex + width,
      ];

      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= current.gray.length || visited[neighbor]) continue;

        const neighborX = neighbor % width;
        if ((neighbor === currentIndex - 1 && neighborX !== x - 1) || (neighbor === currentIndex + 1 && neighborX !== x + 1)) {
          continue;
        }

        if (Math.abs(current.gray[neighbor] - previous.gray[neighbor]) >= MOTION_DIFF_THRESHOLD) {
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspect = boxWidth / Math.max(boxHeight, 1);
    const fillRatio = area / Math.max(boxWidth * boxHeight, 1);
    const maxSide = Math.max(boxWidth, boxHeight);
    const minSide = Math.min(boxWidth, boxHeight);

    if (
      area < 4 ||
      area > maxArea ||
      maxSide < 4 ||
      maxSide > maxSideLimit ||
      minSide < 2 ||
      aspect < 0.35 ||
      aspect > 3.2 ||
      fillRatio < 0.08
    ) {
      continue;
    }

    const averageDiff = diffSum / area;
    const roundness = minSide / Math.max(maxSide, 1);
    const sizePenalty = Math.max(0, (maxSide - sizePenaltyStart) / sizePenaltyRange);
    const score = Math.max(0.12, Math.min(0.88, averageDiff / 255 * 0.9 + roundness * 0.25 - sizePenalty));

    detections.push({
      bbox: [
        minX * current.scaleX,
        minY * current.scaleY,
        boxWidth * current.scaleX,
        boxHeight * current.scaleY,
      ],
      class: "sports ball",
      score,
      source: "motion",
    });
  }

  return {
    detections: detections.sort((a, b) => b.score - a.score).slice(0, 8),
    changedRatio,
    sceneChanged: false,
  };
}

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === "INIT") {
    self.postMessage({ type: "INIT_SUCCESS" });
  } else if (type === "RESET") {
    previousMotionFrame = null;
  } else if (type === "DETECT") {
    const { imageBitmap, timestamp, requestId } = e.data;
    
    try {
      const motionFrame = readMotionFrame(imageBitmap);
      const motion = motionFrame ? detectMotionBalls(motionFrame) : EMPTY_MOTION_RESULT;

      self.postMessage({
        type: "DETECT_RESULT",
        balls: motion.detections,
        sceneChanged: motion.sceneChanged,
        changedRatio: motion.changedRatio,
        timestamp,
        requestId,
      });
    } catch (error) {
      console.error("Ball detection error:", error);
      self.postMessage({
        type: "DETECT_RESULT",
        balls: [],
        sceneChanged: false,
        changedRatio: 0,
        timestamp,
        requestId,
      });
    } finally {
      closeImageSource(imageBitmap);
    }
  }
};
