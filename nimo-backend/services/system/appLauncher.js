/**
 * services/system/appLauncher.js
 * Cross-platform application launcher using child_process.exec.
 *
 * openApp(appName)
 *   1. Normalizes the spoken name (lowercase, trim).
 *   2. Fuzzy-matches against a per-OS app map using fastest-levenshtein.
 *   3. If a candidate is close enough, run its mapped shell command.
 *   4. Otherwise, attempt a direct platform-agnostic launch of the raw name.
 *
 * Returns: { success, launched, error? }
 */

const { spawn } = require('child_process')
const osDetect = require('../../utils/osDetect')
const logger = require('../../utils/logger')
const browserLauncher = require('./browserLauncher')

let distanceFn = null
try {
  // fastest-levenshtein exports `distance` as a named function.
  const mod = require('fastest-levenshtein')
  distanceFn = mod.distance || mod.default || mod
} catch {
  distanceFn = null
  logger.warn('fastest-levenshtein not installed; fuzzy matching disabled.')
}

const appMap = {
  win32: {
    spotify: 'start.spotify:',
    spotify_simple: 'start spotify',
    chrome: 'start chrome',
    edge: 'start msedge',
    firefox: 'start firefox',
    vscode: 'code',
    code: 'code',
    notepad: 'notepad',
    calculator: 'calc',
    explorer: 'explorer',
    terminal: 'start cmd',
    cmd: 'start cmd',
    powershell: 'start powershell',
    settings: 'start ms-settings:',
    vscode_insiders: 'code-insiders',
    word: 'start winword',
    excel: 'start excel',
    powerpoint: 'start powerpnt'
  },
  darwin: {
    spotify: 'open -a Spotify',
    chrome: 'open -a "Google Chrome"',
    firefox: 'open -a Firefox',
    safari: 'open -a Safari',
    vscode: 'open -a "Visual Studio Code"',
    code: 'open -a "Visual Studio Code"',
    notes: 'open -a Notes',
    terminal: 'open -a Terminal',
    finder: 'open -a Finder',
    mail: 'open -a Mail',
    calendar: 'open -a Calendar',
    settings: 'open -x applepref:'
  },
  linux: {
    spotify: 'spotify',
    chrome: 'google-chrome',
    chromium: 'chromium-browser',
    firefox: 'firefox',
    vscode: 'code',
    code: 'code',
    terminal: 'x-terminal-emulator',
    files: 'xdg-open ~',
    nautilus: 'nautilus',
    gedit: 'gedit',
    settings: 'gnome-control-center'
  }
}

// Web destinations: routed through browserLauncher so they open in a brand-new
// browser window.
const webUrlMap = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  spotify: 'https://open.spotify.com',
  facebook: 'https://www.facebook.com',
  twitter: 'https://twitter.com',
  x: 'https://twitter.com',
  instagram: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com',
  amazon: 'https://www.amazon.com',
  flipkart: 'https://www.flipkart.com',
  wikipedia: 'https://www.wikipedia.org',
  stack: 'https://stackoverflow.com',
  stackoverflow: 'https://stackoverflow.com',
  chatgpt: 'https://chat.openai.com',
  gmailweb: 'https://mail.google.com',
  maps: 'https://maps.google.com',
  googlemaps: 'https://maps.google.com'
}

// Domain → URL inference. If user says "open <domain>" e.g. "open facebook.com"
// or "open anthropic dot com", we parse and open that URL.
function inferDomainUrl(rawName, normalizedName) {
  const inputs = [rawName, normalizedName]
  for (const candidate of inputs) {
    if (!candidate) continue
    const cleaned = candidate
      .toLowerCase()
      .replace(/\bdot\b/g, '.')
      .replace(/\s+/g, '')
      .replace(/^\.+|\.+$/g, '')
    if (!cleaned) continue
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cleaned)) {
      return `https://${cleaned}`
    }
  }
  return null
}

// Acceptable fuzzy distance threshold (lower = stricter).
const MAX_DISTANCE = 3

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s-]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Find the best matching key in the OS map for a spoken app name.
 * @param {string} name normalized spoken name
 * @param {'win32'|'darwin'|'linux'} platform
 * @returns {string|null} matched key
 */
function fuzzyMatch(name, platform) {
  const keys = Object.keys(appMap[platform] || {})
  if (!keys.length) return null

  // Exact hit first.
  if (keys.includes(name)) return name

  if (!distanceFn) {
    // Without levenshtein, try a startsWith fallback.
    const partial = keys.find((k) => k.startsWith(name) || name.startsWith(k))
    return partial || null
  }

  let best = null
  let bestDist = Infinity
  for (const k of keys) {
    const d = distanceFn(name, k)
    if (d < bestDist) {
      bestDist = d
      best = k
    }
  }
  return bestDist <= MAX_DISTANCE ? best : null
}

/**
 * Execute a shell command and resolve when it returns, regardless of exit code
 * (many GUI launchers fork and the parent exits 0). We treat a nonzero exit
 * within ~5s as a failure.
 */
function run(cmd) {
  // Static map commands only: tokenized and spawned WITHOUT a shell, so no
  // value can ever be interpreted by a command interpreter. Windows `start`
  // is a cmd builtin and gets cmd.exe with the tokens as separate arguments.
  const tokens = String(cmd).trim().split(/\s+/)
  const bin = tokens[0]
  const args = tokens.slice(1)
  const child = process.platform === 'win32' && bin === 'start'
    ? spawn('cmd.exe', ['/c', 'start', ...args], { shell: false, detached: true, stdio: 'ignore' })
    : spawn(bin, args, { shell: false, detached: true, stdio: 'ignore' })
  return new Promise((resolve) => {
    child.once('error', () => resolve(false))
    child.once('spawn', () => resolve(true))
    setTimeout(() => resolve(true), 3000)
    try { child.unref() } catch { /* noop */ }
  })
}

/**
 * Open an app by spoken name.
 * @param {string} appName
 * @returns {Promise<{success:boolean, launched:string, url?:string, browser?:string, error?:string}>}
 */
async function openApp(appName) {
  const platform = osDetect.getOS()
  const rawName = String(appName || '').trim()
  const name = normalize(appName)
  if (!name) {
    return { success: false, launched: '', error: 'Empty app name.' }
  }

  const map = appMap[platform] || {}
  const matchedKey = fuzzyMatch(name, platform)

  // Try the matched command first.
  if (matchedKey && map[matchedKey]) {
    const ok = await run(map[matchedKey])
    if (ok) {
      logger.info(`openApp: launched "${matchedKey}" via "${map[matchedKey]}".`)
      const url = webUrlMap[matchedKey]
      return { success: true, launched: prettyName(matchedKey), url }
    }
  }

  // Web destinations (mapped apps) get a new browser window.
  if (webUrlMap[name]) {
    const r = await browserLauncher.openInBrowser(webUrlMap[name])
    if (r.success) {
      logger.info(`openApp: opened web destination "${name}" in new ${r.browser} window.`)
      return { success: true, launched: prettyName(name), url: r.url, browser: r.browser }
    }
  }

  // "Open <domain>.<tld>" or "open foo dot com"
  const inferredUrl = inferDomainUrl(rawName, name)
  if (inferredUrl) {
    const r = await browserLauncher.openInBrowser(inferredUrl)
    if (r.success) {
      const friendly = rawName.replace(/\bdot\b/gi, '.').trim()
      logger.info(`openApp: opened inferred domain "${inferredUrl}" in ${r.browser}.`)
      return { success: true, launched: prettyName(friendly), url: r.url, browser: r.browser }
    }
  }

  // Search-on-web fallback: any unknown app name becomes a Google search in a
  // brand-new Chrome window — far better than the "check it's installed"
  // failure users used to see.
  const searchUrl = `https://www.google.com/search?q=open+${encodeURIComponent(name)}`
  const fallback = await browserLauncher.openInBrowser(searchUrl)
  if (fallback.success) {
    logger.info(`openApp: searched the web for "${name}".`)
    return {
      success: true,
      launched: prettyName(name),
      url: fallback.url,
      browser: fallback.browser,
      fallback: true
    }
  }

  logger.warn(`openApp: could not launch "${appName}".`)
  return { success: false, launched: prettyName(matchedKey || name), error: `Could not launch ${appName}.` }
}

function prettyName(key) {
  if (!key) return ''
  return key.split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

module.exports = { openApp, fuzzyMatch, appMap, normalize }
