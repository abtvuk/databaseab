# databaseab

An autonomous database of live TV stream channels.
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
