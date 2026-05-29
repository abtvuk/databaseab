// scripts/sync.js
// ─────────────────────────────────────────────────────────────────────────────
//  Weekly sync from iptv-org.
//
//  What it does:
//    1. Fetches channels.json + streams.json + logos.json from iptv-org
//    2. Adds brand-new channels (by ID) to your list with alive: false
//    3. Mirrors allowed fields on existing channels (name only if editName: true)
//    4. Merges your curated YouTube list (adds new entries, mirrors fields)
//    5. Writes the single unified channels.json
//
//  What it never does:
//    • Probe any stream URL
//    • Remove channels you already have
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

// ── Build a stream URL map from iptv-org streams.json ────────────────────────
// Keyed by channel id → array of stream URLs (up to 3, HLS first)

function buildStreamMap(streams, blockedIds) {
  const map = {}
  for (const s of streams) {
    if (!s.channel) continue
    if (blockedIds.has(s.channel)) continue
    if (!map[s.channel]) map[s.channel] = []
    if (map[s.channel].length >= 3) continue
    map[s.channel].push(s.url)
  }
  return map
}

// ── Build logo map from logos.json ───────────────────────────────────────────

function buildLogoMap(logos) {
  const map = {}
  for (const l of logos) {
    if (l.channel && l.url && !map[l.channel]) map[l.channel] = l.url
  }
  return map
}

// ── Determine radio/tv flags from categories ──────────────────────────────────

function mediaFlags(categories) {
  const cats = (categories || []).map(c => c.toLowerCase())
  const radio = cats.includes('radio')
  return { tv: !radio, radio }
}

// ── Build a new channel entry for a brand-new iptv-org channel ───────────────

function newChannelEntry(c, streamMap, logoMap) {
  const streamUrls = streamMap[c.id] || []
  const { tv, radio } = mediaFlags(c.categories)
  return {
    id:          c.id,
    name:        c.name,
    editName:    cfg.sync.defaults.editName,
    alive:       cfg.sync.defaults.alive,
    probe:       cfg.sync.defaults.probe,
    tv,
    radio,
    country:     c.country     || '',
    channelLogo:  c.logo || logoMap[c.id] || null,
    categories:  c.categories  || [],
    streamUrls,
    website:     c.website     || null,
    replaced_by: c.replaced_by || null,
    uptime: {
      aliveCount:       0,
      totalCount:       0,
      consecutiveAlive: 0,
      lastSeen:         null,
      lastProbed:       null,
      score:            null,
    },
  }
}

// ── Mirror allowed fields onto an existing channel entry ─────────────────────

function mirrorFields(existing, iptvChannel, streamMap, logoMap) {
  const mirrored = { ...existing }

  // Name — only if editName is not explicitly false
  if (existing.editName !== false) {
    mirrored.name = iptvChannel.name
  }

  // Always-mirrored fields
  mirrored.channelLogo = iptvChannel.logo || logoMap[iptvChannel.id] || existing.channelLogo || null
  mirrored.streamUrls  = streamMap[iptvChannel.id] || existing.streamUrls || []
  mirrored.country     = iptvChannel.country     || existing.country     || ''
  mirrored.categories  = iptvChannel.categories  || existing.categories  || []
  mirrored.website     = iptvChannel.website     || existing.website     || null
  mirrored.replaced_by = iptvChannel.replaced_by || existing.replaced_by || null

  // Re-derive tv/radio from updated categories
  const { tv, radio } = mediaFlags(mirrored.categories)
  mirrored.tv    = tv
  mirrored.radio = radio

  return mirrored
}

// ── Merge curated YouTube list ────────────────────────────────────────────────
// Every YouTube channel gets the full channel schema — same fields as iptv-org
// channels. Fields that don't apply (streamUrls, website, replaced_by) are set
// to safe empty values. country is uppercased. blank entries are skipped.

function mergeYouTubeList(channels, logoMap) {
  const channelMap = new Map(channels.map(c => [c.id, c]))

  let ytList = []
  try {
    ytList = JSON.parse(fs.readFileSync(path.resolve(cfg.sources.youtube), 'utf8'))
  } catch {
    console.warn('  ⚠ Could not load YouTube list — skipping.')
    return channels
  }

  let added = 0, updated = 0, skippedCount = 0

  for (const yt of ytList) {
    // Skip blank/incomplete entries
    if (!yt.id || !yt.ytId || !yt.name) { skippedCount++; continue }
    if (isNameBlocked(yt.name)) { skippedCount++; continue }

    const country   = yt.country ? yt.country.toUpperCase() : ''
    const languages = (yt.languages || []).map(l => l.toLowerCase()).filter(Boolean)
    const categories = [...new Set([...(yt.categories || []).filter(Boolean), 'youtube'])]
    const { tv, radio } = mediaFlags(categories)
    const channelLogo = yt.logo || logoMap[yt.id] || null

    if (!channelMap.has(yt.id)) {
      channelMap.set(yt.id, {
        id:          yt.id,
        name:        yt.name,
        editName:    yt.editName   ?? cfg.sync.defaults.editName,
        alive:       yt.alive      ?? cfg.sync.defaults.alive,
        probe:       yt.probe      ?? cfg.sync.defaults.probe,
        tv,
        radio,
        country,
        channelLogo,
        languages,
        categories,
        streamUrls:  [],
        ytId:        yt.ytId,
        website:     yt.website    || null,
        replaced_by: null,
        uptime: {
          aliveCount:       0,
          totalCount:       0,
          consecutiveAlive: 0,
          lastSeen:         null,
          lastProbed:       null,
          score:            null,
        },
      })
      added++
    } else {
      const existing = channelMap.get(yt.id)
      const entry = { ...existing }

      if (existing.editName !== false) entry.name = yt.name
      entry.ytId      = yt.ytId
      entry.country   = country   || existing.country   || ''
      entry.languages = languages.length ? languages : (existing.languages || [])
      entry.channelLogo = channelLogo || existing.channelLogo || null
      entry.categories = categories.length ? categories : (existing.categories || [])
      entry.tv    = tv
      entry.radio = radio
      if (yt.website) entry.website = yt.website

      // Ensure all uptime fields exist for older entries that might be missing them
      entry.uptime = {
        aliveCount:       existing.uptime?.aliveCount       ?? 0,
        totalCount:       existing.uptime?.totalCount       ?? 0,
        consecutiveAlive: existing.uptime?.consecutiveAlive ?? 0,
        lastSeen:         existing.uptime?.lastSeen         ?? null,
        lastProbed:       existing.uptime?.lastProbed       ?? null,
        score:            existing.uptime?.score            ?? null,
      }

      channelMap.set(yt.id, entry)
      updated++
    }
  }

  console.log(`  YouTube: ${added} added, ${updated} updated, ${skippedCount} skipped (blank/blocked)`)
  return Array.from(channelMap.values())
}


// ── Sort ──────────────────────────────────────────────────────────────────────
// Primary: country asc (blank last), secondary: name asc

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

  // ── 1. Fetch iptv-org ───────────────────────────────────────────────────────
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
    console.error(`  ✗ iptv-org fetch failed: ${err.message}`)
    process.exit(1)
  }

  console.log(`  channels:  ${iptvChannels.length}`)
  console.log(`  streams:   ${streams.length}`)
  console.log(`  logos:     ${logos.length}`)
  console.log(`  took ${Date.now() - t1} ms`)

  const blockedIds = new Set(blocklist.filter(b => b.reason === 'nsfw').map(b => b.channel))
  const nsfwIds    = new Set(iptvChannels.filter(c => c.is_nsfw).map(c => c.id))
  const allBlocked = new Set([...blockedIds, ...nsfwIds])

  const streamMap = buildStreamMap(streams, allBlocked)
  const logoMap   = buildLogoMap(logos)

  // Index iptv-org channels by id for fast lookup
  const iptvMap = new Map(
    iptvChannels
      .filter(c => c.id && c.name && !allBlocked.has(c.id) && !isNameBlocked(c.name))
      .map(c => [c.id, c])
  )

  // ── 2. Sync against your existing list ─────────────────────────────────────
  console.log('\n── [2/3] Syncing channel list ──')
  const existing = loadChannels()
  const existingMap = new Map(existing.map(c => [c.id, c]))

  let added = 0, mirrored = 0

  const synced = existing.map(ch => {
    const iptvCh = iptvMap.get(ch.id)
    if (!iptvCh) return ch // your channel, not in iptv-org — leave untouched
    mirrored++
    return mirrorFields(ch, iptvCh, streamMap, logoMap)
  })

  // Add brand-new iptv-org channels not yet in your list
  for (const [id, iptvCh] of iptvMap) {
    if (existingMap.has(id)) continue
    if (!streamMap[id]?.length) continue // skip channels with no streams at all
    synced.push(newChannelEntry(iptvCh, streamMap, logoMap))
    added++
  }

  console.log(`  Existing channels mirrored: ${mirrored}`)
  console.log(`  New channels added:         ${added}`)

  // ── 3. Merge YouTube list ───────────────────────────────────────────────────
  console.log('\n── [3/3] Merging YouTube list ──')
  const withYt = mergeYouTubeList(synced, logoMap)

  // ── Write ───────────────────────────────────────────────────────────────────
  const sorted = sortChannels(withYt)
  saveChannels(sorted)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  DONE  ${sorted.length} total channels → ${cfg.output.channels}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
