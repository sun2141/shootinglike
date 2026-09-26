/**
 * 프레임 읽기 — 이 모듈에서 가장 중요한 한 가지는 "시간을 가정하지 않는 것"이다.
 *
 * 속도 = 거리 / 시간이므로, 시간축이 2배 틀리면 속도도 정확히 2배 틀린다.
 * 60fps 로 찍힌 영상을 30fps 로 가정하면 모든 속도가 절반이 된다.
 * 그래서 fps 메타데이터를 믿지 않고, requestVideoFrameCallback 이 프레임마다
 * 돌려주는 mediaTime(그 프레임이 영상에서 실제로 차지하는 시각)을 그대로 쓴다.
 *
 * 부수 효과로, 재생 중 프레임이 몇 장 누락돼도 계산이 망가지지 않는다.
 * 프레임 간격을 일정하다고 가정하지 않기 때문이다.
 */
import type { Gray } from './types';

interface RVFCMetadata {
  mediaTime: number;
  presentedFrames: number;
  width: number;
  height: number;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: RVFCMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function supportsFrameCallback(video: HTMLVideoElement): boolean {
  return typeof (video as RVFCVideo).requestVideoFrameCallback === 'function';
}

export interface ReadResult {
  frames: number;
  durationS: number;
  fpsMeasured: number | null;
  width: number;
  height: number;
  detectWidth: number;
  detectHeight: number;
  /** 원본 px = 검출 px * scale */
  scale: number;
  droppedHint: boolean;
  /** 브라우저가 실제로 버린 프레임 수 (getVideoPlaybackQuality). 알 수 없으면 null */
  droppedFrames: number | null;
  decodedFrames: number | null;
}

/**
 * 영상을 한 번 재생하면서 프레임마다 콜백을 준다.
 * 프레임 전체를 메모리에 쌓지 않는다 — 10초 60fps 를 그레이스케일로만 들고 있어도
 * 100MB 를 넘기기 때문에, 검출은 스트리밍으로 처리하고 결과만 남긴다.
 */
export async function readFrames(
  video: HTMLVideoElement,
  opts: { detectWidth?: number; playbackRate?: number; onProgress?: (p: number) => void },
  onFrame: (gray: Gray, t: number, index: number) => void,
): Promise<ReadResult> {
  const v = video as RVFCVideo;
  await ensureReady(video);

  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) throw new Error('영상 크기를 읽지 못했습니다.');

  const targetW = Math.min(opts.detectWidth ?? 720, W);
  const scale = W / targetW;
  const dw = Math.round(targetW);
  const dh = Math.max(1, Math.round(H / scale));

  const canvas = makeCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error('2D 캔버스를 만들지 못했습니다.');

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  let index = 0;
  const times: number[] = [];

  if (!supportsFrameCallback(video)) {
    // 폴백: 탐색 기반. 정확한 프레임 시각을 알 수 없어 fps 메타데이터에 의존한다.
    const fps = 30;
    for (let t = 0; t < duration; t += 1 / fps) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, dw, dh);
      onFrame(toGray(ctx.getImageData(0, 0, dw, dh), dw, dh), video.currentTime, index++);
      times.push(video.currentTime);
      opts.onProgress?.(duration ? t / duration : 0);
    }
    return finish();
  }

  video.playbackRate = opts.playbackRate ?? 1.0;
  video.muted = true;
  (video as HTMLVideoElement).currentTime = 0;

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finishOnce = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const step = (_now: number, md: RVFCMetadata) => {
      try {
        ctx.drawImage(video, 0, 0, dw, dh);
        const img = ctx.getImageData(0, 0, dw, dh);
        onFrame(toGray(img, dw, dh), md.mediaTime, index);
        times.push(md.mediaTime);
        index++;
        if (duration) opts.onProgress?.(Math.min(1, md.mediaTime / duration));
      } catch (e) {
        reject(e);
        return;
      }
      if (!video.ended) v.requestVideoFrameCallback!(step);
      else finishOnce();
    };
    video.addEventListener('ended', finishOnce, { once: true });
    video.addEventListener('error', () => reject(new Error('영상 재생 오류')), { once: true });
    v.requestVideoFrameCallback!(step);
    video.play().catch(reject);
  });

  return finish();

  function finish(): ReadResult {
    // rVFC 는 '화면에 표시된' 프레임에서만 호출된다. 기기가 느리면 절반이 통째로 빠질 수 있다.
    // 다행히 시간축을 mediaTime 으로 쓰기 때문에 프레임이 빠져도 속도 계산은 틀어지지 않는다.
    // 다만 표본이 줄어드는 건 사실이라, 실제 버려진 프레임 수를 같이 보고한다.
    let droppedFrames: number | null = null;
    let decodedFrames: number | null = null;
    const q = (video as HTMLVideoElement & {
      getVideoPlaybackQuality?: () => { droppedVideoFrames: number; totalVideoFrames: number };
    }).getVideoPlaybackQuality?.();
    if (q) {
      droppedFrames = q.droppedVideoFrames;
      decodedFrames = q.totalVideoFrames;
    }
    let fpsMeasured: number | null = null;
    let droppedHint = false;
    if (times.length >= 3) {
      const dts: number[] = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 1e-6) dts.push(d);
      }
      if (dts.length) {
        dts.sort((a, b) => a - b);
        const med = dts[Math.floor(dts.length / 2)];
        fpsMeasured = med > 0 ? 1 / med : null;
        // 간격의 1/4 이상이 중앙값의 1.7배를 넘으면 프레임이 빠진 것으로 본다
        const big = dts.filter((d) => d > med * 1.7).length;
        droppedHint = big > dts.length * 0.25;
      }
    }
    return {
      frames: index,
      durationS: duration,
      fpsMeasured,
      width: W,
      height: H,
      detectWidth: dw,
      detectHeight: dh,
      scale,
      droppedHint: droppedHint || (decodedFrames != null && index < decodedFrames * 0.75),
      droppedFrames,
      decodedFrames,
    };
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toGray(img: ImageData, w: number, h: number): Gray {
  const src = img.data;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec.601 휘도. 잔디(녹색)와 흰 공의 대비가 가장 잘 벌어지는 조합이다.
    out[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
  }
  return { data: out, width: w, height: h };
}

async function ensureReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('영상을 불러오지 못했습니다.')), { once: true });
  });
}

async function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = t;
  });
}


/**
 * 탐색(seek) 기반 프레임 수집 — 재생 중 프레임이 버려질 때의 대안.
 *
 * 재생 콜백은 '화면에 표시된' 프레임에서만 불린다. 기기가 느리면 절반이 통째로 빠지고,
 * 그러면 실행할 때마다 결과가 달라진다. 이쪽은 프레임 시각마다 직접 탐색해서 한 장씩
 * 가져오므로 하나도 빠지지 않는다. 대신 느리다 — 그래서 재생으로 먼저 해보고
 * 많이 버려졌을 때만 이걸로 다시 한다.
 *
 * 시각은 여기서도 가정하지 않는다. 탐색 후 실제로 표시된 프레임의 mediaTime 을 쓴다.
 */
export async function readFramesBySeek(
  video: HTMLVideoElement,
  opts: { detectWidth?: number; fpsHint?: number; maxFrames?: number; onProgress?: (p: number) => void },
  onFrame: (gray: Gray, t: number, index: number) => void,
): Promise<ReadResult> {
  const v = video as RVFCVideo;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const targetW = Math.min(opts.detectWidth ?? 960, W);
  const scale = W / targetW;
  const dw = Math.round(targetW);
  const dh = Math.max(1, Math.round(H / scale));
  const canvas = makeCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const fps = Math.min(240, Math.max(15, opts.fpsHint ?? 30));
  const dt = 1 / fps;
  const maxFrames = opts.maxFrames ?? 600;

  video.pause();
  const times: number[] = [];
  let index = 0;
  let last = -1;

  for (let t = 0; t < duration && index < maxFrames; t += dt) {
    const shown = await seekAndWait(video, v, Math.min(t, Math.max(0, duration - 1e-3)));
    const real = shown ?? video.currentTime;
    if (real <= last + 1e-6) continue;       // 같은 프레임을 두 번 담지 않는다
    last = real;
    ctx.drawImage(video, 0, 0, dw, dh);
    onFrame(toGray(ctx.getImageData(0, 0, dw, dh), dw, dh), real, index);
    times.push(real);
    index++;
    if (duration) opts.onProgress?.(Math.min(1, t / duration));
  }

  let fpsMeasured: number | null = null;
  if (times.length >= 3) {
    const dts: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 1e-6) dts.push(d);
    }
    if (dts.length) {
      dts.sort((a, b) => a - b);
      fpsMeasured = 1 / dts[Math.floor(dts.length / 2)];
    }
  }
  return {
    frames: index, durationS: duration, fpsMeasured,
    width: W, height: H, detectWidth: dw, detectHeight: dh, scale,
    droppedHint: false, droppedFrames: 0, decodedFrames: index,
  };
}

function seekAndWait(video: HTMLVideoElement, v: RVFCVideo, t: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: number | null) => { if (!done) { done = true; resolve(val); } };
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback((_now, md) => finish(md.mediaTime));
    }
    video.addEventListener('seeked', () => {
      // rVFC 가 안 오는 경우를 대비한 보험
      setTimeout(() => finish(null), 0);
    }, { once: true });
    video.currentTime = t;
    setTimeout(() => finish(null), 800);
  });
}
