import Link from 'next/link';
import { Activity, Zap, Target } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[var(--color-neon-green)]/10 rounded-full blur-[120px] -z-10" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[var(--color-neon-blue)]/10 rounded-full blur-[120px] -z-10" />

      <main className="max-w-4xl w-full flex flex-col items-center text-center space-y-12">
        
        {/* Hero Section */}
        <div className="space-y-6">
          <div className="inline-block px-4 py-1.5 rounded-full border border-white/10 bg-white/5 backdrop-blur-md mb-4">
            <span className="text-sm font-medium tracking-wider text-gray-300 uppercase">
              Pro-Level Analysis in Your Pocket
            </span>
          </div>
          
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter text-white">
            MASTER YOUR <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--color-neon-green)] to-[var(--color-neon-blue)]">
              FREEKICK
            </span>
          </h1>
          
          <p className="text-xl text-gray-400 max-w-2xl mx-auto font-light">
            Upload your video. Get instant AI-powered feedback on ball speed, posture, and accuracy. No expensive equipment needed.
          </p>
        </div>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
          <Link 
            href="/analyze"
            className="px-8 py-4 bg-white text-black font-bold rounded-full hover:scale-105 transition-transform duration-300 shadow-[0_0_20px_rgba(255,255,255,0.3)] text-lg"
          >
            Start Analysis
          </Link>
          <Link 
            href="/leaderboard"
            className="px-8 py-4 bg-transparent border border-white/20 text-white font-bold rounded-full hover:bg-white/10 transition-colors duration-300 text-lg"
          >
            Leaderboard
          </Link>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full mt-16 pt-16 border-t border-white/10">
          <div className="glass-card p-6 flex flex-col items-center text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-green)]/10 flex items-center justify-center text-[var(--color-neon-green)] mb-2">
              <Zap size={24} />
            </div>
            <h3 className="text-xl font-bold">Speed Est.</h3>
            <p className="text-gray-400 text-sm">Calculate initial ball speed based on your physical scale.</p>
          </div>
          
          <div className="glass-card p-6 flex flex-col items-center text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-[var(--color-neon-blue)]/10 flex items-center justify-center text-[var(--color-neon-blue)] mb-2">
              <Activity size={24} />
            </div>
            <h3 className="text-xl font-bold">Form Check</h3>
            <p className="text-gray-400 text-sm">AI posture analysis to correct your plant foot and follow-through.</p>
          </div>

          <div className="glass-card p-6 flex flex-col items-center text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white mb-2">
              <Target size={24} />
            </div>
            <h3 className="text-xl font-bold">Compete</h3>
            <p className="text-gray-400 text-sm">Rank up on the global leaderboard with your best strikes.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
