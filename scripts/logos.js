const cfg   = require('../config')
const fs    = require('fs')
const path  = require('path')
const { execFile } = require('child_process')

const LOGO_SIZE      = 48
const LOGOS_DIR       = path.resolve('feeds/logos')
const MANIFEST_PATH   = path.resolve('feeds/logos-manifest.json')
const CONCURRENCY     = 5
const DEADLINE_MS     = 100 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 15000
const UA = 'abtv-logos/1.0'

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

function loadChannelsWithLogos() {
  const seen = new Map()
  for (const outputKey of ['channels', 'youtube']) {
    const p = path.resolve(cfg.output[outputKey])
    let data
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      continue
    }
    for (const c of data.channels || []) {
      if (c.id && c.channelLogo) seen.set(c.id, c.channelLogo)
    }
  }
  return seen
}

async function downloadToFile(url, destPath) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, reason: 'empty_body' }
    fs.writeFileSync(destPath, buf)
    return { ok: true }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch_error' }
  }
}

function resizeToWebp(srcPath, destPath) {
  return new Promise(resolve => {
    const args = [
      '-y', '-v', 'error',
      '-i', srcPath,
      '-vf', `scale=${LOGO_SIZE}:${LOGO_SIZE}:force_original_aspect_ratio=decrease,pad=${LOGO_SIZE}:${LOGO_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      '-pix_fmt', 'yuva420p',
      '-lossless', '0',
      '-quality', '80',
      destPath,
    ]
    execFile('ffmpeg', args, { timeout: 20000 }, (err) => {
      if (err) return resolve({ ok: false, reason: 'ffmpeg_error' })
      resolve({ ok: true })
    })
  })
}

async function processOne(id, url, tmpDir) {
  const ext = (() => {
    try { return path.extname(new URL(url).pathname).slice(0, 5) || '.img' } catch { return '.img' }
  })()
  const tmpSrc = path.join(tmpDir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}${ext}`)
  const dest   = path.join(LOGOS_DIR, `${id}.webp`)

  const dl = await downloadToFile(url, tmpSrc)
  if (!dl.ok) return { ok: false, reason: dl.reason }

  const rs = await resizeToWebp(tmpSrc, dest)
  try { fs.unlinkSync(tmpSrc) } catch {}
  if (!rs.ok) return { ok: false, reason: rs.reason }

  return { ok: true }
}

async function runWithConcurrency(tasks, limit, deadlineMs) {
  let i = 0
  const deadline = Date.now() + deadlineMs
  let stoppedEarly = false
  async function worker() {
    while (i < tasks.length) {
      if (Date.now() >= deadline) { stoppedEarly = true; return }
      const idx = i++
      await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return { stoppedEarly, processed: i }
}

async function main() {
  const current  = loadChannelsWithLogos()
  const manifest = loadManifest()

  const pending = []
  for (const [id, url] of current) {
    if (manifest[id]?.url === url && manifest[id]?.ok) continue
    pending.push([id, url])
  }

  console.log(`logos: total=${current.size}  pending=${pending.length}`)

  if (!pending.length) return

  fs.mkdirSync(LOGOS_DIR, { recursive: true })
  const tmpDir = fs.mkdtempSync('/tmp/abtv-logos-')

  let ok = 0, failed = 0, done = 0
  const failureCounts = {}
  const total = pending.length

  const tasks = pending.map(([id, url]) => async () => {
    const result = await processOne(id, url, tmpDir)
    done++
    if (done % 200 === 0 || done === total) {
      process.stdout.write(`\r  [${done}/${total}]`)
    }
    if (result.ok) {
      manifest[id] = { url, ok: true }
      ok++
    } else {
      manifest[id] = { url, ok: false, reason: result.reason }
      failureCounts[result.reason] = (failureCounts[result.reason] || 0) + 1
      failed++
    }
  })

  const { stoppedEarly } = await runWithConcurrency(tasks, CONCURRENCY, DEADLINE_MS)
  process.stdout.write('\n')

  saveManifest(manifest)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  console.log(`done: ok=${ok}  failed=${failed}${stoppedEarly ? `  (deadline reached, ${total - done} left for next run)` : ''}`)
  if (failed) {
    for (const [reason, count] of Object.entries(failureCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(14)} ${count}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
