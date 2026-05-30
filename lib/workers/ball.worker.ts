import '@tensorflow/tfjs-backend-webgl';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let model: cocoSsd.ObjectDetection | null = null;
let isLoading = false;
let previousMotionFrame: MotionFrame | null = null;
let motionCanvas: OffscreenCanvas | null = null;
let sourceMotionCanvas: OffscreenCanvas | null = null;

const MOTION_ANALYSIS_WIDTH = 360;
const MOTION_DIFF_THRESHOLD = 28;

interface BallDetection {
  bbox: number[];
  class: string;
  score: number;
  source?: "coco" | "motion";
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

function detectMotionBalls(current: MotionFrameData): BallDetection[] {
  const previous = previousMotionFrame;
  previousMotionFrame = {
    width: current.width,
    height: current.height,
    gray: current.gray,
  };

  if (!previous || previous.width !== current.width || previous.height !== current.height) {
    return [];
  }

  const { width, height } = current;
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
      area < 5 ||
      area > 1300 ||
      maxSide < 4 ||
      maxSide > 62 ||
      minSide < 3 ||
      aspect < 0.45 ||
      aspect > 2.2 ||
      fillRatio < 0.12
    ) {
      continue;
    }

    const averageDiff = diffSum / area;
    const roundness = minSide / Math.max(maxSide, 1);
    const sizePenalty = Math.max(0, (maxSide - 34) / 50);
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

  return detections
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === "INIT") {
    if (model || isLoading) return;
    isLoading = true;

    try {
      model = await cocoSsd.load();
      self.postMessage({ type: "INIT_SUCCESS" });
    } catch (error) {
      self.postMessage({ type: "INIT_ERROR", error: String(error) });
    } finally {
      isLoading = false;
    }
  } else if (type === "RESET") {
    previousMotionFrame = null;
  } else if (type === "DETECT") {
    const { imageBitmap, timestamp, requestId } = e.data;

    if (!model) {
      closeImageSource(imageBitmap);
      self.postMessage({ type: "DETECT_RESULT", balls: [], timestamp, requestId });
      return;
    }
    
    try {
      const predictions = await model.detect(imageBitmap, 50, 0.18);
      // 'sports ball' is class ID 32 in COCO, but string is 'sports ball'
      const cocoPredictions: BallDetection[] = predictions
        .filter(p => p.class === 'sports ball')
        .map((prediction) => ({
          bbox: prediction.bbox,
          class: prediction.class,
          score: prediction.score,
          source: "coco",
        }));
      const motionFrame = readMotionFrame(imageBitmap);
      const motionPredictions = motionFrame ? detectMotionBalls(motionFrame) : [];
      const ballPredictions = [...cocoPredictions, ...motionPredictions]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      
      self.postMessage({ 
        type: "DETECT_RESULT", 
        balls: ballPredictions,
        timestamp,
        requestId,
      });
    } catch (error) {
      console.error("Ball detection error:", error);
      self.postMessage({ type: "DETECT_RESULT", balls: [], timestamp, requestId });
    } finally {
      closeImageSource(imageBitmap);
    }
  }
};
