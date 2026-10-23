# StreamVoid — serverless YouTube front-end + custom player

`index.html` (whole app, one file) + `worker.js` (Cloudflare Worker, free tier).
**No API key. No Google login. No Piped/Invidious. No server/VPS. No YouTube iframe.**
Search · Trending · **Shorts** · **RSS subscriptions** · watch page · hand-built player.

---

## Why a worker at all? (the honest bit)

A browser cannot talk to YouTube directly, for two reasons:

1. **CORS** — `youtube.com/youtubei/*` sends no `Access-Control-Allow-Origin`, so `fetch()` from a page is blocked.
2. **IP-bound streams** — the `googlevideo.com` URLs in a player response are signed for the IP that requested
   them. Even with a CORS proxy, the URL dies when played from your machine.

A Cloudflare Worker (free, serverless, no machine to maintain) solves both: it calls YouTube's own InnerTube
API and proxies the media bytes. That replaces Piped/Invidious completely — no third-party video infra.

Playback stays 100% custom: a plain `<video>` element with our own YouTube-style chrome.

---

## Setup (2 minutes, once)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create Worker** → Deploy.
2. Open **Edit code**, paste all of `worker.js`, **Deploy**.
3. Open `https://<your-worker>.workers.dev/` → worker ka status page (saari routes ki list), ya
   `https://<your-worker>.workers.dev/api/health` → `{"ok":true,...}`
4. Open StreamVoid → **Settings → YouTube engine** → paste the worker URL → **Save & test**.
   The dot turns green and full search/trending/playback goes live.

`index.html` can be hosted anywhere static (GitHub Pages, Netlify, S3, or just opened locally).

---

## What the worker does

| Route | Purpose |
| --- | --- |
| `GET /` | status page: worker running, links to every route (`?format=json` for machines). Never a 404 |
| `GET /api/health` | connection check, **`build`** (which worker version is live), discovered client versions, cookie state |
| `GET /api/probe?q=&endpoint=search\|browse` | debug aid: per-client top-level keys, renderer histogram, parsed count, capped raw sample — use it when YouTube changes shape |
| `GET /api/debug` | full client ladder + version sources (`?refresh=1` re-discovers) |
| `GET /api/selftest?id=` | end-to-end check: which pass/client worked, ms, breaker state |
| `GET /api/search?q=` | InnerTube `search` → normalized video list (+ continuation token) |
| `GET /api/searchmore?q=&token=` | next page |
| `GET /api/trending?region=IN` | InnerTube `browse` `FEtrending` |
| `GET /api/shorts?region=IN` | Shorts feed: `browse` `FEshorts` (`shortsLockupViewModel` + `reelItemRenderer`), falling back to `#shorts` search, then to short items in trending |
| `GET /api/player?id=` | InnerTube `player` with a client ladder (android_vr → ios → tv_embedded → android → mweb → web), picks muxed MP4, rewrites URLs to the proxy |
| `GET /api/related?id=` | InnerTube `next` → Up next list |
| `GET /api/rss?channels=UC…,UC…` | fetch + merge YouTube RSS feeds for up to 30 channels → `{items, channels, errors}` (dedupe, newest first, per-channel failure isolated) |
| `GET /api/channel?q=` | resolve anything you paste (`@handle`, `/channel/UC…`, `/c/name`, bare `UC…`) → `{channelId, name, avatar}` |
| `GET /api/media?u=` | **Range-aware** byte proxy for `googlevideo.com` (host allowlist) |
| `GET /mp4/<id>.mp4` | direct file endpoint: resolves the best muxed stream and serves it as `video/mp4` (Range/HEAD supported). `?itag=` picks a quality, `?dl=1` forces a download |
| `GET /api/file/<id>.mp4` | same as above (alias) |

Unknown paths return a JSON 404 that tells you *what* you asked for and lists every valid route
(`{error:"not found", detail:{path, routes, hint, didYouMean}}`). A trailing slash is tolerated
(`/api/health/` works), and `/favicon.ico` is a quiet 204.

**Parsing is shape-tolerant.** YouTube keeps moving list data between renderers. `normalizeList()` reads every
renderer it knows (`videoRenderer`, `compactVideoRenderer`, `gridVideoRenderer`, `playlistVideoRenderer`,
`videoWithContextRenderer`) **and** the 2025/26 `lockupViewModel`, then — if none match — falls back to a
generic scan that finds any object carrying a plausible 11-char video id and rebuilds the item from the strings
and thumbnails in that subtree. Bad id → dropped; duplicates → merged. If lists ever come back empty again,
`/api/probe` prints what shape YouTube is serving so it can be taught in one line.

Signature handling: if a format comes back as `signatureCipher`, the worker fetches the video's `base.js`,
extracts the sig and `n` transform functions and applies them (`buildDecipher`). Plain `url` formats skip all of that.

**Why isn't the player handed a raw `.mp4` link?** Because `googlevideo.com` URLs are signed for the IP that
requested them — a link minted by the worker 403s in your browser. So `/api/player` returns
`/api/media?u=…` (the proxy) and there is a separate human-friendly `/mp4/<id>.mp4` endpoint for the same bytes:

```
https://<worker>/mp4/dQw4w9WgXcQ.mp4              → inline video/mp4 (works in a tab, <video>, VLC, ffmpeg)
https://<worker>/mp4/dQw4w9WgXcQ.mp4?dl=1         → attachment download
https://<worker>/mp4/dQw4w9WgXcQ.mp4?itag=18      → pick a specific quality
```

---

## Subscriptions = channel feeds (no account, no login)

Subscribe to a channel once and its uploads show up in your Subscriptions page. No Google account, no OAuth,
no API key.

**Heads-up (Oct 2026): YouTube retired its RSS endpoint.** `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`
now returns **404** for every channel (`?playlist_id=` too). So the worker tries the feed first, and when it is
gone it reads the channel's **Videos tab through InnerTube** and rebuilds the exact same shape — same fields,
same sorting, no login, still keyless. The feed is retried every 6 hours, so the moment YouTube brings it back
the worker goes back to real RSS without a code change. `/api/rss` reports which path was used per channel:

```json
{ "items": [...], "channels": [...], "errors": [],
  "sources": { "UCxxxx": "feed", "UCyyyy": "innertube" },
  "feedDead": true }
```

Only one 404 retires the feed *after* the channel listing proves the channel exists — a typo'd channel id can't
fool it. The InnerTube path costs 1 request per channel (the feed path is 1 too), so the quota math is unchanged.

Why the worker has to proxy all of this: the feed sends no CORS header, and InnerTube has no CORS at all, so a
page can't read either directly. `/api/rss?channels=A,B,C` fetches everything **in parallel** (8s timeout each),
merges, dedupes by video id, sorts newest-first and caps the result. If one channel fails you still get the rest —
the failure is listed in `errors[]` and the UI shows a small warning instead of an empty page.

One trade-off on the InnerTube path: it gives *"2 hours ago"* instead of a real timestamp, so the worker parses
the relative text and stores an approximate epoch (it keeps YouTube's order), which is what the day-grouping in
the Subscriptions page uses.

In the app:

- **Subscribe** — button under any video, on the channel page, or **Add channel** in the sidebar
  (paste `@mkbhd`, a channel URL, or a `UC…` id — `/api/channel` resolves it; name + avatar come back too).
- **Subscriptions page** — day-grouped feed (*Today / Yesterday / date*) across every channel you follow,
  with a channel rail on the left showing avatars and a per-channel filter.
- **Channel page** — banner, avatar, handle, subscriber line, subscribe/unsubscribe, and its uploads.
- **Manage** — Settings → Subscriptions: remove individual channels, **Export OPML**
  (`streamvoid-subscriptions.opml`) and **Import OPML** (drops the file in, it pulls the `channel_id`s out and
  subscribes). OPML stays as the standard interchange format — note that reading the exported feeds in a
  third-party RSS reader depends on YouTube's endpoint coming back, which is why this app fetches through the
  worker instead.
- Subscriptions live in `localStorage` (`sv_subs`) — nothing about you leaves the browser.

Refreshing is on demand (pull-to-refresh / the refresh button): 1 request per channel, so a 20-channel
check costs 20 of your 100k daily worker requests. There is no background polling to burn quota.

---

## Recommendations

The Up-next list is built on the client, from four signals — no recommendation service, no tracking:

| Signal | Source | Weight |
| --- | --- | --- |
| What YouTube itself pairs with this video | `/api/related` (`next` endpoint) | highest base |
| Channels you actually watch | local watch history → top 6 authors → `/api/rss` | high, +8 per past view |
| Subscriptions (any source) | subscription list | +10 flat |
| More from the current channel | the same RSS call (current `authorId` included) | high |
| Freshness & popularity | `published` (feed) + `viewCount` | recency decays over a day, log-scaled views |

Items are merged, deduped, scored and sorted (top 20) — then each card says *why* it is there:
*Because you watch X*, *More from X*, *From a channel you follow*, *Related to this video*, *Trending now*.
Cold start (no history, no subs) falls back to related + trending, so the rail is never empty.
Results are cached for 5 minutes per video, so replaying the rail costs nothing.

Home gets a **Recommended for you** rail built the same way once you have any history or subscriptions
(`recommendHome()`), with subscriptions and frequent channels weighted first.

Shorts are filtered out of the watch-page rail (long-form context), and the video you are already
watching is always excluded.

---

## Shorts

Shorts are just normal videos, so playback needs nothing new: `/api/shorts` gives the list, `/api/player`
gives the stream, `/api/media` proxies it. The worker parses **both** shapes YouTube uses:

- `shortsLockupViewModel` (current): `entityId: "shorts-shelf-item-<id>"`, `overlayMetadata` (title + views),
  `thumbnailViewModel.image.sources` — the biggest source wins, and the id is validated before it is kept
- `reelItemRenderer` (older): `videoId`, `headline`, `viewCountText`, `thumbnail.thumbnails`

The feed ladder, in order:

1. `browse` → `FEshorts` (the real Shorts tab)
2. `search` → `#shorts`, then keep only items shorter than 90s (this is also how a normal search result
   becomes a Short)
3. `trending` → filter to ≤90s

Every step is isolated, `attempts` records what each one found, and the fallback steps deliberately ignore
the circuit breakers (`ignoreCooling`) so two dead sources don't kill the third. If you see a Short in a
normal list, `lengthSeconds ≤ 60` marks it (`isShort`) and the thumbnail gets a **Shorts** pill.

In the app:

- **Shorts** in the sidebar → full-height cards, one at a time, scroll-snap (wheel/trackpad) plus
  `↑`/`↓` / `j`/`k` to move, `m` to mute. Only the visible card (and the next one) resolves a stream, so
  opening Shorts costs 1–2 `/api/player` calls, not one per card.
- Autoplay starts **muted** (browsers block unmuted autoplay); tap the speaker or press `m` for sound.
- Subscribe / like / share / "open watch page" sit on the card — the channel id comes from the resolved
  player response when the lockup doesn't carry one.
- Home gets a **Shorts shelf** (horizontal rail) above the grid, and any short video in a normal grid shows
  the Shorts pill.

---

## Stays alive without you touching it

| Breaks over time | How the worker handles it |
| --- | --- |
| **Breakers tripped by one endpoint** | The first attempt honours a cooldown; the self-heal round **ignores** cooldowns (and re-discovers versions), so a warm breaker from another route can't blank search/trending/RSS. |
| **Client versions go stale** (the #1 cause of breakage) | `discoverVersions()` fetches `youtube.com`'s HTML for the current `INNERTUBE_CLIENT_VERSION` and yt-dlp's `_base.py` for the mobile/TV versions — cached 6h (Cache API, falls back to a plain fetch). Every client is tried **twice**: discovered version, then the baked-in fallback. |
| **Signature / `n` algorithm changes** | `buildDecipher()` extracts the functions from the *current* `base.js` at runtime — nothing hardcoded. |
| **Renderer JSON reshuffles** | `collect()` walks the tree recursively instead of relying on fixed paths. |
| **Everything fails at once** | `/api/health` reports the versions it's using, `/api/debug` shows the full ladder + cookie state, and the player surfaces the per-client reasons (e.g. `android_vr@1.62.27: LOGIN_REQUIRED`). |

Optional hard override (no redeploy needed for version bumps):

```bash
npx wrangler secret put CLIENT_VERSIONS
# {"ANDROID":"19.50.1","IOS":"20.10.4"}
```

### Four-pass playback (self-healing)

| Pass | What | When |
| --- | --- | --- |
| 1 | anonymous client ladder (9 clients × 2 versions, breaker-aware, 25s budget) | always |
| 2 | **self-heal**: force re-discovery of versions + `visitorData`, ignore breakers, retry | pass 1 failed |
| 3 | authenticated retry (`android`, `web`, `ios`, `tv_embedded`, `web_embedded` + `SAPISIDHASH`) | pass 2 failed **and** `SV_KEY` matched |
| 4 | emergency mirrors (`EMERGENCY_MIRRORS`, Invidious `local=true` only) | everything else failed |

Extra guards:

- **Circuit breaker** per `client@version` — a combination YouTube just rejected is skipped for 40s → 5min,
  so one broken client can't slow every request.
- **`visitorData`** is scraped from `youtube.com` and sent with each request (helps against soft bot checks).
- **`PO_TOKEN`** secret, if you have one, is attached as `serviceIntegrityDimensions`.
- **Retries with jittered backoff** on 429/5xx/network (`fetchRetry`).
- **Media proxy self-repair**: if a signed URL expires mid-playback (403/410), the worker re-runs the
  player pipeline, swaps in a fresh URL and retries the range request; the response carries
  `x-sv-refreshed: 1`. The app also re-requests `/api/player` automatically on a media error.
- **`/api/selftest?id=…`** runs the whole pipeline and reports timing, which pass succeeded, and breaker state.

Emergency mirrors are **off unless you set them** (you asked for no Piped/Invidious by default):

```bash
npx wrangler secret put EMERGENCY_MIRRORS   # https://inv.example.com
```

### Optional: cookies for age-restricted / members-only videos

Cookies are **worker-side secrets only** — never in the browser, never in Settings:

```bash
npx wrangler secret put YT_COOKIES   # "SID=...; HSID=...; SSID=...; SAPISID=..." (or Netscape cookies.txt)
npx wrangler secret put SV_KEY       # any random string; required to unlock cookie use
```

Then paste the same `SV_KEY` value into the app under **Settings → Access key**.

Behaviour:

1. Pass 1 always tries every client **without** cookies (public videos, zero account risk).
2. Only if that fails, pass 2 retries `android`, `web`, `ios`, `tv_embedded` **with** cookies
   (`web` also gets a computed `SAPISIDHASH`).
3. Cookies are ignored entirely unless the request carries the correct `SV_KEY`, so a public worker
   URL can't be used to ride your Google account.

Notes: use a **throwaway Google account** (YouTube ToS discourages this), cookies expire after
~1–2 years or on password/2FA change, and "confirm you're not a bot" issues are usually PoToken,
which cookies do not fully solve.

---

## The player (hand-built)

- Big centre play, auto-hiding gradient controls, buffered + played bars, scrub tooltip on hover, drag-to-seek.
- Volume slider, mute, current/total time, quality menu, theater mode, fullscreen.
- **Speed 0.25×–3×** in ten steps, with an on-screen `2×` badge whenever you are not at normal speed.
- **Pitch control** — *Preserve pitch* (default, voices stay natural at any speed) or *Varispeed*
  (tape-style, pitch follows speed), toggled in the player or in Settings.
- **Zoom / fit** — *Fit to screen* (contain), *Fill (crop)* (cover), or 125% / 150% / 200% zoom, from the
  player's zoom button (`z`), the settings menu, or as a default in Settings. Badge shows the current mode.
- Keyboard: `space`/`k` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume · `<`/`>` speed step ·
  `z` zoom · `m` mute · `f` fullscreen · `t` theater · `n` next · `0`–`9` jump to %
- Double-click = fullscreen, click = play/pause, "tap to play" overlay when a browser blocks autoplay.
- Quality switching keeps your position; autoplay pushes the next Up-next video on end.
- Errors are specific (unsupported format / network / decode) with Retry + "Open on YouTube".

UI is a YouTube-style shell: collapsible sidebar, chips, hover cards with duration badges, watch page with
like/share/save pills, channel row, expandable description, and the Up next rail with an autoplay toggle.

---

## Local preview (no worker needed)

```bash
node dev-server.mjs        # http://localhost:3000
```

This serves the real app, but answers `/api/*` with mock data and Google's public sample MP4s, so you can
click through the whole UI and player. It is a preview tool only — production uses your worker.

---

## Known limits

- Worker returns **muxed** formats only (usually 360p/720p). Higher resolutions come as separate video/audio
  DASH tracks and would need MSE muxing in the browser.
- Live streams and some age-restricted / members-only / region-locked videos return no muxed stream; the
  player then offers "Open on YouTube".
- YouTube's bot checks (`PoToken`) can reject a client on some networks; the ladder + cookies cover most cases,
  and the worker always reports what it tried. If all fail, `Retry` after a moment or from another network.
- Version discovery + 4-pass fallback make breakage rare and recoverable, but **"never breaks" is not a thing**:
  YouTube can change the cipher/player flow in a way that needs a code patch. What this setup does give you is
  graceful degradation (a dead client is skipped, playback self-heals, mirrors are the last resort) instead of
  a blank screen.
- Subscriptions: YouTube killed `feeds/videos.xml` in Oct 2026. The worker now falls back to the channel's
  Videos tab (InnerTube), which gives relative dates ("2 hours ago") — day grouping uses an approximation.
- Shorts: `/api/shorts` returns one page (up to 40). There is no endless scroll yet — hit Refresh for more,
  and YouTube's `FEshorts` tab is region/algorithm dependent, which is why the two fallbacks exist.
- Cloudflare free tier: 100k requests/day. Media proxying costs bandwidth — fine for personal use.

## Files

```
index.html       entire app (React 18 UMD + Babel in-browser, no build step)
worker.js        Cloudflare Worker: InnerTube API + sig decipher + media proxy + RSS
dev-server.mjs   local preview with mock API + sample MP4s
tests/           regression suites (worker: node tests/smoke.mjs etc; UI: see below)
```

### Tests

```bash
node tests/smoke.mjs      # worker core: decipher, list calls, breakers, media, routes
node tests/rsstest.mjs    # feeds: parsing, merge/dedupe/sort, resolveChannel, /api/rss + /api/channel
node tests/mptest.mjs     # /mp4 endpoint: Range/206, HEAD, content-type, ?itag, ?dl
node tests/shortstest.mjs # Shorts: both renderer shapes, dedupe, view parsing, 3-step ladder, route

npm i jsdom react react-dom @babel/core @babel/preset-react
node tests/ui.test.cjs    # compiles the JSX out of index.html and drives it in jsdom
```

The first three need no dependencies — they import `worker.js` directly and stub `fetch`/`caches`.
