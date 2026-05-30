// scripts/sync.js
// ─────────────────────────────────────────────────────────────────────────────
//  Weekly sync from iptv-org + famelack.
//
//  What it does:
//    1. Fetches iptv-org channels, streams, logos, blocklist
//    2. Fetches famelack TV + radio from GitHub
//    3. Syncs iptv-org channels (mirror fields, add new ones)
//    4. Merges famelack TV channels (unique ones not already in DB by name)
//    5. Merges famelack radio stations (full import, radio: true)
//    6. Merges your curated YouTube list
//    7. Writes single unified channels.json
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

// ── Build stream URL map from iptv-org streams.json ──────────────────────────

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

// ── Generate a unique ID for famelack channels (no iptv-org ID exists) ────────
// Format: <slug>.<countrycode>  e.g. "bbcnews.uk"

function generateId(name, country, existingIds) {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20)
  const cc = (country || 'xx').toLowerCase()
  let id = slug ? `${slug}.${cc}` : `famelack.${cc}`
  let suffix = 1
  while (existingIds.has(id)) { id = `${slug}${suffix++}.${cc}` }
  return id
}

// ── Extract YouTube video ID from famelack embed URLs ─────────────────────────
// e.g. https://www.youtube-nocookie.com/embed/HxEcfPpyLMA → HxEcfPpyLMA

function extractYtId(url) {
  const m = (url || '').match(/\/embed\/([A-Za-z0-9_-]{10,12})/)
  return m ? m[1] : null
}

// ── New iptv-org channel entry ────────────────────────────────────────────────

function newIptvEntry(c, streamMap, logoMap) {
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
    channelLogo: c.logo || logoMap[c.id] || null,
    languages:   [],
    categories:  c.categories  || [],
    streamUrls:  (streamMap[c.id] || []).map(s => s.url),
    referrer:    streamMap[c.id]?.[0]?.referrer  || null,
    userAgent:   streamMap[c.id]?.[0]?.userAgent || null,
    needsProxy:  !!(streamMap[c.id]?.[0]?.referrer || streamMap[c.id]?.[0]?.userAgent),
    ytId:        null,
    website:     c.website     || null,
    replaced_by: c.replaced_by || null,
    geoBlocked:  false,
    source:      'iptv',
    nanoid:      null,
    uptime:      emptyUptime(),
  }
}

// ── Mirror iptv-org fields onto an existing channel ───────────────────────────

function mirrorIptvFields(existing, iptvCh, streamMap, logoMap) {
  const ch = { ...existing }

  if (ch.editName !== false) ch.name = iptvCh.name

  ch.channelLogo = iptvCh.logo || logoMap[iptvCh.id] || existing.channelLogo || null
  delete ch.logo   // remove old field name if present
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

  // Backfill new fields on existing channels that predate them
  if (!('geoBlocked' in ch)) ch.geoBlocked = false
  if (!('source'     in ch)) ch.source      = 'iptv'
  if (!('nanoid'     in ch)) ch.nanoid      = null
  if (!('languages'  in ch)) ch.languages   = []

  return ch
}

// ── Merge famelack TV channels ────────────────────────────────────────────────

function mergeFamelackTV(channels, famelackTV) {
  const byName     = new Map(channels.map(c => [c.name.toLowerCase().trim(), true]))
  const existingIds = new Set(channels.map(c => c.id))

  let addedHLS = 0, addedYT = 0, skipped = 0

  for (const fc of famelackTV) {
    const nameLower = (fc.name || '').toLowerCase().trim()
    if (!nameLower || isNameBlocked(fc.name)) { skipped++; continue }
    if (byName.has(nameLower))                { skipped++; continue }

    const hasHLS = (fc.stream_urls   || []).length > 0
    const hasYT  = (fc.youtube_urls  || []).length > 0
    if (!hasHLS && !hasYT) { skipped++; continue }

    const country   = (fc.country || '').toUpperCase()
    const languages = (fc.languages || []).map(l => l.toLowerCase()).filter(Boolean)
    const id        = generateId(fc.name, fc.country, existingIds)
    existingIds.add(id)
    byName.set(nameLower, true)

    if (hasHLS) {
      channels.push({
        id,
        name:        fc.name,
        editName:    true,
        alive:       true,   // famelack already validated
        probe:       true,
        tv:          true,
        radio:       false,
        country,
        channelLogo: null,
        languages,
        categories:  [],
        streamUrls:  fc.stream_urls,
        ytId:        null,
        website:     null,
        replaced_by: null,
        geoBlocked:  !!fc.isGeoBlocked,
        source:      'famelack',
        nanoid:      fc.nanoid || null,
        uptime:      emptyUptime(),
      })
      addedHLS++
    } else {
      const ytId = extractYtId(fc.youtube_urls[0])
      if (!ytId) { skipped++; continue }
      channels.push({
        id,
        name:        fc.name,
        editName:    true,
        alive:       true,
        probe:       true,
        tv:          true,
        radio:       false,
        country,
        channelLogo: null,
        languages,
        categories:  ['youtube'],
        streamUrls:  [],
        ytId,
        website:     null,
        replaced_by: null,
        geoBlocked:  !!fc.isGeoBlocked,
        source:      'famelack',
        nanoid:      fc.nanoid || null,
        uptime:      emptyUptime(),
      })
      addedYT++
    }
  }

  console.log(`  TV HLS added:     ${addedHLS}`)
  console.log(`  TV YouTube added: ${addedYT}`)
  console.log(`  TV skipped:       ${skipped} (already in DB, no URL, or blocked)`)
  return channels
}

// ── Merge famelack radio stations ─────────────────────────────────────────────

function mergeFamelackRadio(channels, famelackRadio) {
  const existingIds = new Set(channels.map(c => c.id))
  let added = 0, skipped = 0

  for (const fr of famelackRadio) {
    if (!fr.name || !(fr.stream_urls || []).length) { skipped++; continue }
    if (isNameBlocked(fr.name)) { skipped++; continue }

    const country   = (fr.country || '').toUpperCase()
    const languages = (fr.languages || []).map(l => l.toLowerCase()).filter(Boolean)
    let id = `r-${generateId(fr.name, fr.country, existingIds)}`
    // generateId already handles uniqueness but we passed existingIds above
    existingIds.add(id)

    channels.push({
      id,
      name:        fr.name,
      editName:    true,
      alive:       true,
      probe:       true,
      tv:          false,
      radio:       true,
      country,
      channelLogo: null,
      languages,
      categories:  ['radio'],
      streamUrls:  fr.stream_urls,
      ytId:        null,
      website:     null,
      replaced_by: null,
      geoBlocked:  !!fr.isGeoBlocked,
      source:      'famelack',
      nanoid:      fr.nanoid || null,
      uptime:      emptyUptime(),
    })
    added++
  }

  console.log(`  Radio added:   ${added}`)
  console.log(`  Radio skipped: ${skipped}`)
  return channels
}

// ── Merge curated YouTube list ────────────────────────────────────────────────

function mergeYouTubeList(channels, logoMap) {
  if (!cfg.sources.youtube) return channels

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
    if (!yt.id || !yt.ytId || !yt.name) { skippedCount++; continue }
    if (isNameBlocked(yt.name))          { skippedCount++; continue }

    const country    = yt.country ? yt.country.toUpperCase() : ''
    const languages  = (yt.languages || []).map(l => l.toLowerCase()).filter(Boolean)
    const categories = [...new Set([...(yt.categories || []).filter(Boolean), 'youtube'])]
    const { tv, radio } = mediaFlags(categories)
    const channelLogo = yt.logo || logoMap[yt.id] || null

    if (!channelMap.has(yt.id)) {
      channelMap.set(yt.id, {
        id:          yt.id,
        name:        yt.name,
        editName:    yt.editName ?? cfg.sync.defaults.editName,
        alive:       yt.alive   ?? cfg.sync.defaults.alive,
        probe:       yt.probe   ?? cfg.sync.defaults.probe,
        tv,
        radio,
        country,
        channelLogo,
        languages,
        categories,
        streamUrls:  [],
        ytId:        yt.ytId,
        website:     yt.website || null,
        replaced_by: null,
        geoBlocked:  false,
        source:      null,   // hand-curated
        nanoid:      null,
        uptime:      emptyUptime(),
      })
      added++
    } else {
      const existing = channelMap.get(yt.id)
      const entry = { ...existing }
      if (existing.editName !== false) entry.name = yt.name
      entry.ytId        = yt.ytId
      entry.country     = country     || existing.country     || ''
      entry.languages   = languages.length ? languages : (existing.languages || [])
      entry.channelLogo = channelLogo || existing.channelLogo || null
      delete entry.logo
      entry.categories  = categories.length ? categories : (existing.categories || [])
      entry.tv    = tv
      entry.radio = radio
      if (yt.website) entry.website = yt.website
      if (!('geoBlocked' in entry)) entry.geoBlocked = false
      if (!('source'     in entry)) entry.source     = null
      if (!('nanoid'     in entry)) entry.nanoid     = null
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

  console.log(`  YouTube: ${added} added, ${updated} updated, ${skippedCount} skipped`)
  return Array.from(channelMap.values())
}

// ── Deduplicate YouTube channels — famelack wins over hand-curated ────────────
// If two entries share the same ytId, keep the famelack one.
// Also removes entries with no ytId from this pool (shouldn't happen, safety net).

function deduplicateYouTube(channels) {
  const nonYt  = channels.filter(c => !c.ytId)
  const ytChs  = channels.filter(c => c.ytId)

  const byYtId = new Map()
  for (const ch of ytChs) {
    const existing = byYtId.get(ch.ytId)
    if (!existing) {
      byYtId.set(ch.ytId, ch)
    } else {
      // famelack beats hand-curated (source: null); otherwise keep first seen
      if (existing.source !== 'famelack' && ch.source === 'famelack') {
        byYtId.set(ch.ytId, ch)
      }
    }
  }

  const deduped   = Array.from(byYtId.values())
  const removed   = ytChs.length - deduped.length
  console.log(`  YouTube dedup: ${deduped.length} kept, ${removed} duplicates removed`)
  return [...nonYt, ...deduped]
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

  // ── 1. Fetch all sources in parallel ───────────────────────────────────────
  console.log('── [1/5] Fetching all sources ──')
  const t1 = Date.now()

  let iptvChannels, streams, blocklist, logos, famelackTV, famelackRadio

  try {
    ;[iptvChannels, streams, blocklist, logos, famelackTV, famelackRadio] = await Promise.all([
      fetchJSON(cfg.sources.iptvChannels),
      fetchJSON(cfg.sources.iptvStreams),
      fetchJSON(cfg.sources.iptvBlocklist).catch(() => []),
      fetchJSON(cfg.sources.iptvLogos).catch(() => []),
      fetchJSON(cfg.sources.famelackTV).catch(() => { console.warn('  ⚠ famelack TV fetch failed'); return [] }),
      fetchJSON(cfg.sources.famelackRadio).catch(() => { console.warn('  ⚠ famelack radio fetch failed'); return [] }),
    ])
  } catch (err) {
    console.error(`  ✗ Fetch failed: ${err.message}`)
    process.exit(1)
  }

  console.log(`  iptv-org channels: ${iptvChannels.length}`)
  console.log(`  iptv-org streams:  ${streams.length}`)
  console.log(`  iptv-org logos:    ${logos.length}`)
  console.log(`  famelack TV:       ${famelackTV.length}`)
  console.log(`  famelack radio:    ${famelackRadio.length}`)
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

  // ── 2. Sync iptv-org channels ───────────────────────────────────────────────
  console.log('\n── [2/5] Syncing iptv-org channels ──')
  const existing    = loadChannels()
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

  // ── 3. Merge famelack TV ────────────────────────────────────────────────────
  console.log('\n── [3/5] Merging famelack TV channels ──')
  synced = mergeFamelackTV(synced, famelackTV)

  // ── 4. Merge famelack radio ─────────────────────────────────────────────────
  console.log('\n── [4/5] Merging famelack radio stations ──')
  synced = mergeFamelackRadio(synced, famelackRadio)

  // ── 5. Merge curated YouTube list ───────────────────────────────────────────
  console.log('\n── [5/5] Merging YouTube list ──')
  synced = mergeYouTubeList(synced, logoMap)
  console.log('\n── Deduplicating YouTube channels ──')
  synced = deduplicateYouTube(synced)

  // ── Write ───────────────────────────────────────────────────────────────────
  const sorted = sortChannels(synced)
  saveChannels(sorted)

  const tvCount    = sorted.filter(c => c.tv && !c.radio).length
  const radioCount = sorted.filter(c => c.radio).length
  const ytCount    = sorted.filter(c => c.ytId).length

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  DONE  ${sorted.length} total → ${cfg.output.channels}`)
  console.log(`  TV: ${tvCount}  |  Radio: ${radioCount}  |  YouTube: ${ytCount}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
