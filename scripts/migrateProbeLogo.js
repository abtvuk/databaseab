const cfg = require('../config')
const path = require('path')
const { saveFeedFormatted } = require('./probe')
const { readYoutube, writeYoutube } = require('./youtubeFeed')
const fs = require('fs')

function main() {
  const data = readYoutube()
  let curated = 0, toFill = 0

  for (const c of data.channels || []) {
    if (!c.ytId) continue
    if (c.channelLogo) { c.probeLogo = false; curated++ }
    else               { c.probeLogo = true;  toFill++ }
  }

  writeYoutube(data.channels)
  console.log(`probeLogo migration: curated (false)=${curated}  toFill (true)=${toFill}`)
}

main()
