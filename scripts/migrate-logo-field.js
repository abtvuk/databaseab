// scripts/migrate-logo-field.js
// ─────────────────────────────────────────────────────────────────────────────
//  One-time migration: renames 'logo' → 'channelLogo' on every channel
//  in channels.json and removes the old 'logo' key.
//  Safe to run multiple times — idempotent.
//  DELETE this file after running it once.
// ─────────────────────────────────────────────────────────────────────────────

const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')

const filePath = path.resolve(cfg.output.channels)
const raw  = fs.readFileSync(filePath, 'utf8')
const data = JSON.parse(raw)

let migrated = 0

data.channels = data.channels.map(ch => {
  if (!('logo' in ch)) return ch          // already migrated
  const { logo, ...rest } = ch
  migrated++
  return {
    ...rest,
    channelLogo: ch.channelLogo || logo || null,  // preserve existing channelLogo if present
  }
})

data.generated = new Date().toISOString()
fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
console.log(`✓ Migrated ${migrated} channels — 'logo' → 'channelLogo'`)
console.log('  You can now delete scripts/migrate-logo-field.js')
