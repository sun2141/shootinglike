"use client";

import { useState, useRef, useEffect } from "react";
import { ArrowLeft, Upload, Loader2, Play, Activity, Share2 } from "lucide-react";
import Link from "next/link";
import { drawLandmarks, drawConnectors } from "@/lib/canvas-utils";
import { PoseLandmarker } from "@mediapipe/tasks-vision";
import { estimateSpeedKmh } from "@/lib/analysis/speed";
import { calculateFormScore, type FormResult } from "@/lib/analysis/form";
import { generateFeedback } from "@/lib/analysis/feedback";
import { ShareCard } from "@/components/ShareCard";
import html2canvas from "html2canvas";

interface AnalysisResult {
  framesAnalyzed: number;
  estimatedSpeedKmh: number;
  formResult: FormResult;
  feedbacks: string[];
  kickType: string;
}

export default function AnalyzePage() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isPoseLoading, setIsPoseLoading] = useState(true);
  const [isBallLoading, setIsBallLoading] = useState(true);
  const isModelLoading = isPoseLoading || isBallLoading;
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [impactDetected, setImpactDetected] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseWorkerRef = useRef<Worker | null>(null);
  const ballWorkerRef = useRef<Worker | null>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  
  // Tracking state
  const prevFootPosRef = useRef<{ x: number, y: number } | null>(null);
  const prevBallPosRef = useRef<{ x: number, y: number } | null>(null);
  
  const isPoseProcessingRef = useRef(false);
  const isBallProcessingRef = useRef(false);
  
  // Analysis variables
  const frameCounterRef = useRef<number>(0);
  const impactFrameIndexRef = useRef<number>(-1);
  const startFootPosRef = useRef<{x: number, y: number} | null>(null);
  const nosePosRef = useRef<{x: number, y: number} | null>(null);
  const anklePosRef = useRef<{x: number, y: number} | null>(null);
  const formResultRef = useRef<FormResult | null>(null);

  // Ball variables
  const ballStartPosRef = useRef<{x: number, y: number} | null>(null);
  const ballEndPosRef = useRef<{x: number, y: number} | null>(null);
  const ballTrajectoryRef = useRef<{x: number, y: number}[]>([]);

  useEffect(() => {
    poseWorkerRef.current = new Worker(new URL('../../lib/workers/pose.worker.ts', import.meta.url));
    ballWorkerRef.current = new Worker(new URL('../../lib/workers/ball.worker.ts', import.meta.url));
    
    poseWorkerRef.current.onmessage = (e) => {
      const { type, landmarks } = e.data;
      if (type === "INIT_SUCCESS") {
        setIsPoseLoading(false);
      } else if (type === "INIT_ERROR") {
        console.error("Pose Worker init error", e.data.error);
        setIsPoseLoading(false);
      } else if (type === "DETECT_RESULT") {
        processPoseResult(landmarks);
        isPoseProcessingRef.current = false;
      }
    };

    ballWorkerRef.current.onmessage = (e) => {
      const { type, balls } = e.data;
      if (type === "INIT_SUCCESS") {
        setIsBallLoading(false);
      } else if (type === "INIT_ERROR") {
        console.error("Ball Worker init error", e.data.error);
        setIsBallLoading(false);
      } else if (type === "DETECT_RESULT") {
        processBallResult(balls);
        isBallProcessingRef.current = false;
      }
    };

    poseWorkerRef.current.postMessage({ type: "INIT" });
    ballWorkerRef.current.postMessage({ type: "INIT" });
    
    return () => {
      poseWorkerRef.current?.terminate();
      ballWorkerRef.current?.terminate();
    };
  }, []);

  const processPoseResult = (landmarks: any[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas || !landmarks || landmarks.length === 0) return;

    for (const landmark of landmarks) {
      drawLandmarks(ctx, landmark);
      drawConnectors(ctx, landmark, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(0, 255, 0, 0.7)", lineWidth: 3 });
      
      const rightFoot = landmark[32]; 
      
      if (rightFoot && rightFoot.visibility && rightFoot.visibility > 0.5) {
        const currentX = rightFoot.x * canvas.width;
        const currentY = rightFoot.y * canvas.height;
        
        if (prevFootPosRef.current) {
          const dx = currentX - prevFootPosRef.current.x;
          const dy = currentY - prevFootPosRef.current.y;
          const velocity = Math.sqrt(dx * dx + dy * dy);
          
          // Heuristic: fast foot movement and impact not detected yet
          if (velocity > 30 && impactFrameIndexRef.current === -1) {
            startFootPosRef.current = { x: currentX, y: currentY };
            if (landmark[0]) nosePosRef.current = { x: landmark[0].x * canvas.width, y: landmark[0].y * canvas.height };
            if (landmark[27]) anklePosRef.current = { x: landmark[27].x * canvas.width, y: landmark[27].y * canvas.height };
            
            if (landmark[23] && landmark[25] && landmark[27] && landmark[11]) {
              const plantHip = { x: landmark[23].x * canvas.width, y: landmark[23].y * canvas.height }; 
              const plantKnee = { x: landmark[25].x * canvas.width, y: landmark[25].y * canvas.height }; 
              const plantAnkle = { x: landmark[27].x * canvas.width, y: landmark[27].y * canvas.height }; 
              const leftShoulder = { x: landmark[11].x * canvas.width, y: landmark[11].y * canvas.height }; 
              formResultRef.current = calculateFormScore(plantHip, plantKnee, plantAnkle, leftShoulder);
            }
          }
        }
        prevFootPosRef.current = { x: currentX, y: currentY };
      }
    }
  };

  const processBallResult = (balls: any[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;

    if (balls && balls.length > 0) {
      // Pick the most confident ball or closest to foot
      const ball = balls[0];
      const [x, y, width, height] = ball.bbox;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      // Draw Ball BBox
      ctx.strokeStyle = "rgba(255, 165, 0, 0.9)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, width, height);
      
      // Store ball trajectory
      ballTrajectoryRef.current.push({ x: centerX, y: centerY });
      
      // Draw Trajectory
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 165, 0, 0.5)";
      ctx.lineWidth = 2;
      ballTrajectoryRef.current.forEach((point, idx) => {
        if (idx === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      // Advanced Impact Detection: 
      // If we have a fast moving foot from pose, and now the ball moves fast
      if (prevBallPosRef.current) {
        const dx = centerX - prevBallPosRef.current.x;
        const dy = centerY - prevBallPosRef.current.y;
        const ballVelocity = Math.sqrt(dx * dx + dy * dy);
        
        // If ball velocity spikes, and we haven't locked impact yet
        if (ballVelocity > 20 && startFootPosRef.current && impactFrameIndexRef.current === -1) {
           const distToFoot = Math.sqrt(
             Math.pow(centerX - startFootPosRef.current.x, 2) + 
             Math.pow(centerY - startFootPosRef.current.y, 2)
           );
           
           if (distToFoot < 200) { // foot is near the ball
              setImpactDetected(true);
              impactFrameIndexRef.current = frameCounterRef.current;
              ballStartPosRef.current = { x: prevBallPosRef.current.x, y: prevBallPosRef.current.y };
           }
        }
      }
      
      // Track ball end pos for 5 frames after impact
      if (impactFrameIndexRef.current !== -1 && frameCounterRef.current <= impactFrameIndexRef.current + 5) {
        ballEndPosRef.current = { x: centerX, y: centerY };
      }

      prevBallPosRef.current = { x: centerX, y: centerY };
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setAnalysisResult(null);
      setImpactDetected(false);
    }
  };

  const startAnalysis = async () => {
    if (!videoRef.current || !canvasRef.current || !poseWorkerRef.current || !ballWorkerRef.current) return;
    
    setIsAnalyzing(true);
    setImpactDetected(false);
    
    prevFootPosRef.current = null;
    prevBallPosRef.current = null;
    isPoseProcessingRef.current = false;
    isBallProcessingRef.current = false;
    ballTrajectoryRef.current = [];
    
    frameCounterRef.current = 0;
    impactFrameIndexRef.current = -1;
    startFootPosRef.current = null;
    nosePosRef.current = null;
    anklePosRef.current = null;
    formResultRef.current = null;
    ballStartPosRef.current = null;
    ballEndPosRef.current = null;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;

    video.currentTime = 0;
    await video.play();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const renderLoop = async () => {
      if (video.paused || video.ended) {
        setIsAnalyzing(false);
        
        let finalSpeed = 0;
        let formScore = 70;
        let formRes = formResultRef.current;
        let feedbacks: string[] = ["임팩트를 명확히 찾지 못했습니다. 공과 전신이 잘 보이는 영상을 다시 업로드 해주세요."];
        
        if (impactFrameIndexRef.current !== -1 && ballStartPosRef.current && ballEndPosRef.current && nosePosRef.current && anklePosRef.current && formRes) {
           finalSpeed = estimateSpeedKmh(
             nosePosRef.current,
             anklePosRef.current,
             ballStartPosRef.current,
             ballEndPosRef.current,
             5, // frames elapsed
             30 // fps
           );
           formScore = formRes.score;
           feedbacks = generateFeedback(formRes, finalSpeed);
        } else if (impactFrameIndexRef.current !== -1) {
           formRes = formRes || { score: 75, kneeAngle: 140, torsoLeanAngle: 20 };
           finalSpeed = 85; // Fallback
           formScore = formRes.score;
           feedbacks = generateFeedback(formRes, finalSpeed);
        }
        
        const result: AnalysisResult = {
          framesAnalyzed: frameCounterRef.current,
          estimatedSpeedKmh: finalSpeed, 
          formResult: formRes || { score: formScore, kneeAngle: 0, torsoLeanAngle: 0 }, 
          feedbacks,
          kickType: "Instep Power",
        };
        setAnalysisResult(result);
        
        try {
          const deviceId = localStorage.getItem('deviceId') || ('device_' + Math.random().toString(36).substring(7));
          localStorage.setItem('deviceId', deviceId);
          
          fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId,
              nickname: 'Guest Player',
              estimatedSpeedKmh: result.estimatedSpeedKmh,
              formScore: result.formResult.score,
              kickType: result.kickType,
            })
          }).catch(console.error);

          // Upload video if opted in
          if (optIn && videoFile) {
            const formData = new FormData();
            formData.append('video', videoFile);
            formData.append('deviceId', deviceId);
            formData.append('speed', finalSpeed.toString());
            
            fetch('/api/dataset/upload', {
              method: 'POST',
              body: formData
            }).catch(console.error);
          }
        } catch (e) {
          console.error(e);
        }
        
        return;
      }

      // We clear canvas every frame here, but workers return async, which might cause flickering.
      // For MVP, we clear it here and let workers draw when ready. 
      // If we want no flicker, we should await both workers, but that slows down video playback.
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      frameCounterRef.current += 1;

      if (!isPoseProcessingRef.current && !isBallProcessingRef.current) {
        try {
          isPoseProcessingRef.current = true;
          isBallProcessingRef.current = true;
          
          const imageBitmap1 = await createImageBitmap(video);
          const imageBitmap2 = await createImageBitmap(video);
          
          poseWorkerRef.current?.postMessage({
            type: "DETECT",
            imageBitmap: imageBitmap1,
            timestamp: performance.now()
          }, [imageBitmap1]); 

          ballWorkerRef.current?.postMessage({
            type: "DETECT",
            imageBitmap: imageBitmap2,
            timestamp: performance.now()
          }, [imageBitmap2]);
        } catch {
          isPoseProcessingRef.current = false;
          isBallProcessingRef.current = false;
        }
      }

      requestAnimationFrame(renderLoop);
    };

    renderLoop();
  };

  const handleShare = async () => {
    if (!shareCardRef.current || !analysisResult) return;
    setIsSharing(true);
    try {
      const canvas = await html2canvas(shareCardRef.current, {
        backgroundColor: '#000000',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) throw new Error('Canvas to Blob failed');
        const file = new File([blob], 'freekick-result.png', { type: 'image/png' });
        
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              title: 'My Freekick Analysis',
              text: `I just hit ${analysisResult.estimatedSpeedKmh}km/h with a form score of ${analysisResult.formResult.score}!`,
              files: [file]
            });
          } catch (shareErr) {
            triggerDownload(blob);
          }
        } else {
          triggerDownload(blob);
        }
      }, 'image/png');
    } catch (error) {
      alert('Failed to generate image. Please try again.');
    } finally {
      setIsSharing(false);
    }
  };

  const triggerDownload = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'freekick-result.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex flex-col p-8 relative">
      <header className="w-full max-w-4xl mx-auto flex items-center justify-between mb-12">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>Back to Home</span>
        </Link>
        <div className="font-mono text-sm tracking-widest text-[var(--color-neon-green)] flex items-center gap-2">
          {isModelLoading && <Loader2 size={14} className="animate-spin" />}
          ANALYSIS MODE
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto flex flex-col items-center">
        {!videoUrl ? (
          <div className="w-full max-w-2xl mt-12 flex flex-col gap-6">
            <div className="bg-white/5 backdrop-blur-sm border border-white/20 rounded-3xl p-8 flex flex-col items-center">
              <h2 className="text-2xl font-bold mb-2">Upload your Freekick Video</h2>
              <p className="text-gray-400 text-sm max-w-sm text-center mb-8">
                Make sure your full body and the ball are visible. We recommend recording at 60fps or higher.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
                <label className="flex-1 flex flex-col items-center justify-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 cursor-pointer transition-colors group">
                  <input type="file" accept="video/*" capture="environment" className="hidden" onChange={handleFileUpload} />
                  <span className="text-[var(--color-neon-green)] group-hover:scale-110 transition-transform text-2xl">📸</span>
                  <span className="font-bold text-sm">카메라로 촬영</span>
                </label>
                
                <label className="flex-1 flex flex-col items-center justify-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl p-4 cursor-pointer transition-colors group">
                  <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
                  <span className="text-[var(--color-neon-blue)] group-hover:scale-110 transition-transform text-2xl">🖼️</span>
                  <span className="font-bold text-sm">앨범에서 선택</span>
                </label>
              </div>
            </div>

            <label className="flex items-start gap-3 p-4 bg-white/5 border border-white/10 rounded-xl cursor-pointer hover:bg-white/10 transition-colors">
              <input 
                type="checkbox" 
                className="mt-1 w-5 h-5 accent-[var(--color-neon-green)] cursor-pointer"
                checked={optIn}
                onChange={(e) => setOptIn(e.target.checked)}
              />
              <div className="flex flex-col">
                <span className="font-bold text-sm text-white">AI 학습 데이터 제공 동의 (선택)</span>
                <span className="text-xs text-gray-400 mt-1">
                  동의 시 업로드하신 영상이 안전하게 저장되며, 더 정확한 프리킥 전용 AI 모델(자가개발)을 훈련하는 데 사용됩니다.
                </span>
              </div>
            </label>
          </div>
        ) : (
          <div className="w-full flex flex-col items-center gap-8">
            <div className="relative w-full max-w-3xl bg-black rounded-xl overflow-hidden border border-white/10 shadow-[0_0_30px_rgba(0,0,0,0.5)]">
              <video 
                ref={videoRef} 
                src={videoUrl} 
                className="w-full h-auto max-h-[60vh] object-contain"
                crossOrigin="anonymous"
                playsInline
                muted
                onLoadedMetadata={(e) => {
                  if (canvasRef.current) {
                    canvasRef.current.width = e.currentTarget.videoWidth;
                    canvasRef.current.height = e.currentTarget.videoHeight;
                  }
                }}
              />
              <canvas 
                ref={canvasRef} 
                className="absolute top-0 left-0 w-full h-full object-contain pointer-events-none"
              />
              
              {isAnalyzing && (
                <div className="absolute top-4 right-4 bg-black/50 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 border border-white/10 text-sm font-mono text-[var(--color-neon-green)]">
                  <Activity size={16} className="animate-pulse" />
                  ANALYZING...
                </div>
              )}
              
              {impactDetected && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-[var(--color-neon-green)]/20 text-[var(--color-neon-green)] border border-[var(--color-neon-green)] px-6 py-2 rounded-full font-bold animate-bounce font-mono">
                  IMPACT DETECTED!
                </div>
              )}
            </div>

            {!isAnalyzing && !analysisResult && (
              <div className="flex gap-4">
                <button onClick={() => setVideoUrl(null)} className="px-6 py-3 rounded-full font-bold border border-white/20 hover:bg-white/10 transition-colors">
                  Choose Another
                </button>
                <button 
                  onClick={startAnalysis}
                  disabled={isModelLoading}
                  className="px-8 py-3 rounded-full font-bold bg-white text-black hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isModelLoading ? <Loader2 className="animate-spin" size={20} /> : <Play size={20} />}
                  Start AI Analysis
                </button>
              </div>
            )}

            {analysisResult && (
              <div className="w-full max-w-3xl flex flex-col gap-6 animate-in slide-in-from-bottom-8 fade-in duration-700">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-green)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono">ESTIMATED SPEED</div>
                    <div className="text-4xl font-black text-white">{analysisResult.estimatedSpeedKmh}</div>
                    <div className="text-sm text-[var(--color-neon-green)] mt-1 font-mono">km/h</div>
                  </div>
                  
                  <div className="glass-card p-6 flex flex-col items-center text-center border-t-4 border-t-[var(--color-neon-blue)]">
                    <div className="text-gray-400 text-sm mb-2 font-mono">FORM SCORE</div>
                    <div className="text-4xl font-black text-white">{analysisResult.formResult.score}</div>
                    <div className="text-sm text-[var(--color-neon-blue)] mt-1 font-mono">/ 100 pts</div>
                  </div>

                  <div className="glass-card p-6 flex flex-col items-center justify-center text-center border-t-4 border-t-white/20 relative">
                    <div className="text-gray-400 text-sm mb-2 font-mono">KICK TYPE</div>
                    <div className="text-xl font-bold text-white">{analysisResult.kickType}</div>
                    <button 
                      onClick={handleShare}
                      disabled={isSharing}
                      className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors text-white disabled:opacity-50"
                    >
                      {isSharing ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                    </button>
                  </div>
                </div>

                <div className="glass-card p-6 border-t-4 border-t-[var(--color-neon-green)]/50">
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <Activity size={20} className="text-[var(--color-neon-green)]" />
                    AI Feedback
                  </h3>
                  <ul className="space-y-3">
                    {analysisResult.feedbacks.map((feedback, idx) => (
                      <li key={idx} className="flex items-start gap-3 text-gray-300">
                        <span className="text-[var(--color-neon-green)] mt-1">✓</span>
                        <span>{feedback}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <div className="absolute -left-[9999px] -top-[9999px]">
        {analysisResult && (
          <ShareCard 
            ref={shareCardRef}
            speed={analysisResult.estimatedSpeedKmh}
            formScore={analysisResult.formResult.score}
            kickType={analysisResult.kickType}
          />
        )}
      </div>
    </div>
  );
}
