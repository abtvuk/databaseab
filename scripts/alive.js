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

  console.log(`alive: ${channels.filter(c => c.alive).length}  due: ${candidates.length}  skipped: ${skipped.length}`)

  if (candidates.length === 0) return

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let passed = 0, failed = 0, flippedDead = 0, done = 0
  const total = candidates.length
  const failureCounts   = {}
  const failureBySource = { stream: 0, runner: 0, unknown: 0 }

  const tasks = candidates.map(ch => async () => {
    const urls = ch.streamUrls || []
    const meta = ch.streamMeta || []

    if (!urls.length) {
      const entry = channelMap.get(ch.id)
      if (entry) entry.uptime = { ...(entry.uptime || {}), lastProbed: new Date().toISOString() }
      done++
      progressBar(done, total)
      return
    }

    let result = { alive: false, needsProxy: false, responseMs: 0 }
    let liveIndex = -1
    for (let i = 0; i < urls.length; i++) {
      const ref = meta[i]?.referrer  ?? ch.referrer
      const ua  = meta[i]?.userAgent ?? ch.userAgent
      const r   = await probeUrl(urls[i], ref, ua)
      if (r.alive && !r.browserUnplayable) { result = r; liveIndex = i; break }
      if (r.alive && liveIndex === -1)      { result = r; liveIndex = i }
    }

    done++
    progressBar(done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive) {
      if (liveIndex > 0) {
        entry.streamUrls = [urls[liveIndex], ...urls.filter((_, i) => i !== liveIndex)]
        if (meta.length) entry.streamMeta = [meta[liveIndex], ...meta.filter((_, i) => i !== liveIndex)]
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
      if (failures >= 2) {
        entry.alive = false
        flippedDead++
      }

      failed++
    }
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency)

  const allChannels = channels.map(c => channelMap.get(c.id) || c)
  const { retired, pruned } = applyRetirementAndPruning(allChannels)

  data.channels = allChannels
  saveChannels(data)

  console.log(`passed: ${passed}  failed: ${failed}  flipped: ${flippedDead}  skipped: ${skipped.length}`)
  if (retired) console.log(`archived: ${retired}`)
  if (pruned)  console.log(`pruned: ${pruned}`)

  if (failed > 0) {
    const sorted = Object.entries(failureCounts).sort((a, b) => b[1] - a[1])
    for (const [reason, count] of sorted) {
      console.log(`  ${reason.padEnd(12)} ${String(count).padStart(5)}  (${((count / failed) * 100).toFixed(1)}%)`)
    }
    console.log(`  stream: ${failureBySource.stream}  runner: ${failureBySource.runner}  unknown: ${failureBySource.unknown}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
