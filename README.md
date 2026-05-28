# databaseab

A self-updating database of live TV stream channels. Every 6 hours, streams are fetched, probed, and the results committed back automatically.

---

## Output files

| File | Description |
|---|---|
| `feeds/merged/channels.json` | All live channels from the last build |
| `feeds/merged/dead-channels.json` | Channels that failed liveness checks, by source |
| `feeds/merged/diff.json` | IDs added and removed since the previous build |
| `feeds/merged/uptime-history.json` | Per-channel rolling uptime scores across builds |

### Channel object

```json
{
  "id": "CNN.us",
  "name": "CNN",
  "altNames": ["CNN International"],
  "country": "US",
  "logo": "https://...",
  "languages": ["eng"],
  "categories": ["news"],
  "urls": ["https://stream.example.com/cnn.m3u8"],
  "youtubeUrls": [],
  "ytId": null,
  "cat": "news",
  "quality": "1080p",
  "uptime": 94
}
```

| Field | Description |
|---|---|
| `urls` | HLS stream URLs. Empty if the channel is YouTube-only. |
| `youtubeUrls` | YouTube fallback URLs, when available alongside HLS. |
| `ytId` | YouTube channel ID, handle, or video ID. |
| `altNames` | Alternative names from upstream. |
| `quality` | Quality hint from upstream (`1080p`, `720p`, etc.). |
| `uptime` | Rolling uptime percentage across all builds (0–100). |
| `needsProxy` | `true` if the stream is HTTP-only or referrer-locked. |
| `slow` | `true` if response time exceeded the slow threshold. |
| `browserPlayable` | `false` if no CORS header was detected during probing. |

---

## Sources

| Source | Description |
|---|---|
| [iptv-org](https://github.com/iptv-org/iptv) | Open-source IPTV channel and stream database |
| `feeds/youtube/youtube-channels.json` | Curated YouTube live channels |
| `feeds/custom/custom-channels.json` | Hand-picked streams. Absence in iptv-org database is not guaranteed |

---

## Adding a channel

### YouTube channel

`feeds/youtube/youtube-channels.json` format:

```json
{
  "id": "ChannelName.countrycode",
  "name": "Channel Name",
  "ytId": "UCxxxxxxxxxxxxxxxxxxxxxxxx",
  "country": "KE",
  "languages": ["eng"],
  "categories": ["news", "youtube"],
  "cat": "news",
  "logo": "https://..."
}
```

`ytId` accepts a channel ID (`UCxxxxxxx`), a handle (`@channelname`), or a video ID for a permanent livestream.

### Custom stream channel

`feeds/custom/custom-channels.json` format:

```json
{
  "id": "ChannelName.countrycode",
  "name": "Channel Name",
  "country": "KE",
  "languages": ["eng"],
  "categories": ["general"],
  "cat": "general",
  "logo": "https://...",
  "urls": ["https://stream.example.com/live.m3u8"]
}
```

Both files use [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country codes and [ISO 639-3](https://en.wikipedia.org/wiki/ISO_639-3) language codes.

---

## How it works

1. Fetches channel and stream data from iptv-org
2. Probes each stream with HEAD (GET fallback), checking liveness, response time, and CORS
3. Skips channels stable across recent builds; re-probes recently-dead ones
4. Merges surviving streams with the curated YouTube and custom lists
5. Validates logo URLs and nulls any that are broken
6. Commits updated output files and a build diff

All tunables — timeout, concurrency, retry, incremental threshold — are in [`config.js`](./config.js).

---

## Credits

Stream and channel data sourced from [iptv-org](https://github.com/iptv-org/iptv) under their respective licenses.
