// scripts/check-streams.js
// Reads merged/channels.json, probes every IPTV/custom URL with ffprobe,
// picks the first alive URL per channel, drops channels with no alive URL,
// writes updated merged/channels.json and merged/dead-channels.json

const fs     = require('fs')
const path   = require('path')
const { execFile } = require('child_process')
const cfg    = require('../config')

const { timeoutSeconds, retries, concurrency, retryDelaySeconds } = cfg.check

// ── Probe one URL with ffprobe ─────────────────────────────────────────────
function probeUrl(url) {
  return new Promise(resolve => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-analyzeduration', '3000000',  // 3s
      '-probesize', '500000',          // 500kb max read
      '-timeout', String(timeoutSeconds * 1_000_000), // microseconds
      url,
    ]
    const proc = execFile('ffprobe', args, { timeout: (timeoutSeconds + 2) * 1000 }, (err, stdout) => {
      if (err) return resolve(false)
      try {
        const data = JSON.parse(stdout)
        resolve(Array.isArray(data.streams) && data.streams.length > 0)
      } catch {
        resolve(false)
      }
    })
    // Hard kill safety net
    setTimeout(() => { try { proc.kill() } catch {} }, (timeoutSeconds + 3) * 1000)
  })
}

// ── Retry wrapper ──────────────────────────────────────────────────────────
async function isAlive(url) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelaySeconds * 1000)
    const alive = await probeUrl(url)
    if (alive) return true
  }
  return false
}

// ── Find first alive URL from a list ──────────────────────────────────────
async function findAliveUrl(urls) {
  for (const url of urls) {
    if (await isAlive(url)) return url
  }
  return null
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Concurrency pool ───────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
  const results = []
  const executing = []
  for (const task of tasks) {
    const p = task().then(r => { results.push(r); executing.splice(executing.indexOf(p), 1) })
    executing.push(p)
    if (executing.length >= limit) await Promise.race(executing)
  }
  await Promise.all(executing)
  return results
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const mergedPath = path.resolve(cfg.output.merged)
  const deadPath   = path.resolve(cfg.output.dead)

  if (!fs.existsSync(mergedPath)) {
    console.error('merged/channels.json not found — run merge.js first')
    process.exit(1)
  }

  const { channels } = JSON.parse(fs.readFileSync(mergedPath, 'utf8'))
  console.log(`── Checking streams for ${channels.length} channels ──`)

  // YouTube channels are always alive — skip them
  const toCheck  = channels.filter(ch => !ch.ytId && ch.urls?.length)
  const skipYT   = channels.filter(ch => ch.ytId)
  const skipNoUrl = channels.filter(ch => !ch.ytId && !ch.urls?.length)

  console.log(`  YouTube (skip): ${skipYT.length}`)
  console.log(`  No URL (skip):  ${skipNoUrl.length}`)
  console.log(`  To probe:       ${toCheck.length}`)

  let done = 0
  const alive = []
  const dead  = []

  const tasks = toCheck.map(ch => async () => {
    const liveUrl = await findAliveUrl(ch.urls)
    done++
    if (done % 100 === 0 || done === toCheck.length) {
      console.log(`  [${done}/${toCheck.length}] checked — alive: ${alive.length} dead: ${dead.length}`)
    }
    if (liveUrl) {
      // Keep channel, set urls to [liveUrl] as primary (others dropped)
      alive.push({ ...ch, urls: [liveUrl] })
    } else {
      dead.push(ch)
    }
  })

  await runWithConcurrency(tasks, concurrency)

  // Final merged: youtube + no-url + alive IPTV, sorted by name
  const finalChannels = [...skipYT, ...skipNoUrl, ...alive]
    .sort((a, b) => a.name.localeCompare(b.name))

  // Write live channels
  fs.writeFileSync(mergedPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: finalChannels.length,
    channels: finalChannels,
  }, null, 2))

  // Write dead channels
  fs.mkdirSync(path.dirname(deadPath), { recursive: true })
  fs.writeFileSync(deadPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: dead.length,
    channels: dead,
  }, null, 2))

  console.log(`\n✓ Alive:  ${finalChannels.length} channels → ${cfg.output.merged}`)
  console.log(`✓ Dead:   ${dead.length} channels  → ${cfg.output.dead}`)
}

main().catch(err => { console.error(err); process.exit(1) })
