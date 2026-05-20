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
    
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    
    self.postMessage({ type: "INIT_SUCCESS" });
  } catch (error) {
    console.error("PoseLandmarker initialization failed", error);
    self.postMessage({ type: "INIT_ERROR", error });
  } finally {
    isLoading = false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, imageBitmap, timestamp } = e.data;

  if (type === "INIT") {
    await initPoseLandmarker();
  } 
  else if (type === "DETECT" && poseLandmarker && imageBitmap) {
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
        timestamp
      });
    } catch (err) {
      console.error("Detection error:", err);
    } finally {
      // Must close ImageBitmap to prevent memory leaks in Web Workers
      imageBitmap.close();
    }
  }
};
