/**
 * ballspeed (브라우저) — 영상 파일 하나를 넣으면 공 속도를 돌려준다.
 *
 *   import { analyzeVideo } from '@/lib/ballspeed';
 *   const r = await analyzeVideo(file, { ballSize: 'size5' });
 *   r.verified   // 중력 검산 통과 여부 — false 면 기록에 넣지 말 것
 *   r.speedKmh   // 보정 후 속도 (검산 실패 시 null)
 */
import { analyzeFrames, framesForBudget, type CapturedFrame } from './core';
import { readFrames, readFramesBySeek } from './frames';
import type { AnalyzeOptions, Gray, Measurement } from './types';

export * from './core';
export { readFrames, supportsFrameCallback } from './frames';

export type VideoSource = HTMLVideoElement | File | Blob | string;

export async function analyzeVideo(source: VideoSource, opts: AnalyzeOptions = {}): Promise<Measurement> {
  const { video, cleanup } = await toVideo(source);
  try {
    return await analyzeVideoElement(video, opts);
  } finally {
    cleanup();
  }
}

export async function analyzeVideoElement(video: HTMLVideoElement, opts: AnalyzeOptions = {}): Promise<Measurement> {
  // 재생하면서 '담기만' 한다. 콜백 안에서 검출까지 돌리면 프레임당 10ms 를 넘겨
  // 브라우저가 프레임을 버리고, 표본이 절반으로 줄어 결과가 매번 달라진다.
  const captured: CapturedFrame[] = [];
  let maxFrames: number | null = opts.maxFrames ?? null;
  let hitCap = false;

  const info = await readFrames(
    video,
    {
      detectWidth: opts.detectWidth ?? Math.min(video.videoWidth || 1280, 960),
      playbackRate: opts.playbackRate,
      onProgress: (p) => opts.onProgress?.(p * 0.5),
    },
    (gray: Gray, t: number) => {
      if (maxFrames === null) maxFrames = framesForBudget(gray.data.length, opts.memoryBudgetMB ?? 96);
      if (captured.length < maxFrames) captured.push({ g: gray, t });
      else hitCap = true;
    },
  );

  // 재생 중 프레임이 많이 버려졌으면, 탐색 기반으로 다시 담는다.
  // 표본이 절반으로 줄면 결과가 실행할 때마다 달라지므로 그냥 넘어갈 문제가 아니다.
  const kept = info.decodedFrames ? captured.length / info.decodedFrames : 1;
  let source = info;
  if ((opts.recapture ?? true) && info.decodedFrames && info.decodedFrames > 20 && kept < 0.8) {
    const again: CapturedFrame[] = [];
    try {
      const info2 = await readFramesBySeek(video, {
        detectWidth: opts.detectWidth ?? Math.min(video.videoWidth || 1280, 960),
        fpsHint: info.fpsMeasured ?? 60,
        maxFrames: maxFrames ?? 400,
        onProgress: (p) => opts.onProgress?.(0.5 + p * 0.3),
      }, (gray, t) => { again.push({ g: gray, t }); });
      if (again.length > captured.length * 1.15) {
        captured.length = 0;
        captured.push(...again);
        source = info2;
      }
    } catch {
      // 탐색이 안 되는 브라우저면 재생으로 담은 걸 그대로 쓴다
    }
  }

  const m = analyzeFrames(captured, {
    width: source.width,
    height: source.height,
    scale: source.scale,
    detectWidth: source.detectWidth,
    durationS: source.durationS,
    fpsMeasured: source.fpsMeasured,
    droppedHint: source.droppedHint,
    decodedFrames: source.decodedFrames,
  }, opts);

  if (hitCap && !m.trajectory.length) {
    const lastT = captured[captured.length - 1]?.t ?? 0;
    m.warnings.push(`메모리 한도로 앞 ${captured.length}프레임(약 ${lastT.toFixed(1)}초)까지만 분석했습니다. 차는 순간이 뒤쪽이면 클립을 짧게 잘라주세요.`);
  }
  return m;
}

async function toVideo(source: VideoSource): Promise<{ video: HTMLVideoElement; cleanup: () => void }> {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { video: source, cleanup: () => {} };
  }
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.preload = 'auto';
  let url: string | null = null;
  if (typeof source === 'string') video.src = source;
  else {
    url = URL.createObjectURL(source as Blob);
    video.src = url;
  }
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('영상을 불러오지 못했습니다.')), { once: true });
  });
  return {
    video,
    cleanup: () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (url) URL.revokeObjectURL(url);
    },
  };
}
