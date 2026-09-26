"use client";

/**
 * 앱 안에서 바로 찍는 촬영 모드.
 *
 * 왜 필요한가: 실측해 보니 측정 실패의 3분의 2가 촬영 문제였다(뒤에서 찍음, 30fps, 공이 너무 작음).
 * 다 찍고 나서 "못 쟀습니다" 라고 하면 늦다. 찍기 전에 구도를 잡아주고, 60fps 를 요청하고,
 * 길이를 짧게 끊는 게 정확도를 올리는 가장 확실한 방법이다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Loader2, RefreshCw, Square, Video } from "lucide-react";

const MAX_SECONDS = 4;
const MIN_FPS = 50;

type Props = {
  onRecorded: (file: File) => void;
  onCancel: () => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export function KickRecorder({ onRecorded, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<"starting" | "ready" | "recording" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const stopStream = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setError("이 브라우저에서는 앱 안에서 촬영할 수 없습니다. 아래 '앨범에서 선택'을 써주세요.");
        return;
      }
      if (!pickMimeType()) {
        setStatus("error");
        setError("이 브라우저는 영상 녹화를 지원하지 않습니다. 기본 카메라 앱으로 찍고 '앨범에서 선택'을 써주세요.");
        return;
      }
      try {
        // 60fps 를 '요청'만 할 수 있다. 기기가 못 주면 아래에서 실제 값을 보여주고 경고한다.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            frameRate: { ideal: 60, min: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const settings = stream.getVideoTracks()[0]?.getSettings();
        setFps(settings?.frameRate ? Math.round(settings.frameRate) : null);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus("ready");
      } catch {
        setStatus("error");
        setError("카메라를 열지 못했습니다. 브라우저의 카메라 권한을 확인하거나 '앨범에서 선택'을 써주세요.");
      }
    }

    start();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [stopStream]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const type = recorder.mimeType || "video/mp4";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      stopStream();
      onRecorded(new File([blob], `kick-${Date.now()}.${ext}`, { type }));
    };
    recorderRef.current = recorder;
    recorder.start();
    setStatus("recording");
    setElapsed(0);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000;
      setElapsed(sec);
      if (sec >= MAX_SECONDS) stopRecording(); // 길게 찍으면 엉뚱한 장면을 킥으로 본다
    }, 100);
  }, [onRecorded, stopRecording, stopStream]);

  if (status === "error") {
    return (
      <div className="w-full rounded-2xl border border-yellow-300/30 bg-yellow-300/10 p-6 text-sm text-yellow-100">
        <p>{error}</p>
        <button onClick={onCancel} className="mt-4 rounded-full border border-white/20 px-5 py-2 font-bold text-white hover:bg-white/10">
          돌아가기
        </button>
      </div>
    );
  }

  const lowFps = fps !== null && fps < MIN_FPS;

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="relative w-full overflow-hidden rounded-2xl bg-black aspect-video">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />

        {/* 구도 가이드 — 공은 아래 선 위에, 킥 방향은 화면을 가로지르게 */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-6 bottom-[22%] border-t-2 border-dashed border-[var(--color-neon-green)]/70" />
          <div className="absolute bottom-[22%] left-[18%] h-6 w-6 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-[var(--color-neon-green)]" />
          <div className="absolute bottom-[calc(22%+14px)] left-[22%] right-[12%] flex items-center gap-2 text-[var(--color-neon-green)]">
            <div className="h-0.5 flex-1 bg-[var(--color-neon-green)]/60" />
            <span className="text-xs font-mono">공이 가로로 지나가게</span>
          </div>
        </div>

        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-mono ${lowFps ? "bg-yellow-400/20 text-yellow-200" : "bg-black/50 text-[var(--color-neon-green)]"}`}>
            {fps ? `${fps}fps` : "fps 확인 중"}
          </span>
          {status === "recording" && (
            <span className="rounded-full bg-red-500/80 px-3 py-1 text-xs font-mono text-white">
              REC {elapsed.toFixed(1)}s / {MAX_SECONDS}s
            </span>
          )}
        </div>

        {status === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-gray-300">
            <Loader2 className="mr-2 animate-spin" size={18} /> 카메라 여는 중
          </div>
        )}
      </div>

      {lowFps && (
        <p className="text-xs text-yellow-200">
          이 기기가 {fps}fps 로만 촬영합니다. 30fps 영상은 빠른 슛의 궤적이 남지 않아 측정이 안 될 수 있습니다.
          기본 카메라 앱에서 60fps(또는 슬로모션)로 찍어 &apos;앨범에서 선택&apos; 하는 편이 정확합니다.
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-4 text-xs text-gray-400">
        <span className="font-bold text-white text-sm">찍기 전 확인</span>
        <span>· 공이 날아가는 방향과 <strong className="text-gray-200">직각(옆)</strong>에 서서, 폰을 세워두고 찍어주세요</span>
        <span>· 공이 화면에서 동전만 하게 보이도록 거리를 맞춰주세요 (너무 멀면 못 잽니다)</span>
        <span>· 버튼을 누르고 바로 차면 됩니다. {MAX_SECONDS}초에서 자동으로 멈춥니다</span>
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => {
            stopStream();
            onCancel();
          }}
          className="flex items-center justify-center gap-2 rounded-full border border-white/20 px-5 py-3 font-bold hover:bg-white/10"
        >
          <RefreshCw size={18} />
          취소
        </button>
        {status === "recording" ? (
          <button
            onClick={stopRecording}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red-500 px-6 py-3 font-bold text-white hover:bg-red-400"
          >
            <Square size={18} />
            지금 멈추기
          </button>
        ) : (
          <button
            onClick={startRecording}
            disabled={status !== "ready"}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-white px-6 py-3 font-bold text-black transition-transform hover:scale-105 disabled:opacity-50"
          >
            {status === "ready" ? <Circle size={18} /> : <Video size={18} />}
            촬영 시작
          </button>
        )}
      </div>
    </div>
  );
}
