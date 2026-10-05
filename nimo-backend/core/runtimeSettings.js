/**
 * core/runtimeSettings.js
 * Small in-memory runtime settings for the agent's autonomy level.
 *
 *   controlMode:
 *     'ask'     — (default) every click/press/scroll/type into apps asks the
 *                 user via the approval card
 *     'granted' — the user has authorized computer control for the session:
 *                 input automation runs immediately (typed content is still
 *                 judged by the safety core)
 */

const settings = {
  controlMode: 'ask'
}

function get(key) {
  return settings[key]
}

function set(key, value) {
  settings[key] = value
  return settings[key]
}

module.exports = { get, set }
