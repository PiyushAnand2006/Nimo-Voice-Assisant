/**
 * services/system/textWriter.js
 * NIMO's gated text-file writer. Paths are resolved against the user's own
 * folders by services/guard/writeGuard BEFORE anything reaches here — this
 * module trusts its caller but re-verifies the path boundary as a second
 * layer. It can create, overwrite and append text files; it can never
 * delete or truncate beyond what a single overwrite means.
 */

const fs = require('fs')
const path = require('path')
const { resolveUserWritePath } = require('../guard/writeGuard')
const { NimoError } = require('../../utils/errorHandler')

function assertInsideUserFolders(absPath) {
  const resolved = resolveUserWritePath(absPath)
  if (!resolved) {
    throw new NimoError('WRITE_PATH', 'Path is outside the user folders.', "I only write inside your own folders.", 'error')
  }
  return resolved
}

/**
 * Create or overwrite a UTF-8 text file.
 * @param {{path:string, content:string}} input — path already guard-approved.
 */
async function writeTextFile({ path: rawPath, content }) {
  const target = assertInsideUserFolders(rawPath)
  const existed = fs.existsSync(target)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, String(content), 'utf8')
  return {
    path: target,
    filename: path.basename(target),
    bytes: Buffer.byteLength(String(content), 'utf8'),
    overwritten: existed
  }
}

/** Append UTF-8 text to an existing (or new) file, adding a newline seam. */
async function appendTextFile({ path: rawPath, content }) {
  const target = assertInsideUserFolders(rawPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const existed = fs.existsSync(target)
  const seam = existed && !String(content).startsWith('\n') ? '\n' : ''
  fs.appendFileSync(target, seam + String(content), 'utf8')
  return {
    path: target,
    filename: path.basename(target),
    appendedBytes: Buffer.byteLength(seam + String(content), 'utf8'),
    createdNew: !existed
  }
}

/**
 * READ-ONLY: read a small UTF-8 text file from the user's folders so the
 * agent can look inside it. Never exceeds 64 KB; never touches system areas.
 */
async function readTextFile({ path: rawPath }) {
  const target = assertInsideUserFolders(rawPath)
  const stat = fs.statSync(target)
  if (!stat.isFile()) {
    throw new NimoError('READ_NOT_FILE', 'That path is not a file.', 'That is a folder, not a file.', 'error')
  }
  const cap = 64 * 1024
  const fd = fs.openSync(target, 'r')
  try {
    const buf = Buffer.alloc(Math.min(stat.size, cap))
    fs.readSync(fd, buf, 0, buf.length, 0)
    return {
      path: target,
      filename: path.basename(target),
      sizeBytes: stat.size,
      truncated: stat.size > cap,
      content: buf.toString('utf8')
    }
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = { writeTextFile, appendTextFile, readTextFile }
