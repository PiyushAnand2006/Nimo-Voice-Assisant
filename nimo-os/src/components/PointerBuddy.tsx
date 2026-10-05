/**
 * PointerBuddy.tsx
 * A tiny teardrop companion with two mini eyes that chases the real cursor
 * with a springy lag and a comet trail — NIMO's pointer buddy mode, inspired
 * by classic desktop-pet cursors. Pure presentation; it never intercepts
 * clicks (pointer-events: none).
 *
 * Implementation note: the chase loop lives in refs + ONE stable interval —
 * state updates only carry the position for rendering. (An earlier version
 * put `pos` in the effect deps, tearing the loop down 25×/second.)
 */

import React, { useEffect, useRef, useState } from 'react'

const TRAIL_LEN = 8

export default function PointerBuddy({ enabled }: { enabled: boolean }) {
  const [render, setRender] = useState<{ x: number; y: number; trail: Array<{ x: number; y: number; id: number }> } | null>(null)
  const target = useRef({ x: 0, y: 0 })
  const current = useRef({ x: 0, y: 0 })
  const dotId = useRef(0)
  const trailRef = useRef<Array<{ x: number; y: number; id: number }>>([])

  useEffect(() => {
    if (!enabled) { setRender(null); return }
    let started = false

    const onMove = (e: MouseEvent) => {
      target.current = { x: e.clientX, y: e.clientY }
      if (!started) {
        started = true
        current.current = { x: e.clientX, y: e.clientY }
      }
    }
    window.addEventListener('mousemove', onMove)

    // ONE stable interval: springs toward the cursor, advances the trail,
    // and publishes a single state update per tick for rendering.
    const loop = setInterval(() => {
      current.current.x += (target.current.x - current.current.x) * 0.16
      current.current.y += (target.current.y - current.current.y) * 0.16
      dotId.current += 1
      trailRef.current = [
        ...trailRef.current.slice(-(TRAIL_LEN - 1)),
        { x: current.current.x, y: current.current.y, id: dotId.current }
      ]
      setRender({ x: current.current.x, y: current.current.y, trail: trailRef.current })
    }, 40)

    return () => {
      window.removeEventListener('mousemove', onMove)
      clearInterval(loop)
      setRender(null)
    }
  }, [enabled])

  if (!enabled || !render) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]">
      {/* Comet trail */}
      {render.trail.map((dot, i) => (
        <span
          key={dot.id}
          className="absolute rounded-full"
          style={{
            left: dot.x - 3,
            top: dot.y - 3,
            width: 4 + i * 1.2,
            height: 4 + i * 1.2,
            background: `rgba(120,145,255,${0.05 + (i / Math.max(1, render.trail.length)) * 0.3})`,
            filter: 'blur(1px)'
          }}
        />
      ))}
      {/* The buddy: a glossy blue teardrop with two mini eyes */}
      <div
        className="absolute"
        style={{
          left: render.x - 22,
          top: render.y - 26,
          filter: 'drop-shadow(0 0 14px rgba(110,140,255,0.9)) drop-shadow(0 0 30px rgba(80,110,255,0.45))'
        }}
      >
        <svg width="44" height="52" viewBox="0 0 44 52">
          <defs>
            <radialGradient id="buddyBody" cx="35%" cy="28%" r="90%">
              <stop offset="0%" stopColor="#b9c6ff" />
              <stop offset="45%" stopColor="#5f74f0" />
              <stop offset="100%" stopColor="#3346d8" />
            </radialGradient>
          </defs>
          <path
            d="M22 2 C30 16 42 24 42 34 A20 18 0 1 1 2 34 C2 24 14 16 22 2 Z"
            fill="url(#buddyBody)"
            stroke="#ffffff"
            strokeWidth="2.4"
          />
          {/* Mini eyes look toward motion direction */}
          <circle cx={17} cy={34} r={4.4} fill="#101338" />
          <circle cx={28} cy={36} r={3.6} fill="#101338" />
          <circle cx={15.8} cy={32.4} r={1.4} fill="#fff" />
          <circle cx={26.9} cy={34.9} r={1.1} fill="#fff" />
        </svg>
      </div>
    </div>
  )
}
