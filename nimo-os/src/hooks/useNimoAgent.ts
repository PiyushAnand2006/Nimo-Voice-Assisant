/**
 * useNimoAgent.ts
 * One brain shared by the floating companion and the dashboard:
 * agent calls (with Electron IPC when available, HTTP otherwise),
 * text-to-speech (ElevenLabs primary, OS voice fallback),
 * and the voice loop.
 *
 * VOICE INPUT — two engines:
 *  - Electron: Chromium inside Electron does NOT ship Chrome's
 *    SpeechRecognition backend, so the mic is recorded here (VAD-driven),
 *    encoded as WAV and transcribed by Gemini on the backend
 *    (/api/agent/transcribe). Wake-word + agent flow unchanged.
 *  - Plain browser: Web Speech API (works in Chrome) is used as-is.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentResponse, AgentStep, FaceState, PersonalityTrait } from '../types'

interface NimoBridge {
  invoke: (channel: string, data?: unknown) => Promise<{ ok: boolean; data?: unknown; [k: string]: unknown }>
  on: (channel: string, cb: (payload: unknown) => void) => () => void
  off: (channel: string, cb: (payload: unknown) => void) => void
  windowControl?: (action: string) => void
  platform?: string
}

// ── WAV encoding (16 kHz mono PCM16) for Gemini transcription ──────────
function encodeWavBuffer(buffer: AudioBuffer, targetRate = 16000): string {
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate), targetRate)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  return offline.startRendering().then((rendered) => {
    const samples = rendered.getChannelData(0)
    const wav = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(wav)
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, targetRate, true)
    view.setUint32(28, targetRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    let off = 44
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    let binary = ''
    const bytes = new Uint8Array(wav)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }) as unknown as string
}

export function useNimoAgent(opts: { autoVoice?: boolean; sessionId?: string; listenPushes?: boolean } = {}) {
  const sessionId = opts.sessionId || 'default'
  const bridge: NimoBridge | null = (window as unknown as { nimo?: NimoBridge }).nimo || null
  const httpBase = bridge ? 'http://localhost:3001' : ''

  const [faceState, setFaceState] = useState<FaceState>('idle')
  const [caption, setCaption] = useState('')          // what NIMO is saying / last said
  const [steps, setSteps] = useState<AgentStep[]>([]) // last agent tool trace
  const [needsClarification, setNeedsClarification] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<{ id: string; tool: string; summary: string; path: string | null; preview: string | null } | null>(null)
  const [lastAgentText, setLastAgentText] = useState('')
  const [cards, setCards] = useState<AgentResponse['cards']>([])
  const [busy, setBusy] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [voiceEngine, setVoiceEngine] = useState<'elevenlabs' | 'browser'>('browser')
  const [voiceEnabled, setVoiceEnabled] = useState(false) // always start muted
  const [wakeRequired, setWakeRequired] = useState(() => localStorage.getItem('nimo-wake-required') !== '0')
  // Silent mode: no speaker, no mic — the companion becomes type-only and
  // answers in the cloud popup. Persisted and synced across windows.
  const [silentMode, setSilentModeState] = useState(() => localStorage.getItem('nimo-silent') === '1')
  const silentRef = useRef(silentMode)
  silentRef.current = silentMode
  const [mouse, setMouse] = useState({ nx: 0, ny: 0 })

  const setSilentMode = useCallback((v: boolean) => {
    setSilentModeState(v)
    localStorage.setItem('nimo-silent', v ? '1' : '0')
  }, [])

  // Keep every window in sync when the toggle flips elsewhere.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'nimo-silent') setSilentModeState(e.newValue === '1')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Cloud popup auto-dismiss: the answer clears itself after a while
  // (longer answers stay longer). Close ✕ on the cloud clears instantly.
  useEffect(() => {
    if (!caption) return
    const t = setTimeout(() => setCaption(''), Math.min(20000, 8000 + caption.length * 30))
    return () => clearTimeout(t)
  }, [caption])

  const voiceEnabledRef = useRef(voiceEnabled)
  voiceEnabledRef.current = voiceEnabled
  const wakeRequiredRef = useRef(wakeRequired)
  wakeRequiredRef.current = wakeRequired
  const speakingRef = useRef(false)
  const recRef = useRef<any>(null) // browser SpeechRecognition (fallback engine)
  const micRef = useRef<any>(null) // Gemini recorder engine state
  const personalityRef = useRef<PersonalityTrait>('friendly')

  // ── Text to speech ────────────────────────────────────────────────────
  // Primary engine: ElevenLabs (soft "Alice" voice, resolved server-side).
  // Fallback: the OS/browser voice when ElevenLabs is unavailable (e.g.
  // free plan blocks library voices via API — retry after a cooldown).
  const audioCache = useRef(new Map<string, string>())
  const elUnavailableUntil = useRef(0)

  const speak = useCallback((text: string, state: FaceState = 'talking') => {
    if (!text) return
    setCaption(text)
    // TTS engines spell all-caps "NIMO" letter-by-letter — "Nimo" speaks
    // as one word.
    const spoken = text.replace(/\bNIMO\b/g, 'Nimo').slice(0, 500)

    // Silent mode: the cloud popup IS the answer — nothing is ever voiced,
    // and the mic stays off. Show the expression briefly, then rest.
    if (silentRef.current) {
      setFaceState(state === 'idle' ? 'talking' : state)
      setTimeout(() => setFaceState('idle'), 2200 + Math.min(6000, spoken.length * 45))
      return
    }

    setFaceState(state === 'idle' ? 'talking' : state)
    // Pause the mic while NIMO talks so it never hears itself.
    try { recRef.current?.quietStop?.() } catch { /* noop */ }
    try { micRef.current?.duck?.() } catch { /* noop */ }

    const finish = () => {
      speakingRef.current = false
      setFaceState('idle')
      try { micRef.current?.unduck?.() } catch { /* noop */ }
      if (voiceEnabledRef.current) {
        setTimeout(() => { try { recRef.current?.start?.() } catch { /* noop */ } }, 350)
      }
    }
    const browserSpeak = () => {
      setVoiceEngine('browser')
      if (!('speechSynthesis' in window)) { finish(); return }
      try {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(spoken)
        const voices = window.speechSynthesis.getVoices()
        const preferred =
          voices.find((v) => /Google (US|UK) English/i.test(v.name)) ||
          voices.find((v) => /Samantha|Aria|Zira|Jenny/i.test(v.name)) ||
          voices.find((v) => v.lang?.startsWith('en'))
        if (preferred) utterance.voice = preferred
        utterance.rate = 1.06
        utterance.pitch = 1.05
        speakingRef.current = true
        utterance.onend = finish
        utterance.onerror = finish
        window.speechSynthesis.speak(utterance)
      } catch {
        speakingRef.current = false
        finish()
      }
    }

    const elevenSpeak = async () => {
      // Circuit breaker: after a failure, skip ElevenLabs for 10 minutes
      // so replies never stall waiting for a doomed request.
      if (Date.now() < elUnavailableUntil.current) { browserSpeak(); return }
      try {
        let audioB64 = audioCache.current.get(spoken)
        if (!audioB64) {
          const res = await fetch(`${httpBase}/api/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: spoken })
          })
          const payload = await res.json()
          if (!payload?.ok || !payload?.data?.audio) throw new Error(payload?.error || 'no audio')
          audioB64 = payload.data.audio as string
          if (audioCache.current.size > 40) audioCache.current.clear()
          audioCache.current.set(spoken, audioB64)
        }
        setVoiceEngine('elevenlabs')
        const audio = new Audio(`data:audio/mpeg;base64,${audioB64}`)
        audio.volume = 1
        speakingRef.current = true
        audio.onended = finish
        audio.onerror = () => { speakingRef.current = false; browserSpeak() }
        await audio.play()
      } catch {
        elUnavailableUntil.current = Date.now() + 10 * 60 * 1000
        speakingRef.current = false
        browserSpeak()
      }
    }

    elevenSpeak()
  }, [httpBase])

  // ── Agent call ────────────────────────────────────────────────────────
  const ask = useCallback(async (text: string, personality?: PersonalityTrait): Promise<AgentResponse | null> => {
    const clean = String(text || '').trim()
    if (!clean) return null
    const p = personality || personalityRef.current
    setBusy(true)
    setFaceState('thinking')
    setNeedsClarification(false)
    setSteps([])
    try {
      let payload: any
      if (bridge) {
        const res = await bridge.invoke('nimo:agent', { text: clean, sessionId, personality: p })
        payload = res?.ok ? (res.data as any) : { ok: false, speak: (res as any)?.speak || 'Something went wrong.', text: '', state: 'error', needsClarification: false, steps: [], cards: [] }
      } else {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, sessionId, personality: p })
        })
        payload = await res.json()
      }
      const a = payload as AgentResponse & { pendingApproval?: { id: string; tool: string; summary: string; path: string | null; preview: string | null } }
      setSteps(a.steps || [])
      setCards(a.cards || [])
      setNeedsClarification(Boolean(a.needsClarification))
      setPendingApproval((a as any).pendingApproval || null)
      setLastAgentText(a.text || a.speak || '')
      speak(a.speak || a.text || (a.ok ? 'Done.' : 'Something went wrong.'), a.state || 'talking')
      if (a.openUrl) window.open(a.openUrl, '_blank', 'noopener')
      return a
    } catch {
      speak('I could not reach my brain service. Is the backend running?', 'error')
      return null
    } finally {
      setBusy(false)
    }
  }, [bridge, sessionId, speak])

  // ── Utterance handling (shared by both engines) ───────────────────────
  const handleUtterance = useCallback((text: string) => {
    const clean0 = String(text || '').trim()
    if (!clean0) return
    setTranscript(clean0)
    // Drop fragments that are too short to be a real command (noise garbage).
    if (clean0.length < 4) return
    const lower = clean0.toLowerCase()
    const hasWake = /\b(hey\s+nimo|hi\s+nimo|okay\s+nimo|nimo)\b/.test(lower)
    if (wakeRequiredRef.current && !hasWake) return // ignore ambient chatter
    const clean = clean0.replace(/\b(hey|hi|okay|ok)?\s*nimo\b[,.!]?\s*/gi, '').trim()
    if (clean && clean.length >= 3) ask(clean)
  }, [ask])

  // ── Voice engine: Gemini mic recorder (Electron) ──────────────────────
  const stopGeminiVoice = useCallback(() => {
    const mic = micRef.current
    if (!mic) return
    try { mic.timer && clearInterval(mic.timer) } catch { /* noop */ }
    try { mic.recorder?.state === 'recording' && mic.recorder.stop() } catch { /* noop */ }
    mic.stream?.getTracks().forEach((t: MediaStreamTrack) => t.stop())
    try { mic.ctx?.close() } catch { /* noop */ }
    micRef.current = null
  }, [])

  const startGeminiVoice = useCallback(async () => {
    if (micRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setCaption('This device has no microphone API.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)

      const mic: any = { stream, ctx, recorder: null, timer: null, ducked: false, processing: false, ignoreUntil: 0 }
      // Duck: NIMO is about to speak — stop any recording and ignore the mic
      // until after its voice has faded (prevents it hearing its own answers).
      mic.duck = () => {
        mic.ducked = true
        try { mic.recorder?.state === 'recording' && mic.recorder.stop() } catch { /* noop */ }
        mic.recorder = null
      }
      mic.unduck = () => {
        setTimeout(() => {
          mic.ducked = false
          mic.ignoreUntil = Date.now() + 700
        }, 800)
      }
      micRef.current = mic

      const startRecording = () => {
        const chunks: Blob[] = []
        const recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
        recorder.onstop = async () => {
          mic.recorder = null
          // Discard recordings made while NIMO was speaking or right after
          // it finished — the mic would otherwise hear NIMO's own voice.
          if (mic.processing || mic.ducked || Date.now() < (mic.ignoreUntil || 0) || !voiceEnabledRef.current) return
          const blob = new Blob(chunks, { type: 'audio/webm' })
          if (blob.size < 4000) return // too short to be speech
          mic.processing = true
          setBusy(true)
          try {
            const ab = await blob.arrayBuffer()
            const decoded = await ctx.decodeAudioData(ab)
            const wavB64 = await encodeWavBuffer(decoded, 16000)
            const res = await fetch(`${httpBase}/api/agent/transcribe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: wavB64 })
            })
            const payload = await res.json()
            const text = String(payload?.text || '').trim()
            if (text) handleUtterance(text)
          } catch {
            setCaption('I heard something but could not transcribe it.')
          } finally {
            mic.processing = false
            setBusy(false)
          }
        }
        recorder.start()
        mic.recorder = recorder
      }

      // VAD tick: starts a recording on voice, stops it after silence.
      mic.timer = window.setInterval(() => {
        if (!voiceEnabledRef.current || mic.ducked || mic.processing || Date.now() < (mic.ignoreUntil || 0)) return
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        const now = Date.now()
        if (!mic.speechStarted && rms > 0.02) {
          mic.speechStarted = true
          mic.speechMs = 0
          mic.silenceMs = 0
          mic.silenceSince = now
          setTranscript('…listening')
          startRecording()
        } else if (mic.speechStarted) {
          if (rms > 0.02) { mic.speechMs = (mic.speechMs || 0) + 100; mic.silenceMs = 0; mic.silenceSince = now }
          else { mic.silenceMs = (mic.silenceMs || 0) + 100 }
          const total = now - (mic.silenceSince || now)
          if ((mic.silenceMs >= 1400 && (mic.speechMs || 0) >= 350) || total >= 10000) {
            try { mic.recorder?.state === 'recording' && mic.recorder.stop() } catch { /* noop */ }
            mic.speechStarted = false
          }
        }
      }, 100)
    } catch (err: any) {
      const why = String(err?.message || err?.name || 'denied')
      setCaption(why.includes('Permission') || why.includes('denied') || err?.name === 'NotAllowedError'
        ? 'Microphone permission was denied — allow it to talk to me.'
        : `Microphone error: ${why}`)
      setVoiceEnabled(false)
    }
  }, [handleUtterance, httpBase])

  // ── Voice engine: Web Speech (plain-browser fallback) ─────────────────
  const startBrowserVoice = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setCaption('Voice input is not supported in this browser.')
      return
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const rec = new SpeechRecognition()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = 'en-US'
    let interimBuffer = ''
    let stoppedForSpeak = false

    rec.onstart = () => {
      interimBuffer = ''
      setFaceState((s: FaceState) => (s === 'idle' || s === 'listening' ? 'listening' : s))
      setTranscript('')
    }
    rec.onresult = (event: any) => {
      let interim = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      interimBuffer = (interimBuffer + finalText + interim).trim()
      setTranscript(interimBuffer)
      if (finalText) handleUtterance(finalText)
    }
    rec.onerror = (event: any) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (event.error === 'not-allowed') {
        setVoiceEnabled(false)
        setCaption('Microphone permission was blocked.')
      }
    }
    rec.onend = () => {
      if (stoppedForSpeak) { stoppedForSpeak = false; return }
      if (voiceEnabledRef.current && !speakingRef.current) {
        setTimeout(() => { try { rec.start() } catch { /* noop */ } }, 250)
      }
    }
    recRef.current = rec
    recRef.current.quietStop = () => {
      stoppedForSpeak = true
      try { rec.stop() } catch { /* noop */ }
    }
    setTimeout(() => { try { rec.start() } catch { /* noop */ } }, 200)
  }, [handleUtterance])

  const stopBrowserVoice = useCallback(() => {
    try { recRef.current?.quietStop?.() } catch { /* noop */ }
    recRef.current = null
  }, [])

  // Start/stop the engines when the voice toggle flips (never auto-on).
  // This runs in BOTH windows — autoVoice no longer gates it, because voice
  // always boots muted and the user toggles it manually. Silent mode forces
  // everything off: fully silent = type-only.
  useEffect(() => {
    if (silentMode) {
      if (voiceEnabled) setVoiceEnabled(false)
      stopGeminiVoice()
      stopBrowserVoice()
      setTranscript('')
      return
    }
    if (voiceEnabled) {
      if (bridge) startGeminiVoice()
      else startBrowserVoice()
    } else {
      stopGeminiVoice()
      stopBrowserVoice()
      setTranscript('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceEnabled, silentMode, bridge])

  // Cleanup on unmount.
  useEffect(() => () => {
    stopGeminiVoice()
    stopBrowserVoice()
  }, [stopGeminiVoice, stopBrowserVoice])

  // ── Mouse tracking (Electron global cursor, browser fallback) ─────────
  useEffect(() => {
    if (bridge) {
      const unsub = bridge.on('nimo:mouse', (p) => {
        const pt = p as { x: number; y: number }
        try {
          // Cursor coords are screen DIPs — normalize against the SCREEN
          // size (not the window), so both windows track correctly.
          const sw = window.screen?.width || window.innerWidth
          const sh = window.screen?.height || window.innerHeight
          setMouse({
            nx: Math.max(-1, Math.min(1, (pt.x / sw) * 2 - 1)),
            ny: Math.max(-1, Math.min(1, (pt.y / sh) * 2 - 1))
          })
        } catch { /* noop */ }
      })
      return unsub
    }
    const onMove = (e: MouseEvent) => {
      setMouse({
        nx: Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1)),
        ny: Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1))
      })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [bridge])

  // ── Backend-pushed speech + state (e.g. timers) ───────────────────────
  // The dashboard opts out — the floating companion owns push announcements,
  // otherwise both windows would speak at once.
  useEffect(() => {
    if (!bridge || opts.listenPushes === false) return
    const offSpeak = bridge.on('nimo:speak', (p) => {
      const t = (p as { text?: string })?.text
      if (t) speak(t)
    })
    const offState = bridge.on('nimo:state-change', (p) => {
      const s = (p as { state?: FaceState })?.state
      if (s) setFaceState(s)
    })
    return () => { offSpeak(); offState() }
  }, [bridge, speak, opts.listenPushes])

  const setPersonality = useCallback((p: PersonalityTrait) => {
    personalityRef.current = p
    if (bridge) bridge.invoke('nimo:set-personality', { personality: p }).catch(() => {})
  }, [bridge])

  // ── Approval gate: user decided on a pending write/type action ────────
  const approve = useCallback(async (pendingId: string, approved: boolean) => {
    setPendingApproval(null)
    setBusy(true)
    setFaceState('thinking')
    try {
      const res = await fetch(`${httpBase}/api/agent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, pendingId, approved })
      })
      const payload = await res.json()
      if (Array.isArray(payload.steps)) setSteps(payload.steps)
      if (payload.pendingApproval) setPendingApproval(payload.pendingApproval)
      speak(payload.speak || (approved ? 'Done.' : 'Okay, dropped it.'), payload.state || 'talking')
      return payload
    } catch {
      speak('The approval could not be processed.', 'error')
      return null
    } finally {
      setBusy(false)
    }
  }, [httpBase, sessionId, speak])

  return {
    bridge,
    faceState, setFaceState,
    caption, setCaption,
    steps, cards, needsClarification,
    pendingApproval, approve, lastAgentText, voiceEngine,
    busy,
    transcript,
    ask, speak,
    voiceEnabled, setVoiceEnabled,
    wakeRequired, setWakeRequired: (v: boolean) => {
      setWakeRequired(v)
      localStorage.setItem('nimo-wake-required', v ? '1' : '0')
    },
    silentMode, setSilentMode,
    mouse,
    setPersonality
  }
}
