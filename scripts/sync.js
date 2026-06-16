// scripts/sync.js
// ─────────────────────────────────────────────────────────────────────────────
//  Weekly sync from iptv-org only.
//
//  What it does:
//    1. Fetches iptv-org channels, streams, logos, blocklist
//    2. Strips any radio entries from the existing DB (one-time cleanup)
//    3. Syncs iptv-org channels (mirror fields, add new ones)
//    4. Writes channels.json (TV only) + youtube.json (ytId channels only)
//
//  What it never does:
//    • Fetch or import from any external source other than iptv-org
//    • Add radio stations
//    • Probe any stream URL
//    • Remove TV channels you already have
//    • Touch alive, probe, uptime, or editName fields
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')

const UA = 'abtv-sync/1.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const out = path.resolve(cfg.output.channels)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString(),
    total: channels.length,
    channels,
  }, null, 2))
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

// ── Build stream map from iptv-org streams.json ───────────────────────────────
// Carries url, referrer, and userAgent per stream entry.

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

// ── Build logo map from iptv-org logos.json ───────────────────────────────────

function buildLogoMap(logos) {
  const map = {}
  for (const l of logos) {
    if (l.channel && l.url && !map[l.channel]) map[l.channel] = l.url
  }
  return map
}

// ── Derive tv/radio flags from categories ─────────────────────────────────────

function mediaFlags(categories) {
  const cats = (categories || []).map(c => c.toLowerCase())
  const radio = cats.includes('radio')
  return { tv: !radio, radio }
}

// ── New iptv-org channel entry ────────────────────────────────────────────────

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
    channelLogo:     c.logo || logoMap[c.id] || null,
    editChannelLogo: true,
    languages:       [],
    categories:      c.categories  || [],
    streamUrls:      streams.map(s => s.url),
    referrer:        streams[0]?.referrer  || null,
    userAgent:       streams[0]?.userAgent || null,
    needsProxy:      !!(streams[0]?.referrer || streams[0]?.userAgent),
    ytId:            null,
    website:         c.website     || null,
    replaced_by:     c.replaced_by || null,
    geoBlocked:      false,
    source:          'iptv',
    nanoid:          null,
    uptime:          emptyUptime(),
  }
}

// ── Mirror iptv-org fields onto an existing channel ───────────────────────────

function mirrorIptvFields(existing, iptvCh, streamMap, logoMap) {
  const ch = { ...existing }

  if (ch.editName !== false) ch.name = iptvCh.name

  if (ch.editChannelLogo !== false) {
    ch.channelLogo = iptvCh.logo || logoMap[iptvCh.id] || existing.channelLogo || null
  }
  delete ch.logo
  if (!('editChannelLogo' in ch)) ch.editChannelLogo = true

  const streams  = streamMap[iptvCh.id] || []
  ch.streamUrls  = streams.length ? streams.map(s => s.url) : existing.streamUrls || []
  ch.referrer    = streams[0]?.referrer  || existing.referrer  || null
  ch.userAgent   = streams[0]?.userAgent || existing.userAgent || null
  ch.needsProxy  = !!(ch.referrer || ch.userAgent)
  ch.country     = iptvCh.country     || existing.country     || ''
  ch.categories  = iptvCh.categories  || existing.categories  || []
  ch.website     = iptvCh.website     || existing.website     || null
  ch.replaced_by = iptvCh.replaced_by || existing.replaced_by || null

  const { tv, radio } = mediaFlags(ch.categories)
  ch.tv    = tv
  ch.radio = radio

  // Backfill fields on existing channels that predate them
  if (!('geoBlocked'      in ch)) ch.geoBlocked      = false
  if (!('source'          in ch)) ch.source           = 'iptv'
  if (!('nanoid'          in ch)) ch.nanoid           = null
  if (!('languages'       in ch)) ch.languages        = []
  if (!('referrer'        in ch)) ch.referrer         = null
  if (!('userAgent'       in ch)) ch.userAgent        = null
  if (!('needsProxy'      in ch)) ch.needsProxy       = false
  if (!('editChannelLogo' in ch)) ch.editChannelLogo  = true

  return ch
}

// ── Save youtube.json (ytId channels extracted from main list) ────────────────

function saveYoutube(channels) {
  const ytChannels = channels.filter(c => c.ytId)
  const out = path.resolve(cfg.output.youtube)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString(),
    total: ytChannels.length,
    channels: ytChannels,
  }, null, 2))
  return ytChannels.length
}

// ── Sort ──────────────────────────────────────────────────────────────────────

function sortChannels(channels) {
  return channels.slice().sort((a, b) => {
    if (a.country && !b.country) return -1
    if (!a.country && b.country) return 1
    if (a.country !== b.country) return a.country.localeCompare(b.country)
    return a.name.localeCompare(b.name)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — sync.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // ── 1. Fetch iptv-org sources ───────────────────────────────────────────────
  console.log('── [1/3] Fetching iptv-org sources ──')
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
    console.error(`  ✗ Fetch failed: ${err.message}`)
    process.exit(1)
  }

  console.log(`  iptv-org channels: ${iptvChannels.length}`)
  console.log(`  iptv-org streams:  ${streams.length}`)
  console.log(`  iptv-org logos:    ${logos.length}`)
  console.log(`  took ${Date.now() - t1} ms`)

  const blockedIds = new Set(blocklist.filter(b => b.reason === 'nsfw').map(b => b.channel))
  const nsfwIds    = new Set(iptvChannels.filter(c => c.is_nsfw).map(c => c.id))
  const allBlocked = new Set([...blockedIds, ...nsfwIds])

  const streamMap = buildStreamMap(streams, allBlocked)
  const logoMap   = buildLogoMap(logos)

  const iptvMap = new Map(
    iptvChannels
      .filter(c => c.id && c.name && !allBlocked.has(c.id) && !isNameBlocked(c.name))
      .map(c => [c.id, c])
  )

  // ── 2. Strip radio + sync iptv-org channels ─────────────────────────────────
  console.log('\n── [2/3] Stripping radio, syncing iptv-org channels ──')
  const existing    = loadChannels().filter(c => !c.radio)  // drop all radio entries
  const existingMap = new Map(existing.map(c => [c.id, c]))
  let iptvMirrored  = 0, iptvAdded = 0

  let synced = existing.map(ch => {
    const iptvCh = iptvMap.get(ch.id)
    if (!iptvCh) return ch
    iptvMirrored++
    return mirrorIptvFields(ch, iptvCh, streamMap, logoMap)
  })

  for (const [id, iptvCh] of iptvMap) {
    if (existingMap.has(id)) continue
    if (!streamMap[id]?.length) continue
    synced.push(newIptvEntry(iptvCh, streamMap, logoMap))
    iptvAdded++
  }

  console.log(`  Mirrored: ${iptvMirrored}  |  Added: ${iptvAdded}`)

  // ── 3. Write channels.json + youtube.json ───────────────────────────────────
  console.log('\n── [3/3] Writing output files ──')
  const sorted  = sortChannels(synced)
  saveChannels(sorted)
  const ytCount = saveYoutube(sorted)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  DONE  ${sorted.length} TV channels → ${cfg.output.channels}`)
  console.log(`  YouTube: ${ytCount} channels → ${cfg.output.youtube}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
