/**
 * OverlayApp.tsx
 * The floating on-screen companion: a tiny transparent window hugging the
 * creature exactly. DRAG the creature to place it anywhere; it never moves
 * on its own. The window grows upward only to fit the speech bubble /
 * control pill, then shrinks back.
 *
 * Click-through (unlock) is hover-aware: while unlocked, mouse moves are
 * forwarded to this page, so the window becomes interactive whenever the
 * cursor touches it and click-through again when the cursor leaves.
 */

import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Mic, MicOff, LayoutDashboard, Send, Lock, Unlock, X, CheckCircle2, XCircle, Radio, VolumeX } from 'lucide-react'
import FloatingBlob from '../components/FloatingBlob'
import { useNimoAgent } from '../hooks/useNimoAgent'
import type { FaceState } from '../types'

export default function OverlayApp() {
  const {
    bridge, faceState, caption, setCaption, needsClarification, busy, transcript,
    pendingApproval, approve,
    ask, speak, voiceEnabled, setVoiceEnabled, wakeRequired, setWakeRequired,
    silentMode, setSilentMode, mouse
  } = useNimoAgent({ autoVoice: true, sessionId: 'companion' })

  const [draft, setDraft] = useState('')
  const [inputOpen, setInputOpen] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [hoverStable, setHoverStable] = useState(false) // delayed unhover (no flicker)
  const shrinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreRef = useRef<boolean | null>(null)

  // Transparent window: strip ANY page background so the desktop shows through.
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  // Timer-done announcements arrive via backend IPC.
  useEffect(() => {
    if (!bridge) return
    const off = bridge.on('nimo:timer-done', (p) => {
      const payload = p as { label?: string }
      speak(`${payload?.label || 'Timer'} is done! Time's up!`, 'happy')
    })
    return off
  }, [bridge, speak])

  // ── Pin / click-through with hover-aware restore ────────────────────────
  // While unlocked, the window is mouse-transparent, but Electron forwards
  // mouse moves to this page — so we can detect "cursor over the creature"
  // and become interactive just long enough to click the pill.
  useEffect(() => {
    if (!bridge) return
    const setIgnore = (v: boolean) => {
      if (ignoreRef.current !== v) {
        ignoreRef.current = v
        bridge.invoke('nimo:set-ignore-mouse', { value: v }).catch(() => {})
      }
    }
    if (pinned) {
      setIgnore(false)
      return
    }
    const onMove = (e: MouseEvent) => {
      const inside =
        e.clientX >= 0 && e.clientY >= 0 &&
        e.clientX <= window.innerWidth && e.clientY <= window.innerHeight
      setIgnore(!inside)
    }
    window.addEventListener('mousemove', onMove)
    setIgnore(true) // start click-through until the cursor touches the creature
    return () => window.removeEventListener('mousemove', onMove)
  }, [pinned, bridge])

  const submitDraft = (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    const q = draft
    setDraft('')
    setInputOpen(false)
    ask(q)
  }

  const isElectron = Boolean(bridge)
  const bubbleVisible = Boolean(caption || busy)

  // ── Dynamic window sizing (anchored bottom-center in main.js) ──────────
  // Idle is sized to hug the face exactly — no border, no dead margins.
  const expanded = bubbleVisible || inputOpen || hoverStable || !isElectron
  const W = expanded ? (inputOpen ? 330 : 330) : 124
  const H = inputOpen ? 350 : bubbleVisible ? 300 : hoverStable ? 186 : 140
  useEffect(() => {
    if (!isElectron) return
    bridge.invoke('nimo:companion-resize', { width: W, height: H }).catch(() => {})
  }, [W, H, isElectron, bridge])

  // Delayed unhover so growing/shrinking doesn't flicker.
  useEffect(() => {
    if (hovered) {
      if (shrinkTimer.current) { clearTimeout(shrinkTimer.current); shrinkTimer.current = null }
      setHoverStable(true)
    } else {
      shrinkTimer.current = setTimeout(() => setHoverStable(false), 650)
      return () => { if (shrinkTimer.current) clearTimeout(shrinkTimer.current) }
    }
  }, [hovered])

  const blobSize = expanded ? 118 : 112
  const pillBtn = 'rounded-full p-1.5 transition-all active:scale-90'

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-transparent font-sans text-white"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ═══ Cloud popup (thought-bubble style — no tail, floating dots) ═══ */}
      <div className="pointer-events-none absolute inset-x-0 top-5 z-20 flex justify-center px-4">
        <AnimatePresence mode="wait">
          {(caption || busy) && (
            <motion.div
              key={caption || 'busy'}
              initial={{ opacity: 0, y: 12, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-[300px]"
            >
              {/* Cloud body — solid fill so the scalloped bumps merge seamlessly */}
              <div
                className={`cloud-body relative rounded-[26px] px-4 py-3 text-[12px] leading-relaxed shadow-[0_14px_36px_rgba(2,6,20,0.6)] ${
                  needsClarification ? 'text-amber-200' : 'text-white/90'
                }`}
              >
                {/* Scalloped bumps on top — the cloud silhouette */}
                <span className="cloud-bump absolute -top-2.5 left-[16%] h-6 w-11" />
                <span className="cloud-bump absolute -top-4 left-[42%] h-8 w-14" />
                <span className="cloud-bump absolute -top-2.5 right-[14%] h-6 w-10" />

                {needsClarification && (
                  <span className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-amber-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    Needs your answer
                  </span>
                )}
                {busy ? (
                  <span className="flex justify-center gap-1 py-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-1.5 w-1.5 rounded-full bg-[#a9b8ff]" style={{ animation: `thinkBounce 0.9s ${i * 0.15}s infinite` }} />
                    ))}
                  </span>
                ) : (
                  <span className="line-clamp-4">{caption}</span>
                )}
              </div>
              {/* Floating dots leading down to the creature (thought bubble) */}
              <span className={`cloud-dot absolute left-[38%] top-[calc(100%+2px)] h-2 w-2 ${busy ? 'opacity-0' : 'opacity-100'}`} />
              <span className={`cloud-dot absolute left-[31%] top-[calc(100%+10px)] h-1.5 w-1.5 ${busy ? 'opacity-0' : 'opacity-90'}`} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ═══ Approval card — NIMO asks before critical writes ═══ */}
      <AnimatePresence>
        {pendingApproval && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            className="absolute inset-x-3 top-[104px] z-30 rounded-2xl border border-amber-400/50 bg-[#221503]/95 p-3 shadow-[0_14px_36px_rgba(2,6,20,0.7)]"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-amber-400">
              <Radio className="h-3 w-3 animate-pulse" /> Approval needed
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-100">{pendingApproval.summary}</p>
            {pendingApproval.path && (
              <p className="mt-1 truncate font-mono text-[9px] text-amber-200/60">{pendingApproval.path}</p>
            )}
            {pendingApproval.preview && (
              <pre className="mt-1.5 max-h-16 overflow-y-auto custom-scrollbar whitespace-pre-wrap rounded-lg bg-black/50 p-1.5 font-mono text-[9px] text-amber-200/80">{pendingApproval.preview}</pre>
            )}
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={() => approve(pendingApproval.id, true)}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#5eead4]/15 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#5eead4] transition-all hover:bg-[#5eead4]/25 active:scale-95 disabled:opacity-40"
              >
                <CheckCircle2 className="h-3 w-3" /> Approve
              </button>
              <button
                onClick={() => approve(pendingApproval.id, false)}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-red-500/10 py-1.5 text-[10px] font-bold uppercase tracking-wider text-red-300 transition-all hover:bg-red-500/20 active:scale-95 disabled:opacity-40"
              >
                <XCircle className="h-3 w-3" /> Decline
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ The creature — DRAG it anywhere. Click: silent → type input,
              talking mode → toggles the mic ═══ */}
      <div
        className="absolute inset-x-0 z-10 flex justify-center transition-all duration-200"
        style={{ bottom: inputOpen ? 104 : hoverStable ? 44 : 8 }}
      >
        <div
          title="Drag me anywhere — click to talk or type"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <button
            onClick={() => {
              if (silentMode) {
                setInputOpen(true)
                setCaption('Silent mode — type your task below.')
              } else {
                setVoiceEnabled(!voiceEnabled)
                if (!voiceEnabled) speak('Voice on. Say hey NIMO!', 'happy')
              }
            }}
            className={`block outline-none transition-transform active:scale-95 ${faceState === 'talking' || busy ? 'blob-talk-bounce' : ''}`}
            title={silentMode ? 'Silent mode — click to type a task' : voiceEnabled ? 'Voice on — click to mute' : 'Muted — click to listen'}
          >
            <FloatingBlob state={faceState} mouse={mouse} size={blobSize} />
          </button>
        </div>
      </div>

      {/* Live transcript whisper */}
      {voiceEnabled && transcript && !bubbleVisible && hoverStable && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[36px] z-10 truncate px-3 text-center text-[9px] italic text-white/60 drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
          “{transcript}”
        </div>
      )}

      {/* ═══ Control pill (appears on hover) ═══ */}
      <div
        className={`absolute inset-x-0 bottom-1.5 z-20 flex justify-center transition-opacity duration-200 ${hovered || inputOpen || !isElectron ? 'opacity-100' : 'opacity-0'}`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-0.5 rounded-full border border-white/15 bg-[#0a0e24]/92 px-1 py-0.5 shadow-[0_10px_30px_rgba(2,6,20,0.6)]">
          <button
            onClick={() => {
              if (silentMode) { setInputOpen(true); setCaption('Silent mode — type your task below.'); return }
              setVoiceEnabled(!voiceEnabled)
              if (!voiceEnabled) speak('Voice on. Say hey NIMO!', 'happy')
            }}
            className={`${pillBtn} ${voiceEnabled ? 'text-[#5eead4]' : 'text-white/55 hover:text-white'}`}
            title={silentMode ? 'Silent mode — type instead' : voiceEnabled ? 'Voice on — click to mute' : 'Muted — click to listen'}
          >
            {silentMode ? <VolumeX className="h-3 w-3 text-amber-300/80" /> : voiceEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
          </button>
          <button
            onClick={() => setInputOpen((o) => !o)}
            className={`${pillBtn} text-white/55 hover:text-white`}
            title="Type to NIMO"
          >
            <Send className="h-3 w-3" />
          </button>
          {isElectron && (
            <>
              <button
                onClick={() => bridge?.windowControl?.('open-dashboard')}
                className={`${pillBtn} text-white/55 hover:text-white`}
                title={hovered ? undefined : 'Open/hide dashboard'}
              >
                <LayoutDashboard className="h-3 w-3" />
              </button>
              <button
                onClick={() => setPinned((p) => !p)}
                className={`${pillBtn} ${pinned ? 'text-white/55 hover:text-white' : 'text-fuchsia-300'}`}
                title={pinned ? 'Unlock: clicks pass through the companion' : 'Locked interactive — cursor over it restores clicks'}
              >
                {pinned ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
              </button>
              <button
                onClick={() => bridge?.windowControl?.('hide-companion')}
                className={`${pillBtn} text-white/55 hover:text-red-300`}
                title="Hide companion (tray brings it back)"
              >
                <X className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Quick type input */}
      <AnimatePresence>
        {inputOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute inset-x-0 bottom-10 z-30 flex justify-center px-4"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <form onSubmit={submitDraft} className="flex w-full max-w-[300px] items-center gap-2 rounded-full border border-[#6d7ef2]/40 bg-[#0a0e24]/95 px-4 py-2.5 shadow-[0_14px_36px_rgba(2,6,20,0.6)]">
              <span className="font-mono text-[10px] font-bold text-[#a9b8ff]">nimo$</span>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="ask me anything…"
                className="w-full bg-transparent text-[12px] text-white outline-none placeholder:text-white/25"
              />
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
