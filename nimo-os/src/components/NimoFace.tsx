/**
 * NimoFace.tsx
 * The full-stage character: a giant glossy blue dome that rises from the
 * bottom edge of the screen on a black stage, with a soft glow halo, a star
 * at the apex, huge googly white eyes whose pupils track the mouse, thick
 * brows, blush, and a small expressive mouth.
 *
 * The dome is drawn with a circle anchored below the viewport;
 * preserveAspectRatio keeps it glued to the bottom center at any window size.
 *
 * Expressions map NIMO's FaceState onto the character sheet:
 *   idle      curious neutral (occasional blink) → auto-sleeps after a while
 *   listening eyes wide, brows raised, tiny o mouth
 *   thinking  eyes drift up + thought dots
 *   talking   mouth opens/closes with a pink tongue
 *   happy     squint arc eyes + wide smile
 *   confused  sly half-lidded side glance
 *   error     sad brows, frown, red-tinted halo
 *   music     closed happy arcs + floating notes
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { FaceState } from '../types'

export interface MousePoint {
  nx: number // -1..1
  ny: number // -1..1
}

interface NimoFaceProps {
  state: FaceState
  mouse?: MousePoint
  /** halo strength 0-100 (default 60) */
  glow?: number
  /** compact overlay crops the dome — scale features a touch bigger */
  compact?: boolean
}

// Softer, friendlier feature tones
const NAVY = '#27306f'
const BROW = '#3c4694'
const STAR = '#2c3480'

function NimoFace({ state, mouse, glow = 60, compact = false }: NimoFaceProps) {
  // ── Local mouse fallback (browser dev without Electron cursor feed) ────
  const [localMouse, setLocalMouse] = useState<MousePoint>({ nx: 0, ny: 0 })
  useEffect(() => {
    if (mouse) return
    const onMove = (e: MouseEvent) => {
      setLocalMouse({
        nx: Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1)),
        ny: Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1))
      })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [mouse])
  const m = mouse ?? localMouse

  // ── Blink ──────────────────────────────────────────────────────────────
  const [blink, setBlink] = useState(false)
  useEffect(() => {
    if (state === 'happy' || state === 'music') return
    let alive = true
    let t1: ReturnType<typeof setTimeout>
    let t2: ReturnType<typeof setTimeout>
    const schedule = () => {
      if (!alive) return
      t1 = setTimeout(() => {
        if (!alive) return
        setBlink(true)
        t2 = setTimeout(() => { setBlink(false); schedule() }, 140)
      }, 2400 + Math.random() * 3200)
    }
    schedule()
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2) }
  }, [state])

  // ── Talking mouth ──────────────────────────────────────────────────────
  const [mouthOpen, setMouthOpen] = useState(0.35)
  useEffect(() => {
    if (state !== 'talking') return
    let alive = true
    const tick = () => {
      if (!alive) return
      setMouthOpen(0.3 + Math.random() * 0.7)
      setTimeout(tick, 95 + Math.random() * 110)
    }
    tick()
    return () => { alive = false }
  }, [state])

  // ── Auto sleep: after 45s of idle without mouse movement ───────────────
  const [asleep, setAsleep] = useState(false)
  const lastActivity = useRef(Date.now())
  useEffect(() => {
    lastActivity.current = Date.now()
    setAsleep(false)
  }, [m.nx, m.ny, state])
  useEffect(() => {
    if (state !== 'idle') return
    const i = setInterval(() => {
      if (Date.now() - lastActivity.current > 45000) setAsleep(true)
    }, 2000)
    return () => clearInterval(i)
  }, [state])
  const sleeping = asleep && state === 'idle'

  // ── Geometry per state ─────────────────────────────────────────────────
  const happy = state === 'happy' || state === 'music'
  const squint = happy || sleeping
  const confused = state === 'confused'
  const error = state === 'error'
  const listening = state === 'listening'
  const thinking = state === 'thinking'
  const talking = state === 'talking'

  // Pupil tracking (dampened in thinking/sleep)
  const maxDx = 30
  const maxDy = 24
  const pupilDx = thinking ? -22 : sleeping ? 0 : m.nx * maxDx
  const pupilDy = thinking ? -20 : sleeping ? 0 : m.ny * maxDy

  // Brows: lift when listening/talking, tilt in/down when sad
  const browLift = listening ? -14 : talking ? -10 : confused ? 6 : error ? 14 : sleeping ? 2 : 0
  const browTiltL = error ? 12 : confused ? -4 : 0   // inner-up for sad
  const browTiltR = error ? -12 : confused ? 4 : 0

  // Eye squash for blink (whole eye group scales — googly blink)
  const blinkScale = blink && !squint ? 0.08 : 1

  // Half-lid drop for confused (sly) / error (heavy)
  const lidDrop = confused ? 52 : error ? 46 : 0

  // Halo
  const haloOpacity = 0.12 + (glow / 100) * 0.5
  const haloColor = error
    ? `rgba(255,120,140,${haloOpacity})`
    : state === 'music'
      ? `rgba(190,140,255,${haloOpacity})`
      : state === 'happy'
        ? `rgba(150,255,220,${haloOpacity})`
        : `rgba(205,218,255,${haloOpacity})`

  // Feature scale bump for the compact overlay window
  const fs = compact ? 1.12 : 1
  // Opacity helper for the always-mounted, opacity-toggled SVG variants.
  const on = (b: boolean) => (b ? 1 : 0)

  // ViewBox: 1000 × 760 — dome circle anchored below the bottom edge.
  // Compact (overlay) crops to the face: brows fully visible, dome curvature
  // in the top corners — matching the phone-style framing.
  const viewBox = compact ? '240 200 520 624' : '0 0 1000 760'
  return (
    <div className="absolute inset-0 overflow-hidden bg-black stage-fade-in">
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          {/* Body gradient: light from top-left */}
          <radialGradient id="nimoBody" cx="32%" cy="20%" r="105%">
            <stop offset="0%" stopColor="#c3cdfb" />
            <stop offset="38%" stopColor="#8b9bf6" />
            <stop offset="72%" stopColor="#5a6cee" />
            <stop offset="100%" stopColor="#3f52e4" />
          </radialGradient>
          {/* Per-eye clip so lids/pupils never leak outside the white.
              Circles are positioned at each eye's absolute viewBox coords. */}
          <clipPath id="eyeClipL">
            <circle cx={500 - 152 * fs} cy={480} r={94 * fs} />
          </clipPath>
          <clipPath id="eyeClipR">
            <circle cx={500 + 152 * fs} cy={480} r={94 * fs} />
          </clipPath>
          {/* Soft blush blur */}
          <filter id="blushBlur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={10} />
          </filter>
          <filter id="rimGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={38} />
          </filter>
        </defs>

        {/* Halo: a blurred, slightly larger circle behind the dome gives the
            previews' soft rim glow */}
        <circle
          cx={500} cy={1105} r={796}
          fill={haloColor.replace(/[\d.]+\)$/, `${Math.min(0.9, haloOpacity + 0.25)})`)}
          filter="url(#rimGlow)"
          className="halo-breathe"
        />

        {/* Dome body — circle center far below the viewBox bottom */}
        {/* No CSS transform animations inside this SVG — Chromium throws
            DOMException when React commits around composited animated SVG
            subtrees. Only opacity animations are safe here. */}
        <g>
          <circle cx={500} cy={1105} r={780} fill="url(#nimoBody)" />
          {/* Top-left sheen */}
          <ellipse cx={330} cy={430} rx={320} ry={170} fill="rgba(255,255,255,0.22)" filter="url(#rimGlow)" opacity={0.5} />
          {/* Bottom-right shade */}
          <ellipse cx={760} cy={880} rx={420} ry={260} fill="rgba(30,40,160,0.30)" filter="url(#rimGlow)" />

          {/* ── Star at the apex — outer g holds position, animation on the
              inner path so CSS transform never wipes the placement ── */}
          <g transform={`translate(500 ${341 + (compact ? -10 : 2)})`}>
            <g transform={`scale(${0.78 * fs})`}>
              <path
                d="M0,-34 L9,-11 L33,-11 L14,4 L21,28 L0,14 L-21,28 L-14,4 L-33,-11 L-9,-11 Z"
                fill={STAR}
                className={thinking ? 'star-glow' : ''}
              />
            </g>
          </g>

          {/* ── Brows — thin, gentle ── */}
          <path
            d={`M ${500 - 232 * fs} ${372 + browLift + browTiltL} Q ${500 - 150 * fs} ${330 + browLift - Math.abs(browTiltL) * 0.4} ${500 - 68 * fs} ${372 + browLift - browTiltL}`}
            stroke={BROW} strokeWidth={13 * fs} strokeLinecap="round" fill="none"
            className="transition-all duration-300"
          />
          <path
            d={`M ${500 + 68 * fs} ${372 + browLift - browTiltR} Q ${500 + 150 * fs} ${330 + browLift - Math.abs(browTiltR) * 0.4} ${500 + 232 * fs} ${372 + browLift + browTiltR}`}
            stroke={BROW} strokeWidth={13 * fs} strokeLinecap="round" fill="none"
            className="transition-all duration-300"
          />

          {/* ── Eyes ── */}
          {([0, 1] as const).map((side) => {
            const cx = 500 + (side === 0 ? -1 : 1) * 152 * fs
            const cy = 480
            const clipId = side === 0 ? 'eyeClipL' : 'eyeClipR'
            return (
              <g
                key={side}
                transform={`translate(${cx} ${cy}) scale(1 ${blinkScale}) translate(${-cx} ${-cy})`}
              >
                {/* Open eye — always mounted, opacity-toggled (no SVG node
                    insertion/removal after mount: Chromium + React 19 can
                    throw NotFoundError committing around those) */}
                <g opacity={on(!squint)}>
                  <circle cx={cx} cy={cy} r={92 * fs} fill="#ffffff" />
                  <g clipPath={`url(#${clipId})`}>
                    <circle cx={cx + pupilDx} cy={cy + pupilDy} r={40 * fs} fill={NAVY} />
                    <circle cx={cx + pupilDx - 15 * fs} cy={cy + pupilDy - 16 * fs} r={15 * fs} fill="#ffffff" />
                    <circle cx={cx + pupilDx + 10 * fs} cy={cy + pupilDy + 12 * fs} r={7 * fs} fill="rgba(255,255,255,0.95)" />
                    <circle cx={cx + pupilDx - 3 * fs} cy={cy + pupilDy + 21 * fs} r={4 * fs} fill="rgba(255,255,255,0.6)" />
                  </g>
                  {/* Half lid (sly / sad) */}
                  <g clipPath={`url(#${clipId})`} opacity={on(lidDrop > 0)}>
                    <rect x={cx - 100 * fs} y={cy - 100 * fs} width={200 * fs} height={lidDrop * fs} fill="url(#nimoBody)" />
                    <rect x={cx - 100 * fs} y={cy - 100 * fs + lidDrop * fs - 4} width={200 * fs} height={8 * fs} fill={BROW} opacity={0.85} />
                  </g>
                </g>
                {/* Closed arc eye (happy / music / sleeping) */}
                <path
                  opacity={on(squint)}
                  d={`M ${cx - 70 * fs} ${cy + 8} Q ${cx} ${cy - 66 * fs} ${cx + 70 * fs} ${cy + 8}`}
                  stroke={NAVY} strokeWidth={20 * fs} strokeLinecap="round" fill="none"
                />
              </g>
            )
          })}

          {/* ── Blush ── */}
          <ellipse cx={500 - 292 * fs} cy={586} rx={54 * fs} ry={26 * fs} fill={happy ? 'rgba(255,130,165,0.55)' : 'rgba(255,140,170,0.35)'} filter="url(#blushBlur)" className="transition-all duration-300" />
          <ellipse cx={500 + 292 * fs} cy={586} rx={54 * fs} ry={26 * fs} fill={happy ? 'rgba(255,130,165,0.55)' : 'rgba(255,140,170,0.35)'} filter="url(#blushBlur)" className="transition-all duration-300" />

          {/* ── Mouth — all variants always mounted, opacity-toggled ── */}
          {(() => {
            const mx = 500
            const my = 652
            const talkingRy = (26 + mouthOpen * 46) * fs
            return (
              <g>
                {/* talking: open oval + tongue */}
                <g opacity={on(talking)}>
                  <ellipse cx={mx} cy={my} rx={34 * fs} ry={talkingRy} fill={NAVY} style={{ transition: 'ry 90ms ease' }} />
                  <ellipse cx={mx} cy={my + talkingRy * 0.45} rx={20 * fs} ry={talkingRy * 0.4} fill="#f08bb1" />
                </g>
                {/* happy: big smile + tongue */}
                <g opacity={on(happy)}>
                  <path d={`M ${mx - 52 * fs} ${my - 12} Q ${mx} ${my + 46 * fs} ${mx + 52 * fs} ${my - 12}`} fill={NAVY} />
                  <ellipse cx={mx} cy={my + 8} rx={16 * fs} ry={8 * fs} fill="#f08bb1" />
                </g>
                {/* error: frown */}
                <path
                  opacity={on(error)}
                  d={`M ${mx - 40 * fs} ${my + 14} Q ${mx} ${my - 22 * fs} ${mx + 40 * fs} ${my + 14}`}
                  stroke={NAVY} strokeWidth={14 * fs} strokeLinecap="round" fill="none"
                />
                {/* confused: squiggle */}
                <path
                  opacity={on(confused)}
                  d={`M ${mx - 38 * fs} ${my} q 10 -14 20 0 q 10 14 20 0`}
                  stroke={NAVY} strokeWidth={12 * fs} strokeLinecap="round" fill="none"
                />
                {/* listening / thinking / sleeping: small o */}
                <ellipse cx={mx} cy={my} rx={24 * fs} ry={30 * fs} fill={NAVY} opacity={on(listening || thinking || sleeping)} />
                {/* idle: small o (curious) */}
                <ellipse cx={mx} cy={my} rx={22 * fs} ry={27 * fs} fill={NAVY} opacity={on(!talking && !happy && !error && !confused && !listening && !thinking && !sleeping)} />
              </g>
            )
          })()}
        </g>

        {/* ── Sleep Zz — always mounted, opacity-toggled ── */}
        <g opacity={on(sleeping)} transform={`translate(${500 + 300} ${360})`}>
          <text x={0} y={0} fontSize={44} fontWeight={800} fill="#9fb0ff" fontFamily="monospace">Z</text>
          <text x={26} y={-26} fontSize={30} fontWeight={800} fill="#8296ec" fontFamily="monospace">z</text>
        </g>

        {/* ── Thought dots — always mounted, opacity-toggled ── */}
        <g opacity={on(thinking)}>
          {[
            { x: 812, y: 402, r: 7, d: '0s' },
            { x: 852, y: 366, r: 10, d: '0.15s' },
            { x: 900, y: 322, r: 13, d: '0.3s' }
          ].map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="#c6cffa" opacity={0.9} className="thought-glow" style={{ animationDelay: p.d }} />
          ))}
        </g>

        {/* ── Music notes — always mounted, opacity-toggled ── */}
        <g opacity={on(state === 'music')}>
          <text x={130} y={330} fontSize={44} className="note-glow" fill="rgba(200,150,255,0.9)">♪</text>
          <text x={870} y={430} fontSize={50} className="note-glow" style={{ animationDelay: '0.7s' }} fill="rgba(200,150,255,0.9)">♫</text>
        </g>
      </svg>

      {/* Red vignette pulse on error */}
      {error && <div className="absolute inset-0 pointer-events-none error-vignette" />}
    </div>
  )
}

// Memoized: the dashboard re-renders every second (clock, logs) — the big
// SVG tree should only re-diff when its own props actually change.
export default React.memo(NimoFace)
