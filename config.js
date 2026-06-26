module.exports = {

  sources: {
    iptvChannels:  'https://iptv-org.github.io/api/channels.json',
    iptvStreams:   'https://iptv-org.github.io/api/streams.json',
    iptvBlocklist: 'https://iptv-org.github.io/api/blocklist.json',
    iptvLogos:     'https://iptv-org.github.io/api/logos.json',
  },

  output: {
    channels: 'feeds/merged/channels.json',
    youtube:  'feeds/merged/youtube.json',
    archive:  'feeds/merged/archive.json',
    dead:     'feeds/merged/dead.json',
  },

  schedules: {
    sync:         '0 2 * * 1',
    resurrect:    '0 */4 * * *',
    checkAlive:   '0 */5 * * *',
    checkYoutube: '0 */12 * * *',
  },

  probe: {
    timeoutSeconds:     13,
    retries:            2,
    retryDelaySeconds:  3,
    concurrency:        25,
    segmentConcurrency: 8,
    youtubeConcurrency: 6,
    slowThresholdMs:    8000,
    uptimeScoreMin:     60,
  },

  probeFrequency: {
    noHistory:   0,
    below70:     5,
    from70to80:  8,
    from80to85:  12,
    above85:     24,
  },

  resurrectFrequency: {
    noHistory:          0,
    scoreAbove50:       1,
    scoreAbove20:       30,
    scoreAbove0:        40,
    scoreZeroFewData:   30,
    scoreZeroManyData:  168,
  },

  scoreRecencyWindow: 20,

  sync: {
    mirroredFields: ['logo', 'streamUrls', 'country', 'categories', 'website', 'replaced_by'],
    nameField: 'name',
    defaults: {
      alive:    false,
      probe:    true,
      editName: true,
    },
  },

  retirement: {
    enabled:       true,
    score0DaysMin: 180,
    output:        'feeds/merged/archive.json',
  },

  pruning: {
    enabled:                  true,
    consecutiveFailuresLimit: 100,
    output:                   'feeds/merged/dead.json',
  },

  manualBlocklist: [],

  nameBlocklist: [],

  unplayableDomains: [
    'ncdn.telewebion.ir',
    'telewebion.com',
    'liveingesta318.cdnmedia.tv',
  ],

}
