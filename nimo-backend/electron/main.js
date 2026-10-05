/**
 * electron/main.js
 * Electron entry point for NIMO the desktop companion.
 *
 * Two windows:
 *   1. companionWindow — a frameless, transparent, ALWAYS-ON-TOP floating
 *      cartoon face that hovers over everything, tracks the mouse with its
 *      eyes, listens for voice and speaks through the speakers.
 *   2. dashboardWindow — the full "NIMO OS" control panel (agent activity,
 *      logs, personality, sensors, OS tools).
 *
 * Plus a system tray, a global mouse-poll loop that feeds the companion's
 * eye tracking, and the shared localhost HTTP API (core/httpApi.js).
 */

require('dotenv').config()

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')

const constants = require('../config/constants')
const { initKey } = require('../config/keystore')
const logger = require('../utils/logger')
const { registerAllIpc, dispatchIntent } = require('./ipc')
const { handleApiRequest, setContext } = require('../core/httpApi')
const timerManager = require('../services/system/timerManager')

let companionWindow = null
let dashboardWindow = null
let tray = null
let mouseTimer = null
let lastMouse = { x: -1, y: -1 }
// The creature's screen anchor (center-x, bottom-y). Resizes grow the window
// AROUND this point so the creature never shifts when the bubble/pill appears.
let companionAnchor = null
let suppressAnchorUntil = 0

function captureCompanionAnchor() {
  if (!companionWindow || companionWindow.isDestroyed()) return
  const [x, y] = companionWindow.getPosition()
  const [w, h] = companionWindow.getSize()
  companionAnchor = { cx: x + w / 2, bottom: y + h }
}

// Decide UI source: dev server URL in dev, built nimo-os dist in prod.
function resolveUiBase() {
  if (process.env.NODE_ENV === 'development') {
    return constants.DEV_SERVER_URL
  }
  return null // dist/index.html on disk
}

function uiUrl(query) {
  const base = resolveUiBase()
  if (base) return `${base}?${query}`
  const distPath = path.isAbsolute(constants.UI_BUILD_PATH)
    ? constants.UI_BUILD_PATH
    : path.join(process.cwd(), constants.UI_BUILD_PATH)
  const fileUrl = 'file://' + distPath.replace(/\\/g, '/') + '/index.html'
  return `${fileUrl}?${query}`
}

function loadWindow(win, query) {
  const target = uiUrl(query)
  if (/^https?:\/\//i.test(target)) {
    win.loadURL(target)
  } else {
    win.loadURL(target)
  }
}

// ── Companion overlay window ─────────────────────────────────────────────

function createCompanionWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const W = constants.COMPANION_WIDTH
  const H = constants.COMPANION_HEIGHT

  companionWindow = new BrowserWindow({
    width: W,
    height: H,
    x: screenW - W - 28,
    y: screenH - H - 40,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Web Speech + audio playback in a transparent window
      backgroundThrottling: false
    }
  })

  companionWindow.setAlwaysOnTop(true, 'screen-saver')
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadWindow(companionWindow, 'view=overlay')
  companionWindow.once('ready-to-show', () => { companionWindow.show(); captureCompanionAnchor() })
  // Track the creature's position so resizes anchor exactly where the user
  // dragged it (dragging fires 'moved'; our own resizes are suppressed for
  // a short window since those events can arrive asynchronously).
  companionWindow.on('moved', () => { if (Date.now() > suppressAnchorUntil) captureCompanionAnchor() })
  companionWindow.on('resized', () => { if (Date.now() > suppressAnchorUntil) captureCompanionAnchor() })
  companionWindow.on('closed', () => { companionWindow = null })

  // Timers finishing must ring in the companion (it's the talking face).
  timerManager.setExternalDispatcher((payload) => {
    try {
      if (companionWindow && !companionWindow.isDestroyed()) {
        companionWindow.webContents.send('nimo:timer-done', payload)
      }
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('nimo:timer-done', payload)
      }
    } catch (err) {
      logger.error(`timer dispatch failed: ${err.message}`)
    }
  })
}

// Movement is drag-only — the user positions the companion; nothing moves it
// automatically. (An earlier auto-wander hop made it jump around the screen;
// removed by design.)

// ── Dashboard window ─────────────────────────────────────────────────────

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show()
    dashboardWindow.focus()
    return
  }

  dashboardWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    fullscreen: false, // opens as a normal window — fullscreen is a toggle
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  loadWindow(dashboardWindow, 'view=dashboard')
  // Surface renderer-side failures (blank screen diagnosis)
  dashboardWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logger.warn(`[dashboard:console] ${message} (${sourceId}:${line})`)
  })
  dashboardWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`[dashboard] did-fail-load ${code} ${desc} ${url}`)
  })
  dashboardWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`[dashboard] render-process-gone: ${details.reason}`)
  })
  // Deep diagnosis: capture React's component stack when the SVG commit
  // error strikes, relayed into the backend log buffer.
  const REACT_DIAG = `(() => {
    try {
      const orig = console.error;
      console.error = function (...args) {
        try {
          const text = args.map((a) => {
            if (a && a.stack) return a.stack;
            if (a && a.message) return a.name + ': ' + a.message;
            return String(a);
          }).join(' | ');
          if (text.includes('error occurred') || text.includes('removeChild')) {
            fetch('http://localhost:3001/api/logs/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: '[DIAG] ' + text.slice(0, 1600), type: 'DIAG', category: 'error' })
            }).catch(() => {});
          }
        } catch {}
        orig.apply(console, args);
      };
    } catch {}
  })()`
  dashboardWindow.webContents.on('did-finish-load', () => {
    dashboardWindow.webContents.executeJavaScript(REACT_DIAG).catch(() => {})
  })
  dashboardWindow.once('ready-to-show', () => dashboardWindow.show())
  dashboardWindow.on('closed', () => { dashboardWindow = null })
}

// ── Global mouse tracking (feeds the companion's eye tracking) ───────────

function startMouseTracking() {
  if (mouseTimer) clearInterval(mouseTimer)
  mouseTimer = setInterval(() => {
    try {
      const p = screen.getCursorScreenPoint()
      if (p.x === lastMouse.x && p.y === lastMouse.y) return
      lastMouse = { x: p.x, y: p.y }
      // Both windows track the cursor: the companion's eyes AND the big
      // stage on the dashboard.
      if (companionWindow && !companionWindow.isDestroyed()) {
        companionWindow.webContents.send('nimo:mouse', p)
      }
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('nimo:mouse', p)
      }
    } catch { /* display gone to sleep, etc. */ }
  }, 33) // ~30 fps
}

// ── Shared HTTP API (same routes as server.js) ───────────────────────────

function startBackendHttpServer() {
  const server = http.createServer(handleApiRequest)
  server.on('error', (err) => logger.error(`HTTP server error: ${err.message}`))
  server.listen(constants.HTTP_SERVER_PORT, '127.0.0.1', () => {
    logger.info(`NIMO backend HTTP API listening on port ${constants.HTTP_SERVER_PORT}.`)
    // Fresh session, fresh log: wipe the previous run's event buffer.
    fetch(`http://127.0.0.1:${constants.HTTP_SERVER_PORT}/api/logs/clear`, { method: 'POST' })
      .then(() => logger.info('Event log cleared for a fresh session.'))
      .catch(() => {})
  })
}

// ── Window control IPC (custom titlebars in the renderer) ────────────────

function registerWindowControls() {
  ipcMain.on('nimo:window-control', (_e, { action, value } = {}) => {
    const win = BrowserWindow.fromWebContents(_e.sender) || dashboardWindow
    if (!win) return
    switch (action) {
      case 'minimize': win.minimize(); break
      case 'toggle-maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break
      case 'toggle-fullscreen': win.setFullScreen(!win.isFullScreen()); break
      case 'close': win.close(); break
      case 'hide': win.hide(); break
      case 'show': win.show(); break
      case 'quit': app.quit(); break
      case 'open-dashboard':
        // Toggle: open the dashboard, or hide it if it's already showing.
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          if (dashboardWindow.isVisible()) dashboardWindow.hide()
          else { dashboardWindow.show(); dashboardWindow.focus() }
        } else {
          createDashboardWindow()
        }
        break
      case 'show-companion': if (companionWindow) { companionWindow.show(); companionWindow.focus() } break
      case 'hide-companion': if (companionWindow) companionWindow.hide(); break
    }
  })

  // Renderer-driven dynamic sizing: grows/shrinks around the creature's
  // anchor so it stays EXACTLY where the user dragged it — corners included.
  // Only a 28px sliver is kept on-screen so the creature can never get lost.
  ipcMain.handle('nimo:companion-resize', (_e, { width, height } = {}) => {
    if (!companionWindow || companionWindow.isDestroyed()) return { ok: false }
    if (!companionAnchor) captureCompanionAnchor()
    if (!companionAnchor) return { ok: false }
    const wa = screen.getPrimaryDisplay().workArea
    const w = Math.max(120, Math.min(520, Math.round(width)))
    const h = Math.max(140, Math.min(560, Math.round(height)))
    let nx = Math.round(companionAnchor.cx - w / 2)
    let ny = Math.round(companionAnchor.bottom - h)
    nx = Math.min(Math.max(nx, wa.x - w + 28), wa.x + wa.width - 28)
    ny = Math.min(Math.max(ny, wa.y - h + 28), wa.y + wa.height - 28)
    suppressAnchorUntil = Date.now() + 300
    companionWindow.setContentSize(w, h)
    companionWindow.setPosition(nx, ny)
    // When the clamp pulled the window (corner case), the creature moved
    // with it — re-anchor to the clamped result.
    companionAnchor = { cx: nx + w / 2, bottom: ny + h }
    return { ok: true }
  })

  // Click-through mode: mouse events pass to the desktop below; with
  // forward:true the renderer still receives hover moves and flips back to
  // interactive whenever the cursor touches the creature.
  ipcMain.handle('nimo:set-ignore-mouse', (_e, { value } = {}) => {
    if (companionWindow && !companionWindow.isDestroyed()) {
      companionWindow.setIgnoreMouseEvents(Boolean(value), { forward: true })
    }
    return { ok: true }
  })

  // Show/hide the floating companion from the dashboard.
  ipcMain.handle('nimo:toggle-companion', () => {
    if (!companionWindow || companionWindow.isDestroyed()) return { ok: false, visible: false }
    if (companionWindow.isVisible()) {
      companionWindow.hide()
    } else {
      companionWindow.show()
      companionWindow.focus()
    }
    return { ok: true, visible: companionWindow.isVisible() }
  })
}

// ── Tray ─────────────────────────────────────────────────────────────────

function assertIconPath() {
  const candidates = ['icon.png', 'icon.ico', 'icon.icns']
  return candidates.map((c) => path.join(process.cwd(), 'assets', c)).find((p) => fs.existsSync(p)) || null
}

function createTray() {
  const iconPath = assertIconPath()
  let image = nativeImage.createEmpty()
  if (iconPath) image = nativeImage.createFromPath(iconPath)
  try { tray = new Tray(image) } catch (err) {
    logger.warn(`Tray icon could not be created: ${err.message}`)
    return
  }
  tray.setToolTip('NIMO — your desktop companion')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Companion', click: () => { if (companionWindow) { companionWindow.show(); companionWindow.focus() } } },
    { label: 'Hide Companion', click: () => { if (companionWindow) companionWindow.hide() } },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => createDashboardWindow() },
    { type: 'separator' },
    { label: 'Quit NIMO', click: () => app.quit() }
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => createDashboardWindow())
}

// ── Boot ─────────────────────────────────────────────────────────────────

async function migrateApiKey() {
  try {
    const key = await initKey()
    if (key) {
      process.env.GEMINI_API_KEY = key
      logger.info('Gemini API key resolved and set in process env.')
    }
  } catch (err) {
    logger.error(`Keystore migration failed: ${err.message}`)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (companionWindow) { companionWindow.show(); companionWindow.focus() }
    createDashboardWindow()
  })

  app.whenReady().then(async () => {
    logger.info(`NIMO booting. NODE_ENV=${process.env.NODE_ENV || 'production'}.`)
    await migrateApiKey()

    setContext({ mainWindow: null, dispatchIntent }) // full dispatch for the HTTP API
    registerAllIpc(null)
    registerWindowControls()

    createCompanionWindow()
    createDashboardWindow()

    // The dispatch path needs a live window reference for state pushes.
    setContext({ mainWindow: companionWindow })
    startBackendHttpServer()
    startMouseTracking()

    // Optional: global hotkey to summon the dashboard (Ctrl+Alt+N).
    try {
      globalShortcut.register('Control+Alt+N', () => createDashboardWindow())
    } catch { /* shortcut may be taken */ }

    createTray()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createCompanionWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Tray keeps running; quit only via explicit Quit.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    if (mouseTimer) clearInterval(mouseTimer)
    try { globalShortcut.unregisterAll() } catch { /* noop */ }
    logger.info('NIMO shutting down.')
  })
}

module.exports = { createCompanionWindow, createDashboardWindow, createTray }
