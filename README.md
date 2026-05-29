# databaseab

> A unified, self-updating database of live TV channels and radio stations from around the world.

Powered by automated workflows that sync weekly from upstream sources, verify stream availability, and maintain a single structured dataset — all without manual intervention.

---

## What's inside

**Entries** across three media types, all in one file:

- Live TV channels (HLS streams + YouTube live)
- Radio stations
- Curated YouTube channels

---

## How it works

Three independent workflows run on schedule:

Channels pull from sources, mirrors updated fields, adds new entries, Channels probe separating live and dead ones.

All workflows commit directly to this repo. No manual steps required.

---

## Output

Everything lives in one file: `feeds/merged/channels.json`

---

## Channel object

```json
{
  "id": "CNN.us",
  "name": "CNN",
  "editName": true,
  "alive": true,
  "probe": true,
  "tv": true,
  "radio": false,
  "country": "US",
  "channelLogo": "https://...",
  "languages": ["eng"],
  "categories": ["news"],
  "streamUrls": ["https://stream.example.com/cnn.m3u8"],
  "ytId": null,
  "website": "https://cnn.com",
  "replaced_by": null,
  "geoBlocked": false,
  "source": "iptv",
  "nanoid": null,
  "uptime": {
    "aliveCount": 48,
    "totalCount": 50,
    "consecutiveAlive": 12,
    "lastSeen": "2026-05-29T08:00:00.000Z",
    "lastProbed": "2026-05-29T08:00:00.000Z",
    "score": 96
  }
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique channel identifier. Matches iptv-org ID where applicable. |
| `name` | string | Display name. |
| `editName` | boolean | `false` locks the name from being overwritten during sync. |
| `alive` | boolean | Whether the channel is currently reachable. |
| `probe` | boolean | `false` excludes the channel from all probing workflows. Manual switch. |
| `tv` | boolean | `true` for television channels. |
| `radio` | boolean | `true` for radio stations. |
| `country` | string | ISO 3166-1 alpha-2 country code. |
| `channelLogo` | string \| null | Logo URL. |
| `languages` | string[] | ISO 639-3 language codes. |
| `categories` | string[] | Content categories (e.g. `news`, `sports`, `radio`, `youtube`). |
| `streamUrls` | string[] | HLS stream URLs. Empty for YouTube-only channels. |
| `ytId` | string \| null | YouTube video or stream ID. Set for YouTube channels. |
| `website` | string \| null | Official channel website. |
| `replaced_by` | string \| null | ID of the channel that replaced this one, if applicable. |
| `geoBlocked` | boolean | `true` if the stream is region-restricted. |
| `source` | string \| null | Where the channel came from: `"iptv"`, `"famelack"`, or `null` for hand-curated entries. |
| `nanoid` | string \| null | Famelack's internal ID. Present only on famelack-sourced channels. |
| `uptime.score` | number \| null | Rolling availability percentage (0–100). `null` if not yet probed. |
| `uptime.lastProbed` | string \| null | ISO timestamp of the last probe attempt. |
| `uptime.lastSeen` | string \| null | ISO timestamp of the last successful probe. |

---

## Sources

Our channels and stream data is a beneficiary of the larger community (-ies):

- [iptv-org](https://github.com/iptv-org/iptv) — the largest open-source IPTV channel database, maintained by a global community.
- [Famelack](https://github.com/famelack/famelack-data) — a curated dataset of live TV and radio stations powering [famelack.com](https://famelack.com), released under the MIT License.
