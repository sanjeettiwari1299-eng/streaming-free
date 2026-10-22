# StreamVoid — keyless YouTube front-end

Single-file app (`index.html`). **No API key, no Google account, no build step.**

## How it works

- Content (trending, search, related) comes from public **Invidious** and **Piped** instances.
- Playback uses a **native HTML5 player** (`<video>` + `hls.js` for live/HLS streams) — the YouTube
  player/iframe is never loaded, so there are no YouTube ads or tracking cookies.
- Every request is failover-aware: if an instance is down, times out, or returns no playable stream,
  the app tries the next one automatically and remembers which instances are healthy for 10 minutes
  (`localStorage`).

## Run it

```bash
python3 -m http.server 3000        # then open http://localhost:3000
```

Or just open `index.html` in a browser (it also works from `file://` as long as the browser allows
the remote fetch).

## Settings

- **Backend**: Invidious (default) or Piped — order of preference.
- **Proxy streams through instance**: recommended, direct links often 403.
- **My instances**: add your own instance URL; the app auto-detects Invidious vs Piped.
- **Reset instance health**: clears the cached good/bad list.

## Notes / limitations

- Public instances are community-run: they rate-limit, go down, or block certain videos/channels.
  That is why there is a whole failover list plus a "Try another instance" button on the player.
- If a browser blocks autoplay, the player shows a "tap to play" overlay.
- Some age-restricted / members-only / regional videos return no stream from any instance — the
  player then offers "Open on YouTube".
- History, likes, playlists live only in `localStorage`.

## Instance lists

- Invidious: <https://api.invidious.io/instances.json>
- Piped: <https://github.com/TeamPiped/Piped/wiki/Instances>

If the built-in list gets stale, add fresh instances in Settings — no code change needed.
