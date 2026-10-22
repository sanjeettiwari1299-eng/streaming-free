# StreamVoid — serverless YouTube front-end + custom player

`index.html` (whole app, one file) + `worker.js` (Cloudflare Worker, free tier).
**No API key. No Google login. No Piped/Invidious. No server/VPS. No YouTube iframe.**

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
3. Open `https://<your-worker>.workers.dev/api/health` → `{"ok":true,...}`
4. Open StreamVoid → **Settings → YouTube engine** → paste the worker URL → **Save & test**.
   The dot turns green and full search/trending/playback goes live.

`index.html` can be hosted anywhere static (GitHub Pages, Netlify, S3, or just opened locally).

---

## What the worker does

| Route | Purpose |
| --- | --- |
| `GET /api/health` | connection check + client list |
| `GET /api/search?q=` | InnerTube `search` → normalized video list (+ continuation token) |
| `GET /api/searchmore?q=&token=` | next page |
| `GET /api/trending?region=IN` | InnerTube `browse` `FEtrending` |
| `GET /api/player?id=` | InnerTube `player` with a client ladder (android_vr → ios → tv_embedded → android → mweb → web), picks muxed MP4, rewrites URLs to the proxy |
| `GET /api/related?id=` | InnerTube `next` → Up next list |
| `GET /api/media?u=` | **Range-aware** byte proxy for `googlevideo.com` (host allowlist) |

Signature handling: if a format comes back as `signatureCipher`, the worker fetches the video's `base.js`,
extracts the sig and `n` transform functions and applies them (`buildDecipher`). Plain `url` formats skip all of that.

---

## The player (hand-built)

- Big centre play, auto-hiding gradient controls, buffered + played bars, scrub tooltip on hover, drag-to-seek.
- Volume slider, mute, current/total time, quality menu, playback speed (0.5×–2×), theater mode, fullscreen.
- Keyboard: `space`/`k` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume · `m` mute · `f` fullscreen ·
  `t` theater · `n` next · `0`–`9` jump to %
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
- YouTube's bot checks (`PoToken`) can reject a client on some networks; the worker walks a client ladder and
  surfaces the reasons it tried. If all fail, `Retry` after a moment or from another network.
- Cloudflare free tier: 100k requests/day. Media proxying costs bandwidth — fine for personal use.

## Files

```
index.html       entire app (React 18 UMD + Babel in-browser, no build step)
worker.js        Cloudflare Worker: InnerTube API + sig decipher + media proxy
dev-server.mjs   local preview with mock API + sample MP4s
```
