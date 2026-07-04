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
      return { browserOk: false, needsProxy: false }
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

function checkVideoCodec(url, referrer, userAgent) {
  return new Promise(resolve => {
    const bad = (cfg.unsupportedVideoCodecs || []).map(c => c.toLowerCase())
    if (!bad.length) return resolve(false)
    const args = [
      '-v',          'error',
      '-timeout',    String(TIMEOUT_S * 1_000_000),
      '-user_agent', userAgent || UA,
      ...(referrer ? ['-headers', `Referer: ${referrer}\r\nOrigin: ${(() => { try { return new URL(referrer).origin } catch { return referrer } })()}\r\n`] : []),
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

async function segmentProbe(url, referrer, userAgent) {
  await acquireSegmentSlot()
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    const res   = await fetch(url, {
      signal:  ctrl.signal,
      headers: {
        'User-Agent': userAgent || BROWSER_UA,
        'Origin':     ORIGIN,
        ...(referrer ? { 'Referer': referrer } : {}),
      },
      redirect: 'follow',
    })

    if (!res.ok) { clearTimeout(timer); releaseSegmentSlot(); return { playable: false } }

    const ct = (res.headers.get('content-type') || '').toLowerCase()

    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      clearTimeout(timer)
      res.body?.cancel()
      releaseSegmentSlot()
      return { playable: true }
    }

    const text  = await res.text()
    clearTimeout(timer)

    // PHP/resolver URLs return a body containing the real stream URL rather than
    // an HLS manifest — extract and re-probe instead of parsing as M3U8.
    const isHls = ct.includes('mpegurl') || /\.m3u8?(\?|$)/i.test(url)
    if (!isHls) {
      const resolved = await resolveStreamUrl(url, text)
      releaseSegmentSlot()
      if (resolved && resolved !== url) return segmentProbe(resolved, referrer, userAgent)
      return { playable: false }
    }

    const lines        = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const firstSegment = lines[0]
    if (!firstSegment) { releaseSegmentSlot(); return { playable: false } }

    let segmentUrl
    try        { segmentUrl = new URL(firstSegment).href }
    catch      { segmentUrl = new URL(firstSegment, url).href }

    const ctrl2  = new AbortController()
    const timer2 = setTimeout(() => ctrl2.abort(), 10000)
    const segRes = await fetch(segmentUrl, {
      method:  'GET',
      signal:  ctrl2.signal,
      headers: {
        'User-Agent': UA,
        'Range':      'bytes=0-1023',
        ...(referrer ? { 'Referer': referrer } : {}),
      },
      redirect: 'follow',
    })
    clearTimeout(timer2)
    segRes.body?.cancel()

    const ok = segRes.ok || segRes.status === 206
    releaseSegmentSlot()
    return { playable: ok }
  } catch {
    releaseSegmentSlot()
    return { playable: false }
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

function probeOnce(url, referrer, userAgent, streamType = 'v:0', timeoutS = TIMEOUT_S) {
  return new Promise(resolve => {
    const t0   = Date.now()
    const streamArgs = streamType !== null
      ? ['-select_streams', streamType, '-read_intervals', '%+3', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'csv=p=0']
      : ['-show_entries', 'format=nb_streams', '-of', 'csv=p=0']
    const args = [
      '-v',          'error',
      '-timeout',    String(timeoutS * 1_000_000),
      '-user_agent', userAgent || UA,
      ...(referrer ? ['-headers', `Referer: ${referrer}\r\nOrigin: ${(() => { try { return new URL(referrer).origin } catch { return referrer } })()}\r\n`] : []),
      ...streamArgs,
      url,
    ]

    const child = execFile('ffprobe', args, { timeout: (timeoutS + 5) * 1000 }, (err, stdout, stderr) => {
      const responseMs = Date.now() - t0
      if (err) {
        const timedOut = responseMs >= (timeoutS + 4) * 1000
        const failReason = classifyFailure(timedOut, err, stderr)
        return resolve({ alive: false, responseMs, timedOut, failReason })
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

    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, (timeoutS + 6) * 1000)
  })
}

async function probeWithFallback(url, referrer, userAgent, timeoutS) {
  const r1 = await probeOnce(url, referrer, userAgent, 'v:0', timeoutS)
  if (r1.alive) return r1

  if (userAgent === BROWSER_UA) {
    return { alive: false, responseMs: r1.responseMs, timedOut: r1.timedOut, failReason: r1.failReason }
  }

  const r2 = await probeOnce(url, referrer, BROWSER_UA, 'v:0', timeoutS)
  return r2
}

async function probeUrl(url, referrer, userAgent) {
  let last = { alive: false, needsProxy: false, responseMs: 0 }

  for (let i = 0; i <= cfg.probe.retries; i++) {
    if (i > 0) await sleep(cfg.probe.retryDelaySeconds * 1000)

    const timeoutS = TIMEOUT_S + i * 10
    const result = await probeWithFallback(url, referrer, userAgent, timeoutS)

    if (result.alive) {
      if (isUnplayableDomain(url)) {
        return { alive: true, needsProxy: false, browserUnplayable: true, responseMs: result.responseMs }
      }

      const badCodec = await checkVideoCodec(url, referrer, userAgent)
      if (badCodec) {
        return { alive: true, needsProxy: false, browserUnplayable: true, responseMs: result.responseMs }
      }

      const { browserOk, needsProxy, corsTimedOut } = await corsCheck(url, referrer, userAgent)

      if (!browserOk && (needsProxy || corsTimedOut)) {
        const { playable } = await segmentProbe(url, referrer, userAgent)
        if (!playable) {
          return { alive: true, needsProxy: true, browserUnplayable: false, responseMs: result.responseMs }
        }
      }

      return { alive: true, needsProxy: !browserOk, responseMs: result.responseMs }
    }

    last = { alive: false, needsProxy: false, responseMs: result.responseMs, failReason: result.failReason }
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
    execSync('git pull --rebase --autostash', { stdio: 'ignore' })
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

function isDueForPruning(uptime) {
  const prun = cfg.pruning
  if (!prun?.enabled || !prun.consecutiveFailuresLimit) return false
  const failures = uptime?.consecutiveFailures ?? 0
  return failures >= prun.consecutiveFailuresLimit
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
    if (retireCfg?.enabled && isDueForRetirement(ch.uptime)) {
      toRetire.push({ ...ch, retiredAt: new Date().toISOString() })
    } else if (prunCfg?.enabled && ch.alive === false && isDueForPruning(ch.uptime)) {
      toPrune.push({ ...ch, prunedAt: new Date().toISOString() })
      toKeep.push({ ...ch, probe: false })
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

module.exports = { probeUrl, runWithConcurrency, recordAlive, recordDead, isDueForProbe, isDueForResurrect, checkpoint, progressBar, classifyFailSource, isDueForRetirement, isDueForPruning, applyRetirementAndPruning }
