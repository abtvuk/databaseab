// scripts/build.js
// Fetches iptv-org channels + streams, probes every stream with HEAD/GET,
// merges curated youtube + custom lists (also probed), writes:
//   feeds/merged/channels.json   — all live channels
//   feeds/merged/dead-channels.json — dead by source (iptv / youtube / custom)

const cfg = require('../config')

const IPTV_CHANNELS  = 'https://iptv-org.github.io/api/channels.json'
const IPTV_STREAMS   = 'https://iptv-org.github.io/api/streams.json'
const IPTV_BLOCKLIST = 'https://iptv-org.github.io/api/blocklist.json'
const IPTV_LOGOS     = 'https://iptv-org.github.io/api/logos.json'

const { timeoutSeconds, retries, concurrency, retryDelaySeconds } = cfg.check
const TIMEOUT_MS = timeoutSeconds * 1000
const UA = 'abtv/1.0'

const fs   = require('fs')
const path = require('path')

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`)
  return res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const COUNTRY_MAP = { UK: 'GB', XK: 'XK' }
function normaliseCountry(code) {
  if (!code) return ''
  const u = code.toUpperCase()
  return COUNTRY_MAP[u] ?? u
}

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

// ── Stream probe — HEAD with GET fallback ────────────────────────────────

async function probeOnce(url, referrer, userAgent) {
  const headers = { 'User-Agent': userAgent || UA }
  if (referrer) headers['Referer'] = referrer

  // HEAD first
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers })
    clearTimeout(t)
    if (res.status < 400) return true
    if (res.status !== 405) return false
  } catch (e) {
    if (e.name !== 'AbortError') return false
  }

  // GET fallback with Range header
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { ...headers, Range: 'bytes=0-0' } })
    clearTimeout(t)
    return res.status === 200 || res.status === 206
  } catch {
    return false
  }
}

async function isAlive(url, referrer, userAgent) {
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(retryDelaySeconds * 1000)
    if (await probeOnce(url, referrer, userAgent)) return true
  }
  return false
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  abtv / databaseab — build.js')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // ── 1. Fetch iptv-org data ──────────────────────────────────────────────
  console.log('── [1/4] Fetching iptv-org sources ──')
  const [channels, streams, blocklist, logos] = await Promise.all([
    fetchJSON(IPTV_CHANNELS),
    fetchJSON(IPTV_STREAMS),
    fetchJSON(IPTV_BLOCKLIST).catch(() => []),
    fetchJSON(IPTV_LOGOS).catch(() => []),
  ])
  console.log(`  channels:  ${channels.length}`)
  console.log(`  streams:   ${streams.length}`)
  console.log(`  blocklist: ${blocklist.length}`)

  // Logo map — keyed by channel id
  const logoMap = {}
  for (const l of logos) {
    if (l.channel && l.url && !logoMap[l.channel]) logoMap[l.channel] = l.url
  }

  // Only block nsfw
  const blockedIds = new Set(blocklist.filter(b => b.reason === 'nsfw').map(b => b.channel))

  // Stream map — keyed by channel id, current schema uses `referrer` (not http_referrer)
  const streamMap = {}
  const orphanYt  = []
  for (const s of streams) {
    if (blockedIds.has(s.channel)) continue
    if (!s.channel) {
      if (isYouTubeUrl(s.url)) {
        const ytId = extractYtId(s.url)
        if (ytId && s.title) orphanYt.push({ url: s.url, ytId, title: s.title })
      }
      continue
    }
    if (!streamMap[s.channel]) streamMap[s.channel] = []
    streamMap[s.channel].push({ url: s.url, referrer: s.referrer || null, userAgent: s.user_agent || null })
  }

  // ── 2. Probe iptv-org streams ───────────────────────────────────────────
  console.log('\n── [2/4] Probing iptv-org streams ──')

  const candidates = channels
    .filter(c => c.id && c.name && !blockedIds.has(c.id) && streamMap[c.id]?.length > 0)
    .map(c => {
      const entries  = streamMap[c.id].slice(0, 3)
      const urls     = entries.map(e => e.url)
      const primary  = entries[0]
      const referrer = primary?.referrer  || null
      const userAgent= primary?.userAgent || null
      const ytUrl    = urls.find(isYouTubeUrl)
      const ytId     = ytUrl ? extractYtId(ytUrl) : null
      const cats     = c.categories || []
      const proxy    = ytId ? false : needsProxy(urls[0], referrer)
      return {
        id: c.id, name: c.name,
        country: normaliseCountry(c.country),
        logo: c.logo || logoMap[c.id] || null,
        languages: c.languages || [],
        categories: ytId ? [...new Set([...cats, 'youtube'])] : cats,
        urls: ytId ? [] : urls,
        ytId: ytId || null,
        cat: ytId ? 'youtube' : (cats[0] || 'general'),
        ...(referrer   && { referrer }),
        ...(userAgent  && { userAgent }),
        ...(proxy      && { needsProxy: true }),
      }
    })

  console.log(`  Candidates to probe: ${candidates.length}`)

  const iptvAlive = [], iptvDead = []
  let iptvDone = 0

  const iptvTasks = candidates.map(ch => async () => {
    if (ch.ytId) { iptvAlive.push(ch); return }
    const ok = await isAlive(ch.urls[0], ch.referrer, ch.userAgent)
    iptvDone++
    if (iptvDone % 200 === 0 || iptvDone === candidates.length) {
      console.log(`  [iptv] ${iptvDone}/${candidates.length} — ✓ ${iptvAlive.length}  ✗ ${iptvDead.length}`)
    }
    if (ok) iptvAlive.push(ch)
    else    iptvDead.push(ch)
  })

  await runWithConcurrency(iptvTasks, concurrency)
  console.log(`  iptv done — alive: ${iptvAlive.length}  dead: ${iptvDead.length}`)

  // Add orphan YouTube streams
  const seenYtIds = new Set(iptvAlive.filter(c => c.ytId).map(c => c.ytId))
  let orphanAdded = 0
  for (const o of orphanYt) {
    if (seenYtIds.has(o.ytId)) continue
    seenYtIds.add(o.ytId)
    iptvAlive.push({ id: `orphan.${o.ytId}`, name: o.title, country: '', logo: null, languages: [], categories: ['youtube'], urls: [], ytId: o.ytId, cat: 'youtube' })
    orphanAdded++
  }
  if (orphanAdded) console.log(`  orphan YT streams added: ${orphanAdded}`)

  // ── 3. Probe curated YouTube list ──────────────────────────────────────
  console.log('\n── [3/4] Probing curated YouTube channels ──')
  const seenIds = new Set(iptvAlive.map(c => c.id))
  const ytAlive = [], ytDead = []

  try {
    const ytList = JSON.parse(fs.readFileSync(path.resolve(cfg.sources.youtube.replace('https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/', '')), 'utf8'))
    const ytCandidates = ytList.filter(c => c.id && c.ytId && !blockedIds.has(c.id) && !seenIds.has(c.id))
    console.log(`  Candidates: ${ytCandidates.length}`)
    let ytDone = 0

    const ytTasks = ytCandidates.map(c => async () => {
      // Probe via YouTube embed endpoint — if it returns 200 the channel is live
      const embedUrl = `https://www.youtube.com/embed/${c.ytId}`
      const ok = await isAlive(embedUrl, null, UA)
      ytDone++
      if (ytDone % 50 === 0 || ytDone === ytCandidates.length) {
        console.log(`  [youtube] ${ytDone}/${ytCandidates.length} — ✓ ${ytAlive.length}  ✗ ${ytDead.length}`)
      }
      const ch = {
        id: c.id, name: c.name,
        country: normaliseCountry(c.country || ''),
        logo: c.logo || logoMap[c.id] || null,
        languages: c.languages || [],
        categories: c.categories || ['youtube'],
        urls: [], ytId: c.ytId,
        cat: c.cat || 'youtube',
      }
      if (ok) { seenIds.add(c.id); ytAlive.push(ch) }
      else      ytDead.push(ch)
    })

    await runWithConcurrency(ytTasks, concurrency)
    console.log(`  youtube done — alive: ${ytAlive.length}  dead: ${ytDead.length}`)
  } catch (e) {
    console.warn(`  Could not load youtube list: ${e.message}`)
  }

  // ── 4. Probe custom channels ────────────────────────────────────────────
  console.log('\n── [4/4] Probing custom channels ──')
  const customAlive = [], customDead = []

  try {
    const customList = JSON.parse(fs.readFileSync(path.resolve(cfg.sources.custom.replace('https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/', '')), 'utf8'))
    const customCandidates = customList.filter(c => c.id && c.urls?.length && !seenIds.has(c.id))
    console.log(`  Candidates: ${customCandidates.length}`)
    let customDone = 0

    const customTasks = customCandidates.map(c => async () => {
      const ok = await isAlive(c.urls[0], null, UA)
      customDone++
      if (customDone % 10 === 0 || customDone === customCandidates.length) {
        console.log(`  [custom] ${customDone}/${customCandidates.length} — ✓ ${customAlive.length}  ✗ ${customDead.length}`)
      }
      const ch = {
        id: c.id, name: c.name,
        country: normaliseCountry(c.country || ''),
        logo: c.logo || null,
        languages: c.languages || [],
        categories: c.categories || [c.cat || 'general'],
        urls: c.urls, ytId: null,
        cat: c.cat || 'general',
        ...(c.needsProxy && { needsProxy: true }),
      }
      if (ok) { seenIds.add(c.id); customAlive.push(ch) }
      else      customDead.push(ch)
    })

    await runWithConcurrency(customTasks, concurrency)
    console.log(`  custom done — alive: ${customAlive.length}  dead: ${customDead.length}`)
  } catch (e) {
    console.warn(`  Could not load custom list: ${e.message}`)
  }

  // ── Write outputs ───────────────────────────────────────────────────────
  const seenUrls = new Set()
  const allLive = [...iptvAlive, ...ytAlive, ...customAlive]
  .filter(ch => {
    const key = ch.ytId ?? ch.urls?.[0]
    if (!key) return true   // no URL to deduplicate on — keep it
    if (seenUrls.has(key)) return false
    seenUrls.add(key)
    return true
  })
  .sort((a, b) => a.name.localeCompare(b.name))

  const mergedPath = path.resolve(cfg.output.merged)
  const deadPath   = path.resolve(cfg.output.dead)
  fs.mkdirSync(path.dirname(mergedPath), { recursive: true })

  fs.writeFileSync(mergedPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: allLive.length,
    channels: allLive,
  }, null, 2))

  fs.writeFileSync(deadPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: iptvDead.length + ytDead.length + customDead.length,
    iptv:    { total: iptvDead.length,   channels: iptvDead },
    youtube: { total: ytDead.length,     channels: ytDead },
    custom:  { total: customDead.length, channels: customDead },
  }, null, 2))

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  LIVE    ${allLive.length} channels → ${cfg.output.merged}`)
  console.log(`  DEAD    iptv: ${iptvDead.length}  youtube: ${ytDead.length}  custom: ${customDead.length} → ${cfg.output.dead}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(err => { console.error(err); process.exit(1) })
