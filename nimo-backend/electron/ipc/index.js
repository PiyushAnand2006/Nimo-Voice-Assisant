/**
 * electron/ipc/index.js
 * Registers ALL IPC handlers and contains the dispatchIntent() function that
 * maps an intent to a service call, returning a { action, result, speak, state }
 * envelope for the renderer.
 */

const { ipcMain } = require('electron')
const logger = require('../../utils/logger')
const { format, NimoError } = require('../../utils/errorHandler')

// Core
const { parseCommand } = require('../../core/commandParser')
const { askClaude } = require('../../core/aiClient')
const { runAgent } = require('../../core/agent')
const response = require('../../core/responseBuilder')
const { phrases } = require('../../core/responseBuilder')
const constants = require('../../config/constants')
const { initKey, saveKey, deleteKey, getKey } = require('../../config/keystore')

// Handlers per-category
const systemHandlers = require('./systemHandler')
const searchHandlers = require('./searchHandler')
const mediaHandlers = require('./mediaHandler')

// Services used by dispatchIntent()
const volumeControl = require('../../services/system/volumeControl')
const appLauncher = require('../../services/system/appLauncher')
const timerManager = require('../../services/system/timerManager')
const screenshotter = require('../../services/system/screenshotter')
const searchService = require('../../services/web/searchService')
const spotifyHandler = require('../../services/media/spotifyHandler')
const youtubeHandler = require('../../services/media/youtubeHandler')
const mediaKeys = require('../../services/system/mediaKeys')

function pushStateChange(mainWindow, state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nimo:state-change', { state })
  }
}

function pushSpeak(mainWindow, text) {
  if (mainWindow && !mainWindow.isDestroyed() && text) {
    mainWindow.webContents.send('nimo:speak', { text })
  }
}

// Personality chosen in the dashboard; used by the agent fallback path.
let currentPersonality = 'friendly'

/**
 * Central intent → service dispatcher.
 * Returns { action, result, speak, state }.
 */
async function dispatchIntent(intent, params, mainWindow) {
  try {
    switch (intent) {
      // ---------- Music ----------
      case 'play_music': {
        const query = (params.query || '').trim()
        if (!query) {
          return response.playMusic({ success: false, query: '', error: 'Empty query.' }, 'youtube', {})
        }
        // Don't strip 'on youtube' or 'on spotify' if it's the *only* thing in the query.
        // Actually, just pass the raw query.
        const isSpotify = /spotify/i.test(query)
        const clean = query.replace(/\s+on\s+(?:spotify|youtube)\b.*$/i, '').trim()
        const service = isSpotify ? 'spotify' : 'youtube'

        // Directly launch the browser — no confirmation needed.
        const r = isSpotify
          ? await spotifyHandler.openSpotify(clean)
          : await youtubeHandler.openYouTube(clean)
        return response.playMusic(r, service)
      }

      // ---------- Open YouTube ----------
      case 'open_youtube': {
        const res = await youtubeHandler.openYouTube('')
        return response.openUrl(res.url || 'https://www.youtube.com', 'youtube')
      }

      // ---------- Media transport controls (OS-level media keys) ----------
      case 'music_next': {
        const r = await mediaKeys.mediaNext()
        return response.mediaControl('next',
          r.success ? 'Skipping to the next track.' : "I couldn't send the next-track key.")
      }
      case 'music_previous': {
        const r = await mediaKeys.mediaPrevious()
        return response.mediaControl('previous',
          r.success ? 'Going back to the previous track.' : "I couldn't send the previous-track key.")
      }
      case 'music_pause': {
        const r = await mediaKeys.mediaPlayPause()
        return response.mediaControl('pause',
          r.success ? 'Pausing the music.' : "I couldn't send the pause key.")
      }
      case 'music_resume': {
        const r = await mediaKeys.mediaPlayPause()
        return response.mediaControl('resume',
          r.success ? 'Resuming the music.' : "I couldn't send the play key.")
      }

      // ---------- App ----------
      case 'open_app': {
        const res = await appLauncher.openApp(params.appName)
        if (res && res.url) return response.openUrl(res.url, res.launched || params.appName)
        return response.openApp(res)
      }

      // ---------- Web Search ----------
      case 'web_search': {
        const res = await searchService.performSearch(params.query, constants.DEFAULT_SEARCH_ENGINE)
        return response.webSearch(res, res.engine || constants.DEFAULT_SEARCH_ENGINE)
      }

      // ---------- Image Search ----------
      case 'image_search': {
        const res = await searchService.openImageSearch(params.query)
        return response.imageSearch(res)
      }

      // ---------- Timer ----------
      case 'set_timer': {
        const res = timerManager.setTimer(params.minutes, params.label || 'Timer')
        return response.setTimer(res)
      }

      // ---------- Time / Date ----------
      case 'get_time': {
        const now = new Date()
        const data = {
          time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          date: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        }
        return response.getTime(data)
      }
      case 'get_date': {
        const now = new Date()
        const data = { date: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) }
        return response.getDate(data)
      }

      // ---------- Volume ----------
      case 'volume_up': {
        const level = await volumeControl.volumeUp()
        return response.volume({ level }, 'up')
      }
      case 'volume_down': {
        const level = await volumeControl.volumeDown()
        return response.volume({ level }, 'down')
      }
      case 'set_volume': {
        const level = await volumeControl.setVolume(params.value ?? 50)
        return response.volume({ level }, 'set')
      }

      // ---------- Screenshot ----------
      case 'screenshot': {
        const res = await screenshotter.takeScreenshot()
        return response.screenshot(res)
      }

      // ---------- Weather (legacy fast-path: real API via the agent tools) ----------
      case 'get_weather': {
        const liveData = require('../../services/web/liveData')
        const r = await liveData.getWeather(params.city || null)
        return response.weather({ summary: r.speak, data: r.data })
      }

      // ---------- Stop ----------
      case 'stop': {
        timerManager.cancelAll()
        if (mainWindow) pushStateChange(mainWindow, 'idle')
        return response.stop()
      }

      // ---------- Agent fallback ----------
      // The catch-all now runs the full tool-using agent: real-time fetches,
      // OS actions, and clarifying questions when the request is ambiguous.
      case 'ai_query': {
        pushStateChange(mainWindow, 'thinking')
        const result = await runAgent({
          text: params.text || '',
          sessionId: 'ipc-default',
          personality: currentPersonality
        })
        if (mainWindow && result.speak) pushSpeak(mainWindow, result.speak)
        return {
          action: result.needsClarification ? 'agent_clarify' : 'agent',
          result: { text: result.text, steps: result.steps, cards: result.cards },
          speak: result.speak,
          state: result.state,
          openUrl: result.openUrl,
          needsClarification: result.needsClarification,
          steps: result.steps,
          cards: result.cards
        }
      }

      default:
        return response.build(
          'unknown',
          { intent },
          "I'm not sure what to do with that one.",
          'confused'
        )
    }
  } catch (err) {
    return format(err, 'INTENT_DISPATCH')
  }
}

/**
 * Register every IPC channel. Call once from main after the BrowserWindow is
 * ready.
 */
function registerAllIpc(mainWindow) {
  // --- Category handlers (volume, search, media, etc.) ---
  systemHandlers.registerSystemHandlers(mainWindow)
  searchHandlers.registerSearchHandlers()
  mediaHandlers.registerMediaHandlers()

  // --- Parsed command pipeline ---
  ipcMain.handle('nimo:run-command', async (_e, { transcript }) => {
    const parsed = parseCommand(transcript)
    if (!parsed) {
      return response.build(
        'unknown',
        { transcript },
        "I didn't catch a command in that.",
        'confused'
      )
    }
    // Push 'thinking' state while we calculate the action.
    pushStateChange(mainWindow, 'thinking')
    const envelope = await dispatchIntent(parsed.intent, parsed.params, mainWindow)
    // After dispatching, push a state that the action implies — but only if the
    // envelope's speak text is non-empty (AI replies come pre-flagged 'talking').
    if (!envelope || !envelope.state || envelope.state === 'idle' || envelope.state === 'thinking') {
      pushStateChange(mainWindow, envelope && envelope.state ? envelope.state : 'idle')
    } else {
      pushStateChange(mainWindow, envelope.state)
    }
    return envelope
  })

  // --- Direct AI query (no parsing) ---
  ipcMain.handle('nimo:ai-query', async (_e, { text, history }) => {
    try {
      if (!text) return format(new Error('No text supplied.'), 'AI')
      pushStateChange(mainWindow, 'thinking')
      const reply = await askClaude(text, history)
      pushSpeak(mainWindow, reply)
      return { ok: true, data: { text: reply } }
    } catch (err) {
      return format(err, 'AI')
    }
  })

  // --- Full agent brain (tools + clarification + sessions) ---
  ipcMain.handle('nimo:agent', async (_e, { text, sessionId, personality } = {}) => {
    try {
      if (!text || !String(text).trim()) return format(new Error('No text supplied.'), 'AGENT')
      pushStateChange(mainWindow, 'thinking')
      const result = await runAgent({
        text: String(text),
        sessionId: sessionId || 'ipc-default',
        personality: personality || currentPersonality
      })
      if (result.speak) pushSpeak(mainWindow, result.speak)
      return { ok: true, data: result }
    } catch (err) {
      return format(err, 'AGENT')
    }
  })

  ipcMain.handle('nimo:set-personality', async (_e, { personality } = {}) => {
    if (personality) currentPersonality = personality
    return { ok: true, data: { personality: currentPersonality } }
  })

  // --- OS layer: installed apps + read-only file search ---
  ipcMain.handle('nimo:list-apps', async (_e, { filter } = {}) => {
    try {
      const appFinder = require('../../services/system/appFinder')
      const apps = appFinder.listInstalledApps()
      const f = String(filter || '').toLowerCase()
      const filtered = f ? apps.filter((a) => a.name.toLowerCase().includes(f)) : apps
      return { ok: true, data: { count: apps.length, apps: filtered.slice(0, 100).map((a) => ({ name: a.name, folder: a.folder })) } }
    } catch (err) {
      return format(err, 'APPS')
    }
  })

  ipcMain.handle('nimo:search-files', async (_e, { name, folder } = {}) => {
    try {
      const fileSearch = require('../../services/system/fileSearch')
      const r = await fileSearch.searchFiles({ name, folder })
      return { ok: r.ok, data: r.data, speak: r.speak }
    } catch (err) {
      return format(err, 'FILE_SEARCH')
    }
  })

  ipcMain.handle('nimo:save-api-key', async (_e, { key }) => {
    try {
      const ok = await saveKey(String(key || '').trim())
      if (ok) process.env.GEMINI_API_KEY = String(key).trim()
      return { ok: true, data: { saved: ok } }
    } catch (err) {
      return format(err, 'KEYSTORE')
    }
  })

  ipcMain.handle('nimo:has-api-key', async () => {
    try {
      const key = await getKey()
      return { ok: true, data: { hasKey: Boolean(key && key.length > 0) } }
    } catch (err) {
      return format(err, 'KEYSTORE')
    }
  })

  // --- State event relay (renderer pushes listening/talking state) ---
  ipcMain.handle('nimo:state-event', async (_e, { state } = {}) => {
    if (state) pushStateChange(mainWindow, state)
    return { ok: true, data: { state } }
  })

  logger.info('All IPC handlers registered.')
}

module.exports = { registerAllIpc, dispatchIntent, pushStateChange, pushSpeak }
