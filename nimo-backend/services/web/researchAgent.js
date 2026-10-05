/**
 * services/web/researchAgent.js
 * NIMO's "do a research on X" pipeline.
 *
 *   researchTopic(topic, {depth})
 *     1. Search DuckDuckGo HTML for the topic (via safeFetch).
 *     2. Pick the top N result pages and extract readable text.
 *     3. Hand the collected material to Gemini for a structured briefing.
 *     4. Return a short speakable summary + the full report + sources.
 *
 * Read-only by design: pages are fetched, never stored; nothing is opened
 * in the browser unless the user asks for that separately.
 */

const { safeFetchText, SafeFetchError } = require('../guard/safeFetch')
const { askModel } = require('../../core/aiClient')
const logger = require('../../utils/logger')

const DDG_HTML = 'https://html.duckduckgo.com/html/?q='
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const PAGE_TEXT_CAP = 6000   // chars of text per source page
const MAX_SOURCES = 4        // pages read per research run
const SEARCH_RETRIES = 2

function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeDdgRedirect(href) {
  const m = String(href || '').match(/[?&]uddg=([^&]+)/)
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { /* fall through */ }
  }
  return href
}

/** Search DuckDuckGo HTML; returns [{ title, url, snippet }]. */
async function webSearch(query, limit = 6) {
  let lastErr = null
  for (let attempt = 0; attempt <= SEARCH_RETRIES; attempt++) {
    try {
      const html = await safeFetchText(DDG_HTML + encodeURIComponent(query), {
        timeoutMs: 9000,
        headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' }
      })
      const results = []
      const blocks = html.match(/<div class="result[\s\S]*?(?=<div class="result|<div class="results--main)/g) || []
      for (const block of blocks) {
        const t = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
        if (!t) continue
        const url = decodeDdgRedirect(t[1])
        const title = stripHtml(t[2])
        const s = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
        const snippet = s ? stripHtml(s[1]) : ''
        // Only keep http(s) results; safeFetch re-validates on fetch anyway.
        if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet })
        if (results.length >= limit) break
      }
      if (results.length) return results
      lastErr = new Error('no results parsed')
    } catch (err) {
      lastErr = err
      if (err instanceof SafeFetchError && err.code === 'E_TIMEOUT') break
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
  }
  logger.warn(`webSearch("${query}") failed: ${lastErr && lastErr.message}`)
  return []
}

/**
 * Fetch a page and pull out readable paragraph text (very lightweight
 * readability: block elements, noise tags removed, length-filtered lines).
 */
async function readPageText(url, cap = PAGE_TEXT_CAP) {
  const html = await safeFetchText(url, { timeoutMs: 9000 })
  const body = html.match(/<body[\s\S]*?<\/body>/i) ? html.match(/<body[\s\S]*?<\/body>/i)[0] : html
  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<(p|div|li|h1|h2|h3|h4|td|article|section)[\s>]/gi, '\n<$1')
  const lines = cleaned
    .split('\n')
    .map((l) => stripHtml(l))
    .filter((l) => l.length > 60 && !/cookie|javascript|subscribe|newsletter|sign in|©/i.test(l))
  let text = lines.join('\n')
  if (text.length > cap) text = text.slice(0, cap)
  return text
}

/**
 * Run a multi-step research task and synthesize a briefing.
 * @param {string} topic
 * @param {{focus?:string, sources?:number}} [opts]
 * @returns {Promise<{ok:boolean, speak:string, data:{report:string, sources:Array, topic:string}}>}
 */
async function researchTopic(topic, opts = {}) {
  const t = String(topic || '').trim()
  if (!t) return { ok: false, speak: 'Tell me what to research and I am on it.', data: { topic: '', report: '', sources: [] } }

  const maxSources = Math.min(opts.sources || MAX_SOURCES, 5)
  try {
    const query = opts.focus ? `${t} ${opts.focus}` : t
    const hits = await webSearch(query, maxSources + 2)

    const materials = []
    const sources = []
    for (const hit of hits) {
      if (materials.length >= maxSources) break
      if (sources.some((s) => s.url === hit.url)) continue
      try {
        const text = await readPageText(hit.url)
        if (text.length < 200) continue
        materials.push({ url: hit.url, title: hit.title, text })
        sources.push({ title: hit.title, url: hit.url, snippet: hit.snippet })
      } catch (err) {
        logger.debug(`researchTopic: skipping ${hit.url}: ${err.message}`)
      }
    }

    if (!materials.length) {
      return { ok: false, speak: `I searched but couldn't read enough about "${t}" right now. Try again in a moment?`, data: { topic: t, report: '', sources: hits.slice(0, 3).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })) } }
    }

    const sourceBlock = materials
      .map((m, i) => `SOURCE [${i + 1}]: ${m.title}\nURL: ${m.url}\nCONTENT:\n${m.text}\n`)
      .join('\n---\n')

    const prompt = `You are NIMO, a personal research assistant. Research topic: "${t}"${opts.focus ? ` (focus: ${opts.focus})` : ''}.

Below are excerpts from ${materials.length} web sources fetched live just now. Synthesize them into a research briefing.

Rules:
- Write everything in ENGLISH.
- Start with a 1-2 sentence headline summary (this will be spoken aloud, so make it crisp).
- Then a "Key findings" section with 3-5 bullet points, each citing sources like [1], [2].
- Then a short "Bottom line" sentence.
- If sources disagree, say so. Never invent facts that are not in the excerpts.

${sourceBlock}`

    const report = await askModel(prompt, { temperature: 0.4 })
    const firstPara = report.split('\n').map((l) => l.trim()).filter(Boolean)[0] || `Here's what I found on ${t}.`

    return { ok: true, speak: firstPara, data: { topic: t, report, sources } }
  } catch (err) {
    logger.warn(`researchTopic("${t}") failed: ${err.message}`)
    return { ok: false, speak: 'My research run hit a wall — the web looks unreachable right now.', data: { topic: t, report: '', sources: [], error: err.message } }
  }
}

module.exports = { researchTopic, webSearch, readPageText }
