"use client";

export const VIDEO_READY_TIMEOUT_MS = 12000;
const SEEK_TIMEOUT_MS = 5000;
/** Grace period after `seeked` to let a frame callback deliver the real media time. */
const FRAME_CALLBACK_GRACE_MS = 80;

interface FrameCallbackMetadata {
  mediaTime: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: FrameCallbackMetadata) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function supportsFrameCallback(video: HTMLVideoElement) {
  return typeof (video as FrameCallbackVideo).requestVideoFrameCallback === "function";
}

export function waitForVideoData(
  video: HTMLVideoElement,
  timeoutMs = VIDEO_READY_TIMEOUT_MS
): Promise<void> {
  const hasCurrentFrame = () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  if (hasCurrentFrame()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("canplay", handleLoaded);
      video.removeEventListener("canplaythrough", handleLoaded);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleLoaded = () => {
      if (hasCurrentFrame()) finish();
    };
    const handleError = () => finish(new Error("Video data could not be loaded."));
    const timeoutId = window.setTimeout(() => finish(new Error("Video data load timed out.")), timeoutMs);

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("canplay", handleLoaded);
    video.addEventListener("canplaythrough", handleLoaded);
    video.addEventListener("error", handleError);

    try {
      video.load();
    } catch {
      // Some browsers throw when load() is called on transient blob URLs.
    }

    if (hasCurrentFrame()) finish();
  });
}

/**
 * Seeks to `targetSeconds` and resolves with the media time of the frame that
 * is actually presented, in milliseconds.
 *
 * `video.fastSeek()` is deliberately not used: it is allowed to snap to the
 * nearest keyframe, and the old pipeline then timed the sample with the
 * *requested* time. On 25fps clips that mismatch alone was worth ±10% on the
 * reported speed.
 */
export function seekToTime(video: HTMLVideoElement, targetSeconds: number): Promise<number> {
  const duration = Number.isFinite(video.duration) ? video.duration : targetSeconds;
  const target = Math.max(0, Math.min(targetSeconds, duration));
  const frameVideo = video as FrameCallbackVideo;

  return new Promise((resolve, reject) => {
    let settled = false;
    let frameHandle: number | null = null;
    let graceTimer: number | null = null;

    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
      if (graceTimer !== null) window.clearTimeout(graceTimer);
      if (frameHandle !== null && typeof frameVideo.cancelVideoFrameCallback === "function") {
        frameVideo.cancelVideoFrameCallback(frameHandle);
      }
    };

    const finish = (timeMs: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(timeMs);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handleSeeked = () => {
      if (settled) return;
      if (frameHandle === null) {
        finish(video.currentTime * 1000);
        return;
      }
      // Prefer the frame callback's mediaTime, but do not hang waiting for it.
      graceTimer = window.setTimeout(() => finish(video.currentTime * 1000), FRAME_CALLBACK_GRACE_MS);
    };

    const handleError = () => fail(new Error("Video seek failed."));
    const timeoutId = window.setTimeout(() => fail(new Error("Video seek timed out.")), SEEK_TIMEOUT_MS);

    if (typeof frameVideo.requestVideoFrameCallback === "function") {
      frameHandle = frameVideo.requestVideoFrameCallback((_now, metadata) => {
        frameHandle = null;
        finish(metadata.mediaTime * 1000);
      });
    }

    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);

    const alreadyThere =
      Math.abs(video.currentTime - target) < 0.001 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

    try {
      if (alreadyThere) {
        handleSeeked();
      } else {
        video.currentTime = target;
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Video seek failed."));
    }
  });
}
