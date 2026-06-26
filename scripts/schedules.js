const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')

// Map config.js schedule key -> workflow file
const SCHEDULE_MAP = [
  { key: 'sync',         file: '.github/workflows/sync.yml'          },
  { key: 'resurrect',    file: '.github/workflows/resurrect.yml'     },
  { key: 'checkAlive',   file: '.github/workflows/check-alive.yml'   },
  { key: 'checkYoutube', file: '.github/workflows/check-youtube.yml' },
]

const root = path.resolve(__dirname, '..')
let changed = 0

for (const { key, file } of SCHEDULE_MAP) {
  const cron = cfg.schedules[key]
  if (!cron) { console.warn(`  ⚠  No schedule for key "${key}" in config.js`); continue }

  const filePath = path.join(root, file)
  if (!fs.existsSync(filePath)) { console.warn(`  ⚠  Workflow not found: ${file}`); continue }

  const original = fs.readFileSync(filePath, 'utf8')

  // Replace the cron line under the schedule: block
  const updated = original.replace(
    /( {4}- cron: ')[^']+(')/,
    (_, pre, post) => `${pre}${cron}${post}`
  )

  if (updated === original) {
    console.log(`  ✓  ${file}  (no change needed — already "${cron}")`)
    continue
  }

  fs.writeFileSync(filePath, updated)
  console.log(`  ✓  ${file}  → cron updated to "${cron}"`)
  changed++
}

console.log(`\n  ${changed} file(s) updated.`)
console.log('  Commit the changed YML files alongside any config.js schedule change.\n')
