const cfg = require('../config')
const fs = require('fs')
const path = require('path')
const { stringifyFeed, hasLanguages } = require('./probe')

const FEEDS = [
  cfg.output.channels,
  cfg.output.archive,
  cfg.output.dead,
  cfg.output.blocked,
  cfg.output.youtubeTv,
  cfg.output.youtubeWebcams,
]

function withFlag(c) {
  const out = {}
  for (const k of Object.keys(c)) {
    if (k === 'showLanguage') continue
    out[k] = c[k]
    if (k === 'languages') out.showLanguage = hasLanguages(c)
  }
  if (!('showLanguage' in out)) out.showLanguage = hasLanguages(c)
  return out
}

function main() {
  for (const file of FEEDS) {
    const p = path.resolve(file)
    const raw = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(raw)
    const channels = (data.channels || []).map(withFlag)
    const payload = { ...data, total: channels.length, channels }
    const plain = raw === JSON.stringify(data, null, 2)
    fs.writeFileSync(p, plain ? JSON.stringify(payload, null, 2) : stringifyFeed(payload))
    const shown = channels.filter(c => c.showLanguage).length
    console.log(`${file}: ${channels.length} channels  showLanguage true=${shown} false=${channels.length - shown}  format=${plain ? 'plain' : 'pipeline'}`)
  }
}

main()
