# databaseab

A self-updating database of live TV stream channels. Every 6 hours, streams are fetched from three sources, probed for liveness, and the results are committed back to this repository automatically.

---

## Output files

| File | Description |
|---|---|
| `feeds/merged/channels.json` | All live channels from the last build |
| `feeds/merged/dead-channels.json` | Channels that failed liveness checks, broken down by source |

### `channels.json` structure

```json
{
  "generated": "2026-05-26T04:28:20.324Z",
  "total": 5695,
  "channels": [
    {
      "id": "CNN.us",
      "name": "CNN",
      "country": "US",
      "logo": "https://...",
      "languages": ["eng"],
      "categories": ["news"],
      "urls": ["https://stream.example.com/cnn.m3u8"],
      "ytId": null,
      "cat": "news"
    }
  ]
}
```

- `urls` — HLS stream URLs. Empty array if the channel streams via YouTube.
- `ytId` — YouTube channel/video ID. Present only for YouTube-based channels.
- `needsProxy` — present and `true` if the stream requires a proxy (HTTP-only or referrer-locked).

---

## Sources

| Source | Description |
|---|---|
| [iptv-org](https://github.com/iptv-org/iptv) | Large open-source IPTV channel and stream database |
| `feeds/youtube/youtube-channels.json` | Curated list of YouTube live channels |
| `feeds/custom/custom-channels.json` | Hand-picked streams not in iptv-org |

---

## Adding a channel

### YouTube channel
Add an entry to `feeds/youtube/youtube-channels.json`:

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

`ytId` can be a channel ID (`UCxxxxxxx`), a handle (`@channelname`), or a video ID for a permanent livestream.

### Custom stream channel
Add an entry to `feeds/custom/custom-channels.json`:

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
2. Probes every stream URL with a HEAD request (GET fallback) within a timeout window
3. Merges surviving streams with the curated YouTube and custom lists
4. Commits updated `channels.json` and `dead-channels.json` back to the repo

Build settings (timeout, concurrency, retry) are all in [`config.js`](./config.js).

---

## Manual run

Go to **Actions → Build & Check Streams → Run workflow** to trigger a build outside the schedule.

---

## Credits

Stream and channel data sourced from [iptv-org](https://github.com/iptv-org/iptv) under their respective licenses.
