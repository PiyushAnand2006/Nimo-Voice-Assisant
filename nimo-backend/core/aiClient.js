/**
 * core/aiClient.js
 * Thin wrapper around the Google Gemini SDK.
 *
 *   askClaude(userText, conversationHistory) → string  (name kept for compat)
 *
 * Keeps the last N messages (AI_HISTORY_LENGTH) in memory for context
 * continuity across turns. The conversation window is managed in-process.
 */

const { GoogleGenAI } = require('@google/genai')
const constants = require('../config/constants')
const logger = require('../utils/logger')
const { NimoError } = require('../utils/errorHandler')

const { AI_MODEL, AI_MAX_TOKENS, AI_SYSTEM_PROMPT, AI_HISTORY_LENGTH } = constants

let client = null
/** In-memory conversation window: [{ role, content }, ...] */
let history = []

/**
 * Lazy-initialize the Gemini client. The API key is read from the OS
 * keychain (via keystore) by the main process during startup and placed in
 * process.env.GEMINI_API_KEY.
 * @returns {GoogleGenAI}
 */
function getClient() {
  if (client) return client
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new NimoError(
      'NO_API_KEY',
      'Gemini API key not configured.',
      'I do not have an API key set. Please add one in your settings.',
      'error'
    )
  }
  client = new GoogleGenAI({ apiKey })
  logger.info(`aiClient initialized with model=${AI_MODEL}.`)
  return client
}

/**
 * Send userText to Gemini, using the rolling history window.
 * @param {string} userText
 * @param {Array<{role:string, content:string}>} [conversationHistory] Optional override history.
 * @returns {Promise<string>} the assistant reply text.
 */
async function askClaude(userText, conversationHistory) {
  if (!userText || !userText.trim()) return ''

  const ai = getClient()

  let prior = Array.isArray(conversationHistory) && conversationHistory.length
    ? conversationHistory.slice(-AI_HISTORY_LENGTH)
    : history.slice(-AI_HISTORY_LENGTH)

  const messages = [...prior, { role: 'user', parts: [{ text: userText }] }]

  try {
    const response = await ai.models.generateContent({
      model: AI_MODEL,
      contents: messages,
      config: {
        systemInstruction: AI_SYSTEM_PROMPT,
        maxOutputTokens: AI_MAX_TOKENS,
        temperature: 0.7
      }
    })

    const reply = response.text?.trim() || ''

    if (!Array.isArray(conversationHistory)) {
      history.push({ role: 'user', parts: [{ text: userText }] })
      history.push({ role: 'model', parts: [{ text: reply }] })
      const maxEntries = AI_HISTORY_LENGTH * 2
      if (history.length > maxEntries) {
        history = history.slice(-maxEntries)
      }
    }

    logger.debug(`askClaude reply: "${reply}"`)
    return reply
  } catch (err) {
    if (err instanceof NimoError) throw err
    const code = err.status ? `AI_${err.status}` : 'AI_ERROR'
    throw new NimoError(
      code,
      err.message || 'Unknown Gemini API error.',
      'I had trouble thinking about that. Maybe try again?',
      'error'
    )
  }
}

/**
 * One-shot model call with a raw prompt (no history management).
 * Used by the research pipeline and any service that needs bare completion.
 * @param {string} prompt
 * @param {{temperature?:number, systemInstruction?:string, maxTokens?:number}} [opts]
 * @returns {Promise<string>}
 */
async function askModel(prompt, opts = {}) {
  if (!prompt || !prompt.trim()) return ''
  const ai = getClient()
  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: opts.systemInstruction || 'You are a precise research and synthesis engine. Answer only from the provided material.',
      maxOutputTokens: opts.maxTokens || AI_MAX_TOKENS,
      temperature: opts.temperature ?? 0.5
    }
  })
  const text = response.text?.trim() || ''
  if (!text) throw new NimoError('AI_EMPTY', 'Model returned an empty response.', 'My mind went blank for a second.', 'error')
  return text
}

/**
 * Vision call: send an image + prompt to the model (screen understanding
 * for the GUI-automation loop). Returns the model's raw text.
 * @param {string} prompt
 * @param {string} imageBase64 PNG bytes, base64-encoded
 */
async function visionLocate(prompt, imageBase64) {
  if (!prompt || !imageBase64) return ''
  const ai = getClient()
  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: imageBase64 } },
        { text: prompt }
      ]
    }],
    config: { temperature: 0.1, maxOutputTokens: 300 }
  })
  return response.text || ''
}

// NIMO speaks English and Hindi only — any other script in a transcription
// is the model hallucinating on noise and gets filtered out.
const FOREIGN_SCRIPT_RE = /[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F\u10A0-\u10FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF65-\uFFDC]/
const NON_EN_HI_RE = /[^A-Za-z\u00C0-\u024F\u0900-\u097F0-9\s.,!?'"()\-:;%&/+*#@\[\]{}<>=_~`₹।॥]/g

/** Keep only English/Hindi content; drop noise transcriptions wholesale. */
function enforceEnglishHindi(text) {
  if (!text) return ''
  const cleaned = text.replace(NON_EN_HI_RE, '')
  const stripped = text.length - cleaned.replace(/\s/g, '').length
  const original = text.replace(/\s/g, '').length
  // If most characters were foreign garbage, the whole thing is noise.
  if (original > 0 && stripped / original > 0.25) return ''
  return cleaned.trim()
}

/**
 * Voice input: transcribe a WAV recording (base64) with Gemini.
 * Electron does not ship Chrome's SpeechRecognition backend, so NIMO
 * records the mic in the renderer and transcribes here instead.
 * English or Hindi only — noise/silence returns ''.
 */
async function transcribeAudio(audioBase64) {
  if (!audioBase64) return ''
  const ai = getClient()
  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: audioBase64 } },
        { text: 'Transcribe this audio exactly as spoken. The speech will be in ENGLISH or HINDI — transcribe English in English and Hindi in Hindi (Devanagari). Use NO other language or script. Output ONLY the transcription text — no commentary, no quotes, no timecodes. If the audio is silence, noise, or contains no clear speech, output nothing at all.' }
      ]
    }],
    config: { temperature: 0.1, maxOutputTokens: 300 }
  })
  return enforceEnglishHindi((response.text || '').trim())
}

function clearHistory() {
  history = []
  logger.info('AI conversation history cleared.')
}

function getHistory() {
  return [...history]
}

module.exports = { askClaude, askModel, visionLocate, transcribeAudio, clearHistory, getHistory, getClient }