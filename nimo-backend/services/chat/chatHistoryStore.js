/**
 * services/chat/chatHistoryStore.js
 *
 * Optional MongoDB-backed chat history persistence. The default exported store
 * is safe to use when MongoDB is not configured: it remains disabled and all
 * persistence operations become no-ops until MONGODB_URI is provided.
 */

const { MongoClient } = require('mongodb')

const DEFAULT_DB_NAME = 'nimo'
const COLLECTION_NAME = 'chat_messages'

function createChatHistoryStore(options = {}) {
  const env = options.env || process.env
  const logger = options.logger || null
  const createClient = options.clientFactory || ((uri, clientOptions) => new MongoClient(uri, clientOptions))

  let client = null
  let collection = null
  let initPromise = null
  let disabled = false

  function getUri() {
    return options.uri !== undefined ? options.uri : env.MONGODB_URI
  }

  function getDbName() {
    return options.dbName || env.MONGODB_DB_NAME || DEFAULT_DB_NAME
  }

  function warnUnavailable() {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('MongoDB chat history persistence is unavailable; persistence disabled.')
    }
  }

  async function init(initOptions = {}) {
    if (collection) {
      return {
        enabled: true,
        dbName: getDbName(),
        collectionName: COLLECTION_NAME
      }
    }

    const uri = getUri()
    if (!uri) {
      disabled = true
      return {
        enabled: false,
        reason: 'missing_uri',
        dbName: getDbName(),
        collectionName: COLLECTION_NAME
      }
    }

    if (initPromise) return initPromise

    initPromise = (async () => {
      let nextClient = null
      try {
        nextClient = createClient(uri, initOptions.clientOptions)
        await nextClient.connect()
        collection = nextClient.db(getDbName()).collection(COLLECTION_NAME)
        client = nextClient
        disabled = false
        return {
          enabled: true,
          dbName: getDbName(),
          collectionName: COLLECTION_NAME
        }
      } catch {
        disabled = true
        collection = null
        client = null
        if (nextClient && typeof nextClient.close === 'function') {
          try { await nextClient.close() } catch { /* best effort */ }
        }
        warnUnavailable()
        return {
          enabled: false,
          reason: 'connection_failed',
          dbName: getDbName(),
          collectionName: COLLECTION_NAME
        }
      } finally {
        initPromise = null
      }
    })()

    return initPromise
  }

  async function ensureCollection() {
    if (collection) return collection
    const state = await init()
    return state.enabled ? collection : null
  }

  function normalizeTimestamp(timestamp) {
    if (timestamp === undefined) return new Date()
    if (timestamp instanceof Date) {
      if (Number.isNaN(timestamp.getTime())) throw new TypeError('timestamp must be a valid date')
      return timestamp
    }

    const parsed = new Date(timestamp)
    if (Number.isNaN(parsed.getTime())) throw new TypeError('timestamp must be a valid date')
    return parsed
  }

  function validateMessage(message) {
    if (!message || typeof message !== 'object') {
      throw new TypeError('message must be an object')
    }
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string')
    }
    if (typeof message.role !== 'string' || message.role.length === 0) {
      throw new TypeError('role must be a non-empty string')
    }
    if (typeof message.text !== 'string') {
      throw new TypeError('text must be a string')
    }
  }

  async function saveMessage(message) {
    const target = await ensureCollection()
    if (!target || disabled) return null

    validateMessage(message)
    const document = {
      sessionId: message.sessionId,
      role: message.role,
      text: message.text,
      timestamp: normalizeTimestamp(message.timestamp)
    }
    if (message.metadata !== undefined) document.metadata = message.metadata

    const result = await target.insertOne(document)
    return { ...document, _id: result.insertedId }
  }

  async function listMessages(sessionId, listOptions = {}) {
    const target = await ensureCollection()
    if (!target || disabled) return []
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string')
    }

    let cursor = target.find({ sessionId }).sort({ timestamp: 1, _id: 1 })
    if (Number.isInteger(listOptions.limit) && listOptions.limit > 0) {
      cursor = cursor.limit(listOptions.limit)
    }
    return cursor.toArray()
  }

  async function close() {
    const currentClient = client
    client = null
    collection = null
    disabled = false
    if (currentClient && typeof currentClient.close === 'function') {
      await currentClient.close()
    }
  }

  async function resetForTests() {
    await close()
  }

  return {
    init,
    saveMessage,
    listMessages,
    close,
    resetForTests
  }
}

const defaultStore = createChatHistoryStore()

module.exports = {
  init: defaultStore.init,
  saveMessage: defaultStore.saveMessage,
  listMessages: defaultStore.listMessages,
  close: defaultStore.close,
  resetForTests: defaultStore.resetForTests,
  createChatHistoryStore,
  DEFAULT_DB_NAME,
  COLLECTION_NAME
}
