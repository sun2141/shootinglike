"use client";

import type { ReferenceCalibrationSummary } from "./reference-calibration";
import { runVideoAnalysis } from "./pipeline/run-analysis";
import type { PipelineResult } from "./pipeline/types";
import type { BallSizeId } from "./scale-reference";
import { VisionWorkers } from "./pipeline/vision-workers";

export type ClientVideoAnalysisResult = PipelineResult;

export interface ClientVideoAnalysisProgress {
  current: number;
  total: number;
  progress: number;
  label: string;
}

export interface ClientVideoAnalysisOptions {
  playerHeightCm?: number | null;
  playerHeightProvided?: boolean;
  /** Regulation ball size, used as a fixed-size metric reference. */
  ballSizeId?: BallSizeId | null;
  calibration?: ReferenceCalibrationSummary | null;
  label?: string;
  isCancelled?: () => boolean;
  onProgress?: (progress: ClientVideoAnalysisProgress) => void;
}

const VIDEO_LOAD_TIMEOUT_MS = 20000;

function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.top = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);
  return video;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };
    const handleLoaded = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const handleError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("영상을 불러오지 못했습니다."));
    };
    const timeoutId = window.setTimeout(handleError, VIDEO_LOAD_TIMEOUT_MS);

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
  });
}

/**
 * Headless analyser used by the admin reference batch runner.
 *
 * It now delegates to the same pipeline as the user-facing `/analyze` page
 * instead of carrying a second copy of the tracking logic.
 */
export class BrowserVideoAnalyzer {
  private workers: VisionWorkers | null = null;

  async ready() {
    if (!this.workers) this.workers = new VisionWorkers();
    await this.workers.ready;
  }

  async analyze(sourceUrl: string, options: ClientVideoAnalysisOptions = {}): Promise<PipelineResult> {
    await this.ready();
    const workers = this.workers;
    if (!workers) throw new Error("분석 워커를 초기화하지 못했습니다.");

    const video = createHiddenVideo();
    video.src = sourceUrl;

    try {
      await waitForMetadata(video);

      return await runVideoAnalysis({
        video,
        workers,
        playerHeightCm: options.playerHeightCm,
        playerHeightProvided: options.playerHeightProvided,
        ballSizeId: options.ballSizeId,
        calibration: options.calibration,
        isCancelled: options.isCancelled,
        onProgress: (progress) =>
          options.onProgress?.({ ...progress, label: options.label ?? "" }),
      });
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
  }

  dispose() {
    this.workers?.terminate();
    this.workers = null;
  }
}

export async function analyzeVideoSource(sourceUrl: string, options: ClientVideoAnalysisOptions = {}) {
  const analyzer = new BrowserVideoAnalyzer();
  try {
    return await analyzer.analyze(sourceUrl, options);
  } finally {
    analyzer.dispose();
  }
}
