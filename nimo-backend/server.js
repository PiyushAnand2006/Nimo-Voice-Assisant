/**
 * nimo-backend/server.js
 * Headless localhost HTTP server (NO Electron) — for developing the UI in a
 * plain browser tab. Routes live in core/httpApi.js (shared with Electron).
 *
 * Run with:  node server.js
 */

require('dotenv').config()

const http = require('http')
const constants = require('./config/constants')
const { initKey } = require('./config/keystore')
const logger = require('./utils/logger')
const { handleApiRequest } = require('./core/httpApi')

const PORT = constants.HTTP_SERVER_PORT || 3001

const server = http.createServer(handleApiRequest)

server.on('error', (err) => {
  logger.error(`HTTP server error: ${err.message}`)
  process.exit(1)
})

;(async () => {
  try {
    const key = await initKey()
    if (key) {
      process.env.GEMINI_API_KEY = key
      logger.info('Gemini API key resolved and set in process env.')
    }
  } catch (err) {
    logger.error(`Keystore migration failed: ${err.message}`)
  }

  server.listen(PORT, '127.0.0.1', () => {
    logger.info(`NIMO backend (headless agent mode) listening on http://localhost:${PORT}`)
    logger.info(`nimo-os should proxy /api/* → http://localhost:${PORT}/api/*`)
  })
})()

module.exports = server
