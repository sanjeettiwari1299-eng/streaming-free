"""
StreamVoid backend — keyless search + stream extraction using yt-dlp.

Why a backend? yt-dlp is a Python program and youtube.com blocks browser CORS,
so a browser can't extract streams itself. This tiny server does the extraction
and proxies the media bytes (Range-aware), which also fixes the "googlevideo 403"
problem you get when you open instance-generated URLs directly.

Run:
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8000

Then either open http://localhost:8000/ (it serves index.html too)
or point the static app's Settings → Backend URL at this server.

Env:
    SV_MOCK=1        canned data, no network (for tests / local UI work)
    SV_CACHE_TTL     seconds to cache extracted stream URLs (default 5400)
    SV_PROXY=0       return direct googlevideo URLs instead of proxying
"""

from __future__ import annotations

import os
import time
import json
import shutil
import threading
import urllib.parse
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

try:
    import yt_dlp
except Exception:  # pragma: no cover - yt-dlp is optional at import time
    yt_dlp = None

ROOT = Path(__file__).resolve().parent.parent
MOCK = os.environ.get("SV_MOCK") == "1"
CACHE_TTL = int(os.environ.get("SV_CACHE_TTL", "5400"))
PROXY = os.environ.get("SV_PROXY", "1") != "0"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

app = FastAPI(title="StreamVoid backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _cache_get(key: str):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
        if hit:
            _cache.pop(key, None)
    return None


def _cache_put(key: str, value: dict):
    with _lock:
        _cache[key] = (time.time(), value)
        if len(_cache) > 500:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)


# ── yt-dlp helpers ────────────────────────────────────────────────────────────
def _ydl_opts(extra: dict | None = None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "extractor_retries": 2,
        "socket_timeout": 15,
        "retries": 2,
        "http_headers": {"User-Agent": UA},
    }
    opts.update(extra or {})
    return opts


def _require_ytdlp():
    if MOCK:
        return
    if yt_dlp is None:
        raise HTTPException(503, "yt-dlp is not installed (pip install -r requirements.txt)")


def _norm_entry(e: dict, base: str = "yt-dlp") -> dict:
    vid = e.get("id") or ""
    thumb = e.get("thumbnail")
    if not thumb:
        thumbs = e.get("thumbnails") or []
        thumb = thumbs[-1].get("url") if thumbs else None
    return {
        "videoId": vid,
        "title": e.get("title") or "",
        "author": e.get("uploader") or e.get("channel") or e.get("uploader_id") or "",
        "authorId": e.get("channel_id") or "",
        "viewCount": int(e.get("view_count") or 0),
        "lengthSeconds": int(e.get("duration") or 0),
        "published": int(e.get("timestamp") or 0) or int(time.time()) - 86400,
        "thumbnail": thumb or f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
        "description": (e.get("description") or "")[:400],
        "source": base,
    }


def _mock_items(prefix: str, n: int = 12) -> list[dict]:
    out = []
    for i in range(n):
        vid = (prefix[:5] + f"{i:06d}")[:11]
        out.append(
            {
                "videoId": vid,
                "title": f"{prefix.title()} sample video {i}",
                "author": "Mock Channel",
                "authorId": "UCmock",
                "viewCount": 100000 + i * 37,
                "lengthSeconds": 180 + i,
                "published": int(time.time()) - 86400 * (i + 1),
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
                "description": "mock",
                "source": "mock",
            }
        )
    return out


def search(q: str, limit: int = 24, page: int = 1) -> list[dict]:
    if MOCK:
        return _mock_items("mocksearch", limit)
    _require_ytdlp()
    n = max(1, min(limit, 50))
    start = (max(1, page) - 1) * n
    # ytsearchN gives the first N; for later pages pull a bigger window and slice.
    total = start + n
    with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
        info = ydl.extract_info(f"ytsearch{total}:{q}", download=False)
    entries = (info or {}).get("entries") or []
    return [_norm_entry(e) for e in entries[start:start + n] if e and e.get("id")]


def trending(region: str = "IN", kind: str = "all") -> dict:
    """Trending: yt-dlp has no trending feed, so mirror it server-side from
    public Piped/Invidious instances (no CORS in the server, plus caching)."""
    if MOCK:
        return {"items": _mock_items("mocktrend"), "source": "mock"}
    cached = _cache_get(f"trend:{region}:{kind}")
    if cached:
        return cached
    piped = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.adminforge.de",
        "https://api.piped.private.coffee",
        "https://pipedapi.ducks.party",
    ]
    invidious = [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://iv.melmac.space",
        "https://invidious.f5.si",
        "https://yewtu.be",
    ]
    with httpx.Client(timeout=8, headers={"User-Agent": UA, "Accept": "application/json"}) as c:
        for host in piped:
            try:
                url = f"{host}/trending?region={urllib.parse.quote(region)}"
                if kind in ("music", "gaming", "movies"):
                    url += f"&filter={kind}"
                r = c.get(url)
                if r.status_code == 200:
                    items = [
                        {
                            "videoId": (x.get("url") or "").split("v=")[-1],
                            "title": x.get("title") or "",
                            "author": x.get("uploaderName") or "",
                            "authorId": (x.get("uploaderUrl") or "").replace("/channel/", ""),
                            "viewCount": int(x.get("views") or 0),
                            "lengthSeconds": int(x.get("duration") or 0),
                            "published": int(time.time()) - 86400,
                            "thumbnail": x.get("thumbnail")
                            or f"https://i.ytimg.com/vi/{(x.get('url') or '').split('v=')[-1]}/mqdefault.jpg",
                            "description": x.get("shortDescription") or "",
                            "source": host,
                        }
                        for x in (r.json().get("items") or [])
                        if x.get("url")
                    ]
                    if items:
                        out = {"items": items, "source": host.replace("https://", "")}
                        _cache_put(f"trend:{region}:{kind}", out)
                        return out
            except Exception:
                continue
        for host in invidious:
            try:
                url = f"{host}/api/v1/trending?region={urllib.parse.quote(region)}"
                if kind in ("music", "gaming", "movies"):
                    url += f"&type={kind}"
                r = c.get(url)
                if r.status_code == 200:
                    items = [
                        {
                            "videoId": x.get("videoId"),
                            "title": x.get("title") or "",
                            "author": x.get("author") or "",
                            "authorId": x.get("authorId") or "",
                            "viewCount": int(x.get("viewCount") or 0),
                            "lengthSeconds": int(x.get("lengthSeconds") or 0),
                            "published": int(x.get("published") or 0),
                            "thumbnail": f"https://i.ytimg.com/vi/{x.get('videoId')}/mqdefault.jpg",
                            "description": (x.get("description") or "")[:400],
                            "source": host,
                        }
                        for x in (r.json() or [])
                        if x.get("videoId")
                    ]
                    if items:
                        out = {"items": items, "source": host.replace("https://", "")}
                        _cache_put(f"trend:{region}:{kind}", out)
                        return out
            except Exception:
                continue
    raise HTTPException(502, "no instance available for trending")


def extract(video_id: str) -> dict:
    if not video_id or len(video_id) > 20:
        raise HTTPException(400, "bad video id")
    cached = _cache_get(f"stream:{video_id}")
    if cached:
        return cached
    if MOCK:
        info = {
            "videoId": video_id,
            "title": f"Mock video {video_id}",
            "description": "Mock description",
            "author": "Mock Channel",
            "authorId": "UCmock",
            "viewCount": 123456,
            "likes": 4321,
            "published": int(time.time()) - 86400 * 3,
            "lengthSeconds": 210,
            "live": False,
            "url": "/api/media/" + video_id,
            "quality": "720p",
            "hls": "",
            "related": _mock_items("mockrel", 8),
            "source": "mock",
        }
        _cache_put(f"stream:{video_id}", info)
        return info

    _require_ytdlp()
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = _ydl_opts(
        {
            "format": "best[acodec!=none][vcodec!=none][ext=mp4]/best[acodec!=none][vcodec!=none]/best",
            "extract_flat": False,
        }
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"yt-dlp failed: {exc}") from exc

    if not info:
        raise HTTPException(502, "yt-dlp returned nothing")

    chosen = info
    if info.get("formats"):
        # prefer progressive (audio+video) mp4 by height
        def score(f):
            return (
                1 if (f.get("acodec") not in (None, "none") and f.get("vcodec") not in (None, "none")) else 0,
                int(f.get("height") or 0),
                int(f.get("tbr") or 0),
            )

        progressive = [f for f in info["formats"] if f.get("url")]
        if progressive:
            chosen = max(progressive, key=score)

    playable = chosen.get("url")
    live = bool(info.get("is_live"))

    out = {
        "videoId": video_id,
        "title": info.get("title") or "",
        "description": (info.get("description") or "")[:4000],
        "author": info.get("uploader") or info.get("channel") or "",
        "authorId": info.get("channel_id") or "",
        "viewCount": int(info.get("view_count") or 0),
        "likes": int(info.get("like_count") or 0),
        "published": int(info.get("timestamp") or 0),
        "lengthSeconds": int(info.get("duration") or 0),
        "live": live,
        "quality": chosen.get("format_note") or (f"{chosen.get('height')}p" if chosen.get("height") else ""),
        "hls": "",
        "related": [],
        "source": "yt-dlp",
    }

    out["_upstream"] = playable or ""
    out["_itag"] = str(chosen.get("format_id") or "")
    if PROXY and not live and playable:
        out["url"] = f"/api/media/{video_id}?itag={urllib.parse.quote(out['_itag'])}"
    else:
        out["url"] = playable or ""

    # HLS for live streams — proxy the manifest so segments stay same-origin
    if live and info.get("manifest_url"):
        if PROXY:
            out["hls"] = f"/api/live/{video_id}.m3u8"
            out["_manifest"] = info["manifest_url"]
            out["url"] = ""
        else:
            out["hls"] = info["manifest_url"]

    # cheap related videos (flat search on the title)
    if info.get("title"):
        try:
            with yt_dlp.YoutubeDL(_ydl_opts({"extract_flat": "in_playlist"})) as ydl:
                rel = ydl.extract_info(f"ytsearch8:{info['title']}", download=False) or {}
            out["related"] = [
                _norm_entry(e) for e in (rel.get("entries") or [])[:8] if e and e.get("id") and e.get("id") != video_id
            ]
        except Exception:
            pass

    _cache_put(f"stream:{video_id}", out)
    return out


def direct_url(video_id: str, itag: str = "") -> str:
    info = _cache_get(f"stream:{video_id}") or extract(video_id)
    up = info.get("_upstream") or ""
    if up:
        return up
    raw = info.get("url") or ""
    if raw.startswith("http"):
        return raw
    return ""


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    ver = None
    if yt_dlp is not None:
        try:
            from yt_dlp.version import __version__ as _v  # noqa: WPS433

            ver = _v
        except Exception:
            ver = "installed"
    return {
        "ok": True,
        "service": "streamvoid-backend",
        "ytdlp": ver or ("mock" if MOCK else None),
        "mock": MOCK,
        "proxy": PROXY,
        "node": bool(shutil.which("node")),
    }


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1), limit: int = 24, page: int = 1):
    try:
        items = search(q, limit, page)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"search failed: {exc}") from exc
    return {"items": items, "source": "yt-dlp", "hasMore": len(items) >= min(limit, 50)}


@app.get("/api/trending")
def api_trending(region: str = "IN", filter: str = "all"):  # noqa: A002
    try:
        return trending(region.upper(), filter)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"trending failed: {exc}") from exc


@app.get("/api/stream/{video_id}")
def api_stream(video_id: str):
    out = {k: v for k, v in extract(video_id).items() if not k.startswith("_")}
    return out


@app.get("/api/media/{video_id}")
def api_media(video_id: str, itag: str = "", request: Request = None):
    if MOCK:
        payload = b"\x00" * 1024

        def gen():
            yield payload

        return StreamingResponse(gen(), media_type="video/mp4", headers={"Accept-Ranges": "none"})

    upstream = direct_url(video_id, itag)
    if not upstream:
        raise HTTPException(404, "no stream url")
    rng = request.headers.get("range") if request is not None else None
    return _proxy(upstream, rng)


@app.get("/api/live/{video_id}.m3u8")
def api_live(video_id: str):
    if MOCK:
        raise HTTPException(404, "no live in mock")
    info = extract(video_id)
    manifest = info.get("_manifest")
    if not manifest:
        raise HTTPException(404, "no live manifest")
    with httpx.Client(timeout=15, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = c.get(manifest)
    if r.status_code != 200:
        raise HTTPException(502, "manifest fetch failed")
    return StreamingResponse(
        iter([_rewrite_playlist(r.text, str(r.url))]),
        media_type="application/vnd.apple.mpegurl",
    )


@app.get("/api/liveproxy")
def api_liveproxy(u: str, request: Request = None):
    if not u.startswith(("https://", "http://")):
        raise HTTPException(400, "bad url")
    rng = request.headers.get("range") if request is not None else None
    if ".m3u8" in u.split("?")[0]:
        with httpx.Client(timeout=15, headers={"User-Agent": UA}, follow_redirects=True) as c:
            r = c.get(u)
        if r.status_code != 200:
            raise HTTPException(502, "playlist fetch failed")
        return StreamingResponse(
            iter([_rewrite_playlist(r.text, str(r.url))]),
            media_type="application/vnd.apple.mpegurl",
        )
    return _proxy(u, rng)


def _proxy(upstream: str, range_header: str | None = None):
    """Stream bytes from googlevideo, honouring Range so seeking works."""
    headers = {"User-Agent": UA, "Referer": "https://www.youtube.com/"}
    if range_header:
        headers["Range"] = range_header
    client = httpx.Client(timeout=httpx.Timeout(30, read=120), follow_redirects=True)
    try:
        resp = client.send(httpx.Request("GET", upstream, headers=headers), stream=True)
    except Exception as exc:  # noqa: BLE001
        client.close()
        raise HTTPException(502, f"upstream failed: {exc}") from exc

    if resp.status_code >= 400:
        resp.close()
        client.close()
        raise HTTPException(502, f"upstream {resp.status_code}")

    out_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": resp.headers.get("content-type", "video/mp4"),
    }
    for h in ("content-length", "content-range"):
        if resp.headers.get(h):
            out_headers[h.title()] = resp.headers[h]

    def body():
        try:
            for chunk in resp.iter_bytes(64 * 1024):
                if chunk:
                    yield chunk
        finally:
            resp.close()
            client.close()

    return StreamingResponse(
        body(),
        status_code=resp.status_code,
        headers=out_headers,
        media_type=out_headers["Content-Type"],
    )


def _rewrite_playlist(text: str, base_url: str) -> str:
    base = base_url.rsplit("/", 1)[0]
    out = []
    for line in text.splitlines():
        if line and not line.startswith("#"):
            absolute = line if line.startswith("http") else f"{base}/{line.lstrip('/')}"
            out.append("/api/liveproxy?u=" + urllib.parse.quote(absolute, safe=""))
        else:
            out.append(line)
    return "\n".join(out)


@app.get("/")
def index():
    file = ROOT / "index.html"
    if not file.exists():
        raise HTTPException(404, "index.html not found")
    return FileResponse(file, media_type="text/html")


@app.get("/api")
def api_root():
    return {"ok": True, "endpoints": ["/api/health", "/api/search", "/api/trending", "/api/stream/{id}", "/api/media/{id}"]}
