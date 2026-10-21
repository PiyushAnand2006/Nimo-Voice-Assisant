# NIMO Backend

Electron + Node.js backend for NIMO, a desktop voice assistant with a minimalist "robot face" UI.
This repo contains **only the backend shell** — no UI components, no CSS, no JSX.
The Stitch UI lives in `./ui/index.html` (provided separately) and is loaded by Electron.

## Requirements

- Node.js 18+ (developed against Node 22)
- npm 9+
- Windows 10/11, macOS 12+, or Linux with X11/Wayland

## Quickstart

```bash
# 1. install
npm install

# 2. add your Anthropic API key
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
# On first launch NIMO migrates this key into the OS keychain and blanks .env.

# 3. run (production — loads ./ui/index.html)
npm start

# 4. dev (starts Stitch UI dev server on http://localhost:3000 via npm run ui:dev,
# then loads it in Electron when NODE_ENV=development)
npm run dev
```

## Folder layout

```
nimo-backend/
├── electron/
│   ├── main.js              # Electron entry (BrowserWindow, tray, lifecycle)
│   ├── preload.js           # contextBridge "window.nimo" API
│   └── ipc/
│       ├── index.js         # registerAllIpc() + dispatchIntent()
│       ├── systemHandler.js # volume, app launch, screenshot, timer, time, weather
│       ├── searchHandler.js # web search
│       └── mediaHandler.js  # music (Spotify/YouTube)
├── core/
│   ├── commandParser.js     # parseCommand() / extractParams()
│   ├── intentMap.js         # ordered intent patterns
│   ├── aiClient.js          # @anthropic-ai/sdk wrapper + 6-message history window
│   └── responseBuilder.js   # { action, result, speak, state } formatter
├── services/
│   ├── speech/              # renderer-only (Web Speech API)
│   │   ├── recognizer.js
│   │   └── synthesizer.js
│   ├── system/
│   │   ├── appLauncher.js   # cross-platform exec + fuzzy match (fastest-levenshtein)
│   │   ├── volumeControl.js # loudness + os/nircmd/amixer fallbacks
│   │   ├── screenshotter.js # Electron desktopCapturer + nativeImage
│   │   └── timerManager.js  # in-memory timers + 'nimo:timer-done' dispatch
│   ├── media/
│   │   ├── spotifyHandler.js
│   │   └── youtubeHandler.js
│   └── web/
│       └── searchService.js # Google / DuckDuckGo / Bing
├── config/
│   ├── constants.js         # all tunable values
│   └── keystore.js          # keytar wrapper + .env → keychain migration
├── utils/
│   ├── logger.js            # leveled file logger -> logs/nimo.log
│   ├── osDetect.js          # win32 | darwin | linux
│   └── errorHandler.js      # centralized NimoError formatter
├── assets/                  # tray + window icons
├── ui/                      # Stitch UI export (created separately)
├── logs/                    # runtime log output
├── .env.example
├── .gitignore
└── package.json
```

## IPC channels (UI ↔ main)

All UI calls go through `window.nimo.invoke(channel, data)` exposed by `electron/preload.js`.

Invoke (request/response):

| channel | payload | returns |
|---|---|---|
| `nimo:run-command`     | `{ transcript }` | `{ action, result, speak, state }` |
| `nimo:ai-query`        | `{ text, history? }` | `{ ok, data: { text } }` |
| `nimo:set-volume`      | `{ direction: 'up'\|'down'\|'set', value? }` | `{ ok, data: { level } }` |
| `nimo:open-app`        | `{ appName }` | `{ ok, data: { success, launched } }` |
| `nimo:play-music`      | `{ query, service? }` | `{ ok, data }` |
| `nimo:web-search`      | `{ query, engine? }` | `{ ok, data }` |
| `nimo:take-screenshot` | `–` | `{ ok, data: { path, filename } }` |
| `nimo:set-timer`       | `{ minutes, label? }` | `{ ok, data }` |
| `nimo:cancel-timer`    | `{ id }` | `{ ok, data: { cancelled } }` |
| `nimo:list-timers`     | `–` | `{ ok, data: { timers } }` |
| `nimo:get-time`        | `–` | `{ ok, data: { time, date } }` |
| `nimo:get-weather`     | `{ city? }` | `{ ok, data: { summary, city } }` |
| `nimo:save-api-key`    | `{ key }` | `{ ok, data: { saved } }` |
| `nimo:has-api-key`     | `–` | `{ ok, data: { hasKey } }` |
| `nimo:state-event`     | `{ state }` | `{ ok, data }` |

Events main → renderer:

| channel | payload |
|---|---|
| `nimo:timer-done` | `{ id, label, minutes }` |
| `nimo:state-change` | `{ state: 'idle'\|'listening'\|'thinking'\|'talking'\|'happy'\|'confused'\|'error'\|'music' }` |
| `nimo:speak` | `{ text }` (UI triggers TTS) |
| `nimo:config` | `{ WAKE_WORD, TTS_*, DEFAULT_*, AI_MODEL }` |

All invoke handlers return `{ ok: true, data }` on success and `{ ok: false, error, code, speak, state }` on failure (see `utils/errorHandler.js`).

## Configure UI source

- Production: `NODE_ENV=production` (default) → loads `./ui/index.html` (relative to cwd).
- Development: `NODE_ENV=development` → loads `http://localhost:3000` (your Stitch dev server).
  Configure this URL in `config/constants.js > DEV_SERVER_URL`.

## Voice pipeline

```
[mic] → window.SpeechRecognition (recognizer.js)
        └─ strips "hey nimo" wake-word
           → window.nimo.invoke('nimo:run-command', { transcript })
              └─ commandParser.parseCommand → { intent, params }
                 └─ dispatchIntent(intent, params)
                    ├─ local service (volume, app, music, timer, ...)
                    └─ askClaude() for ai_query
                       └─ responseBuilder → { action, result, speak, state }
                          └─ IPC reply → UI state-change + UI speak → SpeechSynthesis
```

## Building installers

```bash
npm run build
```

electron-builder config in `package.json > build` produces:
- Windows: NSIS `.exe`
- macOS:   `.dmg`
- Linux:   `.AppImage`

Place icons at `assets/icon.ico`, `assets/icon.icns`, `assets/icon.png`.

## Security notes

- API key is held in the OS keychain via `keytar` (`config/keystore.js`).
- First launch migrates `.env → keychain`, then blanks the env var at runtime.
- Chat history persistence is optional. Set `MONGODB_URI` (and optionally `MONGODB_DB_NAME`) in `.env` to store messages in the `chat_messages` collection. If it is unset or unavailable, NIMO continues with in-memory conversation context.
- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Only whitelisted channels are reachable through `contextBridge`.
