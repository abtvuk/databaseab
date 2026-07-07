const cfg = require('../config')
const { probeUrl, probeUrlThorough, isCriticalChannel, runWithConcurrency, recordAlive, recordDead, isDueForProbe,
        progressBar, applyRetirementAndPruning, classifyFailSource, checkpoint,
        isUnplayableDomain, isNameBlocked, isManualBlocked, loadFeed, saveFeed } = require('./probe')
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
  let   channels = data.channels || []

  const blockedFeed = loadFeed(cfg.output.blocked)
  const stillBlocked = []
  const restoredFromBlocked = []
  for (const c of blockedFeed.channels) {
    if (isNameBlocked(c.name) || isManualBlocked(c.id)) stillBlocked.push(c)
    else restoredFromBlocked.push(c)
  }
  if (restoredFromBlocked.length) {
    saveFeed(cfg.output.blocked, stillBlocked)
    channels = [...channels, ...restoredFromBlocked]
    console.log(`[sweep] restored from blocked.json: ${restoredFromBlocked.length}`)
  }

  const archiveFeed = loadFeed(cfg.output.archive)
  const stillArchived = []
  const restoredFromArchive = []
  for (const c of archiveFeed.channels) {
    if (c.unplayableArchived && !isUnplayableDomain(c.streamUrls?.[0] || '')) {
      const { unplayableArchived, ...clean } = c
      restoredFromArchive.push(clean)
    } else {
      stillArchived.push(c)
    }
  }
  if (restoredFromArchive.length) {
    saveFeed(cfg.output.archive, stillArchived)
    channels = [...channels, ...restoredFromArchive]
    console.log(`[sweep] restored from archive.json: ${restoredFromArchive.length}`)
  }

  const toBlocked = channels.filter(c => isNameBlocked(c.name) || isManualBlocked(c.id))
  const toArchive = channels.filter(c => !toBlocked.includes(c) && isUnplayableDomain(c.streamUrls?.[0] || ''))

  if (toBlocked.length) {
    const existing = loadFeed(cfg.output.blocked)
    const existingIds = new Set(existing.channels.map(c => c.id))
    saveFeed(cfg.output.blocked, [...existing.channels, ...toBlocked.filter(c => !existingIds.has(c.id))])
    console.log(`[sweep] moved to blocked.json: ${toBlocked.length}`)
  }
  if (toArchive.length) {
    const existing = loadFeed(cfg.output.archive)
    const existingIds = new Set(existing.channels.map(c => c.id))
    saveFeed(cfg.output.archive, [...existing.channels, ...toArchive.filter(c => !existingIds.has(c.id)).map(c => ({ ...c, unplayableArchived: true }))])
    console.log(`[sweep] moved to archive.json: ${toArchive.length}`)
  }

  const removedIds = new Set([...toBlocked, ...toArchive].map(c => c.id))
  channels = channels.filter(c => !removedIds.has(c.id))
  data.channels = channels

  const candidates = channels.filter(c =>
    c.alive === true &&
    c.probe !== false &&
    !c.radio &&
    !c.ytId &&
    !isUnplayableDomain(c.streamUrls?.[0] || '') &&
    isDueForProbe(c.uptime)
  )
  const skipped  = channels.filter(c => c.alive === true && c.probe !== false && !c.radio && !c.ytId && !isUnplayableDomain(c.streamUrls?.[0] || '') && !isDueForProbe(c.uptime))

  console.log(`alive: ${channels.filter(c => c.alive).length}  due: ${candidates.length}  skipped: ${skipped.length}`)

  if (candidates.length === 0) return

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let passed = 0, failed = 0, flippedDead = 0, done = 0, geoBlockedFailed = 0
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

    const critical = isCriticalChannel(ch.id, urls[0] || '')
    let result = { alive: false, needsProxy: false, responseMs: 0 }
    let liveIndex = -1
    for (let i = 0; i < urls.length; i++) {
      const ref = meta[i]?.referrer  ?? ch.referrer
      const ua  = meta[i]?.userAgent ?? ch.userAgent
      const r   = critical ? await probeUrlThorough(urls[i], ref, ua) : await probeUrl(urls[i], ref, ua)
      if (r.alive && !r.browserUnplayable) { result = r; liveIndex = i; break }
      if (r.alive && liveIndex === -1)      { result = r; liveIndex = i }
      if (!r.alive && liveIndex === -1)     result = r
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
      if (entry.geoBlocked) {
        entry.uptime = { ...(entry.uptime || {}), lastProbed: new Date().toISOString(), consecutiveGeoFailures: (entry.uptime?.consecutiveGeoFailures || 0) + 1 }
        geoBlockedFailed++
        failed++
        if (done % 1000 === 0) checkpoint(data, channels, channelMap, OUTPUT_PATH, 'check-alive', done, total)
        return
      }

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

      console.log(`[fail] ${ch.id}  ${urls[0]}  reason=${reason}  ms=${result.responseMs}  ${result.rawError || ''}`)

      failed++
    }

    if (done % 1000 === 0) checkpoint(data, channels, channelMap, OUTPUT_PATH, 'check-alive', done, total)
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency)

  const allChannels = channels.map(c => channelMap.get(c.id) || c)
  const { retired, pruned } = applyRetirementAndPruning(allChannels)

  data.channels = allChannels
  saveChannels(data)

  console.log(`passed: ${passed}  failed: ${failed}  flipped: ${flippedDead}  geoBlocked: ${geoBlockedFailed}  skipped: ${skipped.length}`)
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
