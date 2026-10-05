/**
 * services/system/keyTyper.js
 * Types text into whatever window the user has FOCUSED (Notepad, a browser
 * field, VS Code...) so NIMO can act inside other applications.
 *
 * ALWAYS gated behind explicit user approval by the agent layer — this
 * module is never called without one.
 *
 * Injection safety: the text is never spliced into a shell command. The
 * PowerShell script is passed via -EncodedCommand (base64 UTF-16LE), and the
 * text itself is embedded as a single-quoted PowerShell literal with the
 * quote doubled, so no metacharacter can escape. SendKeys special characters
 * (+^%~(){}[]) are bracket-escaped so arbitrary text types literally.
 */

const os = require('os')
const { execFile } = require('child_process')
const logger = require('../../utils/logger')
const { NimoError } = require('../../utils/errorHandler')

/** Escape a string for a single-quoted PowerShell literal. */
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** Escape SendKeys metacharacters so text types literally; \n → ENTER. */
function sendKeysEscape(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '{ENTER}')
    .replace(/([+^%~(){}[\]])/g, '{$1}')
}

/** Type text into the focused application window. */
async function typeIntoFocusedApp(text) {
  const body = String(text || '')
  const plat = os.platform()
  try {
    if (plat === 'win32') {
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        `[System.Windows.Forms.SendKeys]::SendWait(${psSingleQuote(sendKeysEscape(body))})`
      // -EncodedCommand: base64 UTF-16LE — no shell interpolation anywhere.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 15000 }, (err) => {
          if (err) reject(new NimoError('TYPE_FAILED', err.message, "I couldn't type that — the focused app may not accept text.", 'error'))
          else resolve(true)
        })
      })
      return { typed: body.length }
    }
    if (plat === 'darwin') {
      const script = `tell application "System Events" to keystroke ${psSingleQuote(body)}`
      await new Promise((resolve, reject) => {
        execFile('osascript', ['-e', script], { timeout: 15000 }, (err) => {
          if (err) reject(new NimoError('TYPE_FAILED', err.message, "I couldn't type that.", 'error'))
          else resolve(true)
        })
      })
      return { typed: body.length }
    }
    // linux
    await new Promise((resolve, reject) => {
      execFile('xdotool', ['type', '--', body], { timeout: 15000 }, (err) => {
        if (err) reject(new NimoError('TYPE_FAILED', err.message, "I couldn't type that.", 'error'))
        else resolve(true)
      })
    })
    return { typed: body.length }
  } catch (err) {
    logger.warn(`keyTyper failed: ${err.message}`)
    throw err
  }
}

module.exports = { typeIntoFocusedApp }
