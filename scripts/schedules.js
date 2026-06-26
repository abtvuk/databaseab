const cfg  = require('../config')
const fs   = require('fs')
const path = require('path')

const SCHEDULE_MAP = [
  { key: 'sync',         file: '.github/workflows/sync.yml'      },
  { key: 'resurrect',    file: '.github/workflows/resurrect.yml' },
  { key: 'checkAlive',   file: '.github/workflows/alive.yml'     },
  { key: 'checkYoutube', file: '.github/workflows/youtube.yml'   },
]

const root = path.resolve(__dirname, '..')
let changed = 0

for (const { key, file } of SCHEDULE_MAP) {
  const cron = cfg.schedules[key]
  if (!cron) { console.warn(`no schedule for key "${key}"`); continue }

  const filePath = path.join(root, file)
  if (!fs.existsSync(filePath)) { console.warn(`not found: ${file}`); continue }

  const original = fs.readFileSync(filePath, 'utf8')

  const updated = original.replace(
    /( {4}- cron: ')[^']+(')/,
    (_, pre, post) => `${pre}${cron}${post}`
  )

  if (updated === original) {
    console.log(`unchanged: ${file}`)
    continue
  }

  fs.writeFileSync(filePath, updated)
  console.log(`updated: ${file}  →  "${cron}"`)
  changed++
}

console.log(`${changed} file(s) updated`)
