/**
 * Node 용 프레임 공급 (검증 전용) — ffmpeg 로 RGBA 를 풀어 lib/rearview 의 FrameSource 로 넘긴다.
 * 앱(브라우저)의 VideoFrameSource 와 같은 약속: scan(t0,t1) 은 t0 순간 보이는 프레임부터.
 */
import { execFileSync, spawn } from "child_process";
import { THUMB_W, type FrameAccess, type FrameSource, type ScanStats } from "../../lib/rearview/analyze";
import type { GrayImage } from "../../lib/rearview/track";

export function probe(file: string) {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration", "-of", "json", file]).toString(),
  );
  const s = j.streams[0];
  const [a, b] = String(s.r_frame_rate).split("/").map(Number);
  return { width: Number(s.width), height: Number(s.height), fps: a / b, duration: Number(s.duration) };
}

export class NodeSource implements FrameSource {
  width: number;
  height: number;
  duration: number;
  fps: number;
  constructor(private readonly file: string) {
    const p = probe(file);
    // 앱과 같게 긴 변 1920 이하로 처리 (여기선 원본이 1920 이하라고 가정)
    this.width = p.width;
    this.height = p.height;
    this.duration = p.duration;
    this.fps = p.fps;
  }

  async scan(t0: number, t1: number, _q: string, cb: (f: FrameAccess) => void | boolean): Promise<ScanStats> {
    const W = this.width;
    const H = this.height;
    const fsz = W * H * 4;
    const i0 = Math.max(0, Math.floor(t0 * this.fps) - 1);
    const ss = i0 / this.fps;
    const p = spawn("ffmpeg", ["-v", "error", "-ss", ss.toFixed(4), "-i", this.file, "-t", (t1 - ss + 0.05).toFixed(3), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    const fr = Buffer.alloc(fsz);
    let fill = 0;
    let idx = 0;
    let frames = 0;
    let stopped = false;
    await new Promise<void>((resolve, reject) => {
      p.stdout.on("data", (d: Buffer) => {
        let off = 0;
        while (off < d.length) {
          const n = Math.min(fsz - fill, d.length - off);
          d.copy(fr, fill, off, off + n);
          fill += n;
          off += n;
          if (fill < fsz) break;
          fill = 0;
          const t = (i0 + idx) / this.fps;
          idx++;
          if (stopped || t <= t0 - 1 / this.fps || t > t1 + 1e-6) continue;
          frames++;
          if (cb(access(fr, W, H, t)) === false) {
            stopped = true;
            p.kill();
          }
        }
      });
      p.on("close", () => resolve());
      p.on("error", reject);
    });
    return { frames, dropped: 0 };
  }
}

function access(data: Buffer, W: number, H: number, t: number): FrameAccess {
  let th: GrayImage | null = null;
  return {
    t,
    region(x, y, w, h) {
      const o = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= H) continue;
        for (let i = 0; i < w; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= W) continue;
          const s = (yy * W + xx) * 4;
          const k = (j * w + i) * 4;
          o[k] = data[s];
          o[k + 1] = data[s + 1];
          o[k + 2] = data[s + 2];
          o[k + 3] = 255;
        }
      }
      return o;
    },
    thumb() {
      if (th) return th;
      const tw = THUMB_W;
      const sc = W / tw;
      const thh = Math.round(H / sc);
      const g = new Float32Array(tw * thh);
      for (let y = 0; y < thh; y++) {
        for (let x = 0; x < tw; x++) {
          const sx = Math.min(W - 1, Math.floor((x + 0.5) * sc));
          const sy = Math.min(H - 1, Math.floor((y + 0.5) * sc));
          const s = (sy * W + sx) * 4;
          g[y * tw + x] = 0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2];
        }
      }
      th = { data: g, width: tw, height: thh };
      return th;
    },
  };
}
