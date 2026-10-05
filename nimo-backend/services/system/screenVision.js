/**
 * services/system/screenVision.js
 * NIMO's eyes for GUI automation: captures the screen, then asks the Gemini
 * vision model to locate a described UI element, returning real screen
 * coordinates ready for computerControl.clickMouse().
 *
 * The image never leaves the machine except to the Gemini API (same as every
 * other brain call). Coordinates are returned in PHYSICAL screen pixels,
 * normalized by the vision model over the captured image and scaled by the
 * actual display bounds.
 */

const { desktopCapturer, screen } = require('electron')
const { visionLocate } = require('../../core/aiClient')
const logger = require('../../utils/logger')
const { NimoError } = require('../../utils/errorHandler')

/** Capture the primary display as a base64 PNG + its actual pixel size. */
async function captureScreen() {
  let sources
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
  } catch (err) {
    throw new NimoError('VISION_CAPTURE', err.message, "I couldn't capture the screen.", 'error')
  }
  const source = sources && sources[0]
  if (!source) throw new NimoError('VISION_NO_SOURCE', 'No screen source.', "I couldn't find a screen to look at.", 'error')
  const size = source.thumbnail.getSize()
  return { base64: source.thumbnail.toPNG().toString('base64'), width: size.width, height: size.height }
}

/**
 * Look at the screen and find the described target.
 * @param {string} target natural-language description, e.g. "the first video result"
 * @returns {Promise<{found:boolean, x:number, y:number, width:number, height:number, note:string}>}
 */
async function locateTarget(target) {
  const shot = await captureScreen()
  const prompt = `Look at this screenshot of the user's screen. Find: "${target}".

Respond with ONLY a JSON object, nothing else:
{"found": true|false, "cx": <center x of the element>, "cy": <center y of the element>, "note": "<5-15 words about what you see there>"}

cx and cy may be given either as FRACTIONS of the image (0..1) or in IMAGE PIXELS — both are accepted. The image is ${shot.width}x${shot.height} pixels. Be precise about the clickable center of the element (e.g. the title text of a video result). If the target is not visible, return {"found": false, "note": "not on screen"}.`

  const raw = await visionLocate(prompt, shot.base64)
  const jsonText = (String(raw).match(/\{[\s\S]*\}/) || [])[0]
  if (!jsonText) throw new NimoError('VISION_PARSE', 'Model did not return JSON.', "I looked but couldn't interpret the screen.", 'error')
  const parsed = JSON.parse(jsonText)

  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds

  if (!parsed.found) {
    return { found: false, x: 0, y: 0, width, height, note: parsed.note || 'not on screen' }
  }

  // Normalize: fractions (<=1.5) scale directly; pixel values divide by the
  // image size first (models sometimes answer in pixels despite the prompt).
  let fcx = Number(parsed.cx) || 0
  let fcy = Number(parsed.cy) || 0
  if (fcx > 1.5) fcx = fcx / shot.width
  if (fcy > 1.5) fcy = fcy / shot.height
  fcx = Math.min(1, Math.max(0, fcx))
  fcy = Math.min(1, Math.max(0, fcy))

  const cx = Math.round(fcx * width)
  const cy = Math.round(fcy * height)
  logger.info(`screenVision: "${target}" → (${cx}, ${cy}) — ${parsed.note || ''}`)
  return { found: true, x: cx, y: cy, width, height, note: parsed.note || '' }
}

module.exports = { captureScreen, locateTarget }
