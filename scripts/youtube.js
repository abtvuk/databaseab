const cfg  = require('../config')
const { runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar, saveFeedFormatted } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

function liveOembedUrlFor(ytId) {
  if (ytId.startsWith('UC')) return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/channel/${ytId}/live`)}&format=json`
  if (ytId.startsWith('@'))  return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/${ytId}/live`)}&format=json`
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`
}

function makePacer(minIntervalMs) {
  let next = 0
  return async function pace() {
    const now  = Date.now()
    const wait = Math.max(0, next - now)
    next = Math.max(now, next) + minIntervalMs
    if (wait) await new Promise(r => setTimeout(r, wait))
  }
}

const pace = makePacer(cfg.probe.youtubePaceMs || 120)

async function fetchWithRetry(url, opts, retries) {
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal })
      clearTimeout(t)
      if (res.status === 429 && i < retries) {
        const retryAfter = parseInt(res.headers.get('retry-after'), 10)
        const backoffMs  = Number.isFinite(retryAfter) ? retryAfter * 1000 : (500 * Math.pow(2, i) + Math.random() * 250)
        await new Promise(r => setTimeout(r, backoffMs))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(t)
      if (i === retries) throw err
      await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)))
    }
  }
}

async function probeYtId(ytId) {
  await pace()
  const url  = liveOembedUrlFor(ytId)
  const opts = { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' }
  const start = Date.now()

  try {
    let res = await fetchWithRetry(url, opts, 2)

    if (res.status === 401) {
      await new Promise(r => setTimeout(r, 20000))
      res = await fetchWithRetry(url, opts, 2)
    }

    const durationMs = Date.now() - start
    if (res.status === 200) return { outcome: 'alive',      status: 200, durationMs }
    if (res.status === 404) return { outcome: 'dead',       status: 404, durationMs }
    return                    { outcome: 'ambiguous', status: res.status, durationMs }
  } catch {
    return { outcome: 'ambiguous', status: 0, durationMs: Date.now() - start }
  }
}

function loadYoutube() {
  const raw = fs.readFileSync(path.resolve(cfg.output.youtube), 'utf8')
  return JSON.parse(raw)
}

function saveYoutube(channels) {
  const ytChannels = channels.filter(c => c.ytId)
  saveFeedFormatted(path.resolve(cfg.output.youtube), {
    generated: new Date().toISOString(),
    total: ytChannels.length,
    channels: ytChannels,
  })
}

async function main() {
  const data     = loadYoutube()
  const channels = data.channels || []
  const forceAll = process.env.FORCE_ALL === 'true'

  const candidates = channels.filter(c => c.ytId && c.probe !== false && (forceAll || isDueForProbe(c.uptime)))
  const skipped    = channels.filter(c => c.ytId && c.probe !== false && !forceAll && !isDueForProbe(c.uptime))

  console.log(`youtube: ${channels.filter(c => c.ytId).length}  due: ${candidates.length}  skipped: ${skipped.length}${forceAll ? '  (forced: all)' : ''}`)
  if (candidates.length === 0) return

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let done = 0
  const total = candidates.length
  const statusCounts = {}
  const results = []

  const tasks = candidates.map(ch => async () => {
    const result = await probeYtId(ch.ytId)
    done++
    progressBar(done, total)
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1
    results.push({ ch, result })
  })

  await runWithConcurrency(tasks, cfg.probe.youtubeConcurrency || 6, 2 * 60 * 60 * 1000)

  const attempted    = results.length
  const ambiguous    = results.filter(r => r.result.outcome === 'ambiguous').length
  const ambiguousRate = attempted ? ambiguous / attempted : 0
  const avgMsPerRequest = attempted ? results.reduce((s, r) => s + r.result.durationMs, 0) / attempted : 0

  const minMs = cfg.probe.youtubeMinMsPerRequest || 40
  const maxRate = cfg.probe.youtubeMaxAmbiguousRate || 0.15
  const trustNegatives = attempted < 20 || (avgMsPerRequest >= minMs && ambiguousRate <= maxRate)

  let passed = 0, markedDead = 0, skippedNegative = 0

  for (const { ch, result } of results) {
    const entry = channelMap.get(ch.id)
    if (!entry) continue

    if (result.outcome === 'alive') {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      passed++
    } else if (result.outcome === 'dead' && trustNegatives) {
      entry.uptime = recordDead(entry.uptime)
      entry.alive  = false
      markedDead++
    } else {
      skippedNegative++
    }
  }

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveYoutube(data.channels)

  console.log(`alive: ${passed}  dead: ${markedDead}  deferred: ${skippedNegative}`)
  console.log(`sanity: avgMs=${avgMsPerRequest.toFixed(1)}  ambiguousRate=${(ambiguousRate * 100).toFixed(1)}%  trustNegatives=${trustNegatives}`)
  if (!trustNegatives) console.log(`::warning::suspected systemic failure (rate limit/block) - all negative results this run were discarded, will retry next cycle`)
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    const label = status === '0' ? 'timeout' : status
    console.log(`  ${label.padEnd(7)}  ${count}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
