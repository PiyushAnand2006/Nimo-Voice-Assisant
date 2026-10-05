/**
 * services/guard/safeFetch.js
 * The single outbound network gateway for NIMO.
 *
 * Every server-side HTTP request NIMO makes (weather APIs, web answers,
 * research pages) MUST go through safeFetch(). It enforces:
 *
 *   1. Only http:// and https:// protocols.
 *   2. Host validation BEFORE connecting: rejects localhost, loopback,
 *      private, link-local and reserved IP ranges (both literal IPs in the
 *      URL and DNS-resolved addresses).
 *   3. Response size cap + timeout so a rogue page cannot stall the agent.
 *
 * NIMO is an entertainment companion — it must never become a tunnel into
 * the local network or the machine itself.
 */

const dns = require('dns').promises
const net = require('net')
const logger = require('../../utils/logger')

const DEFAULT_TIMEOUT_MS = 10000
const MAX_BYTES = 3 * 1024 * 1024 // 3 MB cap per response
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

class SafeFetchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
  }
}

/** true if an IPv4/IPv6 address is private, loopback, link-local or reserved. */
function isForbiddenIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true                    // this-network, private, loopback
    if (a === 169 && b === 254) return true                              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true                     // private
    if (a === 192 && b === 168) return true                              // private
    if (a === 100 && b >= 64 && b <= 127) return true                    // CGNAT
    if (a === 192 && b === 0) return true                                // reserved (192.0.0.x/192.0.2.x)
    if (a === 198 && (b === 18 || b === 19)) return true                 // benchmarking
    if (a >= 224) return true                                            // multicast + reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase()
    if (low === '::' || low === '::1') return true                       // unspecified + loopback
    if (low.startsWith('fe8') || low.startsWith('fe9') ||
        low.startsWith('fea') || low.startsWith('feb')) return true      // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true        // unique-local
    if (low.startsWith('ff')) return true                                // multicast
    // IPv4-mapped (::ffff:10.0.0.1 etc.)
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isForbiddenIp(mapped[1])
    if (low.startsWith('2001:db8')) return true                          // documentation
    return false
  }
  return true // not parseable → treat as forbidden
}

function isForbiddenHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (net.isIP(host)) return isForbiddenIp(host)
  return false
}

// Tiny DNS cache so repeated fetches in one research run don't re-resolve.
const dnsCache = new Map() // hostname → { ok, reason?, expires }
const DNS_TTL_MS = 60 * 1000

/** Resolve hostname and reject if ANY address is private/reserved/loopback. */
async function assertHostIsPublic(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (isForbiddenHostname(host)) {
    throw new SafeFetchError('E_FORBIDDEN_HOST', `Blocked request to non-public host: ${host}`)
  }
  if (process.env.NIMO_ALLOW_PRIVATE_FETCH === '1') return // test escape hatch

  const cached = dnsCache.get(host)
  if (cached && cached.expires > Date.now()) {
    if (!cached.ok) throw new SafeFetchError('E_FORBIDDEN_HOST', cached.reason)
    return
  }

  try {
    const addrs = await dns.lookup(host, { all: true, verbatim: true })
    const bad = addrs.find((a) => isForbiddenIp(a.address))
    if (bad) {
      dnsCache.set(host, { ok: false, reason: `Host ${host} resolves to a private/reserved address (${bad.address})`, expires: Date.now() + DNS_TTL_MS })
      throw new SafeFetchError('E_FORBIDDEN_HOST', `Host ${host} resolves to a private/reserved address.`)
    }
    dnsCache.set(host, { ok: true, expires: Date.now() + DNS_TTL_MS })
  } catch (err) {
    if (err instanceof SafeFetchError) throw err
    dnsCache.set(host, { ok: false, reason: `DNS lookup failed for ${host}`, expires: Date.now() + DNS_TTL_MS })
    throw new SafeFetchError('E_DNS', `Could not resolve host ${host}.`)
  }
}

/**
 * Validated, capped, timed fetch. Returns the raw Response.
 * @param {string} url
 * @param {{timeoutMs?:number, headers?:object, method?:string}} [opts]
 */
async function safeFetch(url, opts = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new SafeFetchError('E_BAD_URL', 'Invalid URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeFetchError('E_PROTOCOL', `Only http/https URLs are allowed (got ${parsed.protocol}).`)
  }
  await assertHostIsPublic(parsed.hostname)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(parsed.href, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!res.ok) throw new SafeFetchError('E_HTTP', `HTTP ${res.status} from ${parsed.hostname}`)
    return res
  } catch (err) {
    if (err instanceof SafeFetchError) throw err
    if (err.name === 'AbortError') throw new SafeFetchError('E_TIMEOUT', `Request timed out: ${parsed.hostname}`)
    throw new SafeFetchError('E_FETCH', err.message || 'Fetch failed.')
  } finally {
    clearTimeout(timer)
  }
}

/** safeFetch + read body as text with a hard size cap. */
async function safeFetchText(url, opts = {}) {
  const res = await safeFetch(url, opts)
  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_BYTES) {
      try { await reader.cancel() } catch { /* noop */ }
      break // truncate rather than fail — page text beyond 3MB is rarely useful
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** safeFetch + JSON parse. */
async function safeFetchJson(url, opts = {}) {
  const text = await safeFetchText(url, opts)
  try {
    return JSON.parse(text)
  } catch {
    throw new SafeFetchError('E_JSON', `Response was not valid JSON from ${new URL(url).hostname}.`)
  }
}

module.exports = { safeFetch, safeFetchText, safeFetchJson, SafeFetchError, isForbiddenHostname, isForbiddenIp }
