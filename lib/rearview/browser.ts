/**
 * 브라우저 프레임 공급 — <video> 를 재생하며 requestVideoFrameCallback 으로 프레임마다
 * '그 프레임의 실제 영상 시각'(mediaTime)과 필요한 부분만 캔버스로 읽는다.
 * 영상은 서버로 보내지 않는다. 모든 계산은 이 기기에서 끝난다.
 */
import { THUMB_W, type FrameAccess, type FrameSource, type ScanStats } from './analyze';
import type { GrayImage } from './track';

interface RVFCMeta {
  mediaTime: number;
}
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: RVFCMeta) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** 처리 해상도: 긴 변 1920 이하 */
export function processingSize(video: HTMLVideoElement): { width: number; height: number; scale: number } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, 1920 / Math.max(vw, vh));
  return { width: Math.round(vw * scale), height: Math.round(vh * scale), scale };
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.001));
  });
}

export class VideoFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  private readonly scale: number;
  private readonly region: CanvasRenderingContext2D;
  private readonly thumbCtx: CanvasRenderingContext2D;
  private readonly thumbH: number;

  constructor(private readonly video: HTMLVideoElement) {
    const p = processingSize(video);
    this.width = p.width;
    this.height = p.height;
    this.scale = p.scale;
    this.duration = Number.isFinite(video.duration) ? video.duration : 0;
    const c1 = document.createElement('canvas');
    this.region = c1.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const c2 = document.createElement('canvas');
    c2.width = THUMB_W;
    this.thumbH = Math.round((THUMB_W * this.height) / this.width);
    c2.height = this.thumbH;
    this.thumbCtx = c2.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  }

  private access(t: number, image?: CanvasImageSource): FrameAccess {
    const v = image ?? this.video;
    const sc = this.scale;
    let thumb: GrayImage | null = null;
    const regionCtx = this.region;
    const thumbCtx = this.thumbCtx;
    const tw = THUMB_W;
    const th = this.thumbH;
    return {
      t,
      region(x, y, w, h) {
        const cv = regionCtx.canvas;
        if (cv.width !== w || cv.height !== h) {
          cv.width = w;
          cv.height = h;
        } else regionCtx.clearRect(0, 0, w, h);
        // 처리 좌표 → 영상 원본 좌표
        regionCtx.drawImage(v, x / sc, y / sc, w / sc, h / sc, 0, 0, w, h);
        return regionCtx.getImageData(0, 0, w, h).data;
      },
      thumb() {
        if (thumb) return thumb;
        thumbCtx.drawImage(v, 0, 0, tw, th);
        const d = thumbCtx.getImageData(0, 0, tw, th).data;
        const g = new Float32Array(tw * th);
        for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        thumb = { data: g, width: tw, height: th };
        return thumb;
      },
    };
  }

  async scan(
    t0: number,
    t1: number,
    quality: 'fast' | 'full' | 'slow',
    cb: (f: FrameAccess) => void | boolean,
    onProgress?: (p: number) => void,
  ): Promise<ScanStats> {
    const v = this.video as RVFCVideo;
    v.pause();
    await seek(v, t0);
    // 한 장면만
    if (t1 - t0 < 0.02 || typeof v.requestVideoFrameCallback !== 'function') {
      if (t1 - t0 < 0.02) {
        cb(this.access(v.currentTime));
        return { frames: 1, dropped: 0 };
      }
      // requestVideoFrameCallback 이 없는 오래된 브라우저: 30fps 로 가정해 한 장씩 탐색 (느리다)
      let n = 0;
      for (let t = t0; t <= t1; t += 1 / 30) {
        await seek(v, t);
        n++;
        if (cb(this.access(t)) === false) break;
        onProgress?.((t - t0) / Math.max(1e-3, t1 - t0));
      }
      return { frames: n, dropped: 0 };
    }
    const rate = quality === 'fast' ? 2 : quality === 'full' ? 0.5 : 0.25;
    const times: number[] = [];
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        v.pause();
        v.removeEventListener('ended', finish);
        resolve();
      };
      const onFrame = (_now: number, md: RVFCMeta) => {
        if (finished) return;
        const t = md.mediaTime;
        // 계산하는 동안 영상을 멈춰 둔다 — 기기가 느려도 프레임을 건너뛰지 않게
        const hold = quality !== 'fast';
        if (hold) v.pause();
        let stop = false;
        // 가능하면 그 순간의 프레임을 붙잡아(VideoFrame) 그림과 시각이 어긋나지 않게 한다.
        // 콜백이 늦게 돌면 <video> 는 이미 다음 프레임을 보여줄 수 있어, 시각은 앞인데 그림은 뒤가 된다.
        let vf: VideoFrame | null = null;
        let tf = t;
        if (typeof VideoFrame !== 'undefined') {
          try {
            vf = new VideoFrame(v);
            if (vf.timestamp !== null && Number.isFinite(vf.timestamp)) tf = vf.timestamp / 1e6;
          } catch {
            vf = null;
          }
        }
        if (tf >= t0 - 1e-3) {
          try {
            stop = cb(this.access(tf, vf ?? undefined)) === false;
          } catch (e) {
            vf?.close();
            finished = true;
            v.pause();
            reject(e);
            return;
          }
          times.push(tf);
          onProgress?.(Math.min(1, (tf - t0) / Math.max(1e-3, t1 - t0)));
        }
        vf?.close();
        if (stop || tf >= t1) finish();
        else {
          v.requestVideoFrameCallback!(onFrame);
          if (hold) v.play().catch(reject);
        }
      };
      v.addEventListener('ended', finish);
      v.requestVideoFrameCallback!(onFrame);
      v.muted = true;
      v.playbackRate = rate;
      v.play().catch(reject);
    });
    v.playbackRate = 1;
    // 빠진 프레임 비율: 간격 중앙값의 1.5배를 넘는 틈
    let dropped = 0;
    if (times.length > 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      const med = gaps[Math.floor(gaps.length / 2)];
      for (let i = 1; i < times.length; i++) {
        const g = times[i] - times[i - 1];
        if (g > 1.5 * med) dropped += Math.round(g / med) - 1;
      }
    }
    return { frames: times.length, dropped: times.length ? dropped / (times.length + dropped) : 0 };
  }
}
