// scripts/resurrect.js
// ─────────────────────────────────────────────────────────────────────────────
//  Dead channel resurrection.
//
//  Targets: channels where alive: false AND probe: true
//  On pass: sets alive: true, updates uptime
//  On fail: updates uptime, alive stays false
//
//  No frequency filter here — dead channels are always worth checking.
//  The 4-hour schedule in the workflow already controls how often this runs.
// ─────────────────────────────────────────────────────────────────────────────

const cfg = require('../config')
const { probeUrl, runWithConcurrency, recordAlive, recordDead, progressBar } = require('./probe')
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
  console.log('  databaseab — resurrect.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadChannels()
  const channels = data.channels || []

  const candidates = channels
    .filter(c => c.alive === false && c.probe !== false && !c.ytId && !c.radio)
    .sort((a, b) => (b.uptime?.score ?? -1) - (a.uptime?.score ?? -1))
  const excluded   = channels.filter(c => c.alive === false && c.probe === false)

  console.log(`  Total dead channels:    ${channels.filter(c => !c.alive).length}`)
  console.log(`  Candidates to probe:    ${candidates.length}`)
  console.log(`  Excluded (probe:false): ${excluded.length}`)
  console.log()

  if (candidates.length === 0) {
    console.log('  No dead channels to resurrect. Exiting.')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    return
  }

  const channelMap = new Map(channels.map(c => [c.id, c]))

  let resurrected = 0, stillDead = 0, done = 0
  const total = candidates.length

  const tasks = candidates.map(ch => async () => {
    const urls = ch.streamUrls || []
    if (!urls.length) {
      // No URL — can't probe, just leave it dead
      done++
      return
    }

    // Try each URL in order; stop at first live one
    let result = { alive: false, needsProxy: false, responseMs: 0 }
    let liveIndex = -1
    for (let i = 0; i < urls.length; i++) {
      result = await probeUrl(urls[i], ch.referrer, ch.userAgent)
      if (result.alive) { liveIndex = i; break }
    }

    done++
    progressBar(done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive) {
      // Bubble the working URL to front so the player hits it first
      if (liveIndex > 0) {
        entry.streamUrls = [urls[liveIndex], ...urls.filter((_, i) => i !== liveIndex)]
      }
      entry.uptime            = recordAlive(entry.uptime)
      entry.alive             = true
      entry.needsProxy        = result.needsProxy ? true : (entry.needsProxy || false)
      entry.browserUnplayable = result.browserUnplayable || false
      if (!entry.browserUnplayable) delete entry.browserUnplayable
      const slow = result.responseMs > (cfg.probe.slowThresholdMs || 8000)
      if (slow) entry.slow = true
      else delete entry.slow
      resurrected++
    } else {
      entry.uptime = recordDead(entry.uptime)
      stillDead++
    }
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency)

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveChannels(data)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  RESURRECTED  ${resurrected}  (flipped to alive: true)`)
  console.log(`  STILL DEAD   ${stillDead}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })