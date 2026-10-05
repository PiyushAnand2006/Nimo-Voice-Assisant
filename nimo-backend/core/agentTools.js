/**
 * core/agentTools.js
 * NIMO's agent tool belt: the complete set of actions the AI may take.
 *
 * SAFETY ENVELOPE (entertainment project, zero destructive capability):
 *   - No tool can delete, move, write or download ANY file.
 *   - No tool executes shell commands from AI-supplied strings; app launch
 *     resolves only against shortcuts found in the OS Start Menu.
 *   - File search is name-only, limited to user profile folders.
 *   - All outbound web access flows through services/guard/safeFetch.
 *
 * Each executor returns a plain JSON-serializable object that is fed back to
 * the model as the tool result.
 */

const logger = require('../utils/logger')
const constants = require('../config/constants')

const liveData = require('../services/web/liveData')
const researchAgent = require('../services/web/researchAgent')
const appFinder = require('../services/system/appFinder')
const fileSearch = require('../services/system/fileSearch')
const volumeControl = require('../services/system/volumeControl')
const screenshotter = require('../services/system/screenshotter')
const timerManager = require('../services/system/timerManager')
const browserLauncher = require('../services/system/browserLauncher')
const searchService = require('../services/web/searchService')
const youtubeHandler = require('../services/media/youtubeHandler')
const spotifyHandler = require('../services/media/spotifyHandler')
const writeGuard = require('../services/guard/writeGuard')
const textWriter = require('../services/system/textWriter')
const keyTyper = require('../services/system/keyTyper')
const pendingActions = require('./pendingActions')
const fileOpener = require('../services/system/fileOpener')
const computerControl = require('../services/system/computerControl')
const screenVision = require('../services/system/screenVision')
const runtimeSettings = require('./runtimeSettings')

// ── Tool declarations (Gemini function-calling schema) ───────────────────

const toolDeclarations = [
  {
    name: 'get_current_time',
    description: 'Get the user\'s current local time. Use for any "what time is it" question.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'get_current_date',
    description: 'Get today\'s date (weekday, day, month, year).',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'get_weather',
    description: 'Fetch LIVE weather for a city (or the user\'s rough location if omitted). Always use this for weather questions instead of guessing.',
    parameters: {
      type: 'OBJECT',
      properties: { city: { type: 'STRING', description: 'City name, e.g. "Delhi" or "Tokyo". Omit for the user\'s location.' } },
      required: []
    }
  },
  {
    name: 'answer_from_web',
    description: 'Look up a factual, evergreen question ("who is X", "what is Y", "when did Z happen") and return a sourced summary. Use for knowledge questions; do NOT use for news or fast-changing data.',
    parameters: {
      type: 'OBJECT',
      properties: { question: { type: 'STRING', description: 'The thing to look up.' } },
      required: ['question']
    }
  },
  {
    name: 'research_topic',
    description: 'Run a multi-step web research task on a topic: searches several sources, reads them, and returns a synthesized briefing with citations. Use when the user asks to "research", "dig into", or "gather info" on something. Takes several seconds.',
    parameters: {
      type: 'OBJECT',
      properties: {
        topic: { type: 'STRING', description: 'What to research.' },
        focus: { type: 'STRING', description: 'Optional angle or constraint, e.g. "2026 only" or "pricing comparison".' }
      },
      required: ['topic']
    }
  },
  {
    name: 'find_installed_apps',
    description: 'List applications actually installed on this PC, optionally filtered by name. Use to check if an app exists before launching, or to answer "what apps do I have".',
    parameters: {
      type: 'OBJECT',
      properties: { filter: { type: 'STRING', description: 'Optional name filter, e.g. "game" or "chrome".' } },
      required: []
    }
  },
  {
    name: 'launch_app',
    description: 'Launch an installed application by name (e.g. "spotify", "vscode", "calculator"). Fails safely with similar-name candidates if nothing matches well.',
    parameters: {
      type: 'OBJECT',
      properties: { app_name: { type: 'STRING', description: 'The app name the user means.' } },
      required: ['app_name']
    }
  },
  {
    name: 'search_files',
    description: 'Search FILE NAMES inside the user\'s own folders (Desktop, Documents, Downloads, Pictures, Music, Videos). Read-only: it only lists matches, it never opens or changes anything.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'File name or part of a name to look for.' },
        folder: { type: 'STRING', description: 'Optional folder hint like "Documents" or "Downloads".' }
      },
      required: ['name']
    }
  },
  {
    name: 'read_text_file',
    description: 'READ a small text file (code, notes, config — up to 64 KB) from the user\'s own folders and return its contents, so you can quote it, summarize it or comment on it. Read-only.',
    parameters: {
      type: 'OBJECT',
      properties: { path: { type: 'STRING', description: 'Absolute path of the file to read.' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new text/code file (notes, markdown, code, config...) in the user\'s own folders. Overwriting an EXISTING file, or any content the safety core flags, asks the user for approval first — if the result comes back needsApproval, tell the user you are waiting for their approval and STOP.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path, e.g. C:\\Users\\me\\Documents\\ideas.md' },
        content: { type: 'STRING', description: 'Full text content to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'append_to_file',
    description: 'Append text to an existing file (or create it) in the user\'s own folders — e.g. add a comment or a line to notes/code. Content the safety core flags asks for approval first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path of the file.' },
        content: { type: 'STRING', description: 'Text to append.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'type_text',
    description: 'Type text into whatever window the user has FOCUSED (e.g. they opened Notepad or a text field and want NIMO to write a comment for them). ALWAYS requires explicit user approval — when the result comes back needsApproval, tell the user and wait.',
    parameters: {
      type: 'OBJECT',
      properties: { text: { type: 'STRING', description: 'Exact text to type.' } },
      required: ['text']
    }
  },
  {
    name: 'open_file',
    description: 'Open a LOCAL file on the user\'s PC with its default application (PDF, image, song, video, document, text/code file) or reveal a FOLDER in Explorer. Use this for any "open <path>" request — never a web search. Documents/media/text only; executables are refused.',
    parameters: {
      type: 'OBJECT',
      properties: { path: { type: 'STRING', description: 'Absolute path, e.g. C:\\Users\\me\\Downloads\\file.pdf' } },
      required: ['path']
    }
  },
  {
    name: 'move_mouse',
    description: 'Move the mouse cursor to absolute screen coordinates (physical pixels). Harmless by itself — used before clicks.',
    parameters: {
      type: 'OBJECT',
      properties: { x: { type: 'NUMBER', description: 'Screen X pixel.' }, y: { type: 'NUMBER', description: 'Screen Y pixel.' } },
      required: ['x', 'y']
    }
  },
  {
    name: 'click_mouse',
    description: 'Click the mouse at absolute screen coordinates (or at the current position if omitted). Controlled by the user\'s computer-control mode: asks for approval unless granted.',
    parameters: {
      type: 'OBJECT',
      properties: {
        x: { type: 'NUMBER', description: 'Screen X pixel (optional).' },
        y: { type: 'NUMBER', description: 'Screen Y pixel (optional).' },
        right: { type: 'BOOLEAN', description: 'Right-click.' },
        double: { type: 'BOOLEAN', description: 'Double-click.' }
      },
      required: []
    }
  },
  {
    name: 'press_keys',
    description: 'Press a keyboard combo in the focused window, e.g. "ctrl+f", "enter", "ctrl+shift+t". Controlled by the computer-control mode.',
    parameters: {
      type: 'OBJECT',
      properties: { keys: { type: 'STRING', description: 'Key combo, lowercase, "+" separated.' } },
      required: ['keys']
    }
  },
  {
    name: 'scroll_screen',
    description: 'Scroll the mouse wheel in the focused window. Positive = up, negative = down. Controlled by the computer-control mode.',
    parameters: {
      type: 'OBJECT',
      properties: { clicks: { type: 'NUMBER', description: 'Notches; negative scrolls down.' } },
      required: ['clicks']
    }
  },
  {
    name: 'find_on_screen',
    description: 'LOOK at the user\'s screen with vision and locate a described element (e.g. "the first video result"). Read-only: returns clickable screen coordinates without acting.',
    parameters: {
      type: 'OBJECT',
      properties: { target: { type: 'STRING', description: 'What to find on screen, in natural language.' } },
      required: ['target']
    }
  },
  {
    name: 'click_on_screen',
    description: 'Look at the screen with vision, locate a described element, MOVE the mouse there and CLICK it — e.g. "click the first video result". Asks approval unless computer control is granted.',
    parameters: {
      type: 'OBJECT',
      properties: { target: { type: 'STRING', description: 'The element to click, in natural language.' } },
      required: ['target']
    }
  },
  {
    name: 'set_volume',
    description: 'Set the system speaker volume to an exact percentage (0-100).',
    parameters: {
      type: 'OBJECT',
      properties: { level: { type: 'NUMBER', description: '0 to 100.' } },
      required: ['level']
    }
  },
  {
    name: 'adjust_volume',
    description: 'Raise or lower the system volume by one step.',
    parameters: {
      type: 'OBJECT',
      properties: { direction: { type: 'STRING', description: '"up" or "down".', description_enumerator: null } },
      required: ['direction']
    }
  },
  {
    name: 'take_screenshot',
    description: 'Capture the screen to a PNG saved in the user\'s Pictures folder. The image stays on the machine — it is never uploaded.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer; NIMO announces when it finishes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        minutes: { type: 'NUMBER', description: 'Duration in minutes (fractions allowed).' },
        label: { type: 'STRING', description: 'Short label, e.g. "Pasta".' }
      },
      required: ['minutes']
    }
  },
  {
    name: 'play_music',
    description: 'Play a song, artist or playlist on YouTube Music or Spotify (opens the service in the browser).',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'What to play.' },
        service: { type: 'STRING', description: '"youtube" or "spotify". Defaults to youtube.' }
      },
      required: ['query']
    }
  },
  {
    name: 'open_website',
    description: 'Open a public website (e.g. "github.com") in the user\'s browser. Only http/https public sites are allowed.',
    parameters: {
      type: 'OBJECT',
      properties: { site: { type: 'STRING', description: 'Site name or URL, e.g. "wikipedia.org".' } },
      required: ['site']
    }
  },
  {
    name: 'search_the_web',
    description: 'Run a web search: returns the top result snippets AND opens the search in the browser for the user to browse.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'Search query.' } },
      required: ['query']
    }
  }
]

// ── Executors ─────────────────────────────────────────────────────────────

function currentTimeData() {
  const now = new Date()
  return {
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }
}

function normalizeSite(site) {
  let s = String(site || '').trim()
  if (!s) return null
  s = s.replace(/\bdot\b/gi, '.').replace(/\s+/g, '')
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.href
  } catch {
    return null
  }
}

/**
 * Execute a tool call. Returns { ok, data } — data is JSON fed back to the
 * model. `openUrl` (when present) is ALSO surfaced to the UI so the frontend
 * can mirror the action. `sessionIdHint` scopes approval-gated actions.
 */
async function executeTool(name, args = {}, opts = {}) {
  const sessionIdHint = opts.sessionId || 'default'
  logger.info(`agentTools.execute: ${name} ${JSON.stringify(args).slice(0, 200)}`)
  try {
    switch (name) {
      case 'get_current_time':
        return { ok: true, data: currentTimeData() }

      case 'get_current_date':
        return { ok: true, data: { date: currentTimeData().date } }

      case 'get_weather': {
        const r = await liveData.getWeather(args.city || null)
        return { ok: r.ok, data: r.data, card: { type: 'weather', ...r.data }, speakOverride: r.speak }
      }

      case 'answer_from_web': {
        const r = await liveData.getQuickAnswer(args.question)
        return { ok: r.ok, data: r.data, card: { type: 'knowledge', ...r.data }, speakOverride: r.speak }
      }

      case 'research_topic': {
        const r = await researchAgent.researchTopic(args.topic, { focus: args.focus })
        return { ok: r.ok, data: { topic: args.topic, ...r.data }, card: { type: 'report', topic: args.topic, ...r.data }, speakOverride: r.speak }
      }

      case 'find_installed_apps': {
        const apps = appFinder.listInstalledApps()
        const filter = String(args.filter || '').toLowerCase()
        const matched = filter
          ? apps.filter((a) => a.name.toLowerCase().includes(filter)).slice(0, 25)
          : apps.slice(0, 40)
        return { ok: true, data: { count: apps.length, filter: filter || null, apps: matched.map((a) => a.name) } }
      }

      case 'launch_app': {
        const r = await appFinder.launchInstalledApp(args.app_name)
        // Fall back to the legacy map (web destinations like youtube, plus
        // common shell apps) when the Start Menu has no such shortcut.
        if (!r.success) {
          const appLauncher = require('../services/system/appLauncher')
          const legacy = await appLauncher.openApp(args.app_name)
          if (legacy.success) {
            return { ok: true, data: { launched: legacy.launched, viaLegacy: true, url: legacy.url || null }, openUrl: legacy.url }
          }
        }
        return { ok: r.success, data: r, candidates: r.candidates }
      }

      case 'search_files': {
        const r = await fileSearch.searchFiles({ name: args.name, folder: args.folder })
        return { ok: r.ok, data: r.data, card: { type: 'files', ...r.data } }
      }

      case 'read_text_file': {
        const r = await textWriter.readTextFile({ path: args.path })
        return { ok: true, data: { ...r, content: String(r.content).slice(0, 8000) }, instruction: 'You read this file — quote or summarize what the user asked about.' }
      }

      // ── Computer control: vision + mouse/keyboard, mode-gated ───────────
      case 'open_file': {
        const r = await fileOpener.openFileOrFolder(args.path)
        return {
          ok: Boolean(r.success),
          data: { path: r.path, isFolder: r.isFolder, error: r.error },
          instruction: r.success ? `Confirm opening ${r.path}` : `Tell the user it failed: ${r.error}`
        }
      }

      case 'move_mouse': {
        const r = await computerControl.moveCursor(args.x, args.y)
        return { ok: true, data: r }
      }

      case 'click_mouse':
      case 'scroll_screen':
      case 'press_keys': {
        // Computer-control mode decides: ask (default) or granted.
        const granted = runtimeSettings.get('controlMode') === 'granted'
        if (!granted) {
          const summary =
            name === 'click_mouse'
              ? `Click the mouse${args.x !== undefined ? ` at (${args.x}, ${args.y})` : ''}`
              : name === 'scroll_screen'
                ? `Scroll ${Number(args.clicks) < 0 ? 'down' : 'up'} ${Math.abs(Number(args.clicks) || 0)} notches`
                : `Press keys: ${args.keys}`
          const pendingId = pendingActions.request(sessionIdHint, { tool: name, args, summary })
          return {
            needsApproval: true,
            pendingId,
            data: { summary },
            instruction: 'Tell the user you need their approval for this input action and stop.'
          }
        }
        if (name === 'click_mouse') {
          const r = await computerControl.clickMouse(args)
          return { ok: true, data: r }
        }
        if (name === 'scroll_screen') {
          const r = await computerControl.scrollWheel(args.clicks)
          return { ok: true, data: r }
        }
        const r = await computerControl.pressKeys(args.keys)
        return { ok: true, data: r }
      }

      case 'find_on_screen': {
        const r = await screenVision.locateTarget(args.target)
        return {
          ok: r.found,
          data: { ...r },
          instruction: r.found
            ? `Target found at (${r.x}, ${r.y}) — ${r.note}. Use click_mouse with these coordinates if the user wants it clicked.`
            : `The target "${args.target}" is not visible on screen.`
        }
      }

      case 'click_on_screen': {
        const granted = runtimeSettings.get('controlMode') === 'granted'
        const look = await screenVision.locateTarget(args.target)
        if (!look.found) {
          return { ok: false, data: { error: `Couldn't find "${args.target}" on screen. ${look.note}` }, instruction: 'Tell the user what you saw instead.' }
        }
        if (!granted) {
          const pendingId = pendingActions.request(sessionIdHint, {
            tool: 'click_mouse',
            args: { x: look.x, y: look.y },
            summary: `Click "${args.target}" at (${look.x}, ${look.y}) — ${look.note}`
          })
          return {
            needsApproval: true,
            pendingId,
            data: { summary: `Click "${args.target}" at (${look.x}, ${look.y})` },
            instruction: 'Tell the user you found the target and are waiting for approval to click it.'
          }
        }
        await computerControl.moveCursor(look.x, look.y)
        const r = await computerControl.clickMouse({ x: look.x, y: look.y })
        return { ok: true, data: { ...r, target: args.target } }
      }

      // ── Gated writes: safety core classifies, approval gate when needed ──
      case 'write_file':
      case 'append_to_file':
      case 'type_text': {
        const isType = name === 'type_text'
        const content = String(isType ? args.text : args.content || '')
        const verdict = await writeGuard.classifyWrite({ tool: name, path: args.path, content })

        if (verdict.verdict === 'blocked') {
          return { ok: false, data: { error: `Blocked by the safety layer: ${verdict.reason}` }, instruction: 'Tell the user this was blocked and why. Do not retry.' }
        }

        // needs_approval is skipped when the user already approved this
        // exact pending action — but hard rules above still apply.
        if (verdict.verdict === 'needs_approval' && !opts.approvedWrite) {
          const summary = isType
            ? `Type ${content.length} characters into the focused app`
            : `${name === 'write_file' ? 'Write' : 'Append to'} ${verdict.resolvedPath}`
          const pendingId = pendingActions.request(sessionIdHint, { tool: name, args, summary, path: verdict.resolvedPath, preview: content.slice(0, 240) })
          return {
            needsApproval: true,
            pendingId,
            data: {
              summary,
              path: verdict.resolvedPath || '(focused application)',
              reason: verdict.reason,
              preview: content.slice(0, 240)
            },
            instruction: 'Tell the user you need their approval for this action and stop — the UI shows an approval card.'
          }
        }

        // Verdict: allow — execute immediately.
        if (isType) {
          const r = await keyTyper.typeIntoFocusedApp(content)
          return { ok: true, data: { typed: r.typed } }
        }
        const r = name === 'write_file'
          ? await textWriter.writeTextFile({ path: verdict.resolvedPath, content })
          : await textWriter.appendTextFile({ path: verdict.resolvedPath, content })
        return {
          ok: true,
          data: { ...r },
          instruction: `Confirm to the user with the exact saved path: ${r.path}`
        }
      }

      case 'set_volume': {
        const level = await volumeControl.setVolume(Number(args.level) || 0)
        return { ok: true, data: { level } }
      }

      case 'adjust_volume': {
        const up = String(args.direction || 'up').toLowerCase() !== 'down'
        const level = up ? await volumeControl.volumeUp() : await volumeControl.volumeDown()
        return { ok: true, data: { level: level.level, direction: up ? 'up' : 'down' } }
      }

      case 'take_screenshot': {
        const r = await screenshotter.takeScreenshot()
        return {
          ok: true,
          data: {
            path: r.path,
            filename: r.filename,
            folder: 'Pictures\\NIMO Screenshots',
            instruction: 'Tell the user the full save path shown in "path" so they can find the file.'
          }
        }
      }

      case 'set_timer': {
        const minutes = Number(args.minutes)
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
          return { ok: false, data: { error: 'Timer must be between 0 and 24 hours.' } }
        }
        const res = timerManager.setTimer(minutes, String(args.label || 'Timer'))
        return { ok: Boolean(res), data: { minutes, label: args.label || 'Timer', id: res && res.id } }
      }

      case 'play_music': {
        const query = String(args.query || '').trim()
        const service = /spotify/i.test(String(args.service || '')) ? 'spotify' : 'youtube'
        if (!query) return { ok: false, data: { error: 'No music query.' } }
        const r = service === 'spotify'
          ? await spotifyHandler.openSpotify(query)
          : await youtubeHandler.openYouTube(query)
        return { ok: Boolean(r && r.success), data: { query, service, url: r && r.url }, openUrl: r && r.url }
      }

      case 'open_website': {
        const url = normalizeSite(args.site)
        if (!url) return { ok: false, data: { error: 'That does not look like a valid public website.' } }
        const r = await browserLauncher.openInBrowser(url)
        return { ok: Boolean(r.success), data: { url, browser: r.browser }, openUrl: url }
      }

      case 'search_the_web': {
        const q = String(args.query || '').trim()
        if (!q) return { ok: false, data: { error: 'Empty search query.' } }
        const r = await searchService.performSearch(q, constants.DEFAULT_SEARCH_ENGINE)
        return { ok: Boolean(r.success), data: { query: q, url: r.url, results: r.results || [] }, openUrl: r.url, card: { type: 'search', query: q, results: r.results || [] } }
      }

      default:
        return { ok: false, data: { error: `Unknown tool: ${name}` } }
    }
  } catch (err) {
    logger.warn(`agentTools ${name} failed: ${err.message}`)
    return { ok: false, data: { error: err.message } }
  }
}

module.exports = { toolDeclarations, executeTool, currentTimeData }
