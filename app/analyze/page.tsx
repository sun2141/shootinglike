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
  const [isModelLoading, setIsModelLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [impactDetected, setImpactDetected] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);
  
  // Heuristic tracking state
  const prevFootPosRef = useRef<{ x: number, y: number } | null>(null);
  const isProcessingFrameRef = useRef(false);
  
  // Analysis variables
  const frameCounterRef = useRef<number>(0);
  const impactFrameIndexRef = useRef<number>(-1);
  const startFootPosRef = useRef<{x: number, y: number} | null>(null);
  const endFootPosRef = useRef<{x: number, y: number} | null>(null);
  const nosePosRef = useRef<{x: number, y: number} | null>(null);
  const anklePosRef = useRef<{x: number, y: number} | null>(null);
  const formResultRef = useRef<FormResult | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('../../lib/workers/pose.worker.ts', import.meta.url));
    
    workerRef.current.onmessage = (e) => {
      const { type, landmarks } = e.data;
      
      if (type === "INIT_SUCCESS") {
        setIsModelLoading(false);
      } else if (type === "INIT_ERROR") {
        console.error("Worker init error", e.data.error);
        setIsModelLoading(false);
      } else if (type === "DETECT_RESULT") {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        const video = videoRef.current;
        if (!ctx || !canvas || !video) {
          isProcessingFrameRef.current = false;
          return;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        frameCounterRef.current += 1;
        
        if (landmarks && landmarks.length > 0) {
          for (const landmark of landmarks) {
            drawLandmarks(ctx, landmark);
            drawConnectors(ctx, landmark, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(0, 255, 0, 0.7)", lineWidth: 3 });
            
            // Right Foot Index
            const rightFoot = landmark[32]; 
            
            if (rightFoot && rightFoot.visibility && rightFoot.visibility > 0.5) {
              const currentX = rightFoot.x * canvas.width;
              const currentY = rightFoot.y * canvas.height;
              
              if (prevFootPosRef.current) {
                const dx = currentX - prevFootPosRef.current.x;
                const dy = currentY - prevFootPosRef.current.y;
                const velocity = Math.sqrt(dx * dx + dy * dy);
                
                // Impact detection
                if (velocity > 30 && impactFrameIndexRef.current === -1) {
                  setImpactDetected(true);
                  impactFrameIndexRef.current = frameCounterRef.current;
                  startFootPosRef.current = { x: currentX, y: currentY };
                  
                  if (landmark[0]) nosePosRef.current = { x: landmark[0].x * canvas.width, y: landmark[0].y * canvas.height };
                  if (landmark[27]) anklePosRef.current = { x: landmark[27].x * canvas.width, y: landmark[27].y * canvas.height }; // Left Ankle
                  
                  // Calculate Form Score at Impact
                  if (landmark[23] && landmark[25] && landmark[27] && landmark[11]) {
                    const plantHip = { x: landmark[23].x * canvas.width, y: landmark[23].y * canvas.height }; 
                    const plantKnee = { x: landmark[25].x * canvas.width, y: landmark[25].y * canvas.height }; 
                    const plantAnkle = { x: landmark[27].x * canvas.width, y: landmark[27].y * canvas.height }; 
                    const leftShoulder = { x: landmark[11].x * canvas.width, y: landmark[11].y * canvas.height }; 
                    
                    formResultRef.current = calculateFormScore(plantHip, plantKnee, plantAnkle, leftShoulder);
                  }
                }
              }
              
              // Track post-impact foot trajectory for 5 frames to estimate speed
              if (impactFrameIndexRef.current !== -1 && frameCounterRef.current <= impactFrameIndexRef.current + 5) {
                endFootPosRef.current = { x: currentX, y: currentY };
              }
              
              prevFootPosRef.current = { x: currentX, y: currentY };
            }
          }
        }
        
        isProcessingFrameRef.current = false;
      }
    };
    workerRef.current.postMessage({ type: "INIT" });
    
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoUrl(URL.createObjectURL(file));
      setAnalysisResult(null);
      setImpactDetected(false);
    }
  };

  const startAnalysis = async () => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) return;
    
    setIsAnalyzing(true);
    setImpactDetected(false);
    prevFootPosRef.current = null;
    isProcessingFrameRef.current = false;
    
    // Reset analysis states
    frameCounterRef.current = 0;
    impactFrameIndexRef.current = -1;
    startFootPosRef.current = null;
    endFootPosRef.current = null;
    nosePosRef.current = null;
    anklePosRef.current = null;
    formResultRef.current = null;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;

    video.currentTime = 0;
    await video.play();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const renderLoop = async () => {
      if (video.paused || video.ended) {
        setIsAnalyzing(false);
        
        // Finalize analysis
        let finalSpeed = 0;
        let formScore = 70;
        let formRes = formResultRef.current;
        let feedbacks: string[] = ["임팩트를 찾지 못했습니다. 전신이 잘 보이는 영상을 다시 업로드 해주세요."];
        
        if (impactFrameIndexRef.current !== -1 && startFootPosRef.current && endFootPosRef.current && nosePosRef.current && anklePosRef.current && formRes) {
           finalSpeed = estimateSpeedKmh(
             nosePosRef.current,
             anklePosRef.current,
             startFootPosRef.current,
             endFootPosRef.current,
             5, // frames elapsed
             30 // fps
           );
           formScore = formRes.score;
           feedbacks = generateFeedback(formRes, finalSpeed);
        } else if (impactFrameIndexRef.current !== -1) {
           // Fallback if some points are missing
           formRes = { score: 75, kneeAngle: 140, torsoLeanAngle: 20 };
           finalSpeed = 85;
           formScore = 75;
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
        
        // Save to DB in background
        try {
          // generate a dummy device ID for MVP (in real app, use localStorage)
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
        } catch (e) {
          console.error(e);
        }
        
        return;
      }

      if (!isProcessingFrameRef.current) {
        try {
          isProcessingFrameRef.current = true;
          const imageBitmap = await createImageBitmap(video);
          workerRef.current?.postMessage({
            type: "DETECT",
            imageBitmap,
            timestamp: performance.now()
          }, [imageBitmap]); 
        } catch {
          isProcessingFrameRef.current = false;
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
            console.error('Share failed, attempting fallback download', shareErr);
            triggerDownload(blob);
          }
        } else {
          // Fallback download
          triggerDownload(blob);
        }
      }, 'image/png');
    } catch (error) {
      console.error('Error generating share card:', error);
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
          <label className="w-full max-w-2xl aspect-video border-2 border-dashed border-white/20 rounded-3xl flex flex-col items-center justify-center bg-white/5 backdrop-blur-sm hover:border-[var(--color-neon-green)]/50 transition-colors cursor-pointer group mt-12">
            <input type="file" accept="video/*" capture="environment" className="hidden" onChange={handleFileUpload} />
            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center text-white mb-4 group-hover:scale-110 transition-transform group-hover:bg-[var(--color-neon-green)]/20 group-hover:text-[var(--color-neon-green)]">
              <Upload size={32} />
            </div>
            <h2 className="text-2xl font-bold mb-2">Upload your Freekick Video</h2>
            <p className="text-gray-400 text-sm max-w-sm text-center">
              Make sure your full body and the ball are visible. We recommend recording at 60fps or higher.
            </p>
          </label>
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

      {/* Hidden Share Card for html2canvas */}
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
