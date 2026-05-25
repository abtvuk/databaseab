// ─────────────────────────────────────────────
//  databaseab — central configuration
//  All tunables live here. Touch nothing else.
// ─────────────────────────────────────────────

module.exports = {

  // ── SCHEDULE ──────────────────────────────
  // How often the merge + check workflow runs.
  // Standard cron syntax (UTC).
  // '0 */6 * * *'  = every 6 hours
  // '0 */12 * * *' = every 12 hours
  // '0 2 * * *'    = once daily at 02:00 UTC
  schedule: '0 */6 * * *',

  // ── SOURCES ───────────────────────────────
  sources: {
    iptv:    'https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/iptv/live-channels.json',
    youtube: 'https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/youtube/youtube-channels.json',
    custom:  'https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/custom/custom-channels.json',
  },

  // ── OUTPUT PATHS ──────────────────────────
  output: {
    merged: 'merged/channels.json',
    dead:   'merged/dead-channels.json',
  },

  // ── STREAM CHECKING ───────────────────────
  check: {
    // Max seconds ffprobe waits per URL before giving up
    timeoutSeconds: 8,

    // How many times to retry a URL before marking it dead
    retries: 2,

    // How many streams to check at the same time
    concurrency: 40,

    // Seconds to wait between retries
    retryDelaySeconds: 2,
  },

}
