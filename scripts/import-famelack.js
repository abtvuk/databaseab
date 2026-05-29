// scripts/import-famelack.js
// ─────────────────────────────────────────────────────────────────────────────
//  One-time import from famelack-data repo.
//
//  What it does:
//    1. Reads famelack tv/raw/categories/all.json
//       - Skips channels already in your DB (matched by name, case-insensitive)
//       - Imports unique HLS channels as tv: true, source: 'famelack'
//       - Imports YouTube-only channels as tv: true, source: 'famelack', ytId set
//    2. Reads famelack radio/raw/categories/all.json
//       - Imports ALL radio stations (you have none — full import)
//       - Sets radio: true, tv: false, source: 'famelack'
//    3. Adds new fields to ALL existing channels:
//       - geoBlocked: false (default — famelack channels get real value)
//       - source: 'iptv' for iptv-org channels, 'famelack' for famelack ones,
//                 null for your hand-curated YouTube channels
//
//  DELETE this file after running it once.
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')

// ── Config ────────────────────────────────────────────────────────────────────
// Point these at your local famelack-data repo clone/extract
const FAMELACK_TV    = path.resolve('famelack-data/tv/raw/categories/all.json')
const FAMELACK_RADIO = path.resolve('famelack-data/radio/raw/categories/all.json')

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadChannels() {
  const raw = fs.readFileSync(path.resolve(cfg.output.channels), 'utf8')
  return JSON.parse(raw)
}

function saveChannels(data) {
  fs.writeFileSync(
    path.resolve(cfg.output.channels),
    JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  )
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

// Extract video ID from famelack's youtube-nocookie embed URLs
// e.g. https://www.youtube-nocookie.com/embed/HxEcfPpyLMA → HxEcfPpyLMA
function extractYtId(url) {
  const m = url.match(/\/embed\/([A-Za-z0-9_-]{10,12})/)
  return m ? m[1] : null
}

function mediaFlags(categories) {
  const cats = (categories || []).map(c => c.toLowerCase())
  const radio = cats.includes('radio')
  return { tv: !radio, radio }
}

// Generate a deterministic ID for famelack channels that have no iptv-org ID.
// Format: <slug>.<countrycode>  e.g. "bbcnews.uk"
// Falls back to nanoid if name can't be slugified cleanly.
function generateId(name, country) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')   // strip non-alphanumeric
    .slice(0, 20)
  const cc = (country || 'xx').toLowerCase()
  return slug ? `${slug}.${cc}` : `famelack-${cc}`
}

// ── Step 1: Backfill new fields on ALL existing channels ──────────────────────

function backfillExisting(channels) {
  return channels.map(ch => {
    const updated = { ...ch }

    // geoBlocked — default false; famelack channels get set in import step
    if (!('geoBlocked' in updated)) updated.geoBlocked = false

    // source — if it already has a real iptv-org id (contains a dot and
    // matches iptv-org pattern like "BBCOne.uk"), mark as iptv.
    // YouTube-curated channels (have ytId but no streamUrls from iptv) → null.
    if (!('source' in updated)) {
      if (updated.ytId && !(updated.streamUrls || []).length) {
        updated.source = null  // hand-curated YouTube
      } else {
        updated.source = 'iptv'
      }
    }

    return updated
  })
}

// ── Step 2: Import famelack TV channels ──────────────────────────────────────

function importFamelackTV(channels, famelackTV) {
  const existingNames = new Map(channels.map(c => [c.name.toLowerCase().trim(), c]))
  const existingIds   = new Set(channels.map(c => c.id))

  let addedHLS = 0, addedYT = 0, skipped = 0

  for (const fc of famelackTV) {
    const nameLower = (fc.name || '').toLowerCase().trim()
    if (!nameLower) { skipped++; continue }

    // Skip if we already have this channel by name
    if (existingNames.has(nameLower)) { skipped++; continue }

    const country    = (fc.country || '').toUpperCase()
    const languages  = (fc.languages || []).map(l => l.toLowerCase()).filter(Boolean)
    const geoBlocked = !!fc.isGeoBlocked

    const hasHLS = (fc.stream_urls || []).length > 0
    const hasYT  = (fc.youtube_urls || []).length > 0

    if (!hasHLS && !hasYT) { skipped++; continue }

    // Generate a unique ID
    let id = generateId(fc.name, fc.country)
    let suffix = 1
    while (existingIds.has(id)) { id = `${generateId(fc.name, fc.country)}${suffix++}` }
    existingIds.add(id)

    if (hasHLS) {
      channels.push({
        id,
        name:        fc.name,
        editName:    true,
        alive:       true,   // famelack already validated these
        probe:       true,
        tv:          true,
        radio:       false,
        country,
        channelLogo: null,
        languages,
        categories:  [],
        streamUrls:  fc.stream_urls || [],
        ytId:        null,
        website:     null,
        replaced_by: null,
        geoBlocked,
        source:      'famelack',
        nanoid:      fc.nanoid || null,
        uptime:      emptyUptime(),
      })
      existingNames.set(nameLower, true)
      addedHLS++
    } else if (hasYT) {
      // YouTube embed → extract video ID
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
        geoBlocked,
        source:      'famelack',
        nanoid:      fc.nanoid || null,
        uptime:      emptyUptime(),
      })
      existingNames.set(nameLower, true)
      addedYT++
    }
  }

  console.log(`  TV HLS added:      ${addedHLS}`)
  console.log(`  TV YouTube added:  ${addedYT}`)
  console.log(`  TV skipped:        ${skipped} (already in DB or no URL)`)
  return channels
}

// ── Step 3: Import famelack radio stations ────────────────────────────────────

function importFamelackRadio(channels, famelackRadio) {
  const existingIds = new Set(channels.map(c => c.id))
  let added = 0, skipped = 0

  for (const fr of famelackRadio) {
    if (!fr.name || !(fr.stream_urls || []).length) { skipped++; continue }

    const country   = (fr.country || '').toUpperCase()
    const languages = (fr.languages || []).map(l => l.toLowerCase()).filter(Boolean)

    let id = generateId(fr.name, fr.country)
    // Prefix radio IDs to avoid collision with TV channel slugs
    id = `r-${id}`
    let suffix = 1
    while (existingIds.has(id)) { id = `r-${generateId(fr.name, fr.country)}${suffix++}` }
    existingIds.add(id)

    channels.push({
      id,
      name:        fr.name,
      editName:    true,
      alive:       true,   // famelack validated
      probe:       true,
      tv:          false,
      radio:       true,
      country,
      channelLogo: null,
      languages,
      categories:  ['radio'],
      streamUrls:  fr.stream_urls || [],
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
  console.log(`  Radio skipped: ${skipped} (no URL or name)`)
  return channels
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
  console.log('  databaseab — import-famelack.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // Load famelack data
  let famelackTV, famelackRadio
  try {
    famelackTV    = JSON.parse(fs.readFileSync(FAMELACK_TV,    'utf8'))
    famelackRadio = JSON.parse(fs.readFileSync(FAMELACK_RADIO, 'utf8'))
  } catch (err) {
    console.error(`  ✗ Could not read famelack data: ${err.message}`)
    console.error(`  Make sure famelack-data/ folder is in your repo root.`)
    process.exit(1)
  }

  console.log(`  Famelack TV channels:    ${famelackTV.length}`)
  console.log(`  Famelack radio stations: ${famelackRadio.length}`)

  // Load our channels
  const data = loadChannels()
  let channels = data.channels || []
  console.log(`  Our current channels:    ${channels.length}\n`)

  // Step 1: backfill new fields on existing channels
  console.log('── [1/3] Backfilling new fields on existing channels ──')
  channels = backfillExisting(channels)

  // Step 2: import famelack TV
  console.log('\n── [2/3] Importing famelack TV channels ──')
  channels = importFamelackTV(channels, famelackTV)

  // Step 3: import famelack radio
  console.log('\n── [3/3] Importing famelack radio stations ──')
  channels = importFamelackRadio(channels, famelackRadio)

  // Sort and save
  const sorted = sortChannels(channels)
  data.channels = sorted
  data.total    = sorted.length
  saveChannels(data)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  DONE  ${sorted.length} total channels → ${cfg.output.channels}`)
  console.log('\n  New fields added to all channels:')
  console.log('    geoBlocked: true/false')
  console.log('    source:     "iptv" | "famelack" | null')
  console.log('    nanoid:     famelack nanoid (famelack channels only)')
  console.log('\n  Delete this file after running — it is a one-time import.')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
