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
    youtube: 'https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/feeds/youtube/youtube-channels.json',
    custom:  'https://raw.githubusercontent.com/savvydarknight/databaseab/refs/heads/main/feeds/custom/custom-channels.json',
  },

  output: {
    merged: 'feeds/merged/channels.json',
    dead:   'feeds/merged/dead-channels.json',
    diff:   'feeds/merged/diff.json',
  },

  // ── STREAM CHECKING ───────────────────────
  check: {
    // Max seconds ffprobe waits per URL before giving up
    timeoutSeconds: 15,

    // How many times to retry a URL before marking it dead
    retries: 2,

    // How many streams to check at the same time
    concurrency: 20,

    // Seconds to wait between retries
    retryDelaySeconds: 3,

    // Max ms a stream response may take before being flagged as slow
    // Slow streams are still included but tagged { slow: true }
    slowThresholdMs: 8000,
  },

  // ── INCREMENTAL PROBING ───────────────────
  // Channels confirmed alive for this many consecutive builds are
  // skipped on the current build and carried forward unchanged.
  // Set to 0 to always probe everything.
  stableBuildsThreshold: 3,

  // ── DEAD-CHANNEL RESURRECTION ─────────────
  // Channels that died within this many builds ago are re-probed
  // even if they are absent from the current upstream fetch.
  resurrecAfterBuilds: 3,

  // ── LOGO VALIDATION ───────────────────────
  // HEAD-check logo URLs and null them out if dead.
  // Adds one extra HEAD request per channel with a logo.
  checkLogos: true,

  // ── NAME BLOCKLIST ────────────────────────
  // Channel names containing any of these strings (case-insensitive)
  // are excluded regardless of source. Extend as needed.
  nameBlocklist: [
    'ABN', 'NTD',
  ],

}
