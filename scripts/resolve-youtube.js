// scripts/resolve-youtube.js
// ─────────────────────────────────────────────────────────────────────────────
//  ONE-TIME script. Run once, then delete.
//
//  What it does:
//    1. Finds all hand-curated YouTube channels (source: null, ytId: UC...)
//    2. Batch-validates them via channels.list (cheap — 1 unit per 50 channels)
//       • Deletes channels whose ID doesn't exist on YouTube
//    3. Searches for each surviving channel's active livestream via search.list
//       • Deletes channels that have never streamed live
//       • Deletes channels with no current active stream
//       • Updates ytId to the live stream video ID for channels that are live
//    4. Deduplicates all YouTube channels by ytId — famelack wins over hand-curated
//    5. Writes the cleaned channels.json
//
//  Quota cost (YouTube Data API v3 — 10,000 units/day default):
//    Step 2: ~ceil(N/50) units  (batch channels.list, 1 unit per page)
//    Step 3: ~N * 100 units     (search.list, 100 units each — expensive)
//
//  ⚠ With 273 channels step 3 costs ~27,300 units — exceeds daily quota.
//    The script automatically splits step 3 across days using a progress file
//    (resolve-progress.json). Run it daily until complete.
//    Alternatively, request a quota increase in Google Cloud Console.
//
//  Usage:
//    YOUTUBE_API_KEY=your_key node scripts/resolve-youtube.js
// ─────────────────────────────────────────────────────────────────────────────

const cfg      = require('../config')
const fs       = require('fs')
const path     = require('path')

const API_KEY        = process.env.YOUTUBE_API_KEY
const PROGRESS_FILE  = path.resolve('resolve-progress.json')
const CHANNELS_FILE  = path.resolve(cfg.output.channels)

// Daily quota budget for search.list (100 units each).
// Default quota is 10,000/day. Keep headroom for other operations.
const SEARCH_BUDGET  = 80   // max search.list calls per run (~8,000 units)

if (!API_KEY) {
  console.error('  ✗ Set YOUTUBE_API_KEY environment variable first.')
  process.exit(1)
}

const UA = 'abtv-resolve/1.0'

// ── API helpers ───────────────────────────────────────────────────────────────

async function ytGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`)
  url.searchParams.set('key', API_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { 'User-Agent': UA } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`YouTube API ${endpoint} ${res.status}: ${err?.error?.message || res.statusText}`)
  }
  return res.json()
}

// ── Load / save channels ──────────────────────────────────────────────────────

function loadData() {
  const raw = fs.readFileSync(CHANNELS_FILE, 'utf8')
  return JSON.parse(raw)
}

function saveData(data) {
  fs.writeFileSync(
    CHANNELS_FILE,
    JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  )
}

// ── Progress file — survives across daily runs ────────────────────────────────

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) }
  catch { return { validatedIds: null, resolvedIds: {}, deletedIds: [] } }
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2))
}

// ── Step 1: Validate channel IDs via channels.list (batch, cheap) ─────────────

async function validateChannelIds(channelIds) {
  const valid   = new Set()
  const batches = []
  for (let i = 0; i < channelIds.length; i += 50) {
    batches.push(channelIds.slice(i, i + 50))
  }

  console.log(`  Validating ${channelIds.length} channel IDs in ${batches.length} batch(es)...`)

  for (const batch of batches) {
    const data = await ytGet('channels', {
      part: 'id',
      id:   batch.join(','),
      maxResults: 50,
    })
    for (const item of (data.items || [])) valid.add(item.id)
    await sleep(300)
  }

  return valid
}

// ── Step 2: Find active livestream for a channel via search.list ──────────────
// Returns video ID string if live now, null otherwise.

async function findLiveStream(channelId) {
  try {
    const data = await ytGet('search', {
      part:             'id',
      channelId,
      type:             'video',
      eventType:        'live',
      maxResults:       1,
    })
    const item = (data.items || [])[0]
    return item?.id?.videoId || null
  } catch (err) {
    console.warn(`    ⚠ search failed for ${channelId}: ${err.message}`)
    return null
  }
}

// ── Dedup all YouTube channels — famelack wins ────────────────────────────────

function deduplicateYouTube(channels) {
  const nonYt = channels.filter(c => !c.ytId)
  const yt    = channels.filter(c => c.ytId)

  const byYtId = new Map()
  for (const ch of yt) {
    const existing = byYtId.get(ch.ytId)
    if (!existing) {
      byYtId.set(ch.ytId, ch)
    } else {
      // famelack beats hand-curated (source: null)
      if (existing.source !== 'famelack' && ch.source === 'famelack') {
        byYtId.set(ch.ytId, ch)
      }
    }
  }

  const kept    = Array.from(byYtId.values())
  const removed = yt.length - kept.length
  return { channels: [...nonYt, ...kept], removed }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  databaseab — resolve-youtube.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const data     = loadData()
  const channels = data.channels || []
  const progress = loadProgress()

  // Target: hand-curated channels with UC... channel IDs (source: null, ytId starts with UC)
  const targets  = channels.filter(c =>
    c.ytId &&
    c.source === null &&
    c.ytId.startsWith('UC') &&
    c.ytId.length === 24
  )

  console.log(`  Hand-curated UC channels found: ${targets.length}`)

  // ── STEP 1: Validate channel IDs (run once, cached in progress file) ─────────
  let validIds
  if (progress.validatedIds) {
    validIds = new Set(progress.validatedIds)
    console.log(`  Step 1 already done. ${validIds.size} valid channels (cached).`)
  } else {
    console.log('\n── Step 1: Validating channel IDs ──')
    const allIds = targets.map(c => c.ytId)
    validIds     = await validateChannelIds(allIds)
    const invalid = allIds.filter(id => !validIds.has(id))

    console.log(`  Valid:   ${validIds.size}`)
    console.log(`  Invalid: ${invalid.length} (will be deleted)`)

    progress.validatedIds = Array.from(validIds)
    progress.deletedIds   = [...(progress.deletedIds || []), ...invalid]
    saveProgress(progress)
  }

  // ── STEP 2: Find live streams (quota-limited, resumes across runs) ───────────
  console.log('\n── Step 2: Finding active livestreams ──')

  const toSearch = targets.filter(c =>
    validIds.has(c.ytId) &&
    !(c.ytId in progress.resolvedIds)
  )

  console.log(`  Remaining to search: ${toSearch.length}`)
  console.log(`  Budget this run:     ${SEARCH_BUDGET} searches`)

  const thisBatch = toSearch.slice(0, SEARCH_BUDGET)
  let searchDone  = 0

  for (const ch of thisBatch) {
    const videoId = await findLiveStream(ch.ytId)
    searchDone++

    if (videoId) {
      progress.resolvedIds[ch.ytId] = videoId
      console.log(`  ✓ [${searchDone}/${thisBatch.length}] ${ch.name} → ${videoId}`)
    } else {
      progress.resolvedIds[ch.ytId] = null  // null = no live stream → delete
      console.log(`  ✗ [${searchDone}/${thisBatch.length}] ${ch.name} → no live stream`)
    }

    // Save progress after each search in case of interruption
    saveProgress(progress)
    await sleep(200)
  }

  const remaining = toSearch.length - thisBatch.length
  if (remaining > 0) {
    console.log(`\n  ⚠ ${remaining} channels still need searching.`)
    console.log('  Run this script again tomorrow to continue (quota resets at midnight PT).')
    console.log('  Progress is saved — it will resume where it left off.')
    return
  }

  // ── STEP 3: Apply results ────────────────────────────────────────────────────
  console.log('\n── Step 3: Applying results ──')

  const deletedIds = new Set([
    ...(progress.deletedIds || []),
    ...Object.entries(progress.resolvedIds).filter(([, v]) => v === null).map(([k]) => k),
  ])

  const resolvedMap = Object.fromEntries(
    Object.entries(progress.resolvedIds).filter(([, v]) => v !== null)
  )

  let deleted = 0, resolved = 0

  const updated = channels.map(ch => {
    if (!ch.ytId || ch.source !== null) return ch  // not a target — leave alone

    if (deletedIds.has(ch.ytId)) {
      deleted++
      return null  // mark for removal
    }

    if (resolvedMap[ch.ytId]) {
      resolved++
      return { ...ch, ytId: resolvedMap[ch.ytId], alive: true }
    }

    return ch
  }).filter(Boolean)

  console.log(`  Channels resolved (UC → video ID): ${resolved}`)
  console.log(`  Channels deleted (invalid/no stream): ${deleted}`)

  // ── STEP 4: Deduplicate by ytId — famelack wins ──────────────────────────────
  console.log('\n── Step 4: Deduplicating by ytId ──')
  const { channels: deduped, removed } = deduplicateYouTube(updated)
  console.log(`  Duplicates removed: ${removed}`)

  // Sort
  const sorted = deduped.slice().sort((a, b) => {
    if (a.country && !b.country) return -1
    if (!a.country && b.country) return 1
    if (a.country !== b.country) return a.country.localeCompare(b.country)
    return a.name.localeCompare(b.name)
  })

  data.channels = sorted
  data.total    = sorted.length
  saveData(data)

  // Clean up progress file
  fs.unlinkSync(PROGRESS_FILE)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  DONE  ${sorted.length} total channels`)
  console.log(`  YouTube channels resolved: ${resolved}`)
  console.log(`  YouTube channels deleted:  ${deleted + removed}`)
  console.log('\n  Delete this file — it is a one-time script.')
  console.log('  resolve-progress.json has been cleaned up automatically.')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
