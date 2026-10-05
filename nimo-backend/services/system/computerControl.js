/**
 * services/system/computerControl.js
 * NIMO's hands: mouse movement, clicks, scrolling and key presses on the
 * user's real desktop. Every caller must pass the safety gate first
 * (services/guard/writeGuard + the approval flow) — nothing here checks
 * permissions itself.
 *
 * Injection safety: all PowerShell is passed via -EncodedCommand
 * (base64 UTF-16LE); the pointer/click path uses a compiled P/Invoke snippet
 * with integer-only arguments — no text is ever spliced into a shell.
 */

const { execFile } = require('child_process')
const logger = require('../../utils/logger')
const { NimoError } = require('../../utils/errorHandler')

/** Run an encoded PowerShell script safely (no shell interpolation). */
function runPs(script, timeoutMs = 10000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(new NimoError('CONTROL_FAILED', err.message, "The OS refused that input action.", 'error'))
      else resolve(String(stdout || '').trim())
    })
  })
}

// P/Invoke once per session: SetCursorPos + mouse_event + SendInput wheel.
const MOUSE_SNIPPET = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NimoMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
}
"@
`

/** Move the cursor to absolute screen coordinates (physical pixels). */
async function moveCursor(x, y) {
  const xi = Math.max(0, Math.round(Number(x) || 0))
  const yi = Math.max(0, Math.round(Number(y) || 0))
  await runPs(`${MOUSE_SNIPPET}\n[NimoMouse]::SetCursorPos(${xi}, ${yi})`)
  return { x: xi, y: yi }
}

/** Click at the current (or given) position. left/right, single/double. */
async function clickMouse({ x, y, right = false, double = false } = {}) {
  let prefix = ''
  if (x !== undefined && y !== undefined) {
    prefix = `[NimoMouse]::SetCursorPos(${Math.max(0, Math.round(Number(x)))}, ${Math.max(0, Math.round(Number(y)))}) | Out-Null; Start-Sleep -Milliseconds 60\n`
  }
  const down = right ? 0x0008 : 0x0002
  const up = right ? 0x0010 : 0x0004
  const click = `[NimoMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [NimoMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`
  const script = `${MOUSE_SNIPPET}\n${prefix}${double ? click + '; Start-Sleep -Milliseconds 80; ' + click : click}`
  await runPs(script)
  return { clicked: true, right: Boolean(right), double: Boolean(double), x: x ?? null, y: y ?? null }
}

/** Scroll the wheel: positive = up, negative = down (units of notches). */
async function scrollWheel(clicks = 3) {
  const n = Math.max(-30, Math.min(30, Math.round(Number(clicks) || 0)))
  const data = n * -120 // positive dwData scrolls up in mouse_event
  await runPs(`${MOUSE_SNIPPET}\n[NimoMouse]::mouse_event(0x0800,0,0,${data},[UIntPtr]::Zero)`)
  return { scrolled: n }
}

/** Press a key combo like "ctrl+f", "enter", "alt+tab" via SendKeys. */
async function pressKeys(combo) {
  const map = {
    ctrl: '^', alt: '%', shift: '+', win: '#',
    enter: '{ENTER}', esc: '{ESC}', escape: '{ESC}', tab: '{TAB}',
    space: ' ', backspace: '{BS}', delete: '{DEL}', del: '{DEL}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}',
    f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}',
    f11: '{F11}', f12: '{F12}'
  }
  const parts = String(combo || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new NimoError('KEYS_EMPTY', 'No keys given.', 'Which keys should I press?', 'error')
  let out = ''
  for (const p of parts) {
    const k = map[p]
    if (k === undefined) {
      if (p.length === 1) out += p
      else throw new NimoError('KEYS_UNKNOWN', `Unknown key "${p}".`, `I don't know the key "${p}".`, 'error')
    } else out += k
  }
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${out.replace(/'/g, "''")}')`
  await runPs(script)
  return { pressed: parts.join('+') }
}

module.exports = { moveCursor, clickMouse, scrollWheel, pressKeys }
