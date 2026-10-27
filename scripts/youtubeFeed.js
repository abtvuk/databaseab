const fs = require('fs')
const path = require('path')
const cfg = require('../config')
const { saveFeedFormatted } = require('./probe')

function isWebcam(c) {
  return Array.isArray(c.categories) && c.categories.includes('webcam')
}

function readFile(p) {
  return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'))
}

function readYoutube() {
  const tv = readFile(cfg.output.youtubeTv)
  const webcams = readFile(cfg.output.youtubeWebcams)
  const generated = [tv.generated, webcams.generated].filter(Boolean).sort().pop() || null
  const channels = [...(tv.channels || []), ...(webcams.channels || [])]
  return { generated, total: channels.length, channels }
}

function splitYoutube(channels) {
  const tv = []
  const webcams = []
  for (const c of channels) (isWebcam(c) ? webcams : tv).push(c)
  return { tv, webcams }
}

function writeYoutube(channels, write = saveFeedFormatted) {
  const { tv, webcams } = splitYoutube(channels)
  const generated = new Date().toISOString()
  write(path.resolve(cfg.output.youtubeTv), { generated, total: tv.length, channels: tv })
  write(path.resolve(cfg.output.youtubeWebcams), { generated, total: webcams.length, channels: webcams })
  return { tv: tv.length, webcams: webcams.length }
}

module.exports = { isWebcam, readYoutube, splitYoutube, writeYoutube }
