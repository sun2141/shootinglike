import '@tensorflow/tfjs-backend-webgl';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let model: cocoSsd.ObjectDetection | null = null;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === "INIT") {
    try {
      model = await cocoSsd.load();
      self.postMessage({ type: "INIT_SUCCESS" });
    } catch (error) {
      self.postMessage({ type: "INIT_ERROR", error: String(error) });
    }
  } else if (type === "DETECT") {
    if (!model) return;
    const { imageBitmap, timestamp } = e.data;
    
    try {
      const predictions = await model.detect(imageBitmap, 50, 0.25);
      // 'sports ball' is class ID 32 in COCO, but string is 'sports ball'
      const ballPredictions = predictions.filter(p => p.class === 'sports ball');
      
      self.postMessage({ 
        type: "DETECT_RESULT", 
        balls: ballPredictions,
        timestamp
      });
    } catch (error) {
      console.error("Ball detection error:", error);
      self.postMessage({ type: "DETECT_RESULT", balls: [], timestamp });
    } finally {
      if (imageBitmap && imageBitmap.close) {
        imageBitmap.close();
      }
    }
  }
};
