const cfg = require('../config')
const path = require('path')
const { saveFeedFormatted } = require('./probe')
const fs = require('fs')

const OUTPUT_PATH = path.resolve(cfg.output.youtube)

function main() {
  const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'))
  let stripped = 0

  for (const c of data.channels || []) {
    if ('legacyYtId' in c) { delete c.legacyYtId; stripped++ }
  }

  saveFeedFormatted(OUTPUT_PATH, { generated: new Date().toISOString(), total: data.channels.length, channels: data.channels })
  console.log(`stripped legacyYtId from ${stripped} entries`)
}

main()
