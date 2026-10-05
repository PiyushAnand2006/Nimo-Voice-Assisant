/**
 * core/pendingActions.js
 * Approval gate for NIMO's sensitive write actions.
 *
 * Flow: a tool executor classifies an action as critical (via
 * services/guard/writeGuard) → the tool returns { needsApproval, pendingId }
 * → the agent surfaces an approval card to the user → the UI calls
 * /api/agent/approve → resolve() executes or discards the stored action.
 *
 * Pending actions expire after 2 minutes and only the most recent action per
 * session is kept, so a stale card can never execute anything.
 */

const logger = require('../utils/logger')

const TTL_MS = 2 * 60 * 1000

/** sessionId → { id, tool, args, summary, path, preview, createdAt, used } */
const pending = new Map()

function request(sessionId, action) {
  const id = `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  pending.set(sessionId || 'default', {
    id,
    createdAt: Date.now(),
    used: false,
    ...action
  })
  logger.info(`pendingActions: request ${id} (${action.tool}) for session ${sessionId || 'default'}`)
  return id
}

/** Fetch a still-valid pending action by id (scoped to the session). */
function get(sessionId, id) {
  const entry = pending.get(sessionId || 'default')
  if (!entry || entry.used) return null
  if (Date.now() - entry.createdAt > TTL_MS || entry.id !== id) return null
  return entry
}

/** Mark an action consumed (approved or declined). Returns the action. */
function resolve(sessionId, id, approved) {
  const entry = get(sessionId, id)
  if (!entry) return null
  entry.used = true
  entry.approved = Boolean(approved)
  logger.info(`pendingActions: ${approved ? 'APPROVED' : 'DECLINED'} ${entry.id} (${entry.tool})`)
  return entry
}

function clearExpired() {
  const now = Date.now()
  for (const [k, v] of pending) {
    if (v.used || now - v.createdAt > TTL_MS) pending.delete(k)
  }
}
setInterval(clearExpired, 30 * 1000).unref?.()

module.exports = { request, get, resolve }
