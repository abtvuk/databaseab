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

    // Hard error codes that a proxy cannot fix — stream is dead or geo-blocked
    if (res.status === 403 || res.status === 404 || res.status === 410 || res.status === 451) {
      return { browserOk: false, needsProxy: false }
    }

    const acao = res.headers.get('access-control-allow-origin')
    const browserOk = acao === '*' || acao === ORIGIN

    // Stream responded (2xx) but CORS missing → proxy can bridge it
    if (res.ok && !browserOk) return { browserOk: false, needsProxy: true }

    // Non-2xx, non-hard-error (e.g. 401, 5xx) — stream may be proxy-able
    if (!res.ok) return { browserOk: false, needsProxy: true }

    return { browserOk: true, needsProxy: false }
  } catch {
    // Network error / timeout on CORS check — stream may still be proxy-able
    return { browserOk: false, needsProxy: true }
  }
}

// ── Unplayable domain check ──────────────────────────────────────────────────
// Returns true if the URL's hostname matches a known token-expiry or
// structurally-unplayable CDN that always passes probing but never plays.

function isUnplayableDomain(url) {
  const blocked = cfg.unplayableDomains || []
  if (!blocked.length) return false
  try {
    const hostname = new URL(url).hostname
    return blocked.some(d => hostname === d || hostname.endsWith('.' + d))
  } catch {
    return false
  }
}

// ── Segment concurrency semaphore ────────────────────────────────────────────
// Limits simultaneous segment probes independently of the main probe concurrency.
// Prevents OOM/runner-death on CI when many channels need proxy verification.

const SEGMENT_CONCURRENCY = cfg.probe.segmentConcurrency || 8
let _segmentActive = 0
const _segmentQueue = []
function acquireSegmentSlot() {
  return new Promise(resolve => {
    if (_segmentActive < SEGMENT_CONCURRENCY) { _segmentActive++; resolve() }
    else _segmentQueue.push(resolve)
  })
}
function releaseSegmentSlot() {
  if (_segmentQueue.length) { _segmentQueue.shift()() }
  else _segmentActive--
}

// ── Segment-level probe ───────────────────────────────────────────────────────
// Called only when corsCheck returns needsProxy:true.
// Fetches the manifest, extracts the first segment/child URL, then fetches
// that segment with a browser UA + Origin to confirm real playability.
// Returns { playable: boolean }
//
// Catches:
//   - jmp2.uk-style redirect chains that browsers can't follow
//   - bozztv-style segment-level origin enforcement
//   - Any CDN that gates segments differently from the manifest

async function segmentProbe(url, referrer, userAgent) {
  await acquireSegmentSlot()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': userAgent || BROWSER_UA,
        'Origin': ORIGIN,
        ...(referrer ? { 'Referer': referrer } : {}),
      },
      redirect: 'follow',
    })

    if (!res.ok) { clearTimeout(timer); releaseSegmentSlot(); return { playable: false } }

    const text = await res.text()
    clearTimeout(timer)
    
    // Extract first non-comment, non-empty line that looks like a URL or path
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const firstSegment = lines[0]
    if (!firstSegment) return { playable: false }

    // Resolve relative URLs against the manifest URL
    let segmentUrl
    try {
      segmentUrl = new URL(firstSegment).href
    } catch {
      segmentUrl = new URL(firstSegment, url).href
    }

    // Fetch the segment/child manifest
    const ctrl2 = new AbortController()
    const timer2 = setTimeout(() => ctrl2.abort(), 10000)
    const segRes = await fetch(segmentUrl, {
      method: 'HEAD',
      signal: ctrl2.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Origin': ORIGIN,
        ...(referrer ? { 'Referer': referrer } : {}),
      },
      redirect: 'follow',
    })
    clearTimeout(timer2)

    const ok = segRes.ok
    releaseSegmentSlot()
    return { playable: ok }
  } catch {
    releaseSegmentSlot()
    return { playable: false }
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
      if (err) {
        const timedOut = responseMs >= (TIMEOUT_S + 4) * 1000
        return resolve({ alive: false, responseMs, timedOut })
      }
      const out = stdout.trim()
      resolve({ alive: out.includes('video') || out.includes('audio'), responseMs, timedOut: false })
    })

    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, (TIMEOUT_S + 6) * 1000)
  })
}

// ── Probe with browser UA fallback ────────────────────────────────────────────
// Fails fast on timeout — if the server is unreachable, don't waste time
// running 3 more probes. Only tries browser UA if the server actually responded.

async function probeWithFallback(url, referrer, userAgent) {
  const r1 = await probeOnce(url, referrer, userAgent, 'v:0')
  if (r1.alive) return r1
  if (r1.timedOut) return { alive: false, responseMs: r1.responseMs }

  const r2 = await probeOnce(url, referrer, userAgent, 'a:0')
  if (r2.alive) return r2
  if (r2.timedOut) return { alive: false, responseMs: r2.responseMs }

  if (!userAgent || userAgent !== BROWSER_UA) {
    const r3 = await probeOnce(url, referrer, BROWSER_UA, 'v:0')
    if (r3.alive) return r3
    if (r3.timedOut) return { alive: false, responseMs: r3.responseMs }

    const r4 = await probeOnce(url, referrer, BROWSER_UA, 'a:0')
    if (r4.alive) return r4
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
      // Check against known token-expiry / structurally-unplayable CDNs first
      if (isUnplayableDomain(url)) {
        return { alive: true, needsProxy: false, browserUnplayable: true, responseMs: result.responseMs }
      }

      const { browserOk, needsProxy } = await corsCheck(url, referrer, userAgent)

      if (!browserOk && needsProxy) {
        // Proxy is needed — but verify it actually plays at segment level
        const { playable } = await segmentProbe(url, referrer, userAgent)
        if (!playable) {
          // Manifest responds but segments don't — alive for bookkeeping but unplayable
          return { alive: true, needsProxy: false, browserUnplayable: true, responseMs: result.responseMs }
        }
      }

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

// ── Recency-weighted score ────────────────────────────────────────────────────
// The raw aliveCount/totalCount ratio is misleading for channels with long
// histories: a channel alive 900/1000 times historically but dead the last
// 50 checks still shows score:90. We weight the most recent N results at
// full value and older results at half, so recent degradation shows up faster.
//
// With scoreRecencyWindow:0 this degrades to the plain ratio.

function computeScore(uptime) {
  const window = cfg.scoreRecencyWindow || 0
  const { aliveCount, totalCount } = uptime
  if (!totalCount) return null
  if (!window || totalCount <= window) {
    return Math.round((aliveCount / totalCount) * 100)
  }
  // We don't store the individual results, so we approximate:
  // recent window is implied by consecutiveAlive + the last N probes.
  // Best we can do without a history array: weight the last `window` results
  // by tracking them via consecutiveAlive as a lower-bound proxy.
  // Approximation: split into "recent" (last `window` probes) and "old" (rest).
  // We infer recent aliveCount from consecutiveAlive (capped at window).
  const recentAlive = Math.min(uptime.consecutiveAlive ?? 0, window)
  const recentTotal = window
  const oldTotal    = totalCount - window
  const oldAlive    = aliveCount - recentAlive
  // Recent results at weight 1.0, old results at weight 0.5
  const weightedAlive = recentAlive * 1.0 + Math.max(0, oldAlive) * 0.5
  const weightedTotal = recentTotal * 1.0 + oldTotal * 0.5
  return Math.round((weightedAlive / weightedTotal) * 100)
}

// ── Uptime helpers ────────────────────────────────────────────────────────────

function recordAlive(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null, lastProbed: null, score: null }
  u.aliveCount++
  u.totalCount++
  u.consecutiveAlive++
  u.lastSeen   = new Date().toISOString()
  u.lastProbed = new Date().toISOString()
  u.score = computeScore(u)
  return u
}

function recordDead(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null, lastProbed: null, score: null }
  u.totalCount++
  u.consecutiveAlive = 0
  u.lastProbed = new Date().toISOString()
  u.score = computeScore(u)
  return u
}

// ── Probe frequency check ─────────────────────────────────────────────────────
// Returns true if this alive channel is due for a re-probe.

function isDueForProbe(uptime) {
  const pf = cfg.probeFrequency
  const score = uptime?.score ?? null
  const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
  const hoursSince = lastProbed ? (Date.now() - lastProbed.getTime()) / 3600000 : Infinity

  if (score === null || uptime?.totalCount === 0) return true

  let minHours
  if      (score >= 85) minHours = pf.above85
  else if (score >= 80) minHours = pf.from80to85
  else if (score >= 70) minHours = pf.from70to80
  else                  minHours = pf.below70

  return hoursSince >= minHours
}

// ── Resurrect frequency check ─────────────────────────────────────────────────
// Returns true if this dead channel is worth retrying now.
// Channels with a long history of 0% get throttled way back.

function isDueForResurrect(uptime) {
  const rf = cfg.resurrectFrequency
  const score      = uptime?.score ?? null
  const total      = uptime?.totalCount ?? 0
  const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
  const hoursSince = lastProbed ? (Date.now() - lastProbed.getTime()) / 3600000 : Infinity

  // No history at all → always try
  if (score === null || total === 0) return true

  let minHours
  if (score === 0) {
    minHours = total > 10 ? rf.scoreZeroManyData : rf.scoreZeroFewData
  } else if (score >= 50) {
    minHours = rf.scoreAbove50
  } else if (score >= 20) {
    minHours = rf.scoreAbove20
  } else {
    minHours = rf.scoreAbove0
  }

  return hoursSince >= minHours
}

// ── Checkpoint (shared) ───────────────────────────────────────────────────────
// Saves current state and pushes to git. Used by check-alive and resurrect.

function checkpoint(data, channels, channelMap, outputPath, label, done, total) {
  const { execSync } = require('child_process')
  data.channels = channels.map(c => channelMap.get(c.id) || c)
  const json = JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  require('fs').writeFileSync(outputPath, json)
  try {
    execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' })
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' })
    execSync(`git add ${outputPath}`, { stdio: 'ignore' })
    execSync(`git diff --staged --quiet || git commit -m "chore: ${label} checkpoint [$(date -u '+%Y-%m-%d %H:%M UTC')]"`, { shell: true, stdio: 'ignore' })
    execSync('git pull --rebase --autostash', { stdio: 'ignore' })
    execSync('git push', { stdio: 'ignore' })
    console.log(`  [checkpoint] saved & pushed at ${done}/${total}`)
  } catch (e) {
    console.warn(`  [checkpoint] git error (non-fatal): ${e.message}`)
  }
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

module.exports = { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForProbe, isDueForResurrect, checkpoint, progressBar }
