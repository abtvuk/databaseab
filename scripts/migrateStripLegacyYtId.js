const cfg = require('../config')
const path = require('path')
const { saveFeedFormatted } = require('./probe')
const { readYoutube, writeYoutube } = require('./youtubeFeed')
const fs = require('fs')

function main() {
  const data = readYoutube()
  let stripped = 0

  for (const c of data.channels || []) {
    if ('legacyYtId' in c) { delete c.legacyYtId; stripped++ }
  }

  writeYoutube(data.channels)
  console.log(`stripped legacyYtId from ${stripped} entries`)
}

main()
