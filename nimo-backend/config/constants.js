module.exports = {
  // AI / Gemini
  AI_MODEL: 'gemini-3.1-flash-lite',
  AI_MAX_TOKENS: 2048,
  AI_HISTORY_LENGTH: 6,

  // Agent loop
  AGENT_MAX_STEPS: 8,          // max tool rounds per utterance (multi-step tasks)
  AGENT_HISTORY_TURNS: 10,     // rolling turns kept per session
  AGENT_SESSION_TTL_MS: 30 * 60 * 1000,
  AI_SYSTEM_PROMPT: `You are NIMO, a friendly and witty desktop voice assistant.
Rules:
- Always respond in 1-2 short sentences max (for TTS clarity)
- Be warm, helpful, slightly playful
- Never say "As an AI..." or "I cannot..."
- If you don't know something current, say so briefly and suggest a search`,

  // Media / Search defaults
  DEFAULT_MUSIC_SERVICE: 'spotify',
  DEFAULT_SEARCH_ENGINE: 'google',

  // Volume
  VOLUME_STEP: 10,
  VOLUME_MIN: 0,
  VOLUME_MAX: 100,

  // Wake word & speech
  WAKE_WORD: 'hey nimo',

  // TTS
  TTS_RATE: 1.05,
  TTS_PITCH: 1.0,
  TTS_LANG: 'en-US',

  // ElevenLabs TTS — a soft, gentle voice (falls back to the OS voice if
  // the name isn't in the account's library)
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_NAME: process.env.ELEVENLABS_VOICE_NAME || 'Alice',
  ELEVENLABS_FALLBACK_VOICE_ID: process.env.ELEVENLABS_FALLBACK_VOICE_ID || '',
  ELEVENLABS_MODEL_ID: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',

  // Screenshot — inside the user's own Pictures folder on EVERY machine
  // (Electron resolves it via app.getPath('pictures'); nothing is hardcoded)
  SCREENSHOT_DIR: 'NIMO Screenshots',

  // Windows
  WINDOW_WIDTH: 1280,
  WINDOW_HEIGHT: 820,
  COMPANION_WIDTH: 124,   // window hugs the face exactly (grows only for bubble/pill)
  COMPANION_HEIGHT: 140,

  // Logging
  LOG_LEVEL: 'info',
  LOG_DIR: 'logs',

  // Keystore
  KEYTAR_SERVICE: 'NIMO',
  KEYTAR_ACCOUNT: 'gemini',

  // UI source (nimo-os Stitch export — sibling folder to nimo-backend)
  UI_BUILD_PATH: '../nimo-os/dist',
  DEV_SERVER_URL: 'http://localhost:3000',

  // NIMO backend HTTP server (nimo-os proxies here)
  HTTP_SERVER_PORT: 3001,

  // NIMO backend root URL (used by nimo-os proxy)
  NIMO_BACKEND_URL: 'http://localhost:3001'
}