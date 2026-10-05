/**
 * services/system/fileSearch.js
 * READ-ONLY local file search for NIMO's agent.
 *
 * Hard safety rules (by design, not by policy):
 *   - Only fs.stat + readdir are ever called. File contents are NEVER read.
 *   - Search roots are limited to the user's profile folders (Desktop,
 *     Documents, Downloads, Pictures, Music, Videos, OneDrive). Windows and
 *     Program Files are refused.
 *   - Nothing can be opened, modified, moved or deleted through this module.
 *   - Results capped + time-boxed so a huge drive can't stall the agent.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const logger = require('../../utils/logger')

const MAX_RESULTS = 25
const MAX_DEPTH = 6
const TIME_BUDGET_MS = 8000
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', 'AppData', '$Recycle.Bin', 'System Volume Information',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '.venv', 'venv',
  '__pycache__', '.vscode', '.idea', 'site-packages'
])

/** Allowed search roots (user profile only). */
function allowedRoots() {
  const home = os.homedir()
  const candidates = [
    'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos',
    'OneDrive', 'OneDrive/Desktop', 'OneDrive/Documents'
  ]
  return candidates
    .map((d) => path.join(home, d))
    .filter((p) => {
      try { return fs.statSync(p).isDirectory() } catch { return false }
    })
}

/**
 * Guard a user-supplied folder hint: resolve it against the home directory
 * and refuse anything outside the allowed roots.
 * @returns {string|null} resolved safe root, or null when refused.
 */
function resolveSafeRoot(folderHint) {
  const roots = allowedRoots()
  if (!folderHint) return roots[0] || null

  const hint = String(folderHint).trim().replace(/[/\\]+$/, '')
  const home = os.homedir()

  // Normalize "documents", "my documents", "Desktop" etc.
  const simple = hint.toLowerCase().replace(/^my /, '').replace(/[^a-z0-9]/g, '')
  const byName = roots.find((r) => path.basename(r).toLowerCase().replace(/[^a-z0-9]/g, '') === simple)
  if (byName) return byName

  // Absolute or relative path: must resolve INSIDE home + an allowed root.
  const abs = path.isAbsolute(hint) ? path.normalize(hint) : path.join(home, hint)
  const norm = path.resolve(abs)
  const inRoot = roots.find((r) => norm === path.resolve(r) || norm.startsWith(path.resolve(r) + path.sep))
  if (inRoot) return norm

  logger.warn(`fileSearch: refused search root outside user folders: ${hint}`)
  return null
}

function matchScore(fileName, query) {
  const f = fileName.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return -1
  if (f === q) return 0
  if (f.startsWith(q)) return 1
  if (f.includes(q)) return 2
  return -1
}

/**
 * Search file NAMES under the user's folders.
 * @param {{name:string, folder?:string, limit?:number}} opts
 * @returns {Promise<{ok:boolean, speak:string, data:{query:string, root:string, results:Array}}>}
 */
async function searchFiles({ name, folder, limit } = {}) {
  const query = String(name || '').trim()
  if (!query) {
    return { ok: false, speak: 'What file should I look for?', data: { query: '', root: '', results: [] } }
  }
  const root = resolveSafeRoot(folder)
  if (!root) {
    return {
      ok: false,
      speak: 'I only search inside your Desktop, Documents, Downloads, Pictures, Music and Videos — nothing system-wide.',
      data: { query, root: '', results: [] }
    }
  }

  const cap = Math.min(Math.max(1, limit || MAX_RESULTS), 50)
  const results = []
  const deadline = Date.now() + TIME_BUDGET_MS
  const queue = [{ dir: root, depth: 0 }]

  // Iterative BFS — no recursion, hard depth + time caps.
  while (queue.length && results.length < cap && Date.now() < deadline) {
    const { dir, depth } = queue.shift()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (results.length >= cap || Date.now() > deadline) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      const score = matchScore(e.name, query)
      if (score >= 0) {
        let stat = null
        try { stat = fs.statSync(full) } catch { /* file vanished — fine */ }
        results.push({
          name: e.name,
          path: full,
          folder: path.basename(dir),
          score,
          sizeKB: stat ? Math.round(stat.size / 1024) : null,
          modified: stat ? stat.mtime.toISOString().slice(0, 10) : null
        })
      }
    }
  }

  results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
  const trimmed = results.slice(0, cap)

  const speak = trimmed.length
    ? `I found ${trimmed.length === 1 ? 'one match' : `${trimmed.length} matches`} for "${query}" in your ${path.basename(root)}.`
    : `I couldn't find anything named "${query}" in your ${path.basename(root)}.`

  logger.info(`fileSearch: "${query}" in ${root} → ${trimmed.length} results.`)
  return { ok: trimmed.length > 0, speak, data: { query, root, results: trimmed } }
}

module.exports = { searchFiles, allowedRoots, resolveSafeRoot }
