import '@tensorflow/tfjs-backend-webgl';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let model: cocoSsd.ObjectDetection | null = null;
let isLoading = false;

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
  } else if (type === "DETECT") {
    const { imageBitmap, timestamp, requestId } = e.data;

    if (!model) {
      if (imageBitmap && imageBitmap.close) {
        imageBitmap.close();
      }
      self.postMessage({ type: "DETECT_RESULT", balls: [], timestamp, requestId });
      return;
    }
    
    try {
      const predictions = await model.detect(imageBitmap, 50, 0.25);
      // 'sports ball' is class ID 32 in COCO, but string is 'sports ball'
      const ballPredictions = predictions.filter(p => p.class === 'sports ball');
      
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
      if (imageBitmap && imageBitmap.close) {
        imageBitmap.close();
      }
    }
  }
};
