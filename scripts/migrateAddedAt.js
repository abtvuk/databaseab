const cfg = require('../config')
const fs = require('fs')
const path = require('path')
const { stringifyFeed } = require('./probe')

const FEEDS = [
  cfg.output.channels,
  cfg.output.archive,
  cfg.output.dead,
  cfg.output.blocked,
  cfg.output.youtubeTv,
  cfg.output.youtubeWebcams,
]

function withAddedAt(c) {
  if ('addedAt' in c) return c
  const out = {}
  for (const k of Object.keys(c)) {
    out[k] = c[k]
    if (k === 'replaced_by') out.addedAt = null
  }
  if (!('addedAt' in out)) out.addedAt = null
  return out
}

function main() {
  for (const file of FEEDS) {
    const p = path.resolve(file)
    const raw = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(raw)
    const channels = (data.channels || []).map(withAddedAt)
    const payload = { ...data, total: channels.length, channels }
    const plain = raw === JSON.stringify(data, null, 2)
    fs.writeFileSync(p, plain ? JSON.stringify(payload, null, 2) : stringifyFeed(payload))
    console.log(`${file}: ${channels.length} channels backfilled with addedAt: null`)
  }
}

main()
