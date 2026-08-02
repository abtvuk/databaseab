const cfg  = require('../config')
const { runWithConcurrency, recordAlive, isDueForProbe, progressBar, saveFeedFormatted } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

function liveOembedUrlFor(ytId) {
  if (ytId.startsWith('UC')) return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/channel/${ytId}/live`)}&format=json`
  if (ytId.startsWith('@'))  return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/${ytId}/live`)}&format=json`
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`
}

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
  const url = liveOembedUrlFor(ytId)
  const opts = { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' }

  try {
    let res = await fetchWithRetry(url, opts, 2)

    if (res.status === 401) {
      await new Promise(r => setTimeout(r, 20000))
      res = await fetchWithRetry(url, opts, 2)
    }

    if (res.status === 200) return { alive: true,  status: 200 }
    if (res.status === 401) return { alive: false, status: 401 }
    if (res.status === 404) return { alive: false, status: 404 }
    return { alive: null, status: res.status }
  } catch {
    return { alive: null, status: 0 }
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
  let passed = 0, unconfirmed = 0, done = 0
  const total = candidates.length
  const statusCounts = {}

  const tasks = candidates.map(ch => async () => {
    const result = await probeYtId(ch.ytId)
    done++
    progressBar(done, total)
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive === true) {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      passed++
    } else {
      unconfirmed++
    }
  })

  await runWithConcurrency(tasks, cfg.probe.youtubeConcurrency || 6, 2 * 60 * 60 * 1000)

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveYoutube(data.channels)

  console.log(`alive: ${passed}  unconfirmed: ${unconfirmed}`)
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    const label = status === '0' ? 'timeout' : status
    console.log(`  ${label.padEnd(7)}  ${count}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
