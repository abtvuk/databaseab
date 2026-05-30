// scripts/probe.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared stream probing utilities used by check-alive.js and resurrect.js
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const { execFile } = require('child_process')

const TIMEOUT_S = cfg.probe.timeoutSeconds
const UA        = 'abtv-probe/1.0'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── ffprobe stream probe ──────────────────────────────────────────────────────
// Uses ffprobe to actually connect and read stream data.
// Handles HLS, RTSP, RTMP natively. Confirms packets are flowing.
// Returns { alive, responseMs, cors }

function probeOnce(url, referrer, userAgent) {
  return new Promise(resolve => {
    const t0   = Date.now()
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000), // ffprobe timeout in microseconds
      '-user_agent', userAgent || UA,
      ...(referrer ? ['-headers', `Referer: ${referrer}\r\n`] : []),
      '-select_streams', 'v:0',       // look for at least one video stream
      '-show_entries',   'stream=codec_type',
      '-of',             'csv=p=0',
      url,
    ]

    const child = execFile('ffprobe', args, { timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout) => {
      const responseMs = Date.now() - t0
      if (err) return resolve({ alive: false, responseMs, cors: false })

      // stdout contains 'video' if a video stream was found
      // For radio/audio-only streams, retry with audio stream check
      const hasVideo = stdout.trim().includes('video')
      resolve({ alive: hasVideo, responseMs, cors: false })
    })

    // Hard kill if execFile timeout doesn't fire in time
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, (TIMEOUT_S + 6) * 1000)
  })
}

// ── Audio-only fallback probe ─────────────────────────────────────────────────
// For streams where no video stream is found — checks for audio (radio stations).

function probeAudioOnce(url, referrer, userAgent) {
  return new Promise(resolve => {
    const t0   = Date.now()
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000),
      '-user_agent', userAgent || UA,
      ...(referrer ? ['-headers', `Referer: ${referrer}\r\n`] : []),
      '-select_streams', 'a:0',
      '-show_entries',   'stream=codec_type',
      '-of',             'csv=p=0',
      url,
    ]

    const child = execFile('ffprobe', args, { timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout) => {
      const responseMs = Date.now() - t0
      if (err) return resolve({ alive: false, responseMs, cors: false })
      resolve({ alive: stdout.trim().includes('audio'), responseMs, cors: false })
    })

    setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, (TIMEOUT_S + 6) * 1000)
  })
}

// ── Probe with retries ────────────────────────────────────────────────────────

async function probeUrl(url, referrer, userAgent) {
  let last = { alive: false, responseMs: 0, cors: false }

  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)

    last = await probeOnce(url, referrer, userAgent)
    if (last.alive) return last

    // If no video stream found, check for audio (radio/audio-only streams)
    if (!last.alive) {
      const audioResult = await probeAudioOnce(url, referrer, userAgent)
      if (audioResult.alive) return audioResult
    }
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

// ── Progress bar ──────────────────────────────────────────────────────────────

function progressBar(done, total) {
  if (done % 100 !== 0 && done !== total) return
  const pct = Math.round((done / total) * 100)
  const filled = Math.round(pct / 4)
  const bar = '█'.repeat(filled) + '░'.repeat(25 - filled)
  process.stdout.write(`\r  [${bar}] ${pct}%`)
  if (done === total) process.stdout.write('\n')
}

module.exports = { probeUrl, probeYouTube, runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar }
