/**
 * services/system/screenshotter.js
 * Captures the primary display using Electron's desktopCapturer + nativeImage.
 *
 *   takeScreenshot() → { path, filename }
 *
 * Files are saved to <pictures>/nimo-screenshots/nimo-{timestamp}.png.
 */

const { app, desktopCapturer, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const constants = require('../../config/constants')
const logger = require('../../utils/logger')
const { NimoError } = require('../../utils/errorHandler')

/**
 * Capture the screen containing the focused window (or the primary display)
 * and write it to disk as a PNG.
 * @returns {Promise<{path:string,filename:string}>}
 */
async function takeScreenshot() {
  let sources
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
  } catch (err) {
    throw new NimoError('SCREENSHOT_CAPTURE', err.message, "I couldn't capture the screen.", 'error')
  }

  if (!sources || sources.length === 0) {
    throw new NimoError('SCREENSHOT_NO_SOURCE', 'No screen sources available.', "I couldn't find a screen to capture.", 'error')
  }

  // Prefer the source that matches the focused window's display.
  let source = sources[0]
  try {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) {
      const display = require('electron').screen.getDisplayMatching(focused.getBounds())
      const match = sources.find((s) => String(s.display_id) === String(display.id))
      if (match) source = match
    }
  } catch {
    // fall back to source[0]
  }

  const png = source.thumbnail.toPNG()
  if (!png || png.length === 0) {
    throw new NimoError('SCREENSHOT_EMPTY', 'Captured image was empty.', "I captured an empty screenshot.", 'error')
  }

  const dir = path.resolve(path.join(app.getPath('pictures'), constants.SCREENSHOT_DIR))
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw new NimoError('SCREENSHOT_DIR', err.message, "I couldn't create the screenshot folder.", 'error')
    }
  }

  // Filename is generated internally — assert containment anyway so the
  // write can never land outside the screenshots folder.
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = path.basename(`nimo-${ts}.png`)
  const filePath = path.resolve(path.join(dir, filename))
  if (!filePath.startsWith(dir + path.sep)) {
    throw new NimoError('SCREENSHOT_PATH', 'Resolved path escaped the screenshots folder.', "I couldn't save the screenshot.", 'error')
  }

  try {
    fs.writeFileSync(filePath, png)
  } catch (err) {
    throw new NimoError('SCREENSHOT_WRITE', err.message, "I couldn't save the screenshot.", 'error')
  }

  logger.info(`Screenshot saved to ${filePath}.`)
  return { path: filePath, filename }
}

module.exports = { takeScreenshot }
