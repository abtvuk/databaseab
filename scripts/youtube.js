const cfg  = require('../config')
const { runWithConcurrency, recordAlive, recordDead, isDueForProbe, progressBar } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS = (cfg.probe.timeoutSeconds || 10) * 1000
const UA = 'abtv-probe/1.0'

async function probeYtId(ytId) {
  let url

  const isVideoId = !ytId.startsWith('UC') && !ytId.startsWith('@')
  if (ytId.startsWith('UC')) {
    url = `https://www.youtube.com/channel/${ytId}`
  } else if (ytId.startsWith('@')) {
    url = `https://www.youtube.com/${ytId}`
  } else {
    url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`
  }

  try {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res  = await fetch(url, {
      method:  isVideoId ? 'GET' : 'HEAD',
      signal:  ctrl.signal,
      headers: { 'User-Agent': UA },
    })
    clearTimeout(t)
    return { alive: res.status === 200 }
  } catch {
    return { alive: null }
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

  const tasks = candidates.map(ch => async () => {
    const result = await probeYtId(ch.ytId)
    done++
    progressBar(done, total)

    const entry = channelMap.get(ch.id)
    if (!entry) return

    if (result.alive === true) {
      entry.uptime = recordAlive(entry.uptime)
      entry.alive  = true
      passed++
    } else {
      // result.alive is false (HTTP non-200) or null (timeout/network error).
      // Both must be treated as a failed probe so timeouts can't hide from
      // scoring and consecutiveFailures/retirement/pruning logic.
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
}

main().catch(err => { console.error(err); process.exit(1) })
