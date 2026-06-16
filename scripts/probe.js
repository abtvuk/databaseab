// scripts/probe.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared stream probing utilities used by check-alive.js and resurrect.js
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const { execFile } = require('child_process')

const TIMEOUT_S  = cfg.probe.timeoutSeconds
const UA         = 'abtv-probe/1.0'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const ORIGIN     = 'https://abtv.cictehro.space'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── CORS check ────────────────────────────────────────────────────────────────
// Returns { browserOk, needsProxy }
// browserOk   = stream is directly playable in a browser
// needsProxy  = stream is alive but needs the server-side proxy to bypass CORS
//
// Key insight: if ffprobe reached the stream but CORS is missing/wrong,
// the stream is ALIVE — it just needs the proxy. We must not mark it dead.

async function corsCheck(url, referrer, userAgent) {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const res   = await fetch(url, {
      method: 'HEAD',
      signal: ctrl.signal,
      headers: {
        'Origin':     ORIGIN,
        'User-Agent': userAgent || BROWSER_UA,
        ...(referrer ? { 'Referer': referrer, 'Origin': new URL(referrer).origin } : {}),
      },
    })
    clearTimeout(timer)

    // 403 with a referrer channel — try without to distinguish geo-block from referrer-lock
    if (res.status === 403 && !referrer) {
      return { browserOk: false, needsProxy: false } // hard block, proxy won't help
    }

    const acao = res.headers.get('access-control-allow-origin')
    const browserOk = acao === '*' || acao === ORIGIN

    // Stream responded but CORS missing → proxy can bridge it
    if (!browserOk && res.ok) return { browserOk: false, needsProxy: true }
    if (!browserOk)           return { browserOk: false, needsProxy: true } // non-2xx but alive, try proxy

    return { browserOk: true, needsProxy: false }
  } catch {
    // Network error / timeout on CORS check — stream may still be proxy-able
    return { browserOk: false, needsProxy: true }
  }
}

// ── ffprobe stream probe ──────────────────────────────────────────────────────
// Uses ffprobe to actually connect and read stream data.
// Tries with the channel's own UA/referrer first, then falls back to a
// browser UA — catches servers that block non-browser agents.
// Returns { alive, responseMs }

function probeOnce(url, referrer, userAgent, streamType = 'v:0') {
  return new Promise(resolve => {
    const t0   = Date.now()
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000),
      '-user_agent', userAgent || UA,
      ...(referrer ? ['-headers', `Referer: ${referrer}\r\nOrigin: ${(() => { try { return new URL(referrer).origin } catch { return referrer } })()}\r\n`] : []),
      '-select_streams', streamType,
      '-show_entries',   'stream=codec_type',
      '-of',             'csv=p=0',
      url,
    ]

    const child = execFile('ffprobe', args, { timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout) => {
      const responseMs = Date.now() - t0
      if (err) return resolve({ alive: false, responseMs })
      const out = stdout.trim()
      resolve({ alive: out.includes('video') || out.includes('audio'), responseMs })
    })

    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, (TIMEOUT_S + 6) * 1000)
  })
}

// ── Probe with browser UA fallback ────────────────────────────────────────────
// Some servers block ffprobe's default UA. Try browser UA as fallback.

async function probeWithFallback(url, referrer, userAgent) {
  // First attempt: channel's own referrer/UA
  let result = await probeOnce(url, referrer, userAgent, 'v:0')
  if (result.alive) return result

  // Audio fallback (radio/audio-only)
  result = await probeOnce(url, referrer, userAgent, 'a:0')
  if (result.alive) return result

  // Second attempt: browser UA (catches UA-blocking servers)
  if (!userAgent || userAgent !== BROWSER_UA) {
    result = await probeOnce(url, referrer, BROWSER_UA, 'v:0')
    if (result.alive) return result

    result = await probeOnce(url, referrer, BROWSER_UA, 'a:0')
    if (result.alive) return result
  }

  return { alive: false, responseMs: 0 }
}

// ── Probe with retries ────────────────────────────────────────────────────────
// Returns { alive, needsProxy, responseMs }
//
// alive      = stream has reachable, decodable content
// needsProxy = alive but browser can't play it directly (CORS/referrer lock)
//              → caller should set needsProxy: true on the channel

async function probeUrl(url, referrer, userAgent) {
  let last = { alive: false, needsProxy: false, responseMs: 0 }

  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)

    const result = await probeWithFallback(url, referrer, userAgent)

    if (result.alive) {
      const { browserOk, needsProxy } = await corsCheck(url, referrer, userAgent)
      return { alive: true, needsProxy: !browserOk, responseMs: result.responseMs }
    }

    last = { alive: false, needsProxy: false, responseMs: result.responseMs }
  }

  return last
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

// ── Progress bar ──────────────────────────────────────────────────────────────

function progressBar(done, total) {
  if (done % 100 !== 0 && done !== total) return
  const pct = Math.round((done / total) * 100)
  const filled = Math.round(pct / 4)
  const bar = '█'.repeat(filled) + '░'.repeat(25 - filled)
  process.stdout.write(`\r  [${bar}] ${pct}%`)
  if (done === total) process.stdout.write('\n')
}

module.exports = { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar }
