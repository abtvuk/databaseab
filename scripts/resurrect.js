// scripts/resurrect.js
// ─────────────────────────────────────────────────────────────────────────────
//  Dead channel resurrection.
//
//  Targets: channels where alive: false AND probe: true
//  On pass: sets alive: true, updates uptime
//  On fail: updates uptime, alive stays false
//
//  Frequency filter: channels with a long history of failures are throttled
//  back via isDueForResurrect() — score:0 with 10+ data points waits 72h
//  between retries instead of running every 4 hours. This prevents the
//  workflow from probing 3000+ hopeless channels on every run.
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const path = require('path')
const fs   = require('fs')
const { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForResurrect, checkpoint, progressBar } = require('./probe')

const CHECKPOINT_EVERY = 1000
const OUTPUT_PATH      = path.resolve(cfg.output.channels)

function loadChannels() {
  const raw = fs.readFileSync(OUTPUT_PATH, 'utf8')
  return JSON.parse(raw)
}

function saveChannels(data) {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2))
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — resurrect.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadChannels()
  const channels = data.channels || []

  const dead = channels.filter(c => c.alive === false && c.probe !== false && !c.ytId && !c.radio)

  const candidates = dead
    .filter(c => isDueForResurrect(c.uptime))
    .sort((a, b) => (b.uptime?.score ?? -1) - (a.uptime?.score ?? -1))

  const throttled = dead.length - candidates.length
  const excluded  = channels.filter(c => c.alive === false && c.probe === false)

  console.log(`  Total dead channels:    ${dead.length}`)
  console.log(`  Throttled (not due):    ${throttled}`)
  console.log(`  Candidates to probe:    ${candidates.length}`)
  console.log(`  Excluded (probe:false): ${excluded.length}`)
  console.log()

  if (candidates.length === 0) {
    console.log('  No channels due for retry. Exiting. 😏')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    return
  }

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let resurrected = 0, stillDead = 0, done = 0
  const total = candidates.length

  const tasks = candidates.map(ch => async () => {
    const urls = ch.streamUrls || []
    if (!urls.length) {
      // No URL — record the attempt so throttle advances, leave dead
      const entry = channelMap.get(ch.id)
      if (entry) entry.uptime = recordDead(entry.uptime)
      done++
      progressBar(done, total)
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
    if (done % CHECKPOINT_EVERY === 0) checkpoint(data, channels, channelMap, OUTPUT_PATH, 'resurrect', done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive) {
      if (liveIndex > 0) {
        entry.streamUrls = [urls[liveIndex], ...urls.filter((_, i) => i !== liveIndex)]
      }
      entry.uptime            = recordAlive(entry.uptime)
      entry.alive             = true
      entry.needsProxy         = result.needsProxy === true
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
  console.log(`  THROTTLED    ${throttled}  (not due yet)`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
