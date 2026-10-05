import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Mic, MicOff, Volume2, Bell, X, FolderSearch, AppWindow, Camera, Sparkles,
  CheckCircle2, XCircle, Loader2, Minus, Square, Send, Terminal, Settings,
  Wand2, Maximize, Minimize, Radio, MoonStar, Eye, EyeOff
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import NimoFace from "./components/NimoFace";
import PointerBuddy from "./components/PointerBuddy";
import StageErrorBoundary from "./components/StageErrorBoundary";
import Markdown from "./components/Markdown";
import { useNimoAgent } from "./hooks/useNimoAgent";
import type {
  FaceState, LogEntry, TimerInfo, PersonalityTrait,
  AgentCard, InstalledApp, FileHit
} from "./types";

type RightDock = "activity" | "logs" | null;
type LeftDock = "tools" | "settings" | null;

const TOOL_EMOJI: Record<string, string> = {
  get_weather: "🌦️", answer_from_web: "📚", research_topic: "🔬",
  launch_app: "🚀", find_installed_apps: "🗂️", search_files: "📁",
  take_screenshot: "📸", set_timer: "⏱️", play_music: "🎵",
  search_the_web: "🔎", open_website: "🌐"
};

const STATUS_TEXT: Record<FaceState, string> = {
  idle: "hovering nearby", listening: 'listening for "hey nimo"',
  thinking: "thinking", talking: "talking", happy: "delighted",
  confused: "needs your answer", error: "something broke", music: "vibing"
};

export default function App() {
  const bridge = (window as any).nimo || null;
  const isElectron = Boolean(bridge);
  const API = isElectron ? "http://localhost:3001" : "";

  const {
    faceState, caption, setCaption, steps, cards, needsClarification, busy,
    pendingApproval, approve, lastAgentText, voiceEngine,
    ask, speak, voiceEnabled, setVoiceEnabled, wakeRequired, setWakeRequired,
    silentMode, setSilentMode,
    transcript, setPersonality: pushPersonality, mouse
  } = useNimoAgent({ autoVoice: false, sessionId: "dashboard", listenPushes: false });

  const [manualInput, setManualInput] = useState("");
  const [personality, setPersonality] = useState<PersonalityTrait>("friendly");
  const [glow, setGlow] = useState(60);
  const [buddyOn, setBuddyOn] = useState(true);
  const [controlMode, setControlMode] = useState<"ask" | "granted">("ask");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [companionVisible, setCompanionVisible] = useState(true);
  const [rightDock, setRightDock] = useState<RightDock>("activity");
  const [leftDock, setLeftDock] = useState<LeftDock>(null);

  // Backend-synced state
  const [logsList, setLogsList] = useState<LogEntry[]>([]);
  const [backendTimers, setBackendTimers] = useState<TimerInfo[]>([]);
  const [timerNotifications, setTimerNotifications] = useState<Array<{ id: string; label: string }>>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [appFilter, setAppFilter] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileFolder, setFileFolder] = useState("");
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // ── Logs & timers polling ───────────────────────────────────────────────
  const syncLogsAndTimers = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/logs`);
      if (res.ok) setLogsList((await res.json()).logs || []);
      const t = await fetch(`${API}/api/timers`);
      if (t.ok) setBackendTimers((await t.json()).timers || []);
    } catch { /* offline */ }
  }, [API]);

  useEffect(() => {
    syncLogsAndTimers();
    const i = setInterval(syncLogsAndTimers, 1000);
    return () => clearInterval(i);
  }, [syncLogsAndTimers]);

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logsList.length]);

  // ── Timer notifications (Electron push) ─────────────────────────────────
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.on("nimo:timer-done", (payload: any) => {
      if (!payload) return;
      const id = payload.id || Date.now().toString();
      setTimerNotifications((prev) => [...prev, { id, label: payload.label || "Timer" }]);
      setTimeout(() => setTimerNotifications((prev) => prev.filter((n) => n.id !== id)), 8000);
    });
    return off;
  }, [bridge]);

  // ── Fullscreen sync (Electron reports F11 too) ──────────────────────────
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = async () => {
    if (bridge) {
      bridge.windowControl?.("toggle-fullscreen");
      setIsFullscreen((f) => !f);
    } else {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { /* user gesture required */ }
    }
  };

  // ── Companion visibility toggle (show/hide the floating creature) ───────
  const toggleCompanion = async () => {
    try {
      const res = await bridge?.invoke("nimo:toggle-companion");
      const v = (res as any)?.data?.visible ?? (res as any)?.visible;
      setCompanionVisible(typeof v === "boolean" ? v : !companionVisible);
    } catch {
      setCompanionVisible((c) => !c);
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────────
  const submitCommand = async (text: string) => {
    if (!text.trim() || busy) return;
    // server.ts (or the backend's own buffer in Electron) logs the exchange.
    await ask(text, personality);
    if (rightDock === null) setRightDock("activity");
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = manualInput;
    setManualInput("");
    submitCommand(cmd);
  };

  const choosePersonality = (p: PersonalityTrait, name: string) => {
    setPersonality(p);
    pushPersonality(p);
    speak(`Personality set to ${name}.`, "happy");
  };

  const loadApps = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/os/apps`);
      if (res.ok) setInstalledApps(((await res.json()).apps || []) as InstalledApp[]);
    } catch { /* noop */ }
  }, [API]);

  useEffect(() => { if (leftDock === "tools") loadApps(); }, [leftDock, loadApps]);

  // Load + toggle the computer-control mode (ask first / granted).
  useEffect(() => {
    if (leftDock !== "settings") return;
    fetch(`${API}/api/agent/control-mode`).then((r) => r.json()).then((d) => {
      if (d?.mode) setControlMode(d.mode);
    }).catch(() => {});
  }, [leftDock, API]);

  const toggleControlMode = () => {
    const next = controlMode === "granted" ? "ask" : "granted";
    setControlMode(next);
    fetch(`${API}/api/agent/control-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    }).catch(() => {});
    speak(next === "granted"
      ? "Computer control granted. I can now click and type on your screen when you ask."
      : "Computer control set back to asking first.", "happy");
  };

  const toggleSilentMode = () => {
    const next = !silentMode;
    setSilentMode(next);
    if (next) {
      // Fully silent = type-only: force the mic off.
      setVoiceEnabled(false);
      setCaption("Silent mode — I will answer in the cloud popup.");
    } else {
      speak("Talking mode back on.", "happy");
    }
  };

  const runFileSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileQuery.trim()) return;
    setFileSearching(true);
    try {
      const res = await fetch(`${API}/api/os/search-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fileQuery, folder: fileFolder || undefined })
      });
      const data = await res.json();
      setFileHits(data.results || []);
    } catch { /* noop */ }
    setFileSearching(false);
  };

  const takeScreenshot = async () => {
    try {
      if (bridge) {
        // Speak the real absolute path so the location is never a mystery.
        const res = await bridge.invoke("nimo:take-screenshot");
        const p = (res as any)?.data?.path as string | undefined;
        speak(p ? `Screenshot saved at ${p.split("\\").join(", ")}.` : "Screenshot saved in Pictures, NIMO Screenshots.", "happy");
      } else {
        await fetch(`${API}/api/run-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: "take a screenshot" })
        });
        speak("Screenshot saved in your Pictures folder, inside NIMO Screenshots.", "happy");
      }
    } catch { /* noop */ }
  };

  // ── Rich cards ──────────────────────────────────────────────────────────
  const renderCard = (card: AgentCard, i: number) => {
    switch (card.type) {
      case "weather":
        return (
          <div key={i} className="rounded-2xl border border-[#6d7ef2]/30 bg-gradient-to-br from-[#101a3d]/90 to-[#0a0f24]/90 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Live weather</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{String(card.place || "")}</p>
              </div>
              <span className="font-mono text-3xl font-bold text-[#a9b8ff]">{String(card.temperature ?? "–")}°</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/55">
              <span>{String(card.condition || "")}</span>
              <span>Feels {String(card.feelsLike ?? "–")}°</span>
              <span>Humidity {String(card.humidity ?? "–")}%</span>
              <span>Wind {String(card.windKph ?? "–")} km/h</span>
              <span>H {String(card.high ?? "–")}° / L {String(card.low ?? "–")}°</span>
            </div>
          </div>
        );
      case "knowledge":
        return (
          <div key={i} className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Knowledge lookup</p>
            <p className="mt-0.5 text-sm font-semibold text-white">{String(card.title || "")}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-white/65">{String(card.extract || "").slice(0, 400)}</p>
            {card.url ? (
              <a href={String(card.url)} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[11px] text-[#a9b8ff] hover:underline">Read the source →</a>
            ) : null}
          </div>
        );
      case "report":
        return (
          <div key={i} className="rounded-2xl border border-[#a78bfa]/30 bg-gradient-to-br from-[#170f38]/85 to-[#0a0d20]/90 p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[#c4b5fd]">Research briefing · {String(card.topic || "")}</p>
            <Markdown text={String(card.report || "")} className="mt-2 max-h-72 overflow-y-auto custom-scrollbar text-[12px] text-white/75" />
            {Array.isArray(card.sources) && (card.sources as Array<{ title: string; url: string }>).length > 0 && (
              <div className="mt-3 border-t border-white/10 pt-2.5">
                <p className="text-[10px] uppercase tracking-[0.15em] text-white/40">Sources</p>
                <ul className="mt-1.5 space-y-1">
                  {(card.sources as Array<{ title: string; url: string }>).map((s, si) => (
                    <li key={si}><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-[#a9b8ff] hover:underline">[{si + 1}] {s.title}</a></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      case "files":
        return (
          <div key={i} className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Files found (read-only)</p>
            <ul className="mt-2 space-y-1.5">
              {((card.results as FileHit[]) || []).map((f, fi) => (
                <li key={fi} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5">
                  <p className="text-[12px] text-white/85">{f.name}</p>
                  <p className="truncate font-mono text-[10px] text-white/35">{f.path}</p>
                </li>
              ))}
            </ul>
          </div>
        );
      case "search":
        return (
          <div key={i} className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">Web results</p>
            <ul className="mt-2 space-y-2">
              {((card.results as Array<{ title: string; url: string; snippet: string }>) || []).map((r, ri) => (
                <li key={ri}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-[#a9b8ff] hover:underline">{r.title}</a>
                  <p className="text-[11px] text-white/50 line-clamp-2">{r.snippet}</p>
                </li>
              ))}
            </ul>
          </div>
        );
      default:
        return null;
    }
  };

  const iconBtn = (label: string, active: boolean, onClick: () => void, icon: React.ReactNode) => (
    <button
      onClick={onClick}
      title={label}
      className={`rounded-xl p-2 transition-all active:scale-90 ${
        active ? "bg-[#6d7ef2]/25 text-[#a9b8ff]" : "text-white/45 hover:bg-white/10 hover:text-white"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden bg-black font-sans text-white">
      {/* ═══ The character — full-screen stage ═══ */}
      <StageErrorBoundary>
        <NimoFace state={faceState} mouse={mouse} glow={glow} />
      </StageErrorBoundary>
      <PointerBuddy enabled={buddyOn} />

      {/* ═══ Speech bubble (above the dome's head) ═══ */}
      <div className="pointer-events-none absolute left-1/2 top-[7%] z-20 w-full max-w-xl -translate-x-1/2 px-6">
        <AnimatePresence mode="wait">
          {(caption || busy) && (
            <motion.div
              key={caption || "busy"}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className={`glass mx-auto rounded-3xl px-6 py-4 text-center text-[14px] leading-relaxed ${
                needsClarification ? "border-amber-400/40 text-amber-200" : "text-white/90"
              }`}
            >
              {needsClarification && (
                <p className="mb-1.5 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
                  <Radio className="h-3 w-3 animate-pulse" /> NIMO needs your answer
                </p>
              )}
              {busy ? (
                <span className="flex justify-center gap-1.5 py-1.5">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="h-2 w-2 rounded-full bg-[#a9b8ff]" style={{ animation: `thinkBounce 0.9s ${i * 0.15}s infinite` }} />
                  ))}
                </span>
              ) : (
                caption
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ═══ Timer notifications ═══ */}
      <AnimatePresence>
        {timerNotifications.map((notif) => (
          <motion.div key={notif.id}
            initial={{ opacity: 0, y: -40, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="glass absolute left-1/2 top-5 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-2xl px-5 py-3"
          >
            <Bell className="h-4 w-4 animate-bounce text-[#5eead4]" />
            <span className="text-xs font-semibold text-white">{notif.label} is done!</span>
            <button onClick={() => setTimerNotifications((prev) => prev.filter((n) => n.id !== notif.id))} className="text-white/40 hover:text-white"><X className="h-3.5 w-3.5" /></button>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* ═══ Top bar ═══ */}
      <header
        className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-6 py-4"
        style={isElectron ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        <div className="flex items-center gap-3">
          <span className="font-serif text-2xl italic tracking-tight text-white">Nimo.</span>
          <span className={`glass-soft flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${needsClarification ? "text-amber-300" : "text-white/60"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${
              faceState === "listening" ? "animate-pulse bg-[#5eead4]" :
              faceState === "thinking" ? "animate-pulse bg-[#93c5fd]" :
              faceState === "error" ? "bg-red-400" :
              faceState === "confused" ? "bg-amber-400" :
              faceState === "music" ? "bg-purple-400" : "bg-[#8b9bf6]"
            }`} />
            {STATUS_TEXT[faceState]}
          </span>
          {voiceEnabled && transcript && (
            <span className="glass-soft hidden max-w-[280px] truncate rounded-full px-3 py-1 text-[10px] italic text-white/50 md:block">“{transcript}”</span>
          )}
        </div>
        <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {isElectron && iconBtn(
            companionVisible ? "Hide floating companion" : "Show floating companion",
            companionVisible,
            toggleCompanion,
            companionVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />
          )}
          {iconBtn("Voice", voiceEnabled, () => { setVoiceEnabled(!voiceEnabled); if (!voiceEnabled) speak("Voice activated. Say hey NIMO!", "happy"); }, voiceEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />)}
          {iconBtn("Tools", leftDock === "tools", () => setLeftDock(leftDock === "tools" ? null : "tools"), <Wand2 className="h-4 w-4" />)}
          {iconBtn("Settings", leftDock === "settings", () => setLeftDock(leftDock === "settings" ? null : "settings"), <Settings className="h-4 w-4" />)}
          {/* One dock, two tabs: agent activity + live logs */}
          {iconBtn("Agent activity & logs", rightDock !== null, () => setRightDock(rightDock === null ? "activity" : null), <Sparkles className="h-4 w-4" />)}
          {iconBtn(isFullscreen ? "Exit fullscreen" : "Fullscreen", isFullscreen, toggleFullscreen, isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />)}
          {isElectron && (
            <>
              <span className="mx-1 h-5 w-px bg-white/10" />
              <button onClick={() => bridge?.windowControl?.("minimize")} className="rounded-xl p-2 text-white/40 hover:bg-white/10 hover:text-white" title="Minimize"><Minus className="h-4 w-4" /></button>
              <button onClick={() => bridge?.windowControl?.("close")} className="rounded-xl p-2 text-white/40 hover:bg-red-500/20 hover:text-red-300" title="Hide to tray"><X className="h-4 w-4" /></button>
            </>
          )}
        </div>
      </header>

      {/* ═══ Right dock: Agent activity / Logs ═══ */}
      <AnimatePresence>
        {rightDock && (
          <motion.aside key={rightDock}
            initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }} transition={{ duration: 0.22 }}
            className="glass slide-in-right absolute bottom-24 right-5 top-20 z-30 flex w-[400px] flex-col rounded-3xl p-5"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1.5">
                <button onClick={() => setRightDock("activity")} className={`rounded-full px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${rightDock === "activity" ? "bg-[#6d7ef2]/25 text-[#a9b8ff]" : "text-white/40 hover:text-white"}`}>Agent activity</button>
                <button onClick={() => setRightDock("logs")} className={`rounded-full px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${rightDock === "logs" ? "bg-[#6d7ef2]/25 text-[#a9b8ff]" : "text-white/40 hover:text-white"}`}>Live logs</button>
              </div>
              <button onClick={() => setRightDock(null)} className="text-white/40 hover:text-white"><X className="h-4 w-4" /></button>
            </div>

            {rightDock === "activity" ? (
              <div className="flex-grow space-y-3 overflow-y-auto custom-scrollbar pr-1">
                {/* Approval card — NIMO asks before critical writes */}
                <AnimatePresence>
                  {pendingApproval && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      className="rounded-2xl border border-amber-400/50 bg-gradient-to-b from-[#2a1d05]/90 to-[#150d02]/90 p-4"
                    >
                      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
                        <Radio className="h-3 w-3 animate-pulse" /> Approval needed
                      </p>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-amber-100">{pendingApproval.summary}</p>
                      {pendingApproval.path && (
                        <p className="mt-1 truncate font-mono text-[10px] text-amber-200/60">{pendingApproval.path}</p>
                      )}
                      {pendingApproval.preview && (
                        <pre className="mt-2 max-h-24 overflow-y-auto custom-scrollbar whitespace-pre-wrap rounded-lg bg-black/50 p-2 font-mono text-[10px] text-amber-200/80">{pendingApproval.preview}</pre>
                      )}
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => approve(pendingApproval.id, true)}
                          disabled={busy}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#5eead4]/15 py-2 text-[11px] font-bold uppercase tracking-wider text-[#5eead4] transition-all hover:bg-[#5eead4]/25 active:scale-95 disabled:opacity-40"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                        </button>
                        <button
                          onClick={() => approve(pendingApproval.id, false)}
                          disabled={busy}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500/10 py-2 text-[11px] font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-500/20 active:scale-95 disabled:opacity-40"
                        >
                          <XCircle className="h-3.5 w-3.5" /> Decline
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* NIMO's answer — ChatGPT-style markdown block */}
                {lastAgentText && (
                  <div className="rounded-2xl border border-[#6d7ef2]/25 bg-gradient-to-br from-[#0d1b3d]/80 to-[#0a0f24]/80 p-4">
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#8fc1ff]">
                      <Sparkles className="h-3 w-3" /> NIMO{voiceEngine === "elevenlabs" ? " · elevenlabs voice" : ""}
                    </p>
                    <Markdown text={lastAgentText} className="text-[12.5px] text-white/85" />
                  </div>
                )}

                {/* Agent steps timeline */}
                {steps.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">What NIMO did</p>
                    <ol className="mt-2.5 space-y-2">
                      {steps.map((s, i) => (
                        <li key={i} className="flex items-center gap-2.5 text-[12px]">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-sm">
                            {TOOL_EMOJI[s.tool] || "✨"}
                          </span>
                          <span className="text-white/70">{s.summary}</span>
                          {s.ok ? <CheckCircle2 className="ml-auto h-3.5 w-3.5 shrink-0 text-[#5eead4]/70" /> : <XCircle className="ml-auto h-3.5 w-3.5 shrink-0 text-red-400/70" />}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Rich cards */}
                {cards.map((c, i) => renderCard(c, i))}

                {steps.length === 0 && cards.length === 0 && !lastAgentText && !pendingApproval && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/25">
                    <MoonStar className="h-7 w-7 opacity-40" />
                    <p className="text-[11px] uppercase tracking-[0.18em]">Ask NIMO anything —<br />its answers and work show up here.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-grow overflow-y-auto custom-scrollbar pr-1 font-mono text-[11px]">
                {logsList.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wider text-white/20">No entries yet…</div>
                ) : (
                  <div className="space-y-1">
                    {logsList.map((log) => {
                      const cls =
                        log.category === "error" ? "text-red-400/90" :
                        log.category === "voice" ? "text-[#5eead4]/90" :
                        log.category === "ai" ? "text-[#a9b8ff]/90" :
                        log.category === "action" ? "text-[#c4b5fd]/90" : "text-white/45";
                      return (
                        <div key={log.id} className="flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-white/[0.03]">
                          <span className="shrink-0 text-white/20">{log.timestamp}</span>
                          <span className="w-14 shrink-0 font-bold text-white/45">{log.type}</span>
                          <span className={`${cls} break-all`}>{log.text}</span>
                        </div>
                      );
                    })}
                    <div ref={logsEndRef} />
                  </div>
                )}
              </div>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ═══ Left dock: Tools / Settings ═══ */}
      <AnimatePresence>
        {leftDock && (
          <motion.aside key={leftDock}
            initial={{ x: -60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -60, opacity: 0 }} transition={{ duration: 0.22 }}
            className="glass slide-in-left absolute bottom-24 left-5 top-20 z-30 flex w-[380px] flex-col rounded-3xl p-5"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1.5">
                <button onClick={() => setLeftDock("tools")} className={`rounded-full px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${leftDock === "tools" ? "bg-[#6d7ef2]/25 text-[#a9b8ff]" : "text-white/40 hover:text-white"}`}>OS tools</button>
                <button onClick={() => setLeftDock("settings")} className={`rounded-full px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition-all ${leftDock === "settings" ? "bg-[#6d7ef2]/25 text-[#a9b8ff]" : "text-white/40 hover:text-white"}`}>Settings</button>
              </div>
              <button onClick={() => setLeftDock(null)} className="text-white/40 hover:text-white"><X className="h-4 w-4" /></button>
            </div>

            <div className="flex-grow space-y-4 overflow-y-auto custom-scrollbar pr-1">
              {leftDock === "tools" ? (
                <>
                  {/* Apps */}
                  <div>
                    <div className="flex items-center justify-between">
                      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-white/40"><AppWindow className="h-3.5 w-3.5" /> Installed apps</p>
                      <input value={appFilter} onChange={(e) => setAppFilter(e.target.value)} placeholder="filter…" className="w-28 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] outline-none focus:border-[#6d7ef2]/60" />
                    </div>
                    <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto custom-scrollbar">
                      {installedApps
                        .filter((a) => !appFilter.trim() || a.name.toLowerCase().includes(appFilter.trim().toLowerCase()))
                        .map((a, i) => (
                          <button key={i} onClick={() => submitCommand(`open ${a.name}`)} title={a.folder}
                            className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/65 transition-all hover:border-[#6d7ef2]/50 hover:text-white">
                            {a.name}
                          </button>
                        ))}
                    </div>
                  </div>
                  {/* Files */}
                  <form onSubmit={runFileSearch} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-white/40"><FolderSearch className="h-3.5 w-3.5" /> Find files (read-only)</p>
                    <div className="mt-2.5 flex gap-2">
                      <input value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="file name…" className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12px] outline-none focus:border-[#6d7ef2]/60" />
                      <select value={fileFolder} onChange={(e) => setFileFolder(e.target.value)} className="rounded-xl border border-white/10 bg-black/40 px-2 text-[12px] outline-none">
                        <option value="">Anywhere</option>
                        <option value="Desktop">Desktop</option>
                        <option value="Documents">Documents</option>
                        <option value="Downloads">Downloads</option>
                        <option value="Pictures">Pictures</option>
                      </select>
                      <button type="submit" disabled={fileSearching} className="rounded-xl bg-[#6d7ef2]/20 px-3 text-[#a9b8ff] transition-all hover:bg-[#6d7ef2]/30 disabled:opacity-40">
                        {fileSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSearch className="h-4 w-4" />}
                      </button>
                    </div>
                    {fileHits.length > 0 && (
                      <ul className="mt-3 max-h-40 space-y-1.5 overflow-y-auto custom-scrollbar">
                        {fileHits.map((f, i) => (
                          <li key={i} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5">
                            <p className="text-[12px] text-white/85">{f.name}</p>
                            <p className="truncate font-mono text-[10px] text-white/35">{f.path}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </form>
                  <button onClick={takeScreenshot} className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-white/10 bg-black/30 p-3.5 text-[12px] text-white/65 transition-all hover:border-[#6d7ef2]/50 hover:text-white">
                    <Camera className="h-4 w-4 text-[#a9b8ff]" /> Capture screen → Pictures (never uploaded)
                  </button>
                  <div className="rounded-2xl border border-[#5eead4]/20 bg-[#5eead4]/[0.05] p-3.5 text-[11px] leading-relaxed text-white/50">
                    <p className="mb-1 font-semibold text-[#5eead4]">🛡 Safety envelope</p>
                    NIMO reads files, launches apps and can now <span className="text-white/75">create and edit text files in your own folders</span> and even type into the app you have focused. Every critical write passes a safety core (hard rules + AI judgment) and <span className="text-white/75">asks for your approval first</span>. It never deletes files and never downloads anything.
                  </div>
                </>
              ) : (
                <>
                  {/* Mood */}
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Mood · how NIMO talks</p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {([
                        ["friendly", "Friendly", "😊"], ["sarcastic", "Sarcastic", "😏"],
                        ["robotic", "Robotic", "🤖"], ["dramatic", "Dramatic", "🎭"],
                        ["quiet", "Serene", "🌙"]
                      ] as Array<[PersonalityTrait, string, string]>).map(([id, name, emoji]) => (
                        <button key={id} onClick={() => choosePersonality(id, name)}
                          className={`flex items-center gap-2 rounded-2xl border px-3.5 py-3 text-left text-[12px] transition-all ${
                            personality === id ? "border-[#6d7ef2]/60 bg-[#6d7ef2]/15 text-white" : "border-white/10 bg-black/30 text-white/55 hover:border-white/25"
                          }`}>
                          <span className="text-lg">{emoji}</span> {name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Glow */}
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Halo glow</p>
                    <div className="mt-2.5 flex items-center gap-3">
                      <input type="range" min={0} max={100} value={glow} onChange={(e) => setGlow(Number(e.target.value))} className="w-full accent-[#6d7ef2]" />
                      <span className="w-10 text-right font-mono text-[11px] text-white/60">{glow}%</span>
                    </div>
                  </div>
                  {/* Toggles */}
                  <div className="space-y-2">
                    {([
                      ["Pointer buddy", buddyOn, () => setBuddyOn(!buddyOn)],
                      ["Wake word required", wakeRequired, () => setWakeRequired(!wakeRequired)],
                      ["Voice listening", voiceEnabled && !silentMode, () => { if (silentMode) { setSilentMode(false); setVoiceEnabled(true); speak("Voice activated. Say hey NIMO!", "happy"); } else { setVoiceEnabled(!voiceEnabled); if (!voiceEnabled) speak("Voice activated. Say hey NIMO!", "happy"); } }],
                      ["Silent mode (cloud replies only)", silentMode, toggleSilentMode],
                      ["Computer control (click & type on screen)", controlMode === "granted", toggleControlMode]
                    ] as Array<[string, boolean, () => void]>).map(([label, on, toggle]) => (
                      <button key={label} onClick={toggle} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-[12px] text-white/70 transition-all hover:border-white/25">
                        <span className="text-left">{label}</span>
                        <span className={`relative ml-3 h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-[#6d7ef2]" : "bg-white/15"}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-3.5 text-[11px] leading-relaxed text-white/40">
                    Volume, timers, music and everything else work by voice too — try <span className="text-white/70">“set volume to 40”</span>, <span className="text-white/70">“timer for 5 minutes”</span> or <span className="text-white/70">“play lofi on youtube”</span>.
                  </div>
                </>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ═══ Timer chips + input bar ═══ */}
      <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3 px-6 pb-6">
        {backendTimers.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {backendTimers.map((t) => (
              <span key={t.id} className="glass-soft flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] text-white/75">
                ⏱ {t.label} · <span className="font-mono font-bold text-[#a9b8ff]">{t.remaining}s</span>
              </span>
            ))}
          </div>
        )}
        <AnimatePresence>
          <motion.form
            onSubmit={handleManualSubmit}
            initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
            className="glass flex w-full max-w-2xl items-center gap-2.5 rounded-full px-5 py-3 transition-shadow focus-within:shadow-[0_0_40px_rgba(109,126,242,0.25)]"
          >
            <span className="font-mono text-xs font-bold uppercase text-[#a9b8ff]">nimo$</span>
            <input
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder={needsClarification ? "type your answer…" : "ask NIMO to do anything…"}
              className="w-full bg-transparent text-[14px] text-white outline-none placeholder:text-white/25"
            />
            <button type="submit" disabled={busy || !manualInput.trim()} className="rounded-full bg-[#6d7ef2]/25 p-2.5 text-[#a9b8ff] transition-all hover:bg-[#6d7ef2]/40 active:scale-90 disabled:opacity-30">
              <Send className="h-4 w-4" />
            </button>
          </motion.form>
        </AnimatePresence>
      </div>
    </div>
  );
}
