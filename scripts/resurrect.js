const cfg  = require('../config')
const path = require('path')
const fs   = require('fs')
const { probeUrl, probeUrlThorough, isCriticalChannel, runWithConcurrency, recordAlive, recordDead, isDueForResurrect,
        checkpoint, progressBar, applyRetirementAndPruning, classifyFailSource,
        recordLinkResult, pruneChannelLinks, saveDeadLinks,
        isNameBlocked, isManualBlocked, stripUnplayableLinks } = require('./probe')

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
  const data     = loadChannels()
  const channels = data.channels || []

  const dead = channels.filter(c => c.alive === false && c.probe !== false && !c.ytId && !c.radio)

  const candidates = dead
    .filter(c => isDueForResurrect(c.uptime))
    .sort((a, b) => (b.uptime?.score ?? -1) - (a.uptime?.score ?? -1))

  const throttled = dead.length - candidates.length

  console.log(`dead: ${dead.length}  throttled: ${throttled}  candidates: ${candidates.length}`)

  if (candidates.length === 0) return

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let resurrected = 0, stillDead = 0, done = 0
  const total = candidates.length
  const failureCounts   = {}
  const failureBySource = { stream: 0, runner: 0, unknown: 0 }
  const removedLinks    = []

  const tasks = candidates.map(ch => async () => {
    if (isNameBlocked(ch.name) || isManualBlocked(ch.id)) {
      done++
      progressBar(done, total)
      return
    }

    const { keepUrls, keepMeta, blocked } = stripUnplayableLinks(ch)
    if (blocked.length) {
      ch.streamUrls = keepUrls
      ch.streamMeta = keepMeta
      ch.domainBlockedLinks = [...(ch.domainBlockedLinks || []), ...blocked]
    }

    const urls = ch.streamUrls || []
    const meta = ch.streamMeta || []
    if (!urls.length) {
      const entry = channelMap.get(ch.id)
      if (entry) entry.uptime = recordDead(entry.uptime)
      done++
      progressBar(done, total)
      return
    }

    let result = { alive: false, needsProxy: false, responseMs: 0 }
    let liveIndex = -1
    let foundGood = false
    for (let i = 0; i < urls.length; i++) {
      const ref = meta[i]?.referrer  ?? ch.referrer
      const ua  = meta[i]?.userAgent ?? ch.userAgent
      const critical = isCriticalChannel(ch.id, urls[i])
      const r   = critical ? await probeUrlThorough(urls[i], ref, ua) : await probeUrl(urls[i], ref, ua)
      meta[i] = recordLinkResult(meta[i] || {}, r.alive)
      if (foundGood) continue
      if (r.alive && !r.browserUnplayable) { result = r; liveIndex = i; foundGood = true; continue }
      if (r.alive && liveIndex === -1)      { result = r; liveIndex = i }
      if (!r.alive && liveIndex === -1)     result = r
    }

    done++
    progressBar(done, total)
    if (done % CHECKPOINT_EVERY === 0) checkpoint(data, channels, channelMap, OUTPUT_PATH, 'resurrect', done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    entry.streamMeta = meta

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
      const slow = result.responseMs > (cfg.probe.slowThresholdMs || 8000)
      if (slow) entry.slow = true
      else delete entry.slow
      resurrected++
    } else {
      entry.uptime = recordDead(entry.uptime)
      const reason = result.failReason || 'other'
      failureCounts[reason] = (failureCounts[reason] || 0) + 1
      const source = classifyFailSource(reason)
      failureBySource[source] = (failureBySource[source] || 0) + 1
      console.log(`[fail] ${ch.id}  ${urls[0]}  reason=${reason}  ms=${result.responseMs}  ${result.rawError || ''}`)
      stillDead++
    }

    pruneChannelLinks(entry, removedLinks)
  })

  await runWithConcurrency(tasks, cfg.probe.concurrency, 2 * 60 * 60 * 1000)

  saveDeadLinks(removedLinks)
  if (removedLinks.length) console.log(`links removed: ${removedLinks.length}`)

  const allChannels = channels.map(c => channelMap.get(c.id) || c)
  const { retired, pruned } = applyRetirementAndPruning(allChannels)

  data.channels = allChannels
  saveChannels(data)

  console.log(`resurrected: ${resurrected}  still dead: ${stillDead}  throttled: ${throttled}`)
  if (retired) console.log(`archived: ${retired}`)
  if (pruned)  console.log(`pruned: ${pruned}`)

  if (stillDead > 0) {
    const sorted = Object.entries(failureCounts).sort((a, b) => b[1] - a[1])
    for (const [reason, count] of sorted) {
      console.log(`  ${reason.padEnd(12)} ${String(count).padStart(5)}  (${((count / stillDead) * 100).toFixed(1)}%)`)
    }
    console.log(`  stream: ${failureBySource.stream}  runner: ${failureBySource.runner}  unknown: ${failureBySource.unknown}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
