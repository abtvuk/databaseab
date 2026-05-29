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
const { runWithConcurrency, recordAlive, recordDead } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

// ── YouTube oEmbed probe ──────────────────────────────────────────────────────
// Returns { alive: bool }
// oEmbed returns 200 for live/accessible videos, 404 for dead/private/deleted.

async function probeYtId(ytId) {
  const url  = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`
  try {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res  = await fetch(url, {
      method:  'GET',
      signal:  ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    clearTimeout(t)
    return { alive: res.status === 200 }
  } catch {
    return { alive: false }
  }
}

// ── Load / save ───────────────────────────────────────────────────────────────

function loadChannels() {
  const raw = fs.readFileSync(path.resolve(cfg.output.channels), 'utf8')
  return JSON.parse(raw)
}

function saveChannels(data) {
  fs.writeFileSync(
    path.resolve(cfg.output.channels),
    JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — check-youtube.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadChannels()
  const channels = data.channels || []

  const candidates = channels.filter(c => c.ytId && c.probe !== false)
  const excluded   = channels.filter(c => c.ytId && c.probe === false)

  console.log(`  Total YouTube channels: ${channels.filter(c => c.ytId).length}`)
  console.log(`  Candidates to probe:    ${candidates.length}`)
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

    if (done % 100 === 0 || done === total) {
      console.log(`  [check-youtube] ${done}/${total} — ✓ ${passed}  ✗ ${failed}`)
    }

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive) {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      passed++
    } else {
      entry.uptime = recordDead(entry.uptime)
      entry.alive  = false
      failed++
    }
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency)

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveChannels(data)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ALIVE  ${passed}`)
  console.log(`  DEAD   ${failed}  (alive: false)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
