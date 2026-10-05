/**
 * core/httpApi.js
 * Single source of truth for NIMO's localhost HTTP API. Both the headless
 * dev server (server.js) and the Electron main process serve these routes,
 * so the UI behaves identically in `npm run ui:dev` and inside the app.
 *
 * Routes:
 *   GET  /api/health
 *   POST /api/run-command   { transcript, personality?, sessionId? }  → legacy fast-path + agent fallback
 *   POST /api/agent         { text, sessionId?, personality? }        → full agent brain
 *   POST /api/agent/reset   { sessionId? }                            → clear conversation memory
 *   GET  /api/timers
 *   POST /api/timers/cancel { id }
 *   GET  /api/os/apps?filter=
 *   POST /api/os/search-files { name, folder? }
 *   POST /api/tts           { text, opts? }
 */

const constants = require('../config/constants')
const logger = require('../utils/logger')
const { parseCommand } = require('./commandParser')
const { runAgent, applyApproval } = require('./agent')
const { transcribeAudio } = require('./aiClient')
const appFinder = require('../services/system/appFinder')
const fileSearch = require('../services/system/fileSearch')
const timerManager = require('../services/system/timerManager')
const elevenLabsTts = require('../services/tts/elevenLabsTts')
const runtimeSettings = require('./runtimeSettings')

let mainWindowRef = null
let dispatchIntentRef = null

// In-process event log buffer (mirrors the UI dev server's buffer so the
// dashboard log panel works inside Electron too).
const logBuffer = []

function pushLog(text, type = 'CLIENT', category = 'info') {
  logBuffer.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type,
    text,
    category
  })
  if (logBuffer.length > 200) logBuffer.pop()
}

/** Electron main injects these after boot; headless mode skips them. */
function setContext({ mainWindow, dispatchIntent } = {}) {
  if (mainWindow !== undefined) mainWindowRef = mainWindow
  if (dispatchIntent !== undefined) dispatchIntentRef = dispatchIntent
}

// ── Plumbing ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, data) {
  try {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS })
    res.end(JSON.stringify(data))
  } catch (err) {
    logger.debug(`sendJson failed: ${err.message}`)
  }
}

// ── Request handler ───────────────────────────────────────────────────────

async function handleApiRequest(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${constants.HTTP_SERVER_PORT}`)
  const pathname = url.pathname

  if (req.method === 'OPTIONS') return sendJson(res, 204, '')

  // ---- Health ----
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'nimo-backend', agent: true, ts: Date.now() })
  }

  // ---- Event log buffer (dashboard live log inside Electron) ----
  if (req.method === 'GET' && pathname === '/api/logs') {
    return sendJson(res, 200, { logs: logBuffer, timers: [] })
  }

  if (req.method === 'POST' && pathname === '/api/logs/add') {
    try {
      const body = await parseBody(req)
      if (body.text) pushLog(String(body.text), body.type || 'CLIENT', body.category || 'info')
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 200, { ok: true })
    }
  }

  if (req.method === 'POST' && pathname === '/api/logs/clear') {
    logBuffer.length = 0
    pushLog('Event log cleared.', 'SYSTEM', 'info')
    return sendJson(res, 200, { ok: true })
  }

  // ---- Full agent brain ----
  if (req.method === 'POST' && pathname === '/api/agent') {
    try {
      const body = await parseBody(req)
      const { text, sessionId, personality } = body
      if (!text || !String(text).trim()) {
        return sendJson(res, 400, { ok: false, error: 'Text is empty' })
      }
      const result = await runAgent({
        text: String(text),
        sessionId: sessionId || 'default',
        personality: personality || 'friendly'
      })
      pushLog(`You: "${String(text).slice(0, 120)}"`, 'YOU', 'voice')
      result.steps?.forEach((s) => pushLog(`Tool: ${s.summary}`, s.ok ? 'TOOL' : 'TOOL!', s.ok ? 'action' : 'error'))
      if (result.speak) pushLog(`NIMO: "${result.speak.slice(0, 140)}"`, 'NIMO', 'ai')
      return sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      logger.error(`/api/agent error: ${err.message}`)
      return sendJson(res, 200, {
        ok: false,
        action: 'agent',
        speak: err.speak || 'I had trouble thinking that through. Maybe try again?',
        text: err.speak || 'I had trouble thinking that through.',
        state: 'error',
        needsClarification: false,
        steps: [],
        cards: []
      })
    }
  }

  if (req.method === 'POST' && pathname === '/api/agent/reset') {
    try {
      const body = await parseBody(req)
      resetSession(body.sessionId)
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 200, { ok: true })
    }
  }

  // ---- Approval gate: resolve a pending write/type action ----
  if (req.method === 'POST' && pathname === '/api/agent/approve') {
    try {
      const body = await parseBody(req)
      const result = await applyApproval({
        sessionId: body.sessionId || 'default',
        pendingId: body.pendingId,
        approved: Boolean(body.approved)
      })
      pushLog(`${body.approved ? 'APPROVED' : 'DECLINED'}: ${result.speak?.slice(0, 100) || ''}`, 'APPROVAL', body.approved ? 'action' : 'info')
      if (result.steps) result.steps.forEach((s) => pushLog(`Tool: ${s.summary}`, s.ok ? 'TOOL' : 'TOOL!', s.ok ? 'action' : 'error'))
      return sendJson(res, 200, result)
    } catch (err) {
      logger.error(`/api/agent/approve error: ${err.message}`)
      return sendJson(res, 200, { ok: false, speak: 'The approval could not be processed.', steps: [] })
    }
  }

  // ---- Legacy one-shot command (fast local intents + agent fallback) ----
  if (req.method === 'POST' && pathname === '/api/run-command') {
    try {
      const body = await parseBody(req)
      const { transcript, personality, sessionId } = body
      logger.info(`[RUN-COMMAND] transcript="${transcript}"`)

      if (!transcript || !String(transcript).trim()) {
        return sendJson(res, 400, { ok: false, error: 'Transcript is empty' })
      }

      const parsed = parseCommand(String(transcript))
      if (!parsed) {
        return sendJson(res, 200, { ok: true, action: 'unknown', result: '', speak: "I didn't catch that.", state: 'confused' })
      }

      // ai_query now routes through the agent (tools + clarification).
      if (parsed.intent === 'ai_query') {
        const result = await runAgent({
          text: parsed.params.text || String(transcript),
          sessionId: sessionId || 'default',
          personality: personality || 'friendly'
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      // Fast-path intents dispatch through the Electron-aware handler when
      // available; headless mode still covers timers, volume, apps, etc.
      const envelope = dispatchIntentRef
        ? await dispatchIntentRef(parsed.intent, parsed.params, mainWindowRef)
        : await headlessDispatch(parsed.intent, parsed.params)

      return sendJson(res, 200, {
        ok: true,
        action: envelope.action || parsed.intent,
        result: envelope.result || '',
        speak: envelope.speak || '',
        state: envelope.state || 'idle',
        openUrl: envelope.openUrl || undefined,
        results: envelope.results || undefined,
        timer: envelope.timer || undefined,
        stop: envelope.stop || false
      })
    } catch (err) {
      logger.error(`/api/run-command error: ${err.message}`)
      return sendJson(res, 200, { ok: false, action: 'error', result: err.message, speak: 'Something went wrong on my end.', state: 'error' })
    }
  }

  // ---- Timers ----
  if (req.method === 'GET' && pathname === '/api/timers') {
    try {
      const timers = timerManager.listTimers().map((t) => ({
        id: t.id,
        label: t.label,
        minutes: t.minutes,
        remaining: Math.max(0, Math.round(t.remainingMs / 1000)),
        active: t.remainingMs > 0
      }))
      return sendJson(res, 200, { ok: true, timers })
    } catch (err) {
      return sendJson(res, 200, { ok: false, timers: [], error: err.message })
    }
  }

  if (req.method === 'POST' && pathname === '/api/timers/cancel') {
    try {
      const body = await parseBody(req)
      const ok = timerManager.cancelTimer(body.id)
      return sendJson(res, 200, { ok, cancelled: ok })
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message })
    }
  }

  // ---- Voice input: transcribe a mic recording via Gemini ----
  if (req.method === 'POST' && pathname === '/api/agent/transcribe') {
    try {
      const body = await parseBody(req)
      const text = await transcribeAudio(String(body.audio || ''))
      return sendJson(res, 200, { ok: true, text })
    } catch (err) {
      logger.error(`/api/agent/transcribe error: ${err.message}`)
      return sendJson(res, 200, { ok: false, text: '', error: err.message })
    }
  }

  // ---- Computer-control mode: 'ask' (default) or 'granted' ----
  if (req.method === 'GET' && pathname === '/api/agent/control-mode') {
    return sendJson(res, 200, { ok: true, mode: runtimeSettings.get('controlMode') })
  }

  if (req.method === 'POST' && pathname === '/api/agent/control-mode') {
    try {
      const body = await parseBody(req)
      const mode = body.mode === 'granted' ? 'granted' : 'ask'
      runtimeSettings.set('controlMode', mode)
      pushLog(`Computer control mode: ${mode}`, 'SETTINGS', 'info')
      return sendJson(res, 200, { ok: true, mode })
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message })
    }
  }

  // ---- OS layer: installed apps (names only) ----
  if (req.method === 'GET' && pathname === '/api/os/apps') {
    try {
      const filter = (url.searchParams.get('filter') || '').toLowerCase()
      const apps = appFinder.listInstalledApps()
      const filtered = filter ? apps.filter((a) => a.name.toLowerCase().includes(filter)) : apps
      return sendJson(res, 200, { ok: true, count: apps.length, apps: filtered.slice(0, 100).map((a) => ({ name: a.name, folder: a.folder })) })
    } catch (err) {
      return sendJson(res, 200, { ok: false, apps: [], error: err.message })
    }
  }

  // ---- OS layer: read-only file search ----
  if (req.method === 'POST' && pathname === '/api/os/search-files') {
    try {
      const body = await parseBody(req)
      const r = await fileSearch.searchFiles({ name: body.name, folder: body.folder })
      return sendJson(res, 200, { ok: r.ok, speak: r.speak, ...r.data })
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message, results: [] })
    }
  }

  // ---- ElevenLabs TTS passthrough ----
  if (req.method === 'POST' && pathname === '/api/tts') {
    try {
      const body = await parseBody(req)
      const { text, opts } = body
      if (!text || !String(text).trim()) return sendJson(res, 400, { ok: false, error: 'Text is empty' })
      // TTS engines spell all-caps "NIMO" letter-by-letter — "Nimo" speaks
      // as one word.
      const data = await elevenLabsTts.synthesize(String(text).replace(/\bNIMO\b/g, 'Nimo'), opts || {})
      return sendJson(res, 200, { ok: true, data })
    } catch (err) {
      logger.error(`/api/tts error: ${err.message}`)
      return sendJson(res, 500, { ok: false, error: err.message })
    }
  }

  return sendJson(res, 404, { ok: false, error: `No route ${req.method} ${pathname}` })
}

// Minimal dispatch for headless mode (no Electron): only pure-Node intents.
async function headlessDispatch(intent, params) {
  const volumeControl = require('../services/system/volumeControl')
  const response = require('./responseBuilder')
  switch (intent) {
    case 'set_volume': return response.volume({ level: await volumeControl.setVolume(params.value ?? 50) }, 'set')
    case 'volume_up': return response.volume({ level: await volumeControl.volumeUp() }, 'up')
    case 'volume_down': return response.volume({ level: await volumeControl.volumeDown() }, 'down')
    case 'set_timer': return response.setTimer(timerManager.setTimer(params.minutes, params.label || 'Timer'))
    case 'stop': {
      timerManager.cancelAll()
      return response.stop()
    }
    case 'get_time': {
      const now = new Date()
      return response.getTime({
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        date: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      })
    }
    case 'get_date': return response.getDate({ date: new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) })
    default:
      return response.build('unknown', { intent }, "I can't do that in headless mode — start the NIMO app.", 'confused')
  }
}

module.exports = { handleApiRequest, setContext, sendJson, parseBody }
