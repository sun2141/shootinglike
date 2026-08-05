"use client";

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { BallPrediction } from "./types";

const FRAME_TIMEOUT_MS = 7000;

export type WorkerFrame = ImageBitmap | ImageData;

interface PoseMessage {
  type: "INIT_SUCCESS" | "INIT_ERROR" | "DETECT_RESULT";
  error?: string;
  requestId?: number;
  landmarks?: NormalizedLandmark[][];
  worldLandmarks?: NormalizedLandmark[][];
}

interface BallMessage {
  type: "INIT_SUCCESS" | "INIT_ERROR" | "DETECT_RESULT";
  error?: string;
  requestId?: number;
  balls?: BallPrediction[];
  sceneChanged?: boolean;
  changedRatio?: number;
}

export interface DetectionResult {
  landmarks: NormalizedLandmark[][];
  worldLandmarks: NormalizedLandmark[][];
  balls: BallPrediction[];
  sceneChanged: boolean;
  changedRatio: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
  timeoutId: number;
}

function closeFrame(frame: WorkerFrame | null) {
  if (frame && "close" in frame && typeof frame.close === "function") {
    frame.close();
  }
}

function transferListFor(frame: WorkerFrame): Transferable[] {
  return "close" in frame ? [frame] : [];
}

/**
 * Owns the pose and ball workers and turns their message protocol into
 * promises. Both the user-facing analyser and the admin batch runner use this,
 * so the two paths can no longer drift apart.
 */
export class VisionWorkers {
  private readonly poseWorker: Worker;
  private readonly ballWorker: Worker;

  private readonly pendingPose = new Map<number, Pending<Omit<PoseMessage, "type">>>();
  private readonly pendingBall = new Map<number, Pending<Omit<BallMessage, "type">>>();

  private requestId = 0;
  private poseReady = false;
  private ballReady = false;

  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  readonly ready: Promise<void>;

  constructor() {
    this.poseWorker = new Worker(new URL("../../workers/pose.worker.ts", import.meta.url));
    this.ballWorker = new Worker(new URL("../../workers/ball.worker.ts", import.meta.url));

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.poseWorker.onmessage = (event: MessageEvent<PoseMessage>) => {
      const { type, requestId, error } = event.data;
      if (type === "INIT_SUCCESS") {
        this.poseReady = true;
        this.checkReady();
      } else if (type === "INIT_ERROR") {
        this.rejectReady?.(new Error(error ?? "Pose model failed to load."));
        this.rejectReady = null;
      } else if (type === "DETECT_RESULT" && requestId !== undefined) {
        const pending = this.pendingPose.get(requestId);
        if (!pending) return;
        this.pendingPose.delete(requestId);
        window.clearTimeout(pending.timeoutId);
        pending.resolve(event.data);
      }
    };

    this.ballWorker.onmessage = (event: MessageEvent<BallMessage>) => {
      const { type, requestId, error } = event.data;
      if (type === "INIT_SUCCESS") {
        this.ballReady = true;
        this.checkReady();
      } else if (type === "INIT_ERROR") {
        this.rejectReady?.(new Error(error ?? "Ball tracker failed to load."));
        this.rejectReady = null;
      } else if (type === "DETECT_RESULT" && requestId !== undefined) {
        const pending = this.pendingBall.get(requestId);
        if (!pending) return;
        this.pendingBall.delete(requestId);
        window.clearTimeout(pending.timeoutId);
        pending.resolve(event.data);
      }
    };

    this.poseWorker.postMessage({ type: "INIT" });
    this.ballWorker.postMessage({ type: "INIT" });
  }

  private checkReady() {
    if (this.poseReady && this.ballReady) {
      this.resolveReady?.();
      this.resolveReady = null;
    }
  }

  reset() {
    this.ballWorker.postMessage({ type: "RESET" });
  }

  async detect(poseFrame: WorkerFrame, ballFrame: WorkerFrame, timestamp: number): Promise<DetectionResult> {
    const requestId = (this.requestId += 1);

    const posePromise = new Promise<Omit<PoseMessage, "type">>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingPose.delete(requestId);
        resolve({});
      }, FRAME_TIMEOUT_MS);
      this.pendingPose.set(requestId, { resolve, timeoutId });
    });

    const ballPromise = new Promise<Omit<BallMessage, "type">>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingBall.delete(requestId);
        resolve({});
      }, FRAME_TIMEOUT_MS);
      this.pendingBall.set(requestId, { resolve, timeoutId });
    });

    try {
      this.poseWorker.postMessage(
        { type: "DETECT", imageBitmap: poseFrame, timestamp, requestId },
        transferListFor(poseFrame)
      );
      this.ballWorker.postMessage(
        { type: "DETECT", imageBitmap: ballFrame, timestamp, requestId },
        transferListFor(ballFrame)
      );
    } catch (error) {
      closeFrame(poseFrame);
      closeFrame(ballFrame);
      throw error;
    }

    const [pose, ball] = await Promise.all([posePromise, ballPromise]);

    return {
      landmarks: pose.landmarks ?? [],
      worldLandmarks: pose.worldLandmarks ?? [],
      balls: ball.balls ?? [],
      sceneChanged: ball.sceneChanged ?? false,
      changedRatio: ball.changedRatio ?? 0,
    };
  }

  terminate() {
    for (const pending of this.pendingPose.values()) window.clearTimeout(pending.timeoutId);
    for (const pending of this.pendingBall.values()) window.clearTimeout(pending.timeoutId);
    this.pendingPose.clear();
    this.pendingBall.clear();
    this.poseWorker.terminate();
    this.ballWorker.terminate();
  }
}
