/**
 * StageErrorBoundary.tsx
 * Guards the big SVG stage: if a render error ever strikes the character,
 * the dashboard keeps working — the stage area shows a calm fallback with a
 * reload affordance instead of an all-black dead window.
 */

import React from 'react'

interface Props { children: React.ReactNode }
interface State { hasError: boolean; message: string }

export default class StageErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message }
  }

  componentDidCatch(err: Error) {
    // Visible in the Electron main-process console diagnostics.
    console.error('[stage-boundary]', `${err.name}: ${err.message}`, err.stack || '')
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white/60">
          <span className="text-3xl">🫧</span>
          <p className="text-[12px] uppercase tracking-[0.2em]">The companion blinked out for a second</p>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="rounded-full border border-[#6d7ef2]/40 bg-[#6d7ef2]/15 px-4 py-1.5 text-[11px] text-[#a9b8ff] transition-all hover:bg-[#6d7ef2]/25 active:scale-95"
          >
            Bring it back
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
