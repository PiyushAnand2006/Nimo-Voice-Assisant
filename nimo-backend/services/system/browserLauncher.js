/**
 * services/system/browserLauncher.js
 * Detects Chrome (and other browsers) on the host OS and opens a URL in a
 * brand-new external browser window.
 *
 *   openInBrowser(url)
 *     1. Discover Chrome, Edge, or Firefox binaries for the current OS.
 *     2. Spawn the binary with an ARGUMENT ARRAY (shell: false) — the URL is
 *        never interpolated into a command string, so nothing can inject.
 *     3. If nothing is found, fall back to the OS default URL handler
 *        (cmd /c start on Windows, `open` on macOS, xdg-open on Linux),
 *        also argument-array only.
 *
 * Only http/https URLs are accepted.
 *
 * Returns: { success:boolean, url:string, browser?:string, error?:string }
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')

const logger = require('../../utils/logger')

function fileExists(p) {
  try { return p && fs.existsSync(p) } catch { return false }
}

/** Spawn a program with an argument array, detached; resolves on spawn. */
function spawnDetached(bin, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { shell: false, detached: true, stdio: 'ignore' })
      child.once('error', (err) => {
        logger.warn(`Browser launch failed (${bin}): ${err.message}`)
        resolve(false)
      })
      child.once('spawn', () => {
        try { child.unref() } catch { /* noop */ }
        resolve(true)
      })
      // Some launchers exit non-zero even on success — don't hang.
      setTimeout(() => resolve(true), 3000)
    } catch (err) {
      logger.warn(`Browser launch threw (${bin}): ${err.message}`)
      resolve(false)
    }
  })
}

/** Locate browser binaries; each candidate is { name, bin, args(url) }. */
function detectBrowsers() {
  const candidates = []
  const chromeExtraFlags = (opts = {}) => (opts.autoplay ? ['--autoplay-policy=no-user-gesture-required', '--autoplay=1'] : [])

  if (process.platform === 'win32') {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`
    ].filter(fileExists)
    if (chromePaths.length) {
      candidates.push({
        name: 'chrome',
        bin: chromePaths[0],
        args: (url, opts) => ['--new-window', ...chromeExtraFlags(opts), url]
      })
    }
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(fileExists)
    if (edgePaths.length) {
      candidates.push({ name: 'edge', bin: edgePaths[0], args: (url) => ['--new-window', url] })
    }
    const firefoxPaths = [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
    ].filter(fileExists)
    if (firefoxPaths.length) {
      candidates.push({ name: 'firefox', bin: firefoxPaths[0], args: (url) => ['-new-tab', url] })
    }
  } else if (process.platform === 'darwin') {
    const macApps = [
      { name: 'chrome', app: 'Google Chrome', extra: (opts) => chromeExtraFlags(opts) },
      { name: 'chrome-canary', app: 'Google Chrome Canary', extra: (opts) => chromeExtraFlags(opts) },
      { name: 'edge', app: 'Microsoft Edge', extra: () => [] },
      { name: 'firefox', app: 'Firefox', extra: () => [] }
    ]
    for (const a of macApps) {
      if (fileExists(`/Applications/${a.app}.app`)) {
        candidates.push({ name: a.name, bin: 'open', args: (url, opts) => ['-a', a.app, ...a.extra(opts), url] })
      }
    }
  } else {
    const linuxBins = [
      { name: 'google-chrome', pre: [] },
      { name: 'chromium', pre: [] },
      { name: 'chromium-browser', pre: [] },
      { name: 'microsoft-edge', pre: [] },
      { name: 'firefox', pre: ['-new-tab'] }
    ]
    for (const b of linuxBins) {
      try {
        const check = spawnSync('which', [b.name], { shell: false })
        if (check.status === 0) {
          candidates.push({
            name: b.name,
            bin: b.name,
            args: (url, opts) => [...b.pre, ...(b.name.includes('chrom') ? ['--new-window'] : []), ...chromeExtraFlags(opts), url]
          })
        }
      } catch { /* skip */ }
    }
  }
  return candidates
}

/**
 * Open the given URL on the host machine in a brand-new browser window.
 * @param {string} url
 * @param {{autoplay?:boolean}} [opts] Launch options (e.g. force autoplay for music).
 * @returns {Promise<{success:boolean, url:string, browser?:string, error?:string}>}
 */
async function openInBrowser(url, opts = {}) {
  const target = String(url || '').trim()
  if (!target) return { success: false, url: '', error: 'Empty URL.' }
  if (!/^https?:\/\//i.test(target)) {
    return { success: false, url: target, error: 'Only http/https URLs can be opened.' }
  }

  for (const b of detectBrowsers()) {
    const args = b.args(target, opts)
    logger.info(`Launching ${b.name} with ${args.length} arguments.`)
    const ok = await spawnDetached(b.bin, args)
    if (ok) return { success: true, url: target, browser: b.name }
  }

  // Fallback: OS default handler — argument arrays only, url as its own argv.
  let ok = false
  if (process.platform === 'win32') ok = await spawnDetached('cmd.exe', ['/c', 'start', '', target])
  else if (process.platform === 'darwin') ok = await spawnDetached('open', [target])
  else ok = await spawnDetached('xdg-open', [target])

  if (ok) return { success: true, url: target, browser: 'default' }
  return { success: false, url: target, error: 'No browser available to open the URL.' }
}

module.exports = { openInBrowser, detectBrowsers }
