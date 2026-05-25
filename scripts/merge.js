// scripts/merge.js
// Fetches all three sources, deduplicates by id (custom > iptv > youtube),
// sorts alphabetically by name, writes merged/channels.json

const fs   = require('fs')
const path = require('path')
const cfg  = require('../config')

async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.json()
}

async function main() {
  console.log('── Fetching sources ──')

  const [iptvRaw, youtubeRaw, customRaw] = await Promise.all([
    fetchJSON(cfg.sources.iptv),
    fetchJSON(cfg.sources.youtube),
    fetchJSON(cfg.sources.custom),
  ])

  // IPTV source is wrapped in { generated, total, channels: [...] }
  const iptv    = iptvRaw.channels ?? iptvRaw
  const youtube = Array.isArray(youtubeRaw) ? youtubeRaw : youtubeRaw.channels
  const custom  = Array.isArray(customRaw)  ? customRaw  : customRaw.channels

  console.log(`  IPTV:    ${iptv.length} channels`)
  console.log(`  YouTube: ${youtube.length} channels`)
  console.log(`  Custom:  ${custom.length} channels`)

  // Merge — priority: custom > iptv > youtube
  // Later entries overwrite earlier ones on same id
  const map = new Map()

  for (const ch of youtube) map.set(ch.id, ch)
  for (const ch of iptv)    map.set(ch.id, ch)
  for (const ch of custom)  map.set(ch.id, ch)

  const merged = Array.from(map.values())
    .sort((a, b) => a.name.localeCompare(b.name))

  console.log(`  Merged:  ${merged.length} unique channels`)

  // Write output
  const outPath = path.resolve(cfg.output.merged)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    total: merged.length,
    channels: merged,
  }, null, 2))

  console.log(`✓ Written to ${cfg.output.merged}`)
}

main().catch(err => { console.error(err); process.exit(1) })
