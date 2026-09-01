const cfg  = require('../config')
const { recordDead, runWithConcurrency, saveFeedFormatted, progressBar } = require('./probe')
const fs   = require('fs')
const path = require('path')

const TIMEOUT_MS    = (cfg.probe.timeoutSeconds || 12) * 1000
const INTERVAL_DAYS = cfg.profileCheck?.intervalDays || 14
const DAILY_UNIT_ALLOWANCE = cfg.profileCheck?.dailyUnitAllowance || 500
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function isChannelId(id)  { return /^UC[a-zA-Z0-9_-]{10,}$/.test(id) }
function isHandle(id)     { return id.startsWith('@') && id.length > 1 }
function looksLikeVideoId(id) { return /^[a-zA-Z0-9_-]{11}$/.test(id) }

function isDue(profileCheck, forceAll) {
  if (forceAll) return true
  if (!profileCheck?.lastChecked) return true
  const days = (Date.now() - new Date(profileCheck.lastChecked).getTime()) / 86400000
  return days >= INTERVAL_DAYS
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

const paceResolve = makePacer(cfg.profileCheck?.resolvePaceMs || 350)
const paceApi      = makePacer(cfg.profileCheck?.apiPaceMs || 150)

let unitsUsed = 0
let stopReason = null

function budgetOk() {
  return !stopReason && unitsUsed < DAILY_UNIT_ALLOWANCE
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function fetchApiJson(url) {
  if (!budgetOk()) return null
  unitsUsed++
  await paceApi()
  try {
    const res = await fetchWithTimeout(url)
    if (res.status === 403 || res.status === 429) { stopReason = 'api-error'; return null }
    if (!res.ok) return null
    return { items: (await res.json()).items || [] }
  } catch {
    return null
  }
}

async function resolveVanitySlug(slug) {
  if (looksLikeVideoId(slug)) return null

  const candidates = [
    `https://www.youtube.com/${slug}`,
    `https://www.youtube.com/c/${slug}`,
    `https://www.youtube.com/user/${slug}`,
  ]

  for (const url of candidates) {
    await paceResolve()
    try {
      const res = await fetchWithTimeout(url, {
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      })
      if (!res.ok) continue

      const finalUrl = res.url || url
      let m = finalUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]{10,})/)
      if (m) return m[1]
      m = finalUrl.match(/\/(@[a-zA-Z0-9._-]{2,})(?:[/?]|$)/)
      if (m) return m[1]

      const html = await res.text()
      m = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{10,})"/)
        || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{10,})"/)
      if (m) return m[1]
    } catch {}
  }
  return null
}

function bestThumb(item) {
  return item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.default?.url || null
}

async function fetchByIds(ids, apiKey) {
  const found = new Map()
  const queried = new Set()

  for (let i = 0; i < ids.length; i += 50) {
    if (!budgetOk()) break
    const batch = ids.slice(i, i + 50)
    const result = await fetchApiJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${batch.join(',')}&key=${apiKey}`)
    if (result === null) continue
    for (const item of result.items) found.set(item.id, bestThumb(item))
    for (const id of batch) queried.add(id)
  }
  return { found, queried }
}

async function fetchByHandle(handle, apiKey) {
  if (!budgetOk()) return { queried: false }
  const result = await fetchApiJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`)
  if (result === null) return { queried: false }
  const item = result.items[0]
  return { queried: true, avatar: item ? bestThumb(item) : undefined }
}

function loadYoutube() {
  return JSON.parse(fs.readFileSync(path.resolve(cfg.output.youtube), 'utf8'))
}

function saveYoutube(channels) {
  const ytChannels = channels.filter(c => c.ytId)
  saveFeedFormatted(path.resolve(cfg.output.youtube), {
    generated: new Date().toISOString(),
    total: ytChannels.length,
    channels: ytChannels,
  })
}

function applyFound(c, avatar, now) {
  if (avatar === undefined) {
    c.profileCheck = { valid: false, lastChecked: now }
    c.alive        = false
    c.uptime       = recordDead(c.uptime)
    return 'invalidated'
  }
  c.profileCheck = { valid: true, lastChecked: now }
  if (avatar && avatar !== c.channelLogo) {
    const kind = c.channelLogo ? 'updated' : 'filled'
    c.channelLogo = avatar
    return kind
  }
  return 'unchanged'
}

async function main() {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY
  if (!apiKey) { console.log('ytProfile: YOUTUBE_DATA_API_KEY not set, skipping'); return }

  const data     = loadYoutube()
  const channels = data.channels || []
  const forceAll = process.env.FORCE_ALL === 'true'

  const eligible = channels.filter(c => c.ytId && c.probeLogo !== false)
  const due      = eligible.filter(c => isDue(c.profileCheck, forceAll))

  console.log(`ytProfile: eligible=${eligible.length}  due=${due.length}  allowance=${DAILY_UNIT_ALLOWANCE}u`)
  if (due.length === 0) return

  const needsResolve = due.filter(c => !isChannelId(c.ytId) && !isHandle(c.ytId))
  let resolved = 0, unresolved = 0

  if (needsResolve.length) {
    let done = 0
    const tasks = needsResolve.map(c => async () => {
      const canonical = await resolveVanitySlug(c.ytId)
      if (canonical) { c.legacyYtId = c.ytId; c.ytId = canonical; resolved++ }
      else unresolved++
      progressBar(++done, needsResolve.length)
    })
    await runWithConcurrency(tasks, cfg.probe.resolveConcurrency || 5, 2 * 60 * 60 * 1000)
  }
  console.log(`resolve: ${'resolved'.padEnd(12)}${resolved}`)
  console.log(`resolve: ${'unresolved'.padEnd(12)}${unresolved}`)

  const now = new Date().toISOString()
  const channelIds = due.filter(c => isChannelId(c.ytId))
  const handles     = due.filter(c => isHandle(c.ytId))

  const tally = { filled: 0, updated: 0, unchanged: 0, invalidated: 0, deferred: 0 }

  if (channelIds.length) {
    const { found, queried } = await fetchByIds(channelIds.map(c => c.ytId), apiKey)
    for (const c of channelIds) {
      if (!queried.has(c.ytId)) { tally.deferred++; continue }
      tally[applyFound(c, found.get(c.ytId), now)]++
    }
  }

  if (handles.length) {
    let done = 0
    const tasks = handles.map(c => async () => {
      const { queried, avatar } = await fetchByHandle(c.ytId, apiKey)
      if (!queried) tally.deferred++
      else tally[applyFound(c, avatar, now)]++
      progressBar(++done, handles.length)
    })
    await runWithConcurrency(tasks, cfg.probe.profileConcurrency || 5, 2 * 60 * 60 * 1000)
  }

  saveYoutube(channels)

  for (const [label, count] of Object.entries(tally)) console.log(`profile: ${label.padEnd(12)}${count}`)
  console.log(`quota: used=${unitsUsed}u  allowance=${DAILY_UNIT_ALLOWANCE}u  remaining=${Math.max(0, DAILY_UNIT_ALLOWANCE - unitsUsed)}u${stopReason ? `  stopped(${stopReason})` : ''}`)
}

main().catch(err => { console.error(err); process.exit(1) })
