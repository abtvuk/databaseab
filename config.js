module.exports = {

  sources: {
    iptvChannels:  'https://iptv-org.github.io/api/channels.json',
    iptvStreams:   'https://iptv-org.github.io/api/streams.json',
    iptvBlocklist: 'https://iptv-org.github.io/api/blocklist.json',
    iptvLogos:     'https://iptv-org.github.io/api/logos.json',
  },

  output: {
    channels: 'feeds/channels.json',
    youtube:  'feeds/youtube.json',
    archive:  'feeds/archive.json',
    dead:     'feeds/dead.json',
  },

  schedules: {
    sync:         '0 2 * * 1',
    resurrect:    '0 */4 * * *',
    checkAlive:   '0 */5 * * *',
    checkYoutube: '0 */6 * * *',
  },

  probe: {
    timeoutSeconds:     15,
    retries:            1,
    retryDelaySeconds:  3,
    concurrency:        25,
    segmentConcurrency: 8,
    youtubeConcurrency: 6,
    slowThresholdMs:    8000,
    uptimeScoreMin:     30,
  },

  probeFrequency: {
    noHistory:   0,
    below70:     6,
    from70to80:  9,
    from80to85:  11,
    above85:     13,
  },

  resurrectFrequency: {
    noHistory:          0,
    scoreAbove50:       10,
    scoreAbove20:       20,
    scoreAbove0:        40,
    scoreZeroFewData:   30,
    scoreZeroManyData:  60,
  },

  scoreRecencyWindow: 100,

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
    output:        'feeds/archive.json',
  },

  pruning: {
    enabled:                  true,
    consecutiveFailuresLimit: 100,
    output:                   'feeds/dead.json',
  },

  manualBlocklist: [],

  nameBlocklist: [],

  unplayableDomains: [
    'ncdn.telewebion.ir',
    'telewebion.com',
    'liveingesta318.cdnmedia.tv',
    '213.91.179.28',
    '77.46.130.252',
    '83.228.75.166',
    '185.9.2.18',
    '91.146.94.234',
    '103.175.73.12',
    '103.72.101.252',
  ],

  unsupportedVideoCodecs: [
    'hevc', 'h265',
    'mpeg2video', 'mpeg1video',
    'vc1', 'wmv1', 'wmv2', 'wmv3',
    'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3',
    'flv1', 'rv10', 'rv20', 'rv30', 'rv40',
  ],

}
