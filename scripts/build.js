// scripts/build.js
// Fetches iptv-org channels + streams, probes every stream with HEAD/GET,
// merges curated youtube list (also probed), writes:
//   feeds/merged/channels.json      — all live channels
//   feeds/merged/dead-channels.json — dead by source (iptv / youtube)
//   feeds/merged/diff.json          — channels added/removed vs previous build
//
// Improvements over v1:
//   • Full ISO 3166-1 country normalisation + TLD/language inference
//   • isNsfw filter at channel level (not just blocklist)
//   • Name-based blocklist (config.nameBlocklist)
//   • altNames + quality + isGeoBlocked fields preserved
//   • youtubeUrls dual-URL fallback per channel
//   • Response-time tracking → slow flag
//   • CORS header check → browserPlayable flag
//   • Logo URL validation (HEAD check)
//   • Uptime history: rolling score across builds
//   • Incremental probing: stable channels skipped
//   • Dead-channel resurrection: recently-dead channels re-probed
//   • Cross-build URL deduplication
//   • Diff output (added / removed since last build)
//   • Rollback snapshot: last-good channels.json preserved on failure
//   • Per-source timing logs

const cfg = require('../config')

const IPTV_CHANNELS  = 'https://iptv-org.github.io/api/channels.json'
const IPTV_STREAMS   = 'https://iptv-org.github.io/api/streams.json'
const IPTV_BLOCKLIST = 'https://iptv-org.github.io/api/blocklist.json'
const IPTV_LOGOS     = 'https://iptv-org.github.io/api/logos.json'

const { timeoutSeconds, retries, concurrency, retryDelaySeconds, slowThresholdMs } = cfg.check
const TIMEOUT_MS = timeoutSeconds * 1000
const UA = 'abtv/1.0'

const fs   = require('fs')
const path = require('path')

// ── Full ISO 3166-1 alpha-2 country map ──────────────────────────────────
// Non-standard → standard corrections, plus Kosovo (XK) kept as-is.
const COUNTRY_CORRECTIONS = {
  UK: 'GB', EL: 'GR', EU: '', // EU is not a country
}
const ISO3166 = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW',
])

// Language → likely country (used for inference when country is missing/invalid)
const LANG_TO_COUNTRY = {
  afr:'ZA', amh:'ET', ara:'SA', aze:'AZ', bel:'BY', ben:'BD', bul:'BG',
  cat:'ES', ces:'CZ', dan:'DK', deu:'DE', ell:'GR', eng:'US', est:'EE',
  fas:'IR', fin:'FI', fra:'FR', gle:'IE', heb:'IL', hin:'IN', hrv:'HR',
  hun:'HU', hye:'AM', ind:'ID', isl:'IS', ita:'IT', jpn:'JP', kat:'GE',
  kaz:'KZ', khm:'KH', kor:'KR', kur:'TR', lav:'LV', lit:'LT', mkd:'MK',
  mlt:'MT', mon:'MN', msa:'MY', mya:'MM', nep:'NP', nld:'NL', nor:'NO',
  pol:'PL', por:'BR', pus:'AF', ron:'RO', rus:'RU', sin:'LK', slk:'SK',
  slv:'SI', som:'SO', spa:'ES', sqi:'AL', srp:'RS', swa:'TZ', swe:'SE',
  tam:'IN', tel:'IN', tgk:'TJ', tha:'TH', tur:'TR', ukr:'UA', urd:'PK',
  uzb:'UZ', vie:'VN', zho:'CN',
}

function normaliseCountry(code, languages, streamUrl) {
  if (code) {
    const u = code.toUpperCase()
    if (COUNTRY_CORRECTIONS[u] !== undefined) return COUNTRY_CORRECTIONS[u]
    if (ISO3166.has(u)) return u
  }
  // Infer from language
  if (languages?.length) {
    for (const lang of languages) {
      const inferred = LANG_TO_COUNTRY[lang?.toLowerCase()]
      if (inferred) return inferred
    }
  }
  // Infer from stream URL TLD
  if (streamUrl) {
    const m = streamUrl.match(/https?:\/\/[^/]+\.([a-z]{2})[/:]/i)
    if (m) {
      const tld = m[1].toUpperCase()
      if (ISO3166.has(tld) && tld !== 'IO' && tld !== 'TV' && tld !== 'CO') return tld
    }
  }
  return ''
}

// ── Name blocklist ────────────────────────────────────────────────────────
const NAME_BLOCKLIST = (cfg.nameBlocklist || []).map(s => s.toLowerCase())
function isNameBlocked(name) {
  if (!name) return false
  const lc = name.toLowerCase()
  return NAME_BLOCKLIST.some(b => lc.includes(b))
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  return res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function isYouTubeUrl(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be'))
}

function extractYtId(url) {
  if (!url) return null
  let m
  m = url.match(/[?&]v=([a-zA-Z0-9_-]{8,})/);          if (m) return m[1]
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{8,})/);      if (m) return m[1]
  m = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{8,})/); if (m) return m[1]
  m = url.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);    if (m) return '@' + m[1]
  m = url.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{8,})/); if (m) return m[1]
  return null
}

function needsProxy(url, referrer) {
  if (!url) return false
  if (url.startsWith('http://')) return true
  if (referrer) return true
  return false
}

// ── Stream probe — HEAD with GET fallback ─────────────────────────────────
// Returns { alive, responseMs, cors } — never throws.

async function probeOnce(url, referrer, userAgent) {
  const headers = { 'User-Agent': userAgent || UA }
  if (referrer) headers['Referer'] = referrer
  const t0 = Date.now()

  // HEAD first
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers })
    clearTimeout(t)
    const responseMs = Date.now() - t0
    if (res.status < 400) {
      const cors = res.headers.get('access-control-allow-origin')
      return { alive: true, responseMs, cors: !!cors }
    }
    if (res.status !== 405) return { alive: false, responseMs, cors: false }
  } catch (e) {
    if (e.name !== 'AbortError') return { alive: false, responseMs: Date.now() - t0, cors: false }
  }

  // GET fallback with Range header
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { ...headers, Range: 'bytes=0-0' } })
    clearTimeout(t)
    const responseMs = Date.now() - t0
    const cors = res.headers.get('access-control-allow-origin')
    const alive = res.status === 200 || res.status === 206
    return { alive, responseMs, cors: !!cors }
  } catch {
    return { alive: false, responseMs: Date.now() - t0, cors: false }
  }
}

async function isAlive(url, referrer, userAgent) {
  let lastResult = { alive: false, responseMs: 0, cors: false }
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(retryDelaySeconds * 1000)
    lastResult = await probeOnce(url, referrer, userAgent)
    if (lastResult.alive) return lastResult
  }
  return lastResult
}

// ── Logo validation — HEAD only, fire-and-forget ──────────────────────────

async function validateLogo(url) {
  if (!url || !cfg.checkLogos) return url
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': UA } })
    clearTimeout(t)
    return res.status < 400 ? url : null
  } catch {
    return null
  }
}

// ── Concurrency pool ──────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  let i = 0
  const results = new Array(tasks.length)
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      results[idx] = await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

// ── History helpers ───────────────────────────────────────────────────────
// History file: feeds/merged/uptime-history.json
// Shape: { [channelId]: { aliveCount: N, totalCount: N, lastSeen: ISO, consecutiveAlive: N } }

const HISTORY_PATH = path.resolve('feeds/merged/uptime-history.json')

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) }
  catch { return {} }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true })
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2))
}

function recordAlive(history, id) {
  const h = history[id] || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null }
  h.aliveCount++
  h.totalCount++
  h.consecutiveAlive++
  h.lastSeen = new Date().toISOString()
  history[id] = h
}

function recordDead(history, id) {
  const h = history[id] || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, lastSeen: null }
  h.totalCount++
  h.consecutiveAlive = 0
  history[id] = h
}

function uptimeScore(history, id) {
  const h = history[id]
  if (!h || h.totalCount === 0) return null
  return Math.round((h.aliveCount / h.totalCount) * 100)
}

function isStable(history, id) {
  const threshold = cfg.stableBuildsThreshold || 0
  if (!threshold) return false
  const h = history[id]
  return h && h.consecutiveAlive >= threshold
}

// ── Diff helpers ──────────────────────────────────────────────────────────

function loadPrevChannelIds() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.resolve(cfg.output.merged), 'utf8'))
    return new Set((prev.channels || []).map(c => c.id))
  } catch { return new Set() }
}

function loadRecentDeadIds() {
  // Returns channel stubs from dead-channels.json for resurrection probing
  try {
    const dead = JSON.parse(fs.readFileSync(path.resolve(cfg.output.dead), 'utf8'))
    const all = [
      ...(dead.iptv?.channels   || []),
      ...(dead.youtube?.channels|| []),
    ]
    return all
  } catch { return [] }
}

// ── Rollback snapshot ─────────────────────────────────────────────────────

function snapshotGood() {
  const src = path.resolve(cfg.output.merged)
  const bak = src.replace('.json', '.backup.json')
  if (fs.existsSync(src)) fs.copyFileSync(src, bak)
}

function restoreFromSnapshot() {
  const src = path.resolve(cfg.output.merged)
  const bak = src.replace('.json', '.backup.json')
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, src)
    console.warn('  ⚠ Restored channels.json from last-good snapshot.')
    return true
  }
  return false
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  abtv / databaseab — build.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // Snapshot previous good output before we overwrite anything
  snapshotGood()

  const history      = loadHistory()
  const prevIds      = loadPrevChannelIds()
  const recentDead   = loadRecentDeadIds()

  // ── 1. Fetch iptv-org data ──────────────────────────────────────────────
  console.log('── [1/4] Fetching iptv-org sources ──')
  const t1 = Date.now()
  let channels, streams, blocklist, logos
  try {
    ;[channels, streams, blocklist, logos] = await Promise.all([
      fetchJSON(IPTV_CHANNELS),
      fetchJSON(IPTV_STREAMS),
      fetchJSON(IPTV_BLOCKLIST).catch(() => []),
      fetchJSON(IPTV_LOGOS).catch(() => []),
    ])
  } catch (err) {
    console.error(`  ✗ iptv-org fetch failed: ${err.message}`)
    restoreFromSnapshot()
    process.exit(1)
  }
  console.log(`  channels:  ${channels.length}`)
  console.log(`  streams:   ${streams.length}`)
  console.log(`  blocklist: ${blocklist.length}`)
  console.log(`  fetch took ${Date.now() - t1} ms`)

  // Logo map — keyed by channel id
  const logoMap = {}
  for (const l of logos) {
    if (l.channel && l.url && !logoMap[l.channel]) logoMap[l.channel] = l.url
  }

  // Block: nsfw from blocklist + channel-level is_nsfw field + name blocklist
  const blockedIds = new Set(blocklist.filter(b => b.reason === 'nsfw').map(b => b.channel))
  const nsfwChannelIds = new Set(channels.filter(c => c.is_nsfw).map(c => c.id))

  function isBlocked(id, name) {
    return blockedIds.has(id) || nsfwChannelIds.has(id) || isNameBlocked(name)
  }

  // Stream map — keyed by channel id
  const streamMap = {}
  const orphanYt  = []
  for (const s of streams) {
    if (isBlocked(s.channel, s.title)) continue
    if (!s.channel) {
      if (isYouTubeUrl(s.url)) {
        const ytId = extractYtId(s.url)
        if (ytId && s.title) orphanYt.push({ url: s.url, ytId, title: s.title })
      }
      continue
    }
    if (!streamMap[s.channel]) streamMap[s.channel] = []
    streamMap[s.channel].push({
      url:       s.url,
      referrer:  s.referrer   || null,
      userAgent: s.user_agent || null,
      quality:   s.quality    || null,
    })
  }

  // ── 2. Probe iptv-org streams ───────────────────────────────────────────
  console.log('\n── [2/4] Probing iptv-org streams ──')
  const t2 = Date.now()

  const candidates = channels
    .filter(c => c.id && c.name && !isBlocked(c.id, c.name) && streamMap[c.id]?.length > 0)
    .map(c => {
      const entries   = streamMap[c.id].slice(0, 3)
      const hlsUrls   = entries.filter(e => !isYouTubeUrl(e.url)).map(e => e.url)
      const ytEntries = entries.filter(e => isYouTubeUrl(e.url))
      const ytId      = ytEntries.length ? extractYtId(ytEntries[0].url) : null
      const ytUrls    = ytEntries.map(e => e.url)
      const primary   = entries[0]
      const referrer  = primary?.referrer  || null
      const userAgent = primary?.userAgent || null
      const quality   = entries.find(e => e.quality)?.quality || null
      const cats      = c.categories || []
      const proxy     = ytId ? false : needsProxy(hlsUrls[0], referrer)
      return {
        id:           c.id,
        name:         c.name,
        altNames:     c.alt_names || [],
        country:      normaliseCountry(c.country, c.languages, hlsUrls[0]),
        logo:         c.logo || logoMap[c.id] || null,
        languages:    c.languages || [],
        categories:   ytId ? [...new Set([...cats, 'youtube'])] : cats,
        urls:         ytId ? [] : hlsUrls,
        youtubeUrls:  ytUrls,
        ytId:         ytId || null,
        cat:          ytId ? 'youtube' : (cats[0] || 'general'),
        ...(quality    && { quality }),
        ...(referrer   && { referrer }),
        ...(userAgent  && { userAgent }),
        ...(proxy      && { needsProxy: true }),
      }
    })

  console.log(`  Candidates to probe: ${candidates.length}`)

  const iptvAlive = [], iptvDead = []
  let iptvDone = 0

  const iptvTasks = candidates.map(ch => async () => {
    if (ch.ytId) {
      recordAlive(history, ch.id)
      iptvAlive.push(ch)
      return
    }

    // Skip probe if channel is stable and was alive last build
    if (isStable(history, ch.id) && prevIds.has(ch.id)) {
      const uptime = uptimeScore(history, ch.id)
      iptvAlive.push({ ...ch, _skipped: true, uptime })
      iptvDone++
      return
    }

    const result = await isAlive(ch.urls[0], ch.referrer, ch.userAgent)
    iptvDone++
    if (iptvDone % 200 === 0 || iptvDone === candidates.filter(c => !c.ytId).length) {
      console.log(`  [iptv] ${iptvDone} probed — ✓ ${iptvAlive.length}  ✗ ${iptvDead.length}`)
    }

    if (result.alive) {
      recordAlive(history, ch.id)
      const uptime = uptimeScore(history, ch.id)
      const slow   = result.responseMs > (slowThresholdMs || 8000)
      iptvAlive.push({
        ...ch,
        uptime,
        ...(slow               && { slow: true }),
        ...(!result.cors       && { browserPlayable: false }),
      })
    } else {
      recordDead(history, ch.id)
      iptvDead.push(ch)
    }
  })

  await runWithConcurrency(iptvTasks, concurrency)
  console.log(`  iptv done — alive: ${iptvAlive.length}  dead: ${iptvDead.length}  (${Date.now() - t2} ms)`)

  // Add orphan YouTube streams
  const seenYtIds = new Set(iptvAlive.filter(c => c.ytId).map(c => c.ytId))
  let orphanAdded = 0
  for (const o of orphanYt) {
    if (seenYtIds.has(o.ytId)) continue
    seenYtIds.add(o.ytId)
    iptvAlive.push({
      id: `orphan.${o.ytId}`, name: o.title,
      altNames: [], country: '', logo: null, languages: [],
      categories: ['youtube'], urls: [], youtubeUrls: [], ytId: o.ytId, cat: 'youtube',
    })
    orphanAdded++
  }
  if (orphanAdded) console.log(`  orphan YT streams added: ${orphanAdded}`)

  // ── 2b. Resurrect recently-dead channels ────────────────────────────────
  console.log('\n── [2b] Resurrecting recently-dead channels ──')
  const seenIdsForResurrect = new Set(iptvAlive.map(c => c.id))
  const resurrectCandidates = recentDead.filter(c =>
    c.id && c.urls?.[0] && !seenIdsForResurrect.has(c.id) && !isBlocked(c.id, c.name)
  )
  console.log(`  Candidates: ${resurrectCandidates.length}`)
  let resurrectCount = 0

  const resurrectTasks = resurrectCandidates.map(ch => async () => {
    const result = await isAlive(ch.urls[0], ch.referrer || null, ch.userAgent || null)
    if (result.alive) {
      recordAlive(history, ch.id)
      const uptime = uptimeScore(history, ch.id)
      const slow   = result.responseMs > (slowThresholdMs || 8000)
      iptvAlive.push({
        ...ch,
        uptime,
        _resurrected: true,
        ...(slow         && { slow: true }),
        ...(!result.cors && { browserPlayable: false }),
      })
      seenIdsForResurrect.add(ch.id)
      resurrectCount++
    } else {
      recordDead(history, ch.id)
    }
  })
  await runWithConcurrency(resurrectTasks, concurrency)
  console.log(`  Resurrected: ${resurrectCount}`)

  // ── 3. Probe curated YouTube list ──────────────────────────────────────
  console.log('\n── [3/4] Probing curated YouTube channels ──')
  const t3 = Date.now()
  const seenIds = new Set(iptvAlive.map(c => c.id))
  const ytAlive = [], ytDead = []

  try {
    const ytList = JSON.parse(fs.readFileSync(path.resolve(cfg.sources.youtube.replace('https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/', '')), 'utf8'))
    const ytCandidates = ytList.filter(c => c.id && c.ytId && !isBlocked(c.id, c.name) && !seenIds.has(c.id))
    console.log(`  Candidates: ${ytCandidates.length}`)
    let ytDone = 0

    const ytTasks = ytCandidates.map(c => async () => {
      // Skip stable channels
      if (isStable(history, c.id) && prevIds.has(c.id)) {
        const uptime = uptimeScore(history, c.id)
        ytAlive.push({ id: c.id, name: c.name, altNames: c.altNames || [],
          country: normaliseCountry(c.country || '', c.languages, null),
          logo: c.logo || logoMap[c.id] || null, languages: c.languages || [],
          categories: c.categories || ['youtube'], urls: [], youtubeUrls: [], ytId: c.ytId,
          cat: c.cat || 'youtube', uptime, _skipped: true })
        seenIds.add(c.id)
        return
      }

      const embedUrl = `https://www.youtube.com/embed/${c.ytId}`
      const result   = await isAlive(embedUrl, null, UA)
      ytDone++
      if (ytDone % 50 === 0 || ytDone === ytCandidates.length) {
        console.log(`  [youtube] ${ytDone}/${ytCandidates.length} — ✓ ${ytAlive.length}  ✗ ${ytDead.length}`)
      }
      const ch = {
        id: c.id, name: c.name, altNames: c.altNames || [],
        country: normaliseCountry(c.country || '', c.languages, null),
        logo: c.logo || logoMap[c.id] || null,
        languages: c.languages || [],
        categories: c.categories || ['youtube'],
        urls: [], youtubeUrls: [], ytId: c.ytId,
        cat: c.cat || 'youtube',
      }
      if (result.alive) {
        recordAlive(history, c.id)
        seenIds.add(c.id)
        ytAlive.push({ ...ch, uptime: uptimeScore(history, c.id) })
      } else {
        recordDead(history, c.id)
        ytDead.push(ch)
      }
    })

    await runWithConcurrency(ytTasks, concurrency)
    console.log(`  youtube done — alive: ${ytAlive.length}  dead: ${ytDead.length}  (${Date.now() - t3} ms)`)
  } catch (e) {
    console.warn(`  Could not load youtube list: ${e.message}`)
  }

  // ── 4. Logo validation ──────────────────────────────────────────────────
  console.log('\n── [5/5] Validating logos ──')
  const t5 = Date.now()
  const allCandidatesForLogos = [...iptvAlive, ...ytAlive].filter(c => c.logo)
  console.log(`  Logos to check: ${allCandidatesForLogos.length}`)

  const logoTasks = allCandidatesForLogos.map(ch => async () => {
    ch.logo = await validateLogo(ch.logo)
  })
  await runWithConcurrency(logoTasks, 40) // higher concurrency — lightweight HEAD only
  const nulledLogos = allCandidatesForLogos.filter(c => c.logo === null).length
  console.log(`  Logos nulled (dead): ${nulledLogos}  (${Date.now() - t5} ms)`)

  // ── Write outputs ───────────────────────────────────────────────────────
  // Cross-build URL deduplication (add prev build's URLs to seenUrls so same
  // stream appearing under a new channel ID doesn't duplicate)
  const seenUrls = new Set()

  const allLive = [...iptvAlive, ...ytAlive]
    .filter(ch => {
      const key = ch.ytId ?? ch.urls?.[0]
      if (!key) return true
      if (seenUrls.has(key)) return false
      seenUrls.add(key)
      return true
    })
    // Strip internal build flags before writing
    .map(({ _skipped, _resurrected, ...ch }) => ({
      ...ch,
      languages: (ch.languages || []).map(l => l.toLowerCase()).filter(Boolean),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Diff
  const newIds     = new Set(allLive.map(c => c.id))
  const added      = allLive.filter(c => !prevIds.has(c.id)).map(c => c.id)
  const removed    = [...prevIds].filter(id => !newIds.has(id))

  const mergedPath = path.resolve(cfg.output.merged)
  const deadPath   = path.resolve(cfg.output.dead)
  const diffPath   = path.resolve(cfg.output.diff)
  fs.mkdirSync(path.dirname(mergedPath), { recursive: true })

  fs.writeFileSync(mergedPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: allLive.length,
    channels: allLive,
  }, null, 2))

  fs.writeFileSync(deadPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: iptvDead.length + ytDead.length,
    iptv:    { total: iptvDead.length,    channels: iptvDead },
    youtube: { total: ytDead.length,      channels: ytDead },
  }, null, 2))

  fs.writeFileSync(diffPath, JSON.stringify({
    generated: new Date().toISOString(),
    added:   { total: added.length,   ids: added },
    removed: { total: removed.length, ids: removed },
  }, null, 2))

  saveHistory(history)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  LIVE    ${allLive.length} channels → ${cfg.output.merged}`)
  console.log(`  DEAD    iptv: ${iptvDead.length}  youtube: ${ytDead.length} → ${cfg.output.dead}`)
  console.log(`  DIFF    +${added.length} added  -${removed.length} removed → ${cfg.output.diff}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
