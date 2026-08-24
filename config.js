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
    blocked:  'feeds/blocked.json',
    deadLinks: 'feeds/deadLinks.json',
  },

  schedules: {
    sync:         '0 2 * * 1',
    resurrect:    '0 */4 * * *',
    checkAlive:   '0 */5 * * *',
    checkYoutube: '0 */6 * * *',
  },

  probe: {
    timeoutSeconds:     12,
    retries:            1,
    retryDelaySeconds:  3,
    concurrency:        24,
    segmentConcurrency: 8,
    youtubeConcurrency: 6,
    slowThresholdMs:    8000,
    uptimeScoreMin:     30,
  },

  probeFrequency: {
    noHistory:   0,
    below70:     5,
    from70to80:  7,
    from80to85:  8,
    above85:     10,
  },

  resurrectFrequency: {
    noHistory:          0,
    scoreAbove50:       10,
    scoreAbove20:       20,
    scoreAbove0:        40,
    scoreZeroFewData:   30,
    scoreZeroManyData:  20,
  },

  scoreRecencyWindow: 100,

  sync: {
    mirroredFields: ['logo', 'streamUrls', 'country', 'categories', 'website', 'replaced_by'],
    nameField: 'name',
    defaults: {
      alive:       false,
      probe:       true,
      editName:    true,
      editCountry: true,
    },
  },

  retirement: {
    enabled:       true,
    score0DaysMin: 180,
    output:        'feeds/archive.json',
  },

  pruning: {
    enabled:   true,
    minProbes: 80,
    output:    'feeds/dead.json',
  },

  linkPruning: {
    enabled:       true,
    minProbes:     80,
    aliveScoreMax: 10,
  },

  manualBlocklist: [],

  linkBlocklist: [],

  nameBlocklist: ['Pluto TV'],

  unplayableDomains: [
    'cdn.qd.je',
    'ncdn.telewebion.ir',
    'ott.watch',
    'Paradise-91/ParaTV/main/streams/equidia/live2',
    'shd-gcp-live.edgenextcdn.net',
    'sra72yz.s.gy',
    'srs.unsj.edu.ar',
    'telewebion.com',
    'tglmp04',
    'tglmp04.akamaized.net',
    '40.160.24.55',
    '77.46.130.252',
    '78.108.244.134',
    '83.228.75.166',
    '103.72.101.252',
    '103.175.73.12',
    '103.253.18.58',
    '167.250.126.140',
    '202.150.161.117',
    '202.169.224.202',
    '206.212.244.63',
    '212.70.131.37',
    '213.91.179.28',

    // Too flaky
    '181.78.197.59',
    '190.83.2.182',

    // Geo Blocked
    'adpnetworkhd-cmd.github.io',
    'amg12058-c15studio-amg12058c1-lg-us-5787.playouts.now.amagi.tv',
    'zabava-htlive.cdn.ngenix.net',
  ],

  unsupportedVideoCodecs: [
    'hevc', 'h265',
    'mpeg2video', 'mpeg1video',
    'vc1', 'wmv1', 'wmv2', 'wmv3',
    'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3',
    'flv1', 'rv10', 'rv20', 'rv30', 'rv40',
  ],

  criticalChannels: [
    'live.elheddaftv.com',
    'livesstream.work.gd',
    'jmp2.uk',
    'janya-digimix.akamaized.net',
  ],

}
