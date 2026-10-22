# StreamVoid — keyless YouTube front-end

Single-file front-end (`index.html`) + a tiny optional backend (`server/app.py`) that uses
[yt-dlp](https://github.com/yt-dlp/yt-dlp) for search and stream extraction.

**No API key, no Google account, no build step, no YouTube player (so no YouTube ads).**

---

## Two ways to run it

### 1. Backend mode (recommended — yt-dlp)

```bash
cd server
pip install -r requirements.txt        # fastapi, uvicorn, httpx, yt-dlp
uvicorn app:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

The same server serves `index.html` and the API, so `Settings → Backend URL` can stay empty
(same origin).

Docker:

```bash
docker build -t streamvoid .
docker run -p 8000:8000 streamvoid
```

What the backend adds:
- `/api/search` → yt-dlp `ytsearch` (real YouTube search, no key)
- `/api/stream/{id}` → yt-dlp extraction, best progressive MP4 (audio+video in one file)
- `/api/media/{id}` → Range-aware **media proxy** (this is what avoids the googlevideo
  403 / CORS problems you get with direct URLs and keeps seeking working)
- `/api/trending` → server-side Invidious/Piped mirror with caching (yt-dlp has no trending feed)
- `/api/live/{id}.m3u8` → HLS manifest rewrite + segment proxy for live streams

Env vars: `SV_MOCK=1` (canned data, no network — great for UI work / tests), `SV_CACHE_TTL`
(default 5400s), `SV_PROXY=0` (hand out raw googlevideo URLs instead of proxying).

### 2. Static mode (no server)

Just open `index.html` (or any static host). The app probes `/api/health`, gets nothing, and
falls back to public **Invidious / Piped** instances for everything. Works, but depends on
community instances that rate-limit and go down.

You can also host the front-end statically and put the backend elsewhere:
`Settings → yt-dlp backend → Backend URL = https://your-api.example.com` (CORS is open).

---

## Why a backend at all?

`yt-dlp` is a Python program and `youtube.com` does not send CORS headers, so a browser cannot
either run it or talk to YouTube directly. JS-only libraries (`yt-search`, `youtube-sr`,
`youtubei.js`, …) have the same wall: they need Node or a proxy for the actual stream URLs.
So: front-end stays static, extraction happens server-side.

## Player

- Native `<video>` element; no YouTube iframe/embed is ever created.
- Progressive MP4 by default, `hls.js` loaded on demand only for HLS/live, native HLS on Safari.
- Failover chain: yt-dlp backend → best Invidious/Piped instance → other formats → "Try another
  instance" / "Open on YouTube".
- Instance health is cached for 10 min in `localStorage`, so dead mirrors are skipped next time.
- If autoplay is blocked, a "tap to play" overlay appears.

## Settings

| Setting | What it does |
| --- | --- |
| Backend URL | Where the yt-dlp API lives (blank = same origin) |
| Use yt-dlp backend | Off = public Invidious/Piped only |
| Backend preference | Invidious first or Piped first for the fallback path |
| Proxy streams through instance | Recommended; direct links often 403 |
| My instances | Add your own instance URLs (auto-detects Invidious vs Piped) |
| Reset instance health | Clears the good/bad cache |

History, likes, playlists live only in `localStorage`.

## Known limitations

- Public instances are community-run: they rate-limit, break, or block videos. Failover is a
  mitigation, not a fix.
- Some videos (age-restricted, members-only, region-locked, DRM) return no stream from any path;
  the player then offers "Open on YouTube".
- Proxying media costs bandwidth — host it on something that allows it (VPS, Render, Fly, etc.).
- Keep `yt-dlp` updated (`pip install -U yt-dlp`); YouTube changes break old versions regularly.

## Instance lists

- Invidious: <https://api.invidious.io/instances.json>
- Piped: <https://github.com/TeamPiped/Piped/wiki/Instances>

## Layout

```
index.html        the whole app (React 18 UMD + Babel in-browser, no build)
server/app.py     FastAPI + yt-dlp backend (search, stream, proxy, trending, live HLS)
server/requirements.txt
Dockerfile        python:3.12-slim + ffmpeg + yt-dlp
```
