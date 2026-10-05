/**
 * services/guard/writeGuard.js
 * NIMO's brain-driven safety layer for anything that WRITES or TYPES.
 *
 * Every write passes through classifyWrite(), which combines:
 *   1. Hard rules (always enforced, cannot be talked away):
 *        - paths must live inside the user's own folders
 *        - executable/script extensions are refused outright
 *        - size caps; destructive patterns refused outright
 *   2. An LLM judgment ("the brain"): a fast Gemini pass classifies the
 *      proposed write as benign / suspicious / malicious — malicious is
 *      blocked, suspicious requires explicit user approval.
 *
 * Verdicts:
 *   'allow'           — safe, execute immediately (e.g. brand-new small note)
 *   'needs_approval'  — plausible but sensitive: overwrite, code, flagged
 *                       content, typing into other apps → ask the user first
 *   'blocked'         — harmful or outside the envelope: refuse, no approval
 *                       can override
 */

const path = require('path')
const { askModel } = require('../../core/aiClient')
const logger = require('../../utils/logger')
const { allowedRoots } = require('../system/fileSearch')

const MAX_WRITE_BYTES = 64 * 1024
const MAX_TYPE_CHARS = 2000

// Extensions NIMO will never create or write, no matter what.
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1', '.vbs',
  '.vbe', '.js.enc', '.jar', '.dll', '.sys', '.reg', '.lnk', '.iso', '.deb',
  '.rpm', '.apk', '.sh'
])

// Extensions NIMO may create/edit (plain text + common code files).
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rtf', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.scss', '.ini', '.cfg', '.conf', '.env.example',
  '.log', '.srt',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.go', '.rb', '.php', '.swift', '.kt', '.sql', '.ipynb'
])

// Destructive / malicious patterns — refused outright when clearly present.
const HARD_BLOCK_PATTERNS = [
  /rm\s+-rf?\s+\/(?:\s|$)/i,
  /format\s+[c-z]:/i,
  /del\s+\/[sfq]\s/i,
  /rd\s+\/s\s/i,
  /vmdetector|keylogger|ransomware|crypto\s?locker|encrypt\s+all\s+files/i,
  /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9\-_]{20,}/,
  /(api[_-]?key|secret|passwd|password)\s*[:=]\s*['"][A-Za-z0-9+/]{16,}['"]/i,
  /Remove-Item\s+-Recurse\s+-Force\s+[A-Za-z]:\\\s*$/i,
  /shutdown\s+\/[sr]/i
]

// Suspicious-but-plausible patterns — escalation to explicit approval.
const SUSPICIOUS_PATTERNS = [
  /invoke-expression|iex\s*\(/i,
  /curl\s+[^\n|]+\|\s*(?:ba)?sh/i,
  /powershell\s+-enc/i,
  /set-executionpolicy/i,
  /net\s+user\s+\w+\s+\/add/i,
  /schtasks\s+\/create/i,
  /registry|reg\s+add|hkey_/i,
  /eval\s*\(\s*(?:atob|unescape|Buffer)/i,
  /document\.cookie|localStorage\.getItem\(['"]token/i
]

/** Resolve a proposed absolute path; null when outside the user's folders.
 *  Relative paths are matched against the user's own folders: a leading
 *  folder name ("Desktop/notes.md") picks that root, otherwise the file is
 *  placed in Documents. */
function resolveUserWritePath(rawPath) {
  const p = String(rawPath || '').trim()
  if (!p) return null
  const home = require('os').homedir()
  let abs
  try {
    if (p.startsWith('~')) abs = path.join(home, p.slice(1))
    else if (path.isAbsolute(p)) abs = path.resolve(p)
    else {
      // Relative: match the first segment against the user's folder names.
      const roots = allowedRoots()
      const normalized = p.replace(/\\/g, '/')
      const first = normalized.split('/')[0].toLowerCase().replace(/\.[a-z0-9]+$/, '')
      const match = roots.find((r) => path.basename(r).toLowerCase() === first)
      if (match) {
        abs = path.join(match, normalized.split('/').slice(1).join('/'))
      } else {
        const documents = roots.find((r) => /documents/i.test(r)) || roots[0]
        if (!documents) return null
        abs = path.join(documents, normalized)
      }
    }
    abs = path.resolve(abs)
  } catch {
    return null
  }
  const roots = allowedRoots()
  const inRoot = roots.some((r) => abs === path.resolve(r) || abs.startsWith(path.resolve(r) + path.sep))
  const inHome = abs === path.resolve(home) || abs.startsWith(path.resolve(home) + path.sep)
  if (!inRoot && !inHome) return null
  if (/(?:^|[\\/])AppData(?:[\\/]|$)/i.test(abs)) return null
  return abs
}

function ruleCheck({ tool, resolvedPath, content }) {
  const risks = []
  if (!resolvedPath && tool !== 'type_text') {
    return { verdict: 'blocked', risks: ['Path is outside your user folders (system areas are off-limits).'] }
  }
  if (tool !== 'type_text') {
    const ext = path.extname(resolvedPath).toLowerCase()
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
      return { verdict: 'blocked', risks: [`.${ext} files can execute code — NIMO never writes those.`] }
    }
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      risks.push(`Unusual file type ".${ext}" — needs approval.`)
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      return { verdict: 'blocked', risks: [`Content is larger than ${Math.round(MAX_WRITE_BYTES / 1024)} KB.`] }
    }
  } else if (content.length > MAX_TYPE_CHARS) {
    return { verdict: 'blocked', risks: [`Text to type is longer than ${MAX_TYPE_CHARS} characters.`] }
  }
  for (const re of HARD_BLOCK_PATTERNS) {
    if (re.test(content)) {
      return { verdict: 'blocked', risks: ['Content matches a destructive or secret-stealing pattern.'] }
    }
  }
  let suspicious = false
  for (const re of SUSPICIOUS_PATTERNS) {
    if (re.test(content)) { suspicious = true; risks.push('Content contains commands or code that could have side effects.') }
  }
  return { verdict: suspicious ? 'needs_approval' : null, risks }
}

/**
 * The LLM judgment: is this write harmful? Returns 'benign' | 'suspicious' |
 * 'malicious' | 'unknown' (unknown → treated as suspicious).
 */
async function llmJudge({ tool, filePath, content }) {
  try {
    const verdict = await askModel(
      `You are the safety core of a desktop assistant. A user asked their agent to perform this WRITE action. Judge ONLY the content and target below.

TOOL: ${tool}
TARGET FILE: ${filePath || '(the currently focused application window — text will be typed into it)'}
CONTENT (may be truncated):
"""
${String(content).slice(0, 4000)}
"""

Classify as exactly one word:
- benign: normal notes, documentation, code, config, messages a person would plausibly write themselves
- suspicious: could cause harm or side effects beyond writing text (auto-execution, network calls that exfiltrate, modifying other programs, credentials involved)
- malicious: clearly destructive, deceptive, credential-stealing, or something the user would be victim of

Answer with ONE word only.`,
      { temperature: 0.1, maxTokens: 10, systemInstruction: 'You are a strict but fair safety classifier. Answer with a single word.' }
    )
    const v = String(verdict).toLowerCase().trim()
    if (v.startsWith('benign')) return 'benign'
    if (v.startsWith('malicious')) return 'malicious'
    if (v.startsWith('suspicious')) return 'suspicious'
    return 'unknown'
  } catch (err) {
    logger.warn(`writeGuard llmJudge failed: ${err.message}`)
    return 'unknown'
  }
}

/**
 * Full classification for a proposed write/type action.
 * @param {{tool:'write_file'|'append_to_file'|'type_text', path?:string, content:string, overwrite?:boolean}} input
 */
async function classifyWrite(input) {
  const tool = input.tool
  const content = String(input.content || '')
  const resolvedPath = tool === 'type_text' ? null : resolveUserWritePath(input.path)

  // Overwriting an existing file is always at least approval-worthy.
  let needsApprovalBecauseOverwrite = false
  if (resolvedPath && tool === 'write_file') {
    try {
      // eslint-disable-next-line global-require
      const fs = require('fs')
      needsApprovalBecauseOverwrite = fs.existsSync(resolvedPath)
    } catch { /* treat as new file */ }
  }

  const rules = ruleCheck({ tool, resolvedPath, content })
  if (rules.verdict === 'blocked') {
    return { verdict: 'blocked', reason: rules.risks.join(' '), risks: rules.risks, resolvedPath }
  }

  // The brain: LLM judgment. Malicious → blocked. Suspicious/unknown → approval.
  const llm = await llmJudge({ tool, filePath: resolvedPath, content })
  if (llm === 'malicious') {
    return { verdict: 'blocked', reason: 'The safety core judged this content harmful.', risks: rules.risks, resolvedPath }
  }

  const risky =
    rules.verdict === 'needs_approval' ||
    llm !== 'benign' ||
    needsApprovalBecauseOverwrite ||
    tool === 'type_text'

  if (risky) {
    const reasons = [...rules.risks]
    if (needsApprovalBecauseOverwrite) reasons.push('This overwrites an existing file.')
    if (tool === 'type_text') reasons.push('Text will be typed into your focused application.')
    if (llm === 'suspicious') reasons.push('The safety core flagged the content as sensitive.')
    return {
      verdict: 'needs_approval',
      reason: reasons.join(' '),
      risks: reasons,
      resolvedPath
    }
  }

  return { verdict: 'allow', reason: 'Benign write.', risks: [], resolvedPath }
}

module.exports = { classifyWrite, resolveUserWritePath, MAX_WRITE_BYTES, MAX_TYPE_CHARS, ALLOWED_EXTENSIONS }
