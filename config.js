// ─────────────────────────────────────────────────────────────────────────────
//  databaseab — central configuration
//  All tunables live here. Every value here maps to a workflow behaviour.
//  Change a value, commit — the next run picks it up automatically.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {

  // ── SOURCES ────────────────────────────────────────────────────────────────
  sources: {
    // iptv-org public API endpoints (do not change unless iptv-org moves them)
    iptvChannels:  'https://iptv-org.github.io/api/channels.json',
    iptvStreams:   'https://iptv-org.github.io/api/streams.json',
    iptvBlocklist: 'https://iptv-org.github.io/api/blocklist.json',
    iptvLogos:     'https://iptv-org.github.io/api/logos.json',

  },

  // ── OUTPUT ─────────────────────────────────────────────────────────────────
  output: {
    channels: 'feeds/merged/channels.json',
    youtube:  'feeds/merged/youtube.json',
  },

  // ── SCHEDULES (cron, UTC) ──────────────────────────────────────────────────
  // Change any of these and mirror the value in the corresponding .yml file.
  // '0 2 * * 1'    = every Monday at 02:00 UTC
  // '0 */4 * * *'  = every 4 hours
  // '0 */8 * * *'  = every 8 hours
  // '0 */12 * * *' = every 12 hours
  // '0 3 * * *'    = once daily at 03:00 UTC
  schedules: {
    sync:       '0 2 * * 1',   // weekly sync from iptv-org (Monday 02:00 UTC)
    resurrect:  '0 */4 * * *', // dead channel resurrection — every 4 hours
    checkAlive: '0 */5 * * *', // alive channel check — every 5 hours (base cadence)
    checkYoutube: '0 */12 * * *',
                               // individual channels override this via uptime score below
  },

  // ── PROBE SETTINGS ─────────────────────────────────────────────────────────
  probe: {
    timeoutSeconds:    7,  // seconds before a stream probe is aborted
    retries:            0,  // retry attempts after first failure (0 = no retry)
    retryDelaySeconds:  2,  // seconds to wait between retries
    concurrency:       35,  // simultaneous probes
    segmentConcurrency: 8, 
    youtubeConcurrency: 6,
    slowThresholdMs:  8000, // ms above which a channel is flagged { slow: true }
    uptimeScoreMin:    60,  // channels with score below this are hidden from consumers (null = no history, always shown)
  },

  // ── UPTIME-BASED PROBE FREQUENCY ───────────────────────────────────────────
  // Controls how often alive channels are re-probed based on their uptime score.
  // Score = (aliveCount / totalCount) * 100, null if no history yet.
  // Channels with no history are always probed (can't trust without data).
  // Hours are "minimum gap since lastProbed before probing again".
  probeFrequency: {
    noHistory:       0,   // always probe (no history = no trust)
    below70:         5,   // score < 70%  → probe if last check was > 5h ago
    from70to80:      8,   // score 70–79% → probe if last check was > 8h ago
    from80to85:     12,   // score 80–84% → probe if last check was > 12h ago
    above85:        24,   // score ≥ 85%  → probe if last check was > 24h ago
  },

  // ── RESURRECT PROBE FREQUENCY ──────────────────────────────────────────────
  // Controls how often dead channels are retried based on their history.
  // Channels with no history are always tried (brand-new / first-seen dead).
  // Hours are "minimum gap since lastProbed before trying again".
  // This prevents the 4-hour resurrect run from re-probing 3000+ hopeless
  // channels every single time — the worst offenders get throttled way back.
  resurrectFrequency: {
    noHistory:          0,   // always try (no data = give it a chance)
    scoreAbove50:       8,   // score ≥ 50% — recently degraded, check often
    scoreAbove20:      24,   // score 20–49% — struggling, once a day
    scoreAbove0:       48,   // score 1–19%  — almost always dead, every 2 days
    scoreZeroFewData:  24,   // score 0%, totalCount ≤ 10 — too early to write off
    scoreZeroManyData: 72,   // score 0%, totalCount > 10 — consistently dead, every 3 days
  },

  // ── SCORE RECENCY WINDOW ───────────────────────────────────────────────────
  // How many of the most recent probe results to weight more heavily when
  // computing a channel's effective score. Older results still count but at
  // half weight, so a channel dead for the last 50 checks doesn't hide behind
  // a good distant history.
  // Set to 0 to disable recency weighting (use raw ratio).
  scoreRecencyWindow: 20,

  // ── SYNC BEHAVIOUR ─────────────────────────────────────────────────────────
  sync: {
    // Fields mirrored from iptv-org on every sync run (for all channels)
    mirroredFields: ['logo', 'streamUrls', 'country', 'categories', 'website', 'replaced_by'],

    // Fields mirrored only when editName: true on the channel
    nameField: 'name',

    // Default values assigned to brand-new channels added from iptv-org
    defaults: {
      alive:    false,  // new channels start unverified
      probe:    true,   // probed by default; set false manually to exclude
      editName: true,   // iptv-org can update the name; set false to lock your edit
    },
  },

  // ── MANUAL CHANNEL BLOCKLIST ───────────────────────────────────────────────
  // Hand-picked channel IDs to never serve to users, regardless of alive status.
  // Use iptv-org channel IDs (e.g. 'PlutoTV.us', 'CNN.us').
  // These are merged with the NSFW blocklist at sync time.
  manualBlocklist: [
    // 'PlutoTV.us',
    // 'ExampleChannel.uk',
  ],

  // ── NSFW / NAME BLOCKLIST ──────────────────────────────────────────────────
  // Channels whose name contains any of these strings are excluded entirely.
  // Case-insensitive. Extend as needed.
  nameBlocklist: [
    'ABN', 'NTD',
  ],

  // ── UNPLAYABLE DOMAIN BLOCKLIST ────────────────────────────────────────────
  // Domains that use token-expiry, signed URLs, or other mechanisms that make
  // streams appear alive at probe time but always fail in a real browser.
  // Channels on these domains are flagged { browserUnplayable: true } regardless
  // of probe result. Add domains here as new patterns are discovered.
  unplayableDomains: [
    'ncdn.telewebion.ir',   // token-expiry signed URLs — expire before user clicks
    'telewebion.com',       // same CDN network
    'liveingesta318.cdnmedia.tv',
  ],

}
