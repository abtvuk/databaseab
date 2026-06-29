const cfg  = require('../config')
const { runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

function watchUrlFor(ytId) {
  if (ytId.startsWith('UC')) return `https://www.youtube.com/channel/${ytId}/live`
  if (ytId.startsWith('@'))  return `https://www.youtube.com/${ytId}/live`
  return `https://www.youtube.com/watch?v=${ytId}`
}

// Pulls ytInitialPlayerResponse out of the page and reads videoDetails.isLive
// from it specifically. Scanning the raw HTML for "isLiveNow"/live-badge
// markers anywhere on the page is unreliable: watch/channel pages also embed
// sidebar "recommended" videos, and if any of those happen to be live, the
// marker shows up on the page even though the channel/video being probed
// isn't streaming at all. That's what was causing dead channels to pass.
function extractPlayerResponse(html) {
  const marker = '"playerResponse":'
  let idx = html.indexOf('ytInitialPlayerResponse')
  if (idx === -1) idx = html.indexOf(marker)
  if (idx === -1) return null

  const braceStart = html.indexOf('{', idx)
  if (braceStart === -1) return null

  let depth = 0
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) {
        const jsonStr = html.slice(braceStart, i + 1)
        try { return JSON.parse(jsonStr) } catch { return null }
      }
    }
  }
  return null
}

async function probeYtId(ytId) {
  const url = watchUrlFor(ytId)

  try {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res  = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    })
    clearTimeout(t)

    if (res.status === 404) return { alive: false, status: 404 }
    if (res.status !== 200) return { alive: null, status: res.status }

    const html = await res.text()

    // Channel/handle /live with nothing currently streaming redirects to
    // the channel home/videos tab, not a watch page - no player response.
    if ((ytId.startsWith('UC') || ytId.startsWith('@')) && !/"videoId":"/.test(html)) {
      return { alive: false, status: 200 }
    }

    const player = extractPlayerResponse(html)
    if (!player) return { alive: null, status: res.status }

    const status = player.playabilityStatus?.status
    // Explicit unavailable/error states ("This channel doesn't have a live
    // stream", deleted/private video, etc.) - always dead, regardless of
    // anything else on the page.
    if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
      return { alive: false, status: res.status }
    }

    const details  = player.videoDetails || {}
    const isLiveNow =
      details.isLive === true ||
      player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow === true

    return { alive: !!isLiveNow, status: res.status }
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
  const out = path.resolve(cfg.output.youtube)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString(),
    total: ytChannels.length,
    channels: ytChannels,
  }, null, 2))
}

async function main() {
  const data     = loadYoutube()
  const channels = data.channels || []

  const candidates = channels.filter(c => c.ytId && c.probe !== false && isDueForProbe(c.uptime))
  const skipped    = channels.filter(c => c.ytId && c.probe !== false && !isDueForProbe(c.uptime))

  console.log(`youtube: ${channels.filter(c => c.ytId).length}  due: ${candidates.length}  skipped: ${skipped.length}`)

  if (candidates.length === 0) return

  const channelMap = new Map(channels.map(c => [c.id, c]))
  let passed = 0, failed = 0, timedOut = 0, done = 0
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
      if (result.alive === null) timedOut++
      entry.uptime = recordDead(entry.uptime)
      const failures = entry.uptime?.consecutiveFailures || 0
      if (failures >= 3) {
        entry.alive = false
        failed++
      }
    }
  })

  await runWithConcurrency(tasks, cfg.probe.youtubeConcurrency || 6)

  data.channels = channels.map(c => channelMap.get(c.id) || c)
  saveYoutube(data.channels)

  console.log(`alive: ${passed}  dead: ${failed}  timedOut: ${timedOut}`)
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    const label = status === '0' ? 'timeout' : status
    console.log(`  ${label.padEnd(7)}  ${count}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
