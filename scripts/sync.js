const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')
const { loadFeed, saveFeed, saveDeadLinks, saveFeedFormatted } = require('./probe')

let deadLinkSet = null
function isDeadLink(channelId, url) {
  if (!deadLinkSet) {
    const dead = loadFeed(cfg.output.deadLinks)
    deadLinkSet = new Set((dead.channels || []).map(l => `${l.channelId}|${l.url}`))
  }
  return deadLinkSet.has(`${channelId}|${url}`)
}

const UA = 'abtv-sync/1.0'

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Fetch failed ${url}: ${res.status}`)
  return res.json()
}

function loadChannels() {
  try {
    const raw = fs.readFileSync(path.resolve(cfg.output.channels), 'utf8')
    return JSON.parse(raw).channels || []
  } catch {
    return []
  }
}

function saveChannels(channels) {
  saveFeedFormatted(path.resolve(cfg.output.channels), {
    generated: new Date().toISOString(),
    total: channels.length,
    channels,
  })
}

function isNameBlocked(name) {
  if (!name) return false
  const lc = name.toLowerCase()
  return (cfg.nameBlocklist || []).some(b => lc.includes(b.toLowerCase()))
}

function emptyUptime() {
  return {
    aliveCount:       0,
    totalCount:       0,
    consecutiveAlive: 0,
    lastSeen:         null,
    lastProbed:       null,
    score:            null,
  }
}

function buildStreamMap(streams, blockedIds) {
  const map = {}
  for (const s of streams) {
    if (!s.channel) continue
    if (blockedIds.has(s.channel)) continue
    if (!map[s.channel]) map[s.channel] = []
    if (map[s.channel].length >= 3) continue
    map[s.channel].push({
      url:       s.url,
      referrer:  s.http_referrer || null,
      userAgent: s.user_agent    || null,
    })
  }
  return map
}

function buildLogoMap(logos) {
  const map = {}
  for (const l of logos) {
    if (l.channel && l.url && !map[l.channel]) map[l.channel] = l.url
  }
  return map
}

function mediaFlags(categories) {
  const cats = (categories || []).map(c => c.toLowerCase())
  const radio = cats.includes('radio')
  return { tv: !radio, radio }
}

function newIptvEntry(c, streamMap, logoMap) {
  const { tv, radio } = mediaFlags(c.categories)
  const streams = streamMap[c.id] || []
  return {
    id:              c.id,
    name:            c.name,
    editName:        cfg.sync.defaults.editName,
    alive:           cfg.sync.defaults.alive,
    probe:           cfg.sync.defaults.probe,
    tv,
    radio,
    country:         c.country     || '',
    editCountry:     cfg.sync.defaults.editCountry,
    channelLogo:     c.logo || logoMap[c.id] || null,
    editChannelLogo: true,
    languages:       [],
    categories:      c.categories  || [],
    streamUrls:      streams.map(s => s.url),
    ...(streams.some(s => s.referrer || s.userAgent) ? { streamMeta: streams.map(s => ({ referrer: s.referrer || null, userAgent: s.userAgent || null })) } : {}),
    referrer:        streams[0]?.referrer  || null,
    userAgent:       streams[0]?.userAgent || null,
    needsProxy:      false,
    ytId:            null,
    website:         c.website     || null,
    replaced_by:     c.replaced_by || null,
    geoBlocked:      false,
    hide:            false,
    source:          'iptv',
    nanoid:          null,
    uptime:          emptyUptime(),
  }
}

function mirrorIptvFields(existing, iptvCh, streamMap, logoMap) {
  const ch = { ...existing }

  if (ch.editName !== false) ch.name = iptvCh.name

  if (ch.editChannelLogo !== false) {
    ch.channelLogo = iptvCh.logo || logoMap[iptvCh.id] || existing.channelLogo || null
  }
  delete ch.logo
  if (!('editChannelLogo' in ch)) ch.editChannelLogo = true

  const streams  = streamMap[iptvCh.id] || []
  const existingUrls = existing.streamUrls || []
  const newUrls  = streams
    .map(s => s.url)
    .filter(u => !existingUrls.includes(u) && !isDeadLink(iptvCh.id, u))
  ch.streamUrls  = [...existingUrls, ...newUrls]
  const existingMeta    = existing.streamMeta || []
  const existingMetaMap = Object.fromEntries(existingUrls.map((u, i) => [u, existingMeta[i] || {}]))
  const metaByUrl       = Object.fromEntries(streams.map(s => [s.url, { source: 'iptv', referrer: s.referrer || null, userAgent: s.userAgent || null }]))
  const rawMeta         = ch.streamUrls.map(u => ({ ...(existingMetaMap[u] || {}), ...(metaByUrl[u] || {}) }))
  if (rawMeta.some(m => m.referrer || m.userAgent || m.source)) ch.streamMeta = rawMeta
  else delete ch.streamMeta
  ch.referrer    = streams[0]?.referrer  || existing.referrer  || null
  ch.userAgent   = streams[0]?.userAgent || existing.userAgent || null
  ch.needsProxy  = existing.needsProxy || false
  if (ch.editCountry !== false) ch.country = iptvCh.country || existing.country || ''
  if (!existing.categories?.length) ch.categories = iptvCh.categories || []
  ch.website     = iptvCh.website     || existing.website     || null
  ch.replaced_by = iptvCh.replaced_by || existing.replaced_by || null

  const { tv, radio } = mediaFlags(ch.categories)
  ch.tv    = tv
  ch.radio = radio

  if (!('geoBlocked'      in ch)) ch.geoBlocked      = false
  if (!('hide'            in ch)) ch.hide            = false
  if (!('source'          in ch)) ch.source           = 'iptv'
  if (!('nanoid'          in ch)) ch.nanoid           = null
  if (!('languages'       in ch)) ch.languages        = []
  if (!('referrer'        in ch)) ch.referrer         = null
  if (!('userAgent'       in ch)) ch.userAgent        = null
  if (!('needsProxy'      in ch)) ch.needsProxy       = false
  if (!('editChannelLogo' in ch)) ch.editChannelLogo  = true
  if (!('editCountry'     in ch)) ch.editCountry      = true

  return ch
}

function saveYoutube() {
  let ytChannels = []
  try {
    const raw = fs.readFileSync(path.resolve(cfg.output.youtube), 'utf8')
    ytChannels = JSON.parse(raw).channels || []
  } catch { return 0 }

  const clean = ytChannels.map(c => ({
    id:          c.id,
    name:        c.name,
    country:     c.country     || '',
    languages:   c.languages   || [],
    categories:  c.categories  || [],
    channelLogo: c.channelLogo || null,
    ytId:        c.ytId,
    alive:       c.alive       ?? false,
    probe:       c.probe       ?? true,
    uptime:      c.uptime      || emptyUptime(),
  }))

  const out = path.resolve(cfg.output.youtube)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString(),
    total: clean.length,
    channels: clean,
  }, null, 2))
  return clean.length
}

function sortChannels(channels) {
  return channels.slice().sort((a, b) => {
    if (a.country && !b.country) return -1
    if (!a.country && b.country) return 1
    if (a.country !== b.country) return a.country.localeCompare(b.country)
    return a.name.localeCompare(b.name)
  })
}

async function main() {
  const t1 = Date.now()

  let iptvChannels, streams, blocklist, logos

  try {
    ;[iptvChannels, streams, blocklist, logos] = await Promise.all([
      fetchJSON(cfg.sources.iptvChannels),
      fetchJSON(cfg.sources.iptvStreams),
      fetchJSON(cfg.sources.iptvBlocklist).catch(() => []),
      fetchJSON(cfg.sources.iptvLogos).catch(() => []),
    ])
  } catch (err) {
    console.error(`fetch failed: ${err.message}`)
    process.exit(1)
  }

  console.log(`fetched: ${iptvChannels.length} channels  ${streams.length} streams  ${logos.length} logos  (${Date.now() - t1}ms)`)

  const blockedIds = new Set(blocklist.filter(b => b.reason === 'nsfw').map(b => b.channel))
  const nsfwIds    = new Set(iptvChannels.filter(c => c.is_nsfw).map(c => c.id))
  const manualIds  = new Set(cfg.manualBlocklist || [])
  const allBlocked = new Set([...blockedIds, ...nsfwIds, ...manualIds])

  const streamMap = buildStreamMap(streams, allBlocked)
  const logoMap   = buildLogoMap(logos)

  const iptvMap = new Map(
    iptvChannels
      .filter(c => c.id && c.name && !allBlocked.has(c.id) && !isNameBlocked(c.name))
      .map(c => [c.id, c])
  )

  const existing    = loadChannels().filter(c => !c.radio && !c.ytId)
  const existingMap = new Map(existing.map(c => [c.id, c]))
  let iptvMirrored  = 0, iptvAdded = 0, iptvRevived = 0

  let synced = existing.map(ch => {
    const iptvCh = iptvMap.get(ch.id)
    if (!iptvCh) return ch
    iptvMirrored++
    return mirrorIptvFields(ch, iptvCh, streamMap, logoMap)
  })

  const deadFeed     = loadFeed(cfg.pruning.output || cfg.output.dead)
  const revivedIds   = new Set()
  const blacklistNow = []

  for (const deadCh of deadFeed.channels || []) {
    if (existingMap.has(deadCh.id)) continue
    const iptvCh = iptvMap.get(deadCh.id)
    if (!iptvCh) continue
    const streams = streamMap[deadCh.id] || []
    if (!streams.length) continue

    const oldUrls   = new Set(deadCh.streamUrls || [])
    const freshOnly = streams.filter(s => !oldUrls.has(s.url) && !isDeadLink(deadCh.id, s.url))
    if (!freshOnly.length) continue

    for (const u of (deadCh.streamUrls || [])) {
      blacklistNow.push({ channelId: deadCh.id, url: u, removedAt: new Date().toISOString() })
    }

    const revived = newIptvEntry(iptvCh, { [deadCh.id]: freshOnly }, logoMap)
    synced.push(revived)
    revivedIds.add(deadCh.id)
    iptvRevived++
  }

  if (revivedIds.size) {
    saveFeed(cfg.pruning.output || cfg.output.dead, (deadFeed.channels || []).filter(c => !revivedIds.has(c.id)))
  }
  saveDeadLinks(blacklistNow)

  for (const [id, iptvCh] of iptvMap) {
    if (existingMap.has(id) || revivedIds.has(id)) continue
    if (!streamMap[id]?.length) continue
    synced.push(newIptvEntry(iptvCh, streamMap, logoMap))
    iptvAdded++
  }

  console.log(`mirrored: ${iptvMirrored}  added: ${iptvAdded}  revived: ${iptvRevived}`)

  const sorted  = sortChannels(synced)
  saveChannels(sorted)

  console.log(`done: ${sorted.length} TV channels`)
}

main().catch(err => { console.error(err); process.exit(1) })
