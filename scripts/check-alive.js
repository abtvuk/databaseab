// scripts/check-alive.js
// ─────────────────────────────────────────────────────────────────────────────
//  Alive channel checker.
//
//  Targets: channels where alive: true AND probe: true AND not a YouTube channel
//  Skips:   channels not due for a probe based on their uptime score + lastProbed
//  On fail: sets alive: false, updates uptime
//  On pass: updates uptime, alive stays true
//
//  Probe frequency (configurable in config.js → probeFrequency):
//    no history     → always probe
//    score < 70%    → probe if last check was > 5h ago
//    score 70–79%   → probe if last check was > 8h ago
//    score 80–84%   → probe if last check was > 12h ago
//    score ≥ 85%    → probe if last check was > 24h ago
// ─────────────────────────────────────────────────────────────────────────────

const cfg = require('../config')
const { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar } = require('./probe')
const fs   = require('fs')
const path = require('path')

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

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — check-alive.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadChannels()
  const channels = data.channels || []

  // YouTube channels are handled by check-youtube.js
  // Radio channels share the same HLS probe path as TV — included here
  const candidates = channels.filter(c =>
    c.alive === true &&
    c.probe !== false &&
    !c.ytId &&
    isDueForProbe(c.uptime)
  )
  const skipped  = channels.filter(c => c.alive === true && c.probe !== false && !c.ytId && !isDueForProbe(c.uptime))
  const excluded = channels.filter(c => c.alive === true && c.probe === false)

  console.log(`  Total alive channels:  ${channels.filter(c => c.alive).length}`)
  console.log(`  Due for probe:         ${candidates.length}`)
  console.log(`  Skipped (not due yet): ${skipped.length}`)
  console.log(`  Excluded (probe:false):${excluded.length}`)
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
    const url = (ch.streamUrls || [])[0]

    if (!url) {
      // No URL to probe — leave alive as-is, just update lastProbed
      const entry = channelMap.get(ch.id)
      if (entry) entry.uptime = { ...(entry.uptime || {}), lastProbed: new Date().toISOString() }
      done++
      progressBar(done, total)
      return
    }

    const result = await probeUrl(url, ch.referrer, ch.userAgent)
    done++
    progressBar(done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive) {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      entry.slow   = result.responseMs > (cfg.probe.slowThresholdMs || 8000) ? true : undefined
      if (!entry.slow) delete entry.slow
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
  console.log(`  PASSED  ${passed}`)
  console.log(`  FAILED  ${failed}  (flipped to alive: false)`)
  console.log(`  SKIPPED ${skipped.length}  (not due yet)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
