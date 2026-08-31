const cfg = require('../config')
const path = require('path')
const { saveFeedFormatted } = require('./probe')
const fs = require('fs')

const OUTPUT_PATH = path.resolve(cfg.output.youtube)

function main() {
  const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'))
  let curated = 0, toFill = 0

  for (const c of data.channels || []) {
    if (!c.ytId) continue
    if (c.channelLogo) { c.probeLogo = false; curated++ }
    else               { c.probeLogo = true;  toFill++ }
  }

  saveFeedFormatted(OUTPUT_PATH, { generated: new Date().toISOString(), total: data.channels.length, channels: data.channels })
  console.log(`probeLogo migration: curated (false)=${curated}  toFill (true)=${toFill}`)
}

main()
