import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const app = express();
const PORT = 3000;
const NIMO_BACKEND = process.env.NIMO_BACKEND_URL || "http://localhost:3001";

app.use(express.json());

// ── Logging helpers ──────────────────────────────────────────────────────────

interface ServerLog {
  id: string;
  timestamp: string;
  type: string;
  text: string;
  category: 'info' | 'voice' | 'intent' | 'ai' | 'action' | 'error';
}

const logs: ServerLog[] = [];

function addLog(text: string, type = "CLIENT", category: ServerLog['category'] = "info") {
  const ts = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry: ServerLog = { id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: ts, type, text, category };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
}

function postLog(text: string, type: string, category: ServerLog['category']) {
  addLog(text, type, category);
}

// Seed with startup log so the event log panel is never empty on first load.
addLog("Connected to NIMO backend on " + NIMO_BACKEND, "SYS_INIT", "info");
addLog("NIMO SYSTEM: All handlers active", "SYS_READY", "info");

// ── API routes ──────────────────────────────────────────────────────────────

// ── Backend target hardening (SSRF guard) ──────────────────────────────────
// The UI server proxies ONLY to NIMO's own backend. NIMO_BACKEND is operator
// configuration (not user input), but we still validate it once at startup
// and re-verify every composed target URL before fetching, so no user-derived
// path fragment can ever redirect a proxy call to another host.
//
// Note: the backend itself IS a loopback service by design — the outbound
// INTERNET guard lives in nimo-backend/services/guard/safeFetch.js, which
// blocks private/loopback hosts for NIMO's web requests.
const BACKEND_URL = (() => {
  try {
    const u = new URL(NIMO_BACKEND);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    return u.origin; // scheme://host:port only — any path in the env var is dropped
  } catch {
    console.error(`[NIMO-OS] Invalid NIMO_BACKEND_URL "${NIMO_BACKEND}", falling back to http://localhost:3001`);
    return "http://localhost:3001";
  }
})();

/**
 * Assert a composed proxy target stays inside the configured backend origin.
 * Rejects non-http(s) schemes, embedded credentials, and any path that could
 * smuggle a different authority (e.g. starting with //).
 */
function assertSafeBackendTarget(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error("Proxy target must stay inside the /api/ namespace");
  }
  if (path.startsWith("//")) {
    throw new Error("Proxy target path may not start with //");
  }
  const target = new URL(path, BACKEND_URL);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only http/https proxy targets are allowed");
  }
  if (target.username || target.password) {
    throw new Error("Proxy target may not embed credentials");
  }
  if (target.origin !== BACKEND_URL) {
    throw new Error("Proxy target host mismatch");
  }
  return target.href;
}

// Generic JSON proxy to the NIMO backend (port 3001). Returns the parsed
// payload so callers can log on it; response is already sent unless
// `send` is false.
async function proxyToBackend(
  req: express.Request,
  res: express.Response,
  path: string,
  timeoutMs = 60000,
  send = true
): Promise<any> {
  let target: string;
  try {
    target = assertSafeBackendTarget(path);
  } catch (err: any) {
    addLog(`Blocked proxy target (${err.message}): ${path}`, "PROXY_GUARD", "error");
    const payload = { ok: false, error: "Blocked proxy target", speak: "That route is not allowed." };
    if (send) res.status(400).json(payload);
    return payload;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const backendRes = await fetch(target, {
      method: req.method === "GET" || req.method === "POST" ? req.method : "GET",
      headers: { "Content-Type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body || {}) : undefined,
      redirect: "error", // never follow a redirect away from the pinned origin
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await backendRes.json();
    if (send) res.status(backendRes.status).json(data);
    return data;
  } catch (err: any) {
    addLog(`Backend proxy error (${path}): ${err.message}`, "PROXY_ERR", "error");
    const payload = { ok: false, error: err.message, speak: "I couldn't reach the NIMO backend. Is it running?" };
    if (send) res.json(payload);
    return payload;
  }
}

// GET /api/logs — returns event log buffer (timers array is always empty;
// timer display is driven by the NIMO backend push events in the renderer).
app.get("/api/logs", (_req, res) => {
  res.json({ logs, timers: [] });
});

app.post("/api/logs/add", (req, res) => {
  const { text, type, category } = req.body || {};
  if (text) postLog(String(text), type || "CLIENT", category || "info");
  res.json({ ok: true });
});

app.post("/api/logs/clear", (_req, res) => {
  logs.length = 0;
  addLog("Event log cleared.", "SYSTEM", "info");
  res.json({ ok: true });
});

// POST /api/run-command — legacy fast-path + agent fallback (NIMO backend).
app.post("/api/run-command", (req, res) => {
  const { transcript } = req.body || {};
  if (transcript) addLog(`User command: "${transcript}"`, "HEARD", "voice");
  return proxyToBackend(req, res, "/api/run-command");
});

// POST /api/agent — the full agent brain (tools, clarification, sessions).
app.post("/api/agent", async (req, res) => {
  const { text } = req.body || {};
  if (text) addLog(`You: "${text}"`, "YOU", "voice");
  const data = await proxyToBackend(req, res, "/api/agent", 120000, false);
  if (data?.speak) addLog(`NIMO: "${data.speak}"`, "REPLY", "ai");
  if (Array.isArray(data?.steps)) {
    data.steps.forEach((s: any) => addLog(`Tool: ${s.summary}`, s.ok ? "TOOL" : "TOOL!", s.ok ? "action" : "error"));
  }
  res.status(200).json(data);
});

// POST /api/agent/reset — clear the agent's conversation memory.
app.post("/api/agent/reset", (req, res) => proxyToBackend(req, res, "/api/agent/reset"));

// GET /api/os/apps — installed app discovery (names only).
// Always forwards the FIXED path with no user-derived data in the URL; the
// renderer filters the returned list locally.
app.get("/api/os/apps", (req, res) => proxyToBackend(req, res, "/api/os/apps"));

// POST /api/os/search-files — read-only file-name search.
app.post("/api/os/search-files", (req, res) => proxyToBackend(req, res, "/api/os/search-files"));

// GET /api/timers — active countdown timers.
app.get("/api/timers", (_req, res) => proxyToBackend(_req, res, "/api/timers"));

// POST /api/tts — proxy to NIMO backend for ElevenLabs TTS.
app.post("/api/tts", async (req, res) => {
  const { text, opts } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: "Text is empty" });
  }

  let target: string;
  try {
    target = assertSafeBackendTarget("/api/tts");
  } catch (err: any) {
    addLog(`Blocked proxy target: ${err.message}`, "PROXY_GUARD", "error");
    return res.status(400).json({ ok: false, error: "Blocked proxy target" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const backendRes = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, opts }),
      redirect: "error",
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!backendRes.ok) {
      throw new Error(`Backend TTS responded with ${backendRes.status}`);
    }

    const data = await backendRes.json();
    return res.json(data);
  } catch (err: any) {
    addLog(`TTS proxy error: ${err.message}`, "TTS_ERR", "error");
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Vite dev server + startup ───────────────────────────────────────────────

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[NIMO-OS] UI server running on http://localhost:${PORT}`);
    console.log(`[NIMO-OS] Proxying /api/run-command → ${NIMO_BACKEND}/api/run-command`);
  });
}

startServer();