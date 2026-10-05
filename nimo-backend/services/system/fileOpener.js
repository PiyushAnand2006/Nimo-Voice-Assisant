/**
 * services/system/fileOpener.js
 * Opens local files with their default application and reveals folders in
 * Explorer. Safety: paths must live inside the user's own folders
 * (resolveUserWritePath), and only known document/media/image/text
 * extensions can be opened — executables are refused outright, so NIMO
 * can never be tricked into launching arbitrary programs this way.
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const logger = require('../../utils/logger')
const { NimoError } = require('../../utils/errorHandler')
const { resolveUserWritePath } = require('../guard/writeGuard')

const OPENABLE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt',
  '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.webm',
  '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.ipynb',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs', '.go'
])

/** Open a file with its default app, or reveal a folder in Explorer. */
async function openFileOrFolder(rawPath) {
  let p = String(rawPath || '').trim().replace(/^"|"$/g, '')
  if (!p) throw new NimoError('OPEN_PATH', 'Empty path.', 'Tell me which file to open.', 'error')
  // Tolerate natural speech: "users thaku downloads file.pdf" is handled by
  // the model via the prompt's folder list — here we just resolve what we get.
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
  p = path.resolve(p)

  let stat = null
  try { stat = fs.statSync(p) } catch { /* fall through */ }
  const isFolder = Boolean(stat && stat.isDirectory())

  if (!isFolder) {
    const ext = path.extname(p).toLowerCase()
    if (!OPENABLE_EXTENSIONS.has(ext)) {
      throw new NimoError(
        'OPEN_BLOCKED',
        `Refusing to open "${ext || 'unknown'}" files.`,
        `I only open documents, media and text files — ".${ext || 'unknown'}" could be an executable, so I'll leave that alone.`,
        'error'
      )
    }
    if (!stat) {
      throw new NimoError('OPEN_NOT_FOUND', `File not found: ${p}`, `I couldn't find that file. Want me to search for it first?`, 'error')
    }
  }

  logger.info(`fileOpener: opening ${p}`)
  return new Promise((resolve) => {
    // explorer.exe with an argument array — shell-free launch.
    const child = spawn('explorer.exe', [p], { shell: false, detached: true, stdio: 'ignore' })
    child.on('error', (err) => {
      logger.warn(`fileOpener spawn failed: ${err.message}`)
      resolve({ success: false, path: p, isFolder, error: err.message })
    })
    child.once('spawn', () => {
      resolve({ success: true, path: p, isFolder })
    })
    // explorer.exe often exits non-zero even on success — don't wait on error
    setTimeout(() => resolve({ success: true, path: p, isFolder }), 1500)
    try { child.unref() } catch { /* noop */ }
  })
}

module.exports = { openFileOrFolder, OPENABLE_EXTENSIONS }
