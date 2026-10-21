const test = require('node:test')
const assert = require('node:assert/strict')

const { createChatHistoryStore } = require('../services/chat/chatHistoryStore')

function createFakeMongo() {
  const messages = []
  const state = { clients: 0, connects: 0, closes: 0, dbName: null, collectionName: null }

  class FakeCursor {
    constructor(items) {
      this.items = items
    }

    sort(sortSpec) {
      this.items = [...this.items].sort((left, right) => {
        const timestampDifference = left.timestamp - right.timestamp
        if (timestampDifference !== 0) return timestampDifference
        return String(left._id).localeCompare(String(right._id))
      })
      assert.deepEqual(sortSpec, { timestamp: 1, _id: 1 })
      return this
    }

    limit(limit) {
      this.items = this.items.slice(0, limit)
      return this
    }

    async toArray() {
      return this.items
    }
  }

  class FakeCollection {
    async insertOne(document) {
      const insertedId = `message-${messages.length + 1}`
      const stored = { ...document, _id: insertedId }
      messages.push(stored)
      return { acknowledged: true, insertedId }
    }

    find(query) {
      return new FakeCursor(messages.filter((message) => message.sessionId === query.sessionId))
    }
  }

  class FakeClient {
    constructor(uri) {
      assert.equal(uri, 'mongodb://example.test')
      state.clients += 1
    }

    async connect() {
      state.connects += 1
    }

    db(name) {
      state.dbName = name
      return {
        collection(name) {
          state.collectionName = name
          return new FakeCollection()
        }
      }
    }

    async close() {
      state.closes += 1
    }
  }

  return { FakeClient, messages, state }
}

test('missing MONGODB_URI disables persistence without constructing a client', async () => {
  let attempted = false
  const store = createChatHistoryStore({
    env: { MONGODB_DB_NAME: 'test-db' },
    clientFactory: () => {
      attempted = true
      throw new Error('should not connect')
    }
  })

  assert.deepEqual(await store.init(), {
    enabled: false,
    reason: 'missing_uri',
    dbName: 'test-db',
    collectionName: 'chat_messages'
  })
  assert.equal(await store.saveMessage({ sessionId: 'session-1', role: 'user', text: 'hello' }), null)
  assert.deepEqual(await store.listMessages('session-1'), [])
  assert.equal(attempted, false)
})

test('connects lazily and saves/list messages with optional metadata', async () => {
  const fakeMongo = createFakeMongo()
  const store = createChatHistoryStore({
    env: { MONGODB_URI: 'mongodb://example.test', MONGODB_DB_NAME: 'chat-test' },
    clientFactory: (uri) => new fakeMongo.FakeClient(uri)
  })

  assert.equal(fakeMongo.state.clients, 0)
  const first = await store.saveMessage({
    sessionId: 'session-1',
    role: 'user',
    text: 'hello',
    timestamp: '2026-01-01T00:00:02.000Z',
    metadata: { source: 'test' }
  })
  await store.saveMessage({
    sessionId: 'session-1',
    role: 'assistant',
    text: 'Hi!',
    timestamp: '2026-01-01T00:00:01.000Z'
  })
  await store.saveMessage({ sessionId: 'other', role: 'user', text: 'ignored' })

  assert.equal(fakeMongo.state.clients, 1)
  assert.equal(fakeMongo.state.connects, 1)
  assert.equal(fakeMongo.state.dbName, 'chat-test')
  assert.equal(fakeMongo.state.collectionName, 'chat_messages')
  assert.equal(first.metadata.source, 'test')
  assert.ok(first.timestamp instanceof Date)

  const messages = await store.listMessages('session-1')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].text, 'Hi!')
  assert.equal(messages[1].text, 'hello')
  assert.equal(messages[1].metadata.source, 'test')

  await store.close()
  assert.equal(fakeMongo.state.closes, 1)
})

test('reuses one lazy connection and resetForTests closes it', async () => {
  const fakeMongo = createFakeMongo()
  const store = createChatHistoryStore({
    env: { MONGODB_URI: 'mongodb://example.test' },
    clientFactory: (uri) => new fakeMongo.FakeClient(uri)
  })

  await store.init()
  await store.init()
  assert.equal(fakeMongo.state.clients, 1)
  assert.equal(fakeMongo.state.connects, 1)

  await store.resetForTests()
  assert.equal(fakeMongo.state.closes, 1)
})
