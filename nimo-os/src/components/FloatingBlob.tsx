/**
 * FloatingBlob.tsx
 * The floating on-screen creature — a soft, CUTE glossy blue plushie-blob:
 * big white eyes with small sparkling pupils that track your cursor, thin
 * gentle brows, rosy blush, and a default smile. Drawn on a transparent
 * background so the Electron overlay shows only the character.
 */

import React, { useEffect, useRef, useState } from 'react'
import type { FaceState } from '../types'

export interface MousePoint {
  nx: number // -1..1
  ny: number // -1..1
}

interface FloatingBlobProps {
  state: FaceState
  mouse?: MousePoint
  size?: number
}

// Softer, friendlier feature tones (near-black navy reads scary when tiny)
const NAVY = '#27306f'
const BROW = '#454f9c'
const STAR = '#2c3480'

export default function FloatingBlob({ state, mouse, size = 250 }: FloatingBlobProps) {
  // ── Local mouse fallback (browser preview) ─────────────────────────────
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
        t2 = setTimeout(() => { setBlink(false); schedule() }, 150)
      }, 2000 + Math.random() * 2800)
    }
    schedule()
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2) }
  }, [state])

  // ── Talking mouth ──────────────────────────────────────────────────────
  const [mouthOpen, setMouthOpen] = useState(0.4)
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

  // ── Auto sleep ─────────────────────────────────────────────────────────
  const [asleep, setAsleep] = useState(false)
  const lastActivity = useRef(Date.now())
  useEffect(() => {
    lastActivity.current = Date.now()
    setAsleep(false)
  }, [m.nx, m.ny, state])
  useEffect(() => {
    if (state !== 'idle') return
    const i = setInterval(() => {
      if (Date.now() - lastActivity.current > 60000) setAsleep(true)
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

  const pupilDx = thinking ? -9 : sleeping ? 0 : m.nx * 11
  const pupilDy = thinking ? -8 : sleeping ? 0 : m.ny * 9

  const browLift = listening ? -8 : talking ? -5 : confused ? 3 : error ? 9 : 0
  const browTiltL = error ? 6 : confused ? -2 : 0
  const browTiltR = error ? -6 : confused ? 2 : 0

  const blinkScale = blink && !squint ? 0.08 : 1
  const lidDrop = confused ? 22 : error ? 19 : 0

  // Clean floating-widget shadow — no colored aura leaking past the body
  const shadow = 'drop-shadow(0 6px 14px rgba(2, 6, 20, 0.35))'

  return (
    <div className="relative select-none" style={{ width: size, height: size * 0.92, filter: shadow }}>
      <svg viewBox="0 0 240 220" className="absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id="blobBody" cx="30%" cy="16%" r="115%">
            <stop offset="0%" stopColor="#e2e8ff" />
            <stop offset="38%" stopColor="#a3b2fa" />
            <stop offset="72%" stopColor="#6d80f4" />
            <stop offset="100%" stopColor="#4d61e8" />
          </radialGradient>
          <clipPath id="blobEyeL"><circle cx={76} cy={106} r={38.5} /></clipPath>
          <clipPath id="blobEyeR"><circle cx={164} cy={106} r={38.5} /></clipPath>
          {/* Body silhouette clip — guarantees highlights never leak outside */}
          <clipPath id="blobBodyClip"><rect x={10} y={16} width={220} height={196} rx={95} /></clipPath>
          <filter id="blobBlush" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation={5} />
          </filter>
        </defs>

        {/* Slight translucency — the desktop faintly shows through */}
        <g className="blob-breathe" style={{ transformOrigin: '120px 130px', opacity: 0.92 }}>
          {/* Soft pillow body */}
          <rect x={10} y={16} width={220} height={196} rx={95} fill="url(#blobBody)" />
          {/* Plush sheen + rim light, clipped strictly inside the body */}
          <g clipPath="url(#blobBodyClip)">
            <ellipse cx={80} cy={52} rx={74} ry={42} fill="rgba(255,255,255,0.38)" filter="url(#blobBlush)" />
            <ellipse cx={120} cy={200} rx={80} ry={14} fill="rgba(255,255,255,0.14)" filter="url(#blobBlush)" />
          </g>

          {/* Star half-sunk into the head rim — fully inside the silhouette */}
          <g transform="translate(120 30)">
            <g transform="scale(0.5)">
              <path
                d="M0,-34 L9,-11 L33,-11 L14,4 L21,28 L0,14 L-21,28 L-14,4 L-33,-11 L-9,-11 Z"
                fill={STAR}
                className={thinking ? 'star-twinkle' : 'blob-star-float'}
              />
            </g>
          </g>

          {/* Brows — thin, high, gentle */}
          <path
            d={`M ${76 - 28} ${60 + browLift + browTiltL} Q 76 ${45 + browLift - Math.abs(browTiltL) * 0.5} ${76 + 28} ${60 + browLift - browTiltL}`}
            stroke={BROW} strokeWidth={5.5} strokeLinecap="round" fill="none"
            className="transition-all duration-300"
          />
          <path
            d={`M ${164 - 28} ${60 + browLift - browTiltR} Q 164 ${45 + browLift - Math.abs(browTiltR) * 0.5} ${164 + 28} ${60 + browLift + browTiltR}`}
            stroke={BROW} strokeWidth={5.5} strokeLinecap="round" fill="none"
            className="transition-all duration-300"
          />

          {/* Eyes — big white, small sparkling pupils */}
          {([0, 1] as const).map((side) => {
            const cx = side === 0 ? 76 : 164
            const cy = 106
            const clipId = side === 0 ? 'blobEyeL' : 'blobEyeR'
            return (
              <g
                key={side}
                transform={`translate(${cx} ${cy}) scale(1 ${blinkScale}) translate(${-cx} ${-cy})`}
                className="transition-transform duration-100"
              >
                {squint ? (
                  <path
                    d={`M ${cx - 26} ${cy + 7} Q ${cx} ${cy - 26} ${cx + 26} ${cy + 7}`}
                    stroke={NAVY} strokeWidth={8} strokeLinecap="round" fill="none"
                  />
                ) : (
                  <>
                    <circle cx={cx} cy={cy} r={38} fill="#ffffff" />
                    <g clipPath={`url(#${clipId})`}>
                      <circle cx={cx + pupilDx} cy={cy + pupilDy} r={13.5} fill={NAVY} className="transition-all duration-150" />
                      {/* Sparkles */}
                      <circle cx={cx + pupilDx - 5} cy={cy + pupilDy - 5.5} r={5.6} fill="#ffffff" />
                      <circle cx={cx + pupilDx + 4.4} cy={cy + pupilDy + 4.6} r={2.7} fill="rgba(255,255,255,0.95)" />
                      <circle cx={cx + pupilDx - 1.5} cy={cy + pupilDy + 8.5} r={1.7} fill="rgba(255,255,255,0.65)" />
                    </g>
                    {lidDrop > 0 && (
                      <g clipPath={`url(#${clipId})`}>
                        <rect x={cx - 42} y={cy - 42} width={84} height={lidDrop} fill="url(#blobBody)" />
                        <rect x={cx - 42} y={cy - 42 + lidDrop - 2} width={84} height={3.5} fill={BROW} opacity={0.8} />
                      </g>
                    )}
                  </>
                )}
              </g>
            )
          })}

          {/* Blush — rosy, clipped inside the body silhouette */}
          <g clipPath="url(#blobBodyClip)">
            <ellipse cx={30} cy={150} rx={26} ry={12} fill={happy ? 'rgba(255,115,155,0.7)' : 'rgba(255,125,165,0.45)'} filter="url(#blobBlush)" className="transition-all duration-300" />
            <ellipse cx={210} cy={150} rx={26} ry={12} fill={happy ? 'rgba(255,115,155,0.7)' : 'rgba(255,125,165,0.45)'} filter="url(#blobBlush)" className="transition-all duration-300" />
          </g>

          {/* Mouth — cute expressions */}
          {(() => {
            const mx = 120
            const my = 156
            if (talking) {
              const ry = 8 + mouthOpen * 15
              return (
                <g>
                  <ellipse cx={mx} cy={my} rx={12} ry={ry} fill={NAVY} style={{ transition: 'ry 90ms ease' }} />
                  <ellipse cx={mx} cy={my + ry * 0.45} rx={7} ry={ry * 0.42} fill="#f591b5" />
                </g>
              )
            }
            if (happy) {
              return (
                <g>
                  <path d={`M ${mx - 21} ${my - 7} Q ${mx} ${my + 19} ${mx + 21} ${my - 7}`} fill={NAVY} />
                  <ellipse cx={mx} cy={my + 8} rx={10} ry={5.5} fill="#f591b5" />
                </g>
              )
            }
            if (error) {
              return <path d={`M ${mx - 14} ${my + 7} Q ${mx} ${my - 8} ${mx + 14} ${my + 7}`} stroke={NAVY} strokeWidth={5.5} strokeLinecap="round" fill="none" />
            }
            if (confused) {
              return <path d={`M ${mx - 14} ${my} q 4 -6 8 0 q 4 6 8 0`} stroke={NAVY} strokeWidth={5} strokeLinecap="round" fill="none" />
            }
            if (listening || thinking) {
              // attentive little o
              return <ellipse cx={mx} cy={my + 2} rx={8} ry={10} fill={NAVY} />
            }
            if (sleeping) {
              return <ellipse cx={mx} cy={my} rx={8} ry={10} fill={NAVY} />
            }
            // idle: soft closed smile
            return <path d={`M ${mx - 11} ${my - 2} Q ${mx} ${my + 8} ${mx + 11} ${my - 2}`} stroke={NAVY} strokeWidth={5} strokeLinecap="round" fill="none" />
          })()}
        </g>

        {/* Sleep Zz — inside the body */}
        {sleeping && (
          <g className="zz-float" transform="translate(176 58)">
            <text x={0} y={0} fontSize={20} fontWeight={800} fill="#9fb0ff" fontFamily="monospace">Z</text>
            <text x={12} y={-12} fontSize={14} fontWeight={800} fill="#8296ec" fontFamily="monospace">z</text>
          </g>
        )}

        {/* Thought dots — inside the body, top-right */}
        {thinking && (
          <g>
            {[
              { x: 182, y: 64, r: 3.2, d: '0s' },
              { x: 197, y: 50, r: 4.3, d: '0.15s' },
              { x: 212, y: 36, r: 5.4, d: '0.3s' }
            ].map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={p.r} fill="#c6cffa" opacity={0.9} className="thought-pop" style={{ animationDelay: p.d }} />
            ))}
          </g>
        )}

        {/* Music notes — inside the body */}
        {state === 'music' && (
          <g>
            <text x={26} y={66} fontSize={20} className="music-note" fill="rgba(200,150,255,0.9)">♪</text>
            <text x={198} y={104} fontSize={22} className="music-note" style={{ animationDelay: '0.7s' }} fill="rgba(200,150,255,0.9)">♫</text>
          </g>
        )}
      </svg>
    </div>
  )
}
