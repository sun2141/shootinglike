import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";

let poseLandmarker: PoseLandmarker | null = null;
let isLoading = false;

async function initPoseLandmarker() {
  if (poseLandmarker || isLoading) return;
  isLoading = true;
  
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    
    const createLandmarker = (delegate: "GPU" | "CPU") =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate,
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

    try {
      poseLandmarker = await createLandmarker("GPU");
    } catch {
      poseLandmarker = await createLandmarker("CPU");
    }
    
    self.postMessage({ type: "INIT_SUCCESS" });
  } catch (error) {
    console.error("PoseLandmarker initialization failed", error);
    self.postMessage({ type: "INIT_ERROR", error: String(error) });
  } finally {
    isLoading = false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, imageBitmap, timestamp, requestId } = e.data;

  if (type === "INIT") {
    await initPoseLandmarker();
  } 
  else if (type === "DETECT" && imageBitmap) {
    if (!poseLandmarker) {
      imageBitmap.close();
      self.postMessage({ type: "DETECT_RESULT", landmarks: [], timestamp, requestId });
      return;
    }

    try {
      const results = poseLandmarker.detectForVideo(imageBitmap, timestamp);
      
      // Serialize landmarks for main thread
      let serializedLandmarks: NormalizedLandmark[][] = [];
      if (results && results.landmarks) {
        serializedLandmarks = results.landmarks;
      }
      
      self.postMessage({ 
        type: "DETECT_RESULT", 
        landmarks: serializedLandmarks,
        timestamp,
        requestId,
      });
    } catch (err) {
      console.error("Detection error:", err);
      self.postMessage({ type: "DETECT_RESULT", landmarks: [], timestamp, requestId });
    } finally {
      // Must close ImageBitmap to prevent memory leaks in Web Workers
      imageBitmap.close();
    }
  }
};
