// scripts/probe.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared stream probing utilities used by check-alive.js and resurrect.js
// ─────────────────────────────────────────────────────────────────────────────

const cfg = require('../config')

const TIMEOUT_MS = cfg.probe.timeoutSeconds * 1000
const UA = 'abtv-probe/1.0'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Single probe attempt — HEAD with GET fallback ─────────────────────────────
// Returns { alive, responseMs, cors }

async function probeOnce(url) {
  const headers = { 'User-Agent': UA }
  const t0 = Date.now()

  // HEAD first
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers })
    clearTimeout(t)
    const responseMs = Date.now() - t0
    if (res.status < 400) {
      const cors = res.headers.get('access-control-allow-origin')
      return { alive: true, responseMs, cors: !!cors }
    }
    if (res.status !== 405) return { alive: false, responseMs, cors: false }
  } catch (e) {
    if (e.name !== 'AbortError') return { alive: false, responseMs: Date.now() - t0, cors: false }
  }

  // GET fallback with Range header
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { ...headers, Range: 'bytes=0-0' },
    })
    clearTimeout(t)
    const responseMs = Date.now() - t0
    const cors = res.headers.get('access-control-allow-origin')
    return { alive: res.status === 200 || res.status === 206, responseMs, cors: !!cors }
  } catch {
    return { alive: false, responseMs: Date.now() - t0, cors: false }
  }
}

// ── Probe with retries ────────────────────────────────────────────────────────

async function probeUrl(url) {
  let last = { alive: false, responseMs: 0, cors: false }
  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)
    last = await probeOnce(url)
    if (last.alive) return last
  }
  return last
}

// ── YouTube oEmbed check ──────────────────────────────────────────────────────
// Returns true if the channel/video is still publicly accessible.

async function probeYouTube(ytId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`
  const result = await probeUrl(url)
  return result
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  let i = 0
  const results = new Array(tasks.length)
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      results[idx] = await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

// ── Uptime helpers ────────────────────────────────────────────────────────────

function recordAlive(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null, lastProbed: null, score: null }
  u.aliveCount++
  u.totalCount++
  u.consecutiveAlive++
  u.lastSeen   = new Date().toISOString()
  u.lastProbed = new Date().toISOString()
  u.score = Math.round((u.aliveCount / u.totalCount) * 100)
  return u
}

function recordDead(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null, lastProbed: null, score: null }
  u.totalCount++
  u.consecutiveAlive = 0
  u.lastProbed = new Date().toISOString()
  u.score = u.totalCount > 0 ? Math.round((u.aliveCount / u.totalCount) * 100) : null
  return u
}

// ── Probe frequency check ─────────────────────────────────────────────────────
// Returns true if this channel is due for a probe based on its uptime score.

function isDueForProbe(uptime) {
  const pf = cfg.probeFrequency
  const score = uptime?.score ?? null
  const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
  const hoursSince = lastProbed ? (Date.now() - lastProbed.getTime()) / 3600000 : Infinity

  // No history at all → always probe
  if (score === null || uptime?.totalCount === 0) return true

  let minHours
  if      (score >= 85)              minHours = pf.above85
  else if (score >= 80)              minHours = pf.from80to85
  else if (score >= 70)              minHours = pf.from70to80
  else                               minHours = pf.below70

  return hoursSince >= minHours
}

module.exports = { probeUrl, probeYouTube, runWithConcurrency, recordAlive, recordDead, isDueForProbe }
