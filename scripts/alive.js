const cfg = require('../config')
const { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForProbe,
        progressBar, applyRetirementAndPruning, classifyFailSource } = require('./probe')
const fs   = require('fs')
const path = require('path')

const OUTPUT_PATH = path.resolve(cfg.output.channels)

function loadChannels() {
  const raw = fs.readFileSync(OUTPUT_PATH, 'utf8')
  return JSON.parse(raw)
}

function saveChannels(data) {
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  )
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — alive.js')
  console.log('━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadChannels()
  const channels = data.channels || []

  const candidates = channels.filter(c =>
    c.alive === true &&
    c.probe !== false &&
    !c.radio &&
    !c.ytId &&
    isDueForProbe(c.uptime)
  )
  const skipped  = channels.filter(c => c.alive === true && c.probe !== false && !c.radio && !c.ytId && !isDueForProbe(c.uptime))
  const excluded = channels.filter(c => c.alive === true && c.probe === false)

  console.log(`  Total alive channels:   ${channels.filter(c => c.alive).length}`)
  console.log(`  Due for probe:          ${candidates.length}`)
  console.log(`  Skipped (not due yet):  ${skipped.length}`)
  console.log(`  Excluded (probe:false): ${excluded.length}`)
  console.log()

  if (candidates.length === 0) {
    console.log('  Nothing to probe. Exiting.')
    return
  }

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let passed = 0, failed = 0, flippedDead = 0, done = 0
  const total = candidates.length
  
  const failureCounts  = {}  // by reason: timeout, dns, http_403, …
  const failureBySource = { stream: 0, runner: 0, unknown: 0 }

  const tasks = candidates.map(ch => async () => {
    const urls = ch.streamUrls || []

    if (!urls.length) {
      // No URL to probe — just update lastProbed
      const entry = channelMap.get(ch.id)
      if (entry) entry.uptime = { ...(entry.uptime || {}), lastProbed: new Date().toISOString() }
      done++
      progressBar(done, total)
      return
    }

    // Try each URL in order, stop at first live one
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
      // Bubble the working URL to front for player to hit it first
      if (liveIndex > 0) {
        entry.streamUrls = [urls[liveIndex], ...urls.filter((_, i) => i !== liveIndex)]
      }
      entry.uptime            = recordAlive(entry.uptime)
      entry.alive             = true
      entry.needsProxy        = result.needsProxy === true
      entry.browserUnplayable = result.browserUnplayable || false
      if (!entry.browserUnplayable) delete entry.browserUnplayable
      entry.slow              = result.responseMs > (cfg.probe.slowThresholdMs || 8000) ? true : undefined
      if (!entry.slow) delete entry.slow
      passed++
    } else {
      entry.uptime = recordDead(entry.uptime)

      const reason = result.failReason || 'other'
      failureCounts[reason] = (failureCounts[reason] || 0) + 1
      const source = classifyFailSource(reason)
      failureBySource[source] = (failureBySource[source] || 0) + 1

      const failures = entry.uptime?.consecutiveFailures || 0
      if (failures >= 3) {
        entry.alive = false
        flippedDead++
      }

      failed++
    }
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency)

  // ─ retirement and pruning─
  const allChannels = channels.map(c => channelMap.get(c.id) || c)
  const { retired, pruned } = applyRetirementAndPruning(allChannels)

  data.channels = allChannels
  saveChannels(data)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  PASSED      ${passed}`)
  console.log(`  FAILED      ${failed}`)
  console.log(`    → flipped to alive:false  ${flippedDead}  (3 consecutive failures)`)
  console.log(`  SKIPPED     ${skipped.length}  (not due yet)`)
  if (retired) console.log(`  ARCHIVED    ${retired}  → ${cfg.retirement.output}`)
  if (pruned)  console.log(`  PRUNED      ${pruned}  → ${cfg.pruning.output} (probe:false)`)

  if (failed > 0) {
    console.log('\n  Failure breakdown:')
    const sorted = Object.entries(failureCounts).sort((a, b) => b[1] - a[1])
    for (const [reason, count] of sorted) {
      const pct = ((count / failed) * 100).toFixed(1)
      console.log(`    ${reason.padEnd(12)}  ${String(count).padStart(5)}  (${pct}%)`)
    }
    console.log('\n  By source (stream-side vs runner/network):')
    console.log(`    stream   ${String(failureBySource.stream).padStart(5)}  — stream returned hard error (4xx / no data)`)
    console.log(`    runner   ${String(failureBySource.runner).padStart(5)}  — timeout / DNS / connection refused`)
    console.log(`    unknown  ${String(failureBySource.unknown).padStart(5)}`)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
