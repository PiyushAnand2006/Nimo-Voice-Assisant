/**
 * services/system/appFinder.js
 * Discovers applications actually installed on this machine so NIMO can act
 * as a real OS layer instead of a hardcoded app map.
 *
 * Windows: scans the Start Menu directories for .lnk shortcuts (all-users +
 * current-user). Those names are exactly what the user sees in their own
 * Start Menu, so fuzzy matching against them feels natural.
 * macOS: /Applications + ~/Applications folders.
 * Linux: .desktop entries in the standard XDG data dirs.
 *
 * LAUNCH SAFETY: we only ever open paths found inside the Start Menu /
 * Applications directories themselves, and always through spawn() with a
 * strict argument array (shell: false) — no shell interpolation is ever
 * performed on the path. No install, no delete, no file writes — launch only.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const logger = require('../../utils/logger')
const osDetect = require('../../utils/osDetect')

let distanceFn = null
try {
  const mod = require('fastest-levenshtein')
  distanceFn = mod.distance || mod.default || mod
} catch { /* fuzzy fallback below */ }

let cache = { apps: [], scannedAt: 0 }
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_SCAN_FILES = 4000

/** Directories to scan, per platform. */
function appDirectories() {
  const plat = osDetect.getOS()
  if (plat === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData'
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return [
      path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ]
  }
  if (plat === 'darwin') {
    return ['/Applications', path.join(os.homedir(), 'Applications')]
  }
  // linux: XDG data dirs with .desktop entries
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(path.delimiter)
  return [
    ...dataDirs.map((d) => path.join(d, 'applications')),
    path.join(os.homedir(), '.local', 'share', 'applications')
  ]
}

function appExtension() {
  const plat = osDetect.getOS()
  return plat === 'win32' ? '.lnk' : plat === 'darwin' ? '.app' : '.desktop'
}

/** Recursively collect shortcut files inside the app directories. */
function collectAppFiles(dir, out, depth = 0) {
  if (depth > 4 || out.length > MAX_SCAN_FILES) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // dir missing or unreadable — fine
  }
  const ext = appExtension()
  for (const e of entries) {
    if (out.length > MAX_SCAN_FILES) return
    const full = path.join(dir, e.name)
    try {
      if (e.isDirectory()) {
        if (e.name === 'Startup') continue
        collectAppFiles(full, out, depth + 1)
      } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
        // Skip uninstallers and junk — NIMO should launch apps, not run them.
        if (/uninstall|uninst|setup|readme|help|license/i.test(e.name)) continue
        out.push(full)
      }
    } catch { /* per-entry failure ignored */ }
  }
}

/** Pretty display name from a shortcut path. */
function prettyNameFromPath(filePath) {
  const plat = osDetect.getOS()
  const base = path.basename(filePath, plat === 'win32' ? '.lnk' : plat === 'darwin' ? '.app' : '.desktop')
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * List installed applications (cached 5 min).
 * @returns {Array<{name:string, path:string, folder:string}>}
 */
function listInstalledApps() {
  if (cache.apps.length && Date.now() - cache.scannedAt < CACHE_TTL_MS) return cache.apps
  const files = []
  for (const dir of appDirectories()) collectAppFiles(dir, files)
  const apps = files.map((p) => ({
    name: prettyNameFromPath(p),
    path: p,
    folder: path.basename(path.dirname(p))
  }))
  apps.sort((a, b) => a.name.localeCompare(b.name))
  cache = { apps, scannedAt: Date.now() }
  logger.info(`appFinder: discovered ${apps.length} installed apps.`)
  return apps
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Fuzzy-resolve a spoken app name to an installed app.
 * @param {string} spokenName
 * @returns {{app:object|null, candidates:Array}}
 */
function resolveApp(spokenName) {
  const apps = listInstalledApps()
  const want = normalize(spokenName)
  if (!want) return { app: null, candidates: [] }

  let best = null
  let bestScore = Infinity
  for (const a of apps) {
    const name = normalize(a.name)
    if (!name) continue
    if (name === want) { best = a; bestScore = 0; break }
    // prefix matches either way are strong candidates
    if (name.startsWith(want) || want.startsWith(name)) {
      const score = Math.abs(name.length - want.length)
      if (score < bestScore) { bestScore = score; best = a }
      continue
    }
    if (distanceFn) {
      const d = distanceFn(want, name)
      if (d < bestScore) { bestScore = d; best = a }
    }
  }
  const threshold = distanceFn ? Math.max(2, Math.floor(want.length * 0.3)) : 0
  const matched = best && bestScore <= threshold ? best : null

  // Name-alike candidates power NIMO's clarification questions.
  const firstWord = want.split(' ')[0]
  const candidates = apps
    .filter((a) => a !== matched)
    .filter((a) => {
      const n = normalize(a.name)
      return n.includes(firstWord) || (distanceFn && distanceFn(want, n) < 4)
    })
    .slice(0, 5)
    .map((a) => a.name)

  return { app: matched, candidates }
}

/**
 * Launch an app by name. Resolves against installed apps first.
 *
 * Launch is shell-free on every platform: spawn() with an argument array and
 * shell:false, so the resolved filesystem path is never interpreted by any
 * command interpreter.
 *
 * @param {string} appName
 * @returns {Promise<{success:boolean, launched:string, path?:string, candidates?:string[], error?:string}>}
 */
async function launchInstalledApp(appName) {
  const { app, candidates } = resolveApp(appName)
  if (!app) {
    return { success: false, launched: String(appName || ''), candidates, error: `No installed app looks like "${appName}".` }
  }

  const plat = osDetect.getOS()
  let child
  if (plat === 'win32') {
    // explorer.exe opens .lnk shortcuts directly — no cmd.exe, no shell stage.
    child = spawn('explorer.exe', [app.path], { shell: false, detached: true, stdio: 'ignore' })
  } else if (plat === 'darwin') {
    child = spawn('open', [app.path], { shell: false, detached: true, stdio: 'ignore' })
  } else {
    const id = path.basename(app.path, '.desktop')
    child = spawn('gtk-launch', [id], { shell: false, detached: true, stdio: 'ignore' })
    child.on('error', () => {
      const fb = spawn('xdg-open', [app.path], { shell: false, detached: true, stdio: 'ignore' })
      fb.on('error', () => logger.warn(`appFinder: xdg-open failed for ${app.path}.`))
      fb.unref()
    })
  }

  const ok = await new Promise((resolve) => {
    child.on('error', () => resolve(false))
    child.once('spawn', () => resolve(true))
    setTimeout(() => resolve(true), 1500) // GUI launchers detach; don't hang
  })
  try { child.unref() } catch { /* noop */ }

  if (ok) {
    logger.info(`appFinder: launched "${app.name}" (${app.path}).`)
    return { success: true, launched: app.name, path: app.path }
  }
  return { success: false, launched: app.name, path: app.path, error: `The OS refused to launch ${app.name}.` }
}

module.exports = { listInstalledApps, resolveApp, launchInstalledApp }
