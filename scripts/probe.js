const cfg  = require('../config')
const { execFile } = require('child_process')

const TIMEOUT_S  = cfg.probe.timeoutSeconds
const UA         = 'abtv-probe/1.0'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const ORIGIN     = 'https://abtv.cictehro.space'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function corsCheck(url, referrer, userAgent) {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const reqHeaders = {
      'Origin':     ORIGIN,
      'User-Agent': userAgent || BROWSER_UA,
      ...(referrer ? { 'Referer': referrer, 'Origin': new URL(referrer).origin } : {}),
    }
    let res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: reqHeaders })

    if (res.status === 405) {
      res.body?.cancel()
      res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { ...reqHeaders, 'Range': 'bytes=0-1023' } })
      res.body?.cancel()
    }
    clearTimeout(timer)

    if (res.status === 403 || res.status === 404 || res.status === 410 || res.status === 451) {
      return { browserOk: false, needsProxy: false, hardBlocked: true, failReason: `cors_http_${res.status}` }
    }

    const sentOrigin = referrer ? (() => { try { return new URL(referrer).origin } catch { return ORIGIN } })() : ORIGIN
    const acao = res.headers.get('access-control-allow-origin')
    const browserOk = acao === '*' || acao === ORIGIN || acao === sentOrigin

    if (res.ok && !browserOk) return { browserOk: false, needsProxy: true }
    if (!res.ok) return { browserOk: false, needsProxy: true }

    return { browserOk: true, needsProxy: false }
  } catch {
    return { browserOk: false, needsProxy: false, corsTimedOut: true }
  }
}

function isNameBlocked(name) {
  if (!name) return false
  const lc = name.toLowerCase()
  return (cfg.nameBlocklist || []).some(b => lc.includes(b.toLowerCase()))
}

function isManualBlocked(id) {
  return (cfg.manualBlocklist || []).includes(id)
}

function isUnplayableDomain(url) {
  const blocked = cfg.unplayableDomains || []
  if (!blocked.length) return false
  try {
    const hostname = new URL(url).hostname
    return blocked.some(d => hostname === d || hostname.endsWith('.' + d))
  } catch {
    return false
  }
}

function stripUnplayableLinks(ch) {
  const urls = ch.streamUrls || []
  const meta = ch.streamMeta || []
  const keepUrls = [], keepMeta = [], blocked = []
  urls.forEach((u, i) => {
    if (isUnplayableDomain(u)) blocked.push({ url: u, blockedAt: new Date().toISOString() })
    else { keepUrls.push(u); keepMeta.push(meta[i] || {}) }
  })
  return { keepUrls, keepMeta, blocked }
}

function restoreUnplayableLinks(ch) {
  const blocked = ch.domainBlockedLinks || []
  const stillBlocked = [], restored = []
  for (const b of blocked) {
    if (isUnplayableDomain(b.url)) stillBlocked.push(b)
    else restored.push(b.url)
  }
  return { stillBlocked, restored }
}

function checkVideoCodec(url, referrer, userAgent) {
  return new Promise(resolve => {
    const bad = (cfg.unsupportedVideoCodecs || []).map(c => c.toLowerCase())
    if (!bad.length) return resolve(false)
    const isHttp = /^https?:\/\//i.test(url)
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000),
      ...(isHttp ? ['-user_agent', userAgent || UA] : []),
      ...(isHttp && referrer ? ['-headers', `Referer: ${referrer}\r\nOrigin: ${(() => { try { return new URL(referrer).origin } catch { return referrer } })()}\r\n`] : []),
      '-select_streams', 'v:0',
      '-show_entries',   'stream=codec_name',
      '-of',              'csv=p=0',
      url,
    ]
    const child = execFile('ffprobe', args, { timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout) => {
      if (err) return resolve(false)
      const codec = stdout.trim().toLowerCase()
      resolve(bad.includes(codec))
    })
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, (TIMEOUT_S + 6) * 1000)
  })
}

const SEGMENT_CONCURRENCY = cfg.probe.segmentConcurrency || 8
let _segmentActive = 0
const _segmentQueue = []
function acquireSegmentSlot() {
  return new Promise(resolve => {
    if (_segmentActive < SEGMENT_CONCURRENCY) { _segmentActive++; resolve() }
    else _segmentQueue.push(resolve)
  })
}
function releaseSegmentSlot() {
  if (_segmentQueue.length) { _segmentQueue.shift()() }
  else _segmentActive--
}

async function resolveStreamUrl(url, body) {
  const trimmed = body.trim()
  if (/^https?:\/\//i.test(trimmed) && !trimmed.includes('\n')) return trimmed
  const m3u8 = body.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i)
  if (m3u8) return m3u8[0]
  const seg = body.match(/https?:\/\/[^\s"'<>]+\.(ts|mp4|aac|mp2t)[^\s"'<>]*/i)
  if (seg)  return seg[0]
  return null
}

function resolveAgainst(candidate, baseUrl) {
  try { return new URL(candidate).href } catch {}
  try { return new URL(candidate, baseUrl).href } catch { return null }
}

function isMasterPlaylist(lines) {
  return lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))
}

function extractVariants(lines) {
  const variants = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
      variants.push(lines[i + 1])
    }
  }
  return variants
}

async function fetchManifest(url, referrer, userAgent) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(url, {
      signal:   ctrl.signal,
      headers:  { 'User-Agent': userAgent || BROWSER_UA, 'Origin': ORIGIN, ...(referrer ? { 'Referer': referrer } : {}) },
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (!res.ok) { res.body?.cancel(); return { ok: false, transient: res.status >= 500, failReason: `manifest_http_${res.status}` } }
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (ct.startsWith('video/') || ct.startsWith('audio/')) { res.body?.cancel(); return { ok: true, direct: true } }
    const text = await res.text()
    return { ok: true, text, contentType: ct, finalUrl: res.url }
  } catch (e) {
    clearTimeout(timer)
    const timedOut = e.name === 'AbortError'
    return { ok: false, transient: timedOut, failReason: timedOut ? 'manifest_timeout' : 'manifest_error' }
  }
}

async function fetchSegmentBytes(segmentUrl, referrer) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(segmentUrl, {
      method:   'GET',
      signal:   ctrl.signal,
      headers:  { 'User-Agent': UA, 'Range': 'bytes=0-1023', ...(referrer ? { 'Referer': referrer } : {}) },
      redirect: 'follow',
    })
    clearTimeout(timer)
    res.body?.cancel()
    if (res.ok || res.status === 206) return { ok: true }
    if (res.status >= 500) return { ok: false, transient: true, failReason: 'segment_5xx' }
    return { ok: false, failReason: `segment_http_${res.status}` }
  } catch (e) {
    clearTimeout(timer)
    const timedOut = e.name === 'AbortError'
    return { ok: false, transient: timedOut, failReason: timedOut ? 'segment_timeout' : 'segment_error' }
  }
}

async function segmentProbeOnce(url, referrer, userAgent, depth = 0) {
  if (depth > 3) return { playable: false, failReason: 'manifest_too_deep' }

  const manifest = await fetchManifest(url, referrer, userAgent)
  if (!manifest.ok) return { playable: false, failReason: manifest.failReason, transient: manifest.transient }
  if (manifest.direct) return { playable: true }

  const isHls = manifest.contentType.includes('mpegurl') || /\.m3u8?(\?|$)/i.test(url)
  if (!isHls) {
    const resolved = await resolveStreamUrl(url, manifest.text)
    if (resolved && resolved !== url) return segmentProbeOnce(resolved, referrer, userAgent, depth + 1)
    return { playable: false, failReason: 'unrecognized_manifest' }
  }

  const lines = manifest.text.split('\n').map(l => l.trim()).filter(Boolean)

  if (isMasterPlaylist(lines)) {
    const variants = extractVariants(lines)
    if (!variants.length) return { playable: false, failReason: 'master_no_variants' }
    let lastReason = 'master_variant_unreachable', lastTransient = false
    for (const v of variants.slice(0, 2)) {
      const variantUrl = resolveAgainst(v, manifest.finalUrl)
      if (!variantUrl) continue
      const r = await segmentProbeOnce(variantUrl, referrer, userAgent, depth + 1)
      if (r.playable) return r
      lastReason    = r.failReason || lastReason
      lastTransient = !!r.transient
    }
    return { playable: false, failReason: lastReason, transient: lastTransient }
  }

  const firstSegment = lines.find(l => !l.startsWith('#'))
  if (!firstSegment) return { playable: false, failReason: 'media_no_segments' }

  const segmentUrl = resolveAgainst(firstSegment, manifest.finalUrl)
  if (!segmentUrl) return { playable: false, failReason: 'segment_url_unresolvable' }

  const seg = await fetchSegmentBytes(segmentUrl, referrer)
  return { playable: seg.ok, failReason: seg.ok ? undefined : seg.failReason, transient: seg.transient }
}

async function segmentProbe(url, referrer, userAgent) {
  await acquireSegmentSlot()
  try {
    const first = await segmentProbeOnce(url, referrer, userAgent)
    if (first.playable || !first.transient) return { playable: first.playable, failReason: first.failReason }
    const retry = await segmentProbeOnce(url, referrer, userAgent)
    return { playable: retry.playable, failReason: retry.failReason }
  } finally {
    releaseSegmentSlot()
  }
}

function classifyFailure(timedOut, err, stderr) {
  if (timedOut || err?.killed) return 'timeout'
  const s = ((stderr || '') + ' ' + (err?.message || '')).toLowerCase()
  if (s.includes('name or service not known') || s.includes('temporary failure in name resolution') || s.includes('nodename nor servname provided')) return 'dns'
  if (s.includes('connection refused'))  return 'refused'
  if (s.includes('connection timed out') || s.includes('operation timed out')) return 'timeout'
  if (s.includes('http error 403') || s.includes('403 forbidden'))  return 'http_403'
  if (s.includes('http error 404') || s.includes('404 not found'))  return 'http_404'
  if (s.includes('http error 401'))                                  return 'http_401'
  if (/http error 5\d\d/.test(s))                                    return 'http_5xx'
  if (s.includes('http error 4'))                                    return 'http_4xx'
  if (s.includes('invalid data') || s.includes('no such file') || s.includes('moov atom not found')) return 'invalid'
  return 'other'
}

function probeOnce(url, referrer, userAgent, streamType = 'v:0') {
  return new Promise(resolve => {
    const t0   = Date.now()
    const isHttp = /^https?:\/\//i.test(url)
    const streamArgs = streamType !== null
      ? ['-select_streams', streamType, '-read_intervals', '%+3', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'csv=p=0']
      : ['-show_entries', 'format=nb_streams', '-of', 'csv=p=0']
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000),
      ...(isHttp ? ['-user_agent', userAgent || UA] : []),
      ...(isHttp && referrer ? ['-headers', `Referer: ${referrer}\r\nOrigin: ${(() => { try { return new URL(referrer).origin } catch { return referrer } })()}\r\n`] : []),
      ...streamArgs,
      url,
    ]

    const child = execFile('ffprobe', args, { timeout: (TIMEOUT_S + 5) * 1000 }, (err, stdout, stderr) => {
      const responseMs = Date.now() - t0
      if (err) {
        const timedOut = responseMs >= (TIMEOUT_S + 4) * 1000
        const failReason = classifyFailure(timedOut, err, stderr)
        return resolve({ alive: false, responseMs, timedOut, failReason, rawError: (stderr || err.message || '').trim().slice(0, 300) })
      }
      const out = stdout.trim()
      if (streamType !== null) {
        const [codecType, frameCount] = out.split(',')
        const hasStream = codecType === 'video' || codecType === 'audio'
        const hasFrames = parseInt(frameCount, 10) > 0
        const alive = hasStream && hasFrames
        return resolve({ alive, responseMs, timedOut: false, failReason: alive ? undefined : (hasStream ? 'no_frames' : 'no_stream') })
      }
      const alive = parseInt(out, 10) > 0
      resolve({ alive, responseMs, timedOut: false, failReason: alive ? undefined : 'no_stream' })
    })

    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, (TIMEOUT_S + 6) * 1000)
  })
}

async function probeWithFallback(url, referrer, userAgent) {
  const r1 = await probeOnce(url, referrer, userAgent, 'v:0')
  if (r1.alive) return r1

  if (userAgent === BROWSER_UA) {
    return { alive: false, responseMs: r1.responseMs, timedOut: r1.timedOut, failReason: r1.failReason, rawError: r1.rawError }
  }

  const r2 = await probeOnce(url, referrer, BROWSER_UA, 'v:0')
  return r2
}

function isCriticalChannel(id, url) {
  const list = cfg.criticalChannels || []
  if (!list.length) return false
  return list.some(entry => id === entry || (url && url.includes(entry)))
}

async function evaluateUrl(url, referrer, userAgent) {
  const ff = await probeWithFallback(url, referrer, userAgent)
  if (!ff.alive) return { ffAlive: false, responseMs: ff.responseMs, failReason: ff.failReason, rawError: ff.rawError }

  if (isUnplayableDomain(url)) {
    return { ffAlive: true, responseMs: ff.responseMs, browserUnplayable: true, failReason: 'unplayable_domain' }
  }
  const badCodec = await checkVideoCodec(url, referrer, userAgent)
  if (badCodec) {
    return { ffAlive: true, responseMs: ff.responseMs, browserUnplayable: true, failReason: 'unsupported_codec' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ffAlive: true, responseMs: ff.responseMs, nonHttp: true }
  }

  const cors = await corsCheck(url, referrer, userAgent)
  if (cors.hardBlocked) {
    return { ffAlive: true, responseMs: ff.responseMs, browserUnplayable: true, failReason: cors.failReason }
  }
  if (cors.browserOk) {
    return { ffAlive: true, responseMs: ff.responseMs, browserOk: true }
  }
  return { ffAlive: true, responseMs: ff.responseMs, browserOk: false, needsProxy: true }
}

async function probeUrl(url, referrer, userAgent) {
  let last = { alive: false, needsProxy: false, responseMs: 0 }

  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)

    const ev = await evaluateUrl(url, referrer, userAgent)

    if (ev.ffAlive) {
      if (ev.browserUnplayable) return { alive: true, needsProxy: false, browserUnplayable: true, responseMs: ev.responseMs }
      if (ev.nonHttp || ev.browserOk) return { alive: true, needsProxy: false, responseMs: ev.responseMs }

      await segmentProbe(url, referrer, userAgent)
      return { alive: true, needsProxy: true, browserUnplayable: false, responseMs: ev.responseMs }
    }

    last = { alive: false, needsProxy: false, responseMs: ev.responseMs, failReason: ev.failReason, rawError: ev.rawError }
  }

  return last
}

async function probeUrlThorough(url, referrer, userAgent) {
  let last = { alive: false, needsProxy: false, responseMs: 0 }

  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)

    const ev = await evaluateUrl(url, referrer, userAgent)

    if (!ev.ffAlive) {
      last = { alive: false, needsProxy: false, responseMs: ev.responseMs, failReason: ev.failReason, rawError: ev.rawError }
      continue
    }
    if (ev.browserUnplayable) return { alive: false, needsProxy: false, responseMs: ev.responseMs, failReason: ev.failReason }
    if (ev.nonHttp || ev.browserOk) return { alive: true, needsProxy: false, responseMs: ev.responseMs }

    const seg = await segmentProbe(url, referrer, userAgent)
    if (seg.playable) return { alive: true, needsProxy: true, responseMs: ev.responseMs }
    return { alive: false, needsProxy: false, responseMs: ev.responseMs, failReason: seg.failReason || 'segment_unplayable' }
  }

  return last
}

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

function computeScore(uptime) {
  const { aliveCount, totalCount } = uptime
  if (!totalCount) return null
  const recent = (uptime.recentResults || []).slice(-10)
  if (!recent.length) return Math.round((aliveCount / totalCount) * 100)
  const alive  = recent.reduce((s, v) => s + v, 0)
  return Math.round((alive / recent.length) * 100)
}

function recordAlive(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, consecutiveFailures: 0, lastSeen: null, lastProbed: null, score: null }
  u.aliveCount++
  u.totalCount++
  u.consecutiveAlive++
  u.consecutiveFailures = 0
  u.lastSeen   = new Date().toISOString()
  u.lastProbed = new Date().toISOString()
  const w = cfg.scoreRecencyWindow || 0
  if (w) { u.recentResults = u.recentResults || []; u.recentResults.push(1); if (u.recentResults.length > w) u.recentResults.shift() }
  u.score = computeScore(u)
  return u
}

function recordDead(uptime) {
  const u = uptime || { aliveCount: 0, totalCount: 0, consecutiveAlive: 0, consecutiveFailures: 0, lastSeen: null, lastProbed: null, score: null }
  u.totalCount++
  u.consecutiveAlive = 0
  u.consecutiveFailures = (u.consecutiveFailures || 0) + 1
  u.lastProbed = new Date().toISOString()
  const w = cfg.scoreRecencyWindow || 0
  if (w) { u.recentResults = u.recentResults || []; u.recentResults.push(0); if (u.recentResults.length > w) u.recentResults.shift() }
  u.score = computeScore(u)
  return u
}

function isDueForProbe(uptime) {
  const pf = cfg.probeFrequency
  const score = uptime?.score ?? null
  const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
  const hoursSince = lastProbed ? (Date.now() - lastProbed.getTime()) / 3600000 : Infinity

  if (score === null || uptime?.totalCount === 0) return true

  let minHours
  if      (score >= 85) minHours = pf.above85
  else if (score >= 80) minHours = pf.from80to85
  else if (score >= 70) minHours = pf.from70to80
  else                  minHours = pf.below70

  return hoursSince >= minHours
}

function isDueForResurrect(uptime) {
  const rf = cfg.resurrectFrequency
  const score      = uptime?.score ?? null
  const total      = uptime?.totalCount ?? 0
  const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
  const hoursSince = lastProbed ? (Date.now() - lastProbed.getTime()) / 3600000 : Infinity

  if (score === null || total === 0) return true

  let minHours
  if (score === 0) {
    minHours = total > 10 ? rf.scoreZeroManyData : rf.scoreZeroFewData
  } else if (score >= 50) {
    minHours = rf.scoreAbove50
  } else if (score >= 20) {
    minHours = rf.scoreAbove20
  } else {
    minHours = rf.scoreAbove0
  }

  return hoursSince >= minHours
}

function checkpoint(data, channels, channelMap, outputPath, label, done, total) {
  const { execSync } = require('child_process')
  data.channels = channels.map(c => channelMap.get(c.id) || c)
  const json = JSON.stringify({ ...data, generated: new Date().toISOString() }, null, 2)
  require('fs').writeFileSync(outputPath, json)
  try {
    execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' })
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' })
    execSync(`git add ${outputPath}`, { stdio: 'ignore' })
    execSync(`git diff --staged --quiet || git commit -m "chore: ${label} checkpoint [$(date -u '+%Y-%m-%d %H:%M UTC')]"`, { shell: true, stdio: 'ignore' })
    try {
      execSync('git pull --rebase --autostash', { stdio: 'ignore' })
    } catch (e) {
      execSync('git rebase --abort', { stdio: 'ignore' })
      throw e
    }
    execSync('git push', { stdio: 'ignore' })
  } catch (e) {
    console.warn(`  [checkpoint] git error (non-fatal): ${e.message}`)
  }
}

function progressBar(done, total) {
  if (done % 100 !== 0 && done !== total) return
  const pct = Math.round((done / total) * 100)
  const filled = Math.round(pct / 4)
  const bar = '█'.repeat(filled) + '░'.repeat(25 - filled)
  process.stdout.write(`\r  [${bar}] ${pct}%`)
  if (done === total) process.stdout.write('\n')
}

function classifyFailSource(failReason) {
  if (!failReason) return 'unknown'
  if (['http_403', 'http_404', 'http_401', 'http_4xx', 'http_5xx', 'no_stream', 'invalid', 'dns'].includes(failReason)) return 'stream'
  if (['timeout', 'refused'].includes(failReason)) return 'runner'
  return 'unknown'
}

function isDueForRetirement(uptime) {
  const ret = cfg.retirement
  if (!ret?.enabled) return false
  const score = uptime?.score ?? null
  if (score !== 0) return false
  const total = uptime?.totalCount ?? 0
  if (total < 10) return false
  const lastSeen = uptime?.lastSeen ? new Date(uptime.lastSeen) : null
  if (!lastSeen) {
    const lastProbed = uptime?.lastProbed ? new Date(uptime.lastProbed) : null
    if (!lastProbed) return false
    const daysSinceProbed = (Date.now() - lastProbed.getTime()) / 86400000
    return daysSinceProbed >= (ret.score0DaysMin || 180)
  }
  const daysDead = (Date.now() - lastSeen.getTime()) / 86400000
  return daysDead >= (ret.score0DaysMin || 180)
}

function isChannelDeadForever(uptime) {
  const prun = cfg.pruning
  if (!prun?.enabled) return false
  const total = uptime?.totalCount || 0
  if (total < prun.minProbes) return false
  return (uptime?.aliveCount || 0) === 0
}

function recordLinkResult(meta, alive) {
  meta.linkTotalCount = (meta.linkTotalCount || 0) + 1
  if (alive) meta.linkAliveCount = (meta.linkAliveCount || 0) + 1
  return meta
}

function isDueForLinkRemoval(meta) {
  const lp = cfg.linkPruning
  if (!lp?.enabled) return false
  const total = meta?.linkTotalCount || 0
  if (total < lp.minProbes) return false
  const alive = meta?.linkAliveCount || 0
  return alive === 0
}

function pruneChannelLinks(entry, removedLinks) {
  const urls = entry.streamUrls || []
  if (urls.length <= 1) return
  const metaArr = entry.streamMeta || []
  const keepIdx = []
  urls.forEach((u, i) => {
    if (isDueForLinkRemoval(metaArr[i])) {
      removedLinks.push({ channelId: entry.id, url: u, removedAt: new Date().toISOString() })
    } else {
      keepIdx.push(i)
    }
  })
  if (keepIdx.length === urls.length) return
  entry.streamUrls  = keepIdx.map(i => urls[i])
  entry.streamMeta  = keepIdx.map(i => metaArr[i] || {})
}

function saveDeadLinks(removedLinks) {
  if (!removedLinks.length) return
  const existing = loadFeed(cfg.output.deadLinks)
  const seen = new Set((existing.channels || []).map(l => `${l.channelId}|${l.url}`))
  const merged = [...(existing.channels || []), ...removedLinks.filter(l => !seen.has(`${l.channelId}|${l.url}`))]
  saveFeed(cfg.output.deadLinks, merged)
}

function loadFeed(outputPath) {
  const p = require('path').resolve(outputPath)
  try {
    return JSON.parse(require('fs').readFileSync(p, 'utf8'))
  } catch {
    return { generated: null, total: 0, channels: [] }
  }
}

function saveFeed(outputPath, channels) {
  const p = require('path').resolve(outputPath)
  require('fs').mkdirSync(require('path').dirname(p), { recursive: true })
  require('fs').writeFileSync(p, JSON.stringify({
    generated: new Date().toISOString(),
    total: channels.length,
    channels,
  }, null, 2))
}

function applyRetirementAndPruning(channels) {
  const retireCfg = cfg.retirement
  const prunCfg   = cfg.pruning

  const toRetire = []
  const toPrune  = []
  const toKeep   = []

  for (const ch of channels) {
    const urls = ch.streamUrls || []
    if (retireCfg?.enabled && isDueForRetirement(ch.uptime)) {
      toRetire.push({ ...ch, retiredAt: new Date().toISOString() })
    } else if (prunCfg?.enabled && ch.alive === false && urls.length === 0) {
      toPrune.push({ ...ch, prunedAt: new Date().toISOString() })
    } else if (prunCfg?.enabled && ch.alive === false && urls.length === 1 && isChannelDeadForever(ch.uptime)) {
      toPrune.push({ ...ch, prunedAt: new Date().toISOString() })
    } else {
      toKeep.push(ch)
    }
  }

  if (toRetire.length) {
    const archivePath = retireCfg.output || cfg.output.archive
    const existing = loadFeed(archivePath)
    const existingIds = new Set(existing.channels.map(c => c.id))
    const newEntries = toRetire.filter(c => !existingIds.has(c.id))
    saveFeed(archivePath, [...existing.channels, ...newEntries])
  }

  if (toPrune.length) {
    const deadPath = prunCfg.output || cfg.output.dead
    const existing = loadFeed(deadPath)
    const existingIds = new Set(existing.channels.map(c => c.id))
    const newEntries = toPrune.filter(c => !existingIds.has(c.id))
    saveFeed(deadPath, [...existing.channels, ...newEntries])
  }

  channels.length = 0
  for (const ch of toKeep) channels.push(ch)

  return { retired: toRetire.length, pruned: toPrune.length }
}

module.exports = { probeUrl, probeUrlThorough, isCriticalChannel, runWithConcurrency, recordAlive, recordDead, isDueForProbe, isDueForResurrect, checkpoint, progressBar, classifyFailSource, isDueForRetirement, isChannelDeadForever, applyRetirementAndPruning, isUnplayableDomain, stripUnplayableLinks, restoreUnplayableLinks, isNameBlocked, isManualBlocked, loadFeed, saveFeed, recordLinkResult, pruneChannelLinks, saveDeadLinks }
