'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Play, Pause, RotateCcw, Volume2, VolumeX, SkipForward,
  Layers, Database, Shield, Zap, TrendingUp, Cpu, CheckCircle, ArrowRight,
} from 'lucide-react';
import { PRESENTATION_SCENES } from './data';
import type { PresentationScene } from './types';

export function VideoSimulator() {
  const [activeSceneIndex, setActiveSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [audioSupported, setAudioSupported] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedProgressRef = useRef<number>(0);
  const speakTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scene: PresentationScene = PRESENTATION_SCENES[activeSceneIndex];

  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      setAudioSupported(true);
    }
  }, []);

  const stopSpeech = () => {
    if (speakTimeoutRef.current) { clearTimeout(speakTimeoutRef.current); speakTimeoutRef.current = null; }
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
  };

  const speakText = (text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis || isMuted) return;
    stopSpeech();
    speakTimeoutRef.current = setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.88;
      utterance.pitch = 1.1;
      const voices = window.speechSynthesis.getVoices();
      const femaleNames = ['samantha', 'zira', 'eva', 'hazel', 'karen', 'moira', 'tessa', 'fiona', 'victoria', 'female'];
      const voice =
        voices.find(v => v.lang.startsWith('en-') && femaleNames.some(n => v.name.toLowerCase().includes(n)) && v.name.toLowerCase().includes('enhanced')) ||
        voices.find(v => v.lang.startsWith('en-') && femaleNames.some(n => v.name.toLowerCase().includes(n))) ||
        voices.find(v => v.lang.startsWith('en-') && v.name.toLowerCase().includes('natural')) ||
        voices.find(v => v.lang.startsWith('en-'));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    }, 800);
  };

  useEffect(() => {
    if (isMuted) {
      stopSpeech();
    } else if (isPlaying) {
      speakText(scene.voiceText);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMuted]);

  const getSceneDuration = (s: PresentationScene, muted: boolean) => {
    if (muted) return s.durationMs;
    const wordCount = s.voiceText.split(/\s+/).filter(Boolean).length;
    return 800 + (wordCount / 1.75) * 1000 + 1500;
  };

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (isPlaying) {
      speakText(scene.voiceText);
      const sceneDuration = getSceneDuration(scene, isMuted);
      startTimeRef.current = Date.now() - (pausedProgressRef.current * sceneDuration) / 100;
      const SLIDE_PAUSE_MS = 2000;
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setProgress(Math.min((elapsed / sceneDuration) * 100, 100));
        if (elapsed >= sceneDuration + SLIDE_PAUSE_MS) {
          clearInterval(timerRef.current!);
          pausedProgressRef.current = 0;
          setProgress(0);
          setActiveSceneIndex(prev => prev < PRESENTATION_SCENES.length - 1 ? prev + 1 : 0);
        }
      }, 50);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      stopSpeech();
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.pause();
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (speakTimeoutRef.current) { clearTimeout(speakTimeoutRef.current); speakTimeoutRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, activeSceneIndex, isMuted]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      if (isPlaying) {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } else {
        window.speechSynthesis.pause();
      }
    }
  }, [isPlaying]);

  const handlePlayPause = () => {
    if (isPlaying) { pausedProgressRef.current = progress; setIsPlaying(false); }
    else setIsPlaying(true);
  };

  const handleRestart = () => {
    stopSpeech();
    pausedProgressRef.current = 0; setProgress(0); setActiveSceneIndex(0); setIsPlaying(true);
  };

  const handleSkip = () => {
    stopSpeech();
    pausedProgressRef.current = 0; setProgress(0);
    setActiveSceneIndex(prev => prev < PRESENTATION_SCENES.length - 1 ? prev + 1 : 0);
  };

  const handleSelectScene = (index: number) => {
    stopSpeech();
    pausedProgressRef.current = 0; setProgress(0); setActiveSceneIndex(index); setIsPlaying(true);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm flex flex-col md:grid md:grid-cols-12 md:min-h-[580px] text-slate-800">

      {/* Left playback area */}
      <div className="md:col-span-8 flex flex-col justify-between bg-[#0b0f19] p-6 relative group border-r border-slate-200/50">

        {/* Progress bar */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-slate-800">
          <div className="h-full bg-blue-500 transition-all duration-75" style={{ width: `${progress}%` }} />
        </div>

        {/* Header */}
        <div className="flex justify-between items-center pb-4 border-b border-slate-800/60 z-10">
          <div className="flex items-center gap-2">
            <span className="flex h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-[10px] font-mono tracking-wider uppercase text-slate-400">Essbase OCI Portal</span>
          </div>
          <span className="text-[10px] font-mono text-blue-400 bg-blue-950/40 border border-blue-900/50 px-2 py-0.5 rounded">
            Scene {scene.id} of {PRESENTATION_SCENES.length}
          </span>
        </div>

        {/* Visual stage */}
        <div className="my-8 flex items-center justify-center min-h-[280px] relative">

          {/* INTRO */}
          {scene.visualType === 'intro' && (
            <div className="w-full max-w-lg animate-fade-in flex flex-col items-center relative rounded-2xl overflow-hidden border border-slate-800 bg-slate-950 shadow-2xl min-h-[240px]">
              <div className="absolute inset-0 opacity-40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/tractor_assembly.jpg"
                  alt="Tractor assembly line"
                  className="w-full h-full object-cover brightness-75 scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/85 to-slate-950/30" />
              </div>
              <div className="relative z-10 p-8 text-center flex flex-col items-center">
                <div className="mb-4">
                  <div className="w-16 h-16 rounded-2xl border-2 border-emerald-400 bg-slate-900/95 flex items-center justify-center text-emerald-400 shadow-xl">
                    <Database size={30} />
                  </div>
                </div>
                <h2 className="text-2xl font-sans font-extrabold text-white tracking-tight mb-2 uppercase">{scene.title}</h2>
                <div className="h-0.5 w-12 bg-blue-500 mb-3" />
                <p className="text-xs text-slate-300 font-sans tracking-wide max-w-xs mb-1">{scene.subtitle}</p>
                <p className="text-[10px] text-slate-400 font-mono uppercase tracking-widest">Oracle Essbase 21c Hybrid Engine</p>
              </div>
            </div>
          )}

          {/* CUBE */}
          {scene.visualType === 'cube' && (
            <div className="w-full max-w-xl flex flex-col md:grid md:grid-cols-12 gap-4 animate-fade-in">
              <div className="md:col-span-8 flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl shadow-lg">
                    <div className="flex items-center gap-1.5 mb-2 text-emerald-400">
                      <Database size={14} />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Dense Financials</span>
                    </div>
                    <div className="space-y-1 font-mono text-[10px] text-slate-300">
                      <div className="bg-emerald-950/20 border border-emerald-900/30 p-1 rounded flex justify-between">
                        <span>Measures</span><span className="text-emerald-500 font-bold">BSO</span>
                      </div>
                      <div className="bg-slate-950 p-1 rounded flex justify-between border border-slate-800">
                        <span>Scenario</span><span className="text-slate-500">Fast Calc</span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl shadow-lg">
                    <div className="flex items-center gap-1.5 mb-2 text-indigo-400">
                      <Layers size={14} />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Sparse Hierarchies</span>
                    </div>
                    <div className="space-y-1 font-mono text-[10px] text-slate-300">
                      <div className="bg-indigo-950/20 border border-indigo-900/30 p-1 rounded flex justify-between">
                        <span>Product/Model</span><span className="text-indigo-400 font-bold">Hybrid</span>
                      </div>
                      <div className="bg-slate-950 p-1 rounded flex justify-between border border-slate-800">
                        <span>Plant/Geo</span><span className="text-slate-500">ASO</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="bg-slate-900/50 border border-slate-800/80 p-2.5 rounded-lg text-center font-mono text-[9px] text-slate-400 flex items-center justify-center gap-2">
                  <span>Product Sparse</span>
                  <span className="text-slate-600">&#10145;</span>
                  <span className="bg-indigo-950 px-1.5 py-0.5 rounded border border-indigo-900/40 text-indigo-300">Aggregates Dynamic</span>
                  <span className="text-slate-600">&#10145;</span>
                  <span className="bg-emerald-950 px-1.5 py-0.5 rounded border border-emerald-900/40 text-emerald-300">BSO blocks</span>
                </div>
              </div>
              <div className="md:col-span-4 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col justify-between shadow-lg relative min-h-[140px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/high_tech_tractor.jpg" alt="High Tech Tractor" className="w-full h-24 object-cover" />
                <div className="p-2 bg-slate-950 text-[9px] text-slate-400 font-mono leading-normal border-t border-slate-800">
                  <span className="text-white block font-bold text-[9.5px]">Model Sparse Hierarchy</span>
                  Resolves Series (Compact, Utility, Row-Crop) block dimensions dynamically.
                </div>
              </div>
            </div>
          )}

          {/* ARCHITECTURE */}
          {scene.visualType === 'architecture' && (
            <div className="w-full max-w-xl animate-fade-in">
              <svg viewBox="0 0 540 240" className="w-full h-auto font-mono">
                <rect x="10" y="90" width="80" height="60" rx="6" fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
                <text x="50" y="115" fill="#f8fafc" fontSize="9" textAnchor="middle" fontWeight="bold">Smart View</text>
                <text x="50" y="130" fill="#94a3b8" fontSize="8" textAnchor="middle">Excel Client</text>
                <text x="50" y="142" fill="#38bdf8" fontSize="7" textAnchor="middle">On-Premise</text>
                <path d="M 90 120 L 140 120" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
                <text x="115" y="110" fill="#10b981" fontSize="7" textAnchor="middle">FastConnect</text>
                <rect x="140" y="10" width="380" height="220" rx="10" fill="#0f172a" stroke="#0284c7" strokeWidth="1.5" strokeDasharray="3 3" />
                <text x="150" y="25" fill="#0284c7" fontSize="8" fontWeight="bold">OCI Virtual Cloud Network (VCN)</text>
                <rect x="160" y="50" width="80" height="140" rx="8" fill="#1e293b" stroke="#64748b" strokeWidth="1" />
                <text x="200" y="65" fill="#94a3b8" fontSize="8" textAnchor="middle" fontWeight="bold">PUBLIC</text>
                <text x="200" y="75" fill="#94a3b8" fontSize="7" textAnchor="middle">SUBNET</text>
                <rect x="170" y="100" width="60" height="30" rx="4" fill="#0284c7" stroke="#38bdf8" strokeWidth="1" />
                <text x="200" y="118" fill="#ffffff" fontSize="8" textAnchor="middle">Public LB</text>
                <rect x="170" y="145" width="60" height="30" rx="4" fill="#334155" stroke="#475569" strokeWidth="1" />
                <text x="200" y="163" fill="#94a3b8" fontSize="8" textAnchor="middle">Bastion VM</text>
                <rect x="270" y="40" width="120" height="160" rx="8" fill="#0b1329" stroke="#10b981" strokeWidth="1" />
                <text x="330" y="55" fill="#10b981" fontSize="8" textAnchor="middle" fontWeight="bold">PRIVATE APP SUBNET</text>
                <rect x="280" y="70" width="100" height="35" rx="4" fill="#022c22" stroke="#059669" strokeWidth="1.5" />
                <text x="330" y="87" fill="#ffffff" fontSize="8" textAnchor="middle" fontWeight="bold">Essbase Server 1</text>
                <text x="330" y="97" fill="#34d399" fontSize="7" textAnchor="middle">Primary Compute VM</text>
                <rect x="280" y="115" width="100" height="35" rx="4" fill="#0b1329" stroke="#334155" strokeWidth="1" />
                <text x="330" y="132" fill="#94a3b8" fontSize="8" textAnchor="middle">Essbase Server 2</text>
                <text x="330" y="142" fill="#475569" fontSize="7" textAnchor="middle">HA Failover Node</text>
                <rect x="280" y="160" width="100" height="30" rx="4" fill="#1e1b4b" stroke="#4f46e5" strokeWidth="1" />
                <text x="330" y="174" fill="#c7d2fe" fontSize="8" textAnchor="middle">OCI FSS Mount</text>
                <text x="330" y="183" fill="#818cf8" fontSize="7" textAnchor="middle">Shared Cubes &amp; Logs</text>
                <rect x="410" y="50" width="100" height="140" rx="8" fill="#1c1917" stroke="#f59e0b" strokeWidth="1" />
                <text x="460" y="65" fill="#f59e0b" fontSize="8" textAnchor="middle" fontWeight="bold">PRIVATE DB</text>
                <rect x="420" y="90" width="80" height="50" rx="4" fill="#451a03" stroke="#d97706" strokeWidth="1.5" />
                <text x="460" y="112" fill="#ffffff" fontSize="8" textAnchor="middle" fontWeight="bold">Oracle ADW</text>
                <text x="460" y="122" fill="#fbbf24" fontSize="7" textAnchor="middle">Repository &amp; DB</text>
                <path d="M 240 115 L 270 90" stroke="#10b981" strokeWidth="1" />
                <path d="M 380 90 L 410 110" stroke="#6366f1" strokeWidth="1" strokeDasharray="2 2" />
                <path d="M 380 175 L 420 120" stroke="#f59e0b" strokeWidth="1" />
              </svg>
            </div>
          )}

          {/* ROADMAP */}
          {scene.visualType === 'roadmap' && (
            <div className="w-full max-w-lg flex flex-col gap-6 animate-fade-in">
              <h3 className="text-white text-xs font-mono uppercase tracking-wider text-center">Gated Implementation Progression</h3>
              <div className="relative">
                <div className="absolute top-1/2 left-0 right-0 h-1 bg-slate-800 -translate-y-1/2" />
                <div
                  className="absolute top-1/2 left-0 h-1 bg-indigo-500 -translate-y-1/2 transition-all duration-300"
                  style={{ width: `${(scene.id - 1) * 25}%` }}
                />
                <div className="grid grid-cols-5 relative justify-between text-center">
                  {([
                    { phase: 'Phase 1-2', name: 'Foundation',   Icon: Shield },
                    { phase: 'Phase 3',   name: 'Modernize',    Icon: Cpu },
                    { phase: 'Phase 4',   name: 'Integrations', Icon: Database },
                    { phase: 'Phase 5',   name: 'Testing Gate', Icon: Zap },
                    { phase: 'Phase 6',   name: 'Go-Live',      Icon: TrendingUp },
                  ] as const).map(({ phase, name, Icon }, idx) => {
                    const isActive = idx <= activeSceneIndex;
                    return (
                      <div key={idx} className="flex flex-col items-center">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                          isActive
                            ? 'bg-slate-900 border-2 border-indigo-400 text-indigo-400 scale-110'
                            : 'bg-slate-950 border border-slate-800 text-slate-600'
                        }`}>
                          <Icon size={14} />
                        </div>
                        <span className="text-[9px] font-mono mt-2 text-slate-400 block">{phase}</span>
                        <span className={`text-[10px] font-bold ${isActive ? 'text-white' : 'text-slate-600'}`}>{name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-3 rounded-lg text-left">
                <p className="text-[10px] font-mono text-indigo-400 uppercase tracking-widest font-bold">Testing Focus</p>
                <p className="text-xs text-slate-300 mt-1">Active gate checks verify rule logic conversions and data accuracy before DNS cutover. 30-day parallel operation with automated comparison.</p>
              </div>
            </div>
          )}

          {/* GAINS */}
          {scene.visualType === 'gains' && (
            <div className="w-full max-w-xl flex flex-col md:grid md:grid-cols-12 gap-4 animate-fade-in">
              <div className="md:col-span-7 bg-slate-900 border border-slate-800 p-4 rounded-xl shadow-xl space-y-4">
                <h4 className="text-xs font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <Zap size={14} className="text-emerald-400 animate-pulse" />
                  Manufacturing Planning Speedup Benchmarks
                </h4>
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                      <span>On-Premise Batch Aggregation</span>
                      <span className="text-rose-400 font-bold">8.4 Hours</span>
                    </div>
                    <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                      <div className="h-full bg-rose-500 rounded-full" style={{ width: '95%' }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                      <span>OCI Hybrid Storage Engine</span>
                      <span className="text-emerald-400 font-bold">4.2 Sec (Instant)</span>
                    </div>
                    <div className="h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: '1.5%' }} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center pt-1 font-mono text-[10px]">
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-[8px] text-slate-500 block uppercase">Query Speedup</span>
                    <span className="text-xs font-bold text-emerald-400">7,200x Faster</span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800">
                    <span className="text-[8px] text-slate-500 block uppercase">Overhead</span>
                    <span className="text-xs font-bold text-emerald-400">Reduced 60%</span>
                  </div>
                </div>
              </div>
              <div className="md:col-span-5 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col justify-between shadow-lg relative min-h-[140px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/tractor_assembly.jpg" alt="Tractor Assembly" className="w-full h-24 object-cover" />
                <div className="p-2 bg-slate-950 text-[9px] text-slate-400 font-mono leading-normal border-t border-slate-800">
                  <span className="text-white block font-bold text-[9.5px]">Real-time Simulations</span>
                  Enables instantaneous labor, parts, and assembly what-if forecasting.
                </div>
              </div>
            </div>
          )}

          {/* SUMMARY */}
          {scene.visualType === 'summary' && (
            <div className="w-full max-w-md bg-slate-900 border border-slate-800 p-6 rounded-xl shadow-xl animate-fade-in space-y-5">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <CheckCircle size={16} className="text-emerald-400" />
                Project Outcomes &amp; Go-Live Readiness
              </h4>
              <div className="grid grid-cols-2 gap-3 text-center font-mono">
                {[
                  { label: 'Aggregation Time', value: '4.2 Sec', sub: 'was 8.4 hours', color: 'text-emerald-400' },
                  { label: 'Performance Gain', value: '7,200×',  sub: 'faster',        color: 'text-emerald-400' },
                  { label: 'Admin Overhead',   value: '−60%',    sub: 'reduced',        color: 'text-blue-400'   },
                  { label: 'Migration Phases', value: '6 Gated', sub: 'zero data loss', color: 'text-indigo-400' },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                    <span className="text-[9px] text-slate-500 block uppercase">{label}</span>
                    <span className={`text-sm font-bold ${color}`}>{value}</span>
                    <span className="text-[9px] text-slate-500 block">{sub}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest font-bold">Next Steps</span>
                {[
                  'DNS cutover and go-live validation',
                  'Smart View connectivity testing for all plants',
                  'Decommission on-premise server cluster',
                  'Schedule quarterly OCI cost review',
                ].map((step) => (
                  <div key={step} className="flex items-start gap-2 text-[11px] text-slate-300">
                    <ArrowRight size={10} className="text-emerald-400 mt-0.5 shrink-0" />
                    <span>{step}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Narrator script */}
        <div className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 min-h-[90px] relative z-10">
          <div className="absolute top-2 left-3 flex items-center gap-1.5 text-blue-400 uppercase tracking-widest font-mono text-[9px]">
            <Volume2 size={10} />
            <span>Narrator Voice-over Script</span>
          </div>
          <p className="text-xs text-slate-200 mt-3 font-sans leading-relaxed italic">&ldquo;{scene.voiceText}&rdquo;</p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap justify-between items-center gap-4 mt-6 pt-4 border-t border-slate-800/60">
          <div className="flex items-center gap-2">
            <button onClick={handlePlayPause} className="p-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer" title={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <button onClick={handleRestart} className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer" title="Restart">
              <RotateCcw size={16} />
            </button>
            <button onClick={handleSkip} className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer" title="Next Slide">
              <SkipForward size={16} />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono border transition-all cursor-pointer ${
                isMuted
                  ? 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                  : 'bg-blue-950/40 border-blue-900/50 text-blue-400 hover:bg-blue-950/60'
              }`}
            >
              {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              <span>{isMuted ? 'Sound Off' : 'Sound On'}</span>
            </button>
            {!audioSupported && (
              <span className="text-[10px] text-amber-500 font-mono">TTS not supported</span>
            )}
          </div>
        </div>
      </div>

      {/* Right scene nav */}
      <div className="md:col-span-4 bg-slate-50 p-6 flex flex-col justify-between border-l border-slate-200">
        <div className="space-y-4">
          <h3 className="text-sm font-sans font-bold text-slate-800 tracking-tight">Presentation Outline</h3>
          <p className="text-xs text-slate-500">Click any section to navigate to that architectural viewpoint.</p>
          <div className="space-y-2.5">
            {PRESENTATION_SCENES.map((s, idx) => {
              const isActive = idx === activeSceneIndex;
              return (
                <button
                  key={s.id}
                  onClick={() => handleSelectScene(idx)}
                  className={`w-full text-left p-3 rounded-xl border transition-all text-xs flex flex-col gap-1 cursor-pointer ${
                    isActive
                      ? 'bg-white border-blue-500 text-slate-950 shadow-sm'
                      : 'bg-white/40 border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex justify-between items-center w-full">
                    <span className={`font-mono text-[10px] uppercase font-bold tracking-wider ${isActive ? 'text-blue-600' : 'text-slate-400'}`}>
                      Slide {s.id}
                    </span>
                    {isActive && isPlaying && (
                      <span className="text-[9px] text-blue-600 flex items-center gap-1 font-semibold">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-pulse" />
                        Live
                      </span>
                    )}
                  </div>
                  <span className={`font-sans font-bold ${isActive ? 'text-slate-900' : 'text-slate-700'}`}>{s.title}</span>
                  <span className={`text-[11px] line-clamp-1 ${isActive ? 'text-slate-600' : 'text-slate-500'}`}>{s.subtitle}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="bg-white border border-slate-200 p-4 rounded-xl mt-6">
          <span className="text-[10px] font-mono text-blue-600 uppercase tracking-widest font-bold">Executive Context</span>
          <p className="text-xs text-slate-600 mt-2 leading-relaxed font-sans">{scene.description}</p>
        </div>
      </div>
    </div>
  );
}
