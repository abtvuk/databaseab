// scripts/check-youtube.js
// ─────────────────────────────────────────────────────────────────────────────
//  YouTube channel availability checker.
//
//  Targets: channels where ytId is set AND probe: true
//  Uses YouTube oEmbed API — returns 404 for deleted/private/terminated channels.
//  On pass: alive: true, uptime updated
//  On fail: alive: false, uptime updated
//
//  Runs every 12 hours. YouTube channels are more stable than HLS streams
//  so they don't need the same aggressive frequency as check-alive.
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const { runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

// ── YouTube availability probe ────────────────────────────────────────────────
// ytId can be:
//   - A video/stream ID (11 chars, e.g. "dQw4w9WgXcQ") → use oEmbed
//   - A channel ID (starts with "UC")                  → use channel page
//   - A handle (starts with "@")                       → use handle page
//
// oEmbed only works for video IDs — it always 404s for channel IDs and handles,
// which would cause them to be incorrectly marked dead on every check.

async function probeYtId(ytId) {
  let url
  
const isVideoId = !ytId.startsWith('UC') && !ytId.startsWith('@')
  if (ytId.startsWith('UC')) {
    url = `https://www.youtube.com/channel/${ytId}`
  } else if (ytId.startsWith('@')) {
    url = `https://www.youtube.com/${ytId}`
  } else {
    // Video/stream ID — oEmbed is the lightest check
    url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`
  }

  try {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res  = await fetch(url, {
      method:  isVideoId ? 'GET' : 'HEAD',
      signal:  ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    clearTimeout(t)
    // 200 = exists, 404 = deleted/terminated, 302→login = private
    return { alive: res.status === 200 }
  } catch {
    return { alive: null }  // transient error — don't flip dead
  }
}

// ── Load / save ───────────────────────────────────────────────────────────────

function loadYoutube() {
  const raw = fs.readFileSync(path.resolve(cfg.output.youtube), 'utf8')
  return JSON.parse(raw)
}

// ── Save youtube.json ─────────────────────────────────────────────────────────

function saveYoutube(channels) {
  const ytChannels = channels.filter(c => c.ytId)
  const out = path.resolve(cfg.output.youtube)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString(),
    total: ytChannels.length,
    channels: ytChannels,
  }, null, 2))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — check-youtube.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadYoutube()
  const channels = data.channels || []

  const candidates = channels.filter(c => c.ytId && c.probe !== false && isDueForProbe(c.uptime))
  const skipped    = channels.filter(c => c.ytId && c.probe !== false && !isDueForProbe(c.uptime))
  const excluded   = channels.filter(c => c.ytId && c.probe === false)

  console.log(`  Total YouTube channels: ${channels.filter(c => c.ytId).length}`)
  console.log(`  Candidates to probe:    ${candidates.length}`)
  console.log(`  Skipped (not due yet):  ${skipped.length}`)
  console.log(`  Excluded (probe:false): ${excluded.length}`)
  console.log()

  if (candidates.length === 0) {
    console.log('  Nothing to probe. Exiting.')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    return
  }

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let passed = 0, failed = 0, done = 0
  const total = candidates.length

  const tasks = candidates.map(ch => async () => {
    const result = await probeYtId(ch.ytId)
    done++

    progressBar(done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive === true) {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      passed++
    } else if (result.alive === false) {
      entry.uptime = recordDead(entry.uptime)
      // ── Point 6: don't flip dead on a single failure — require 3 consecutive
      const failures = entry.uptime?.consecutiveFailures || 0
      if (failures >= 3) {
        entry.alive = false
        failed++
      }
      // alive stays true until 3 failures accumulate
    }
    // null = transient error, leave alive/uptime untouched
  })

  await runWithConcurrency(tasks, cfg.probe.youtubeConcurrency || 6)

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveYoutube(data.channels)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ALIVE  ${passed}`)
  console.log(`  DEAD   ${failed}  (alive: false)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
