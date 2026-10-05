/**
 * services/web/liveData.js
 * Real-time information fetching for NIMO's agent brain.
 *
 * All requests go through safeFetch (http/https only, public hosts only).
 * APIs are keyless so the companion works out of the box:
 *
 *   getWeather(city?)   → Open-Meteo geocoding + current forecast
 *   getQuickAnswer(q)   → Wikipedia search + REST summary (factual answers)
 *
 * Every result includes a short `speak` line plus structured `data` the UI
 * can render as a rich card.
 */

const { safeFetchJson } = require('../guard/safeFetch')
const logger = require('../../utils/logger')

// ── Weather (Open-Meteo, keyless) ─────────────────────────────────────────

const WEATHER_CODES = {
  0: ['Clear sky', 'clear'], 1: ['Mainly clear', 'clear'], 2: ['Partly cloudy', 'cloudy'],
  3: ['Overcast', 'cloudy'], 45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'],
  56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Violent showers', 'rain'],
  85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'storm'], 99: ['Thunderstorm with hail', 'storm']
}

/**
 * Fetch live weather. Without a city, falls back to a coarse guess from the
 * machine timezone (no location services needed); with a city, geocodes it.
 * @param {string|null} city
 * @returns {Promise<{ok:boolean, speak:string, data:object}>}
 */
async function getWeather(city) {
  try {
    let place = null
    if (city && String(city).trim()) {
      const geo = await safeFetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.trim())}&count=1&language=en&format=json`,
        { timeoutMs: 8000 }
      )
      const hit = geo && Array.isArray(geo.results) && geo.results[0]
      if (!hit) {
        return { ok: false, speak: `I couldn't find a place called ${city}.`, data: { city } }
      }
      place = { name: hit.name, admin: hit.admin1, country: hit.country, lat: hit.latitude, lon: hit.longitude }
    } else {
      // Keyless coarse location: use the timezone's representative coordinates.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'
      const rough = tzCityTable[tz] || { name: tz.split('/').pop().replace(/_/g, ' '), lat: 28.61, lon: 77.21, country: '' }
      place = { name: rough.name, admin: '', country: rough.country || '', lat: rough.lat, lon: rough.lon }
    }

    const w = await safeFetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2`,
      { timeoutMs: 8000 }
    )
    const cur = w.current || {}
    const [desc, kind] = WEATHER_CODES[cur.weather_code] || ['Unknown', 'clear']
    const today = (w.daily && w.daily.temperature_2m_max?.[0]) ?? null
    const tonight = (w.daily && w.daily.temperature_2m_min?.[0]) ?? null

    const where = place.admin ? `${place.name}, ${place.country}` : `${place.name}${place.country ? ', ' + place.country : ''}`
    const speak = `Right now in ${where} it's ${Math.round(cur.temperature_2m)}°C with ${desc.toLowerCase()}` +
      (today != null ? `, today's high around ${Math.round(today)}°.` : '.')

    return {
      ok: true,
      speak,
      data: {
        place: where,
        temperature: Math.round(cur.temperature_2m),
        feelsLike: Math.round(cur.apparent_temperature),
        humidity: cur.relative_humidity_2m,
        windKph: Math.round(cur.wind_speed_10m || 0),
        condition: desc,
        kind,
        high: today != null ? Math.round(today) : null,
        low: tonight != null ? Math.round(tonight) : null,
        fetchedAt: new Date().toISOString()
      }
    }
  } catch (err) {
    logger.warn(`getWeather failed: ${err.message}`)
    return { ok: false, speak: "I couldn't reach the weather service just now.", data: { city: city || null, error: err.message } }
  }
}

// Coarse coordinates for common timezone cities (keyless fallback).
const tzCityTable = {
  'Asia/Kolkata': { name: 'Delhi NCR', lat: 28.61, lon: 77.21, country: 'India' },
  'Asia/Karachi': { name: 'Karachi', lat: 24.86, lon: 67.01, country: 'Pakistan' },
  'America/New_York': { name: 'New York', lat: 40.71, lon: -74.01, country: 'USA' },
  'America/Los_Angeles': { name: 'Los Angeles', lat: 34.05, lon: -118.24, country: 'USA' },
  'America/Chicago': { name: 'Chicago', lat: 41.88, lon: -87.63, country: 'USA' },
  'Europe/London': { name: 'London', lat: 51.51, lon: -0.13, country: 'UK' },
  'Europe/Paris': { name: 'Paris', lat: 48.86, lon: 2.35, country: 'France' },
  'Europe/Berlin': { name: 'Berlin', lat: 52.52, lon: 13.4, country: 'Germany' },
  'Asia/Tokyo': { name: 'Tokyo', lat: 35.68, lon: 139.69, country: 'Japan' },
  'Asia/Dubai': { name: 'Dubai', lat: 25.2, lon: 55.27, country: 'UAE' },
  'Australia/Sydney': { name: 'Sydney', lat: -33.87, lon: 151.21, country: 'Australia' },
  'Asia/Singapore': { name: 'Singapore', lat: 1.35, lon: 103.82, country: 'Singapore' }
}

// ── Quick factual answers (Wikipedia, keyless) ────────────────────────────

/**
 * Fetch a short factual answer for "who/what is X" style questions.
 * @param {string} query
 * @returns {Promise<{ok:boolean, speak:string, data:object}>}
 */
async function getQuickAnswer(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, speak: 'I need something to look up.', data: {} }
  try {
    const search = await safeFetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1`,
      { timeoutMs: 8000 }
    )
    const title = search?.query?.search?.[0]?.title
    if (!title) {
      return { ok: false, speak: `I couldn't find anything reliable on "${q}".`, data: { query: q } }
    }
    const sum = await safeFetchJson(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { timeoutMs: 8000, headers: { Accept: 'application/json' } }
    )
    const extract = String(sum.extract || '').trim()
    if (!extract) {
      return { ok: false, speak: `I found "${title}" but couldn't read a summary.`, data: { query: q } }
    }
    // First 1-2 sentences for TTS; full extract goes to the UI card.
    const firstSentences = extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')
    return {
      ok: true,
      speak: firstSentences,
      data: {
        query: q,
        title: sum.title || title,
        extract,
        thumbnail: sum.thumbnail?.source || null,
        url: (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        fetchedAt: new Date().toISOString()
      }
    }
  } catch (err) {
    logger.warn(`getQuickAnswer failed: ${err.message}`)
    return { ok: false, speak: 'My knowledge lookup failed — the answer service seems unreachable.', data: { query: q, error: err.message } }
  }
}

module.exports = { getWeather, getQuickAnswer }
