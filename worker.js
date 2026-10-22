/**
 * StreamVoid serverless YouTube proxy — Cloudflare Worker (free tier).
 *
 * Deploy (2 minutes, no CLI):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. Paste this whole file → Deploy
 *   3. Open the worker URL + /api/health → {"ok":true}
 *   4. Paste that URL in StreamVoid → Settings → Engine URL
 *
 * What it does: talks YouTube's own InnerTube API (search / trending / related /
 * player), picks muxed MP4 streams, and proxies the media bytes so playback works
 * from any IP (googlevideo URLs are IP-bound; this is why a plain static page can't do it).
 *
 * No Piped, no Invidious, no API key, no VM.
 */

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA = {
  web: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  mobile: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
};

// Client ladder: cheapest-to-parse and most PoToken-free first.
const CLIENTS = [
  {
    id: "android_vr",
    num: "28",
    ctx: {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
      gl: "IN",
      utcOffsetMinutes: 330,
    },
    ua: UA.mobile,
  },
  {
    id: "ios",
    num: "5",
    ctx: { clientName: "IOS", clientVersion: "19.45.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.1.0.22B83", hl: "en", gl: "IN" },
    ua: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)",
  },
  {
    id: "tv_embedded",
    num: "85",
    ctx: {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      clientScreen: "EMBED",
      thirdParty: { embedUrl: "https://www.youtube.com/" },
      hl: "en",
      gl: "IN",
    },
    ua: UA.web,
  },
  {
    id: "android",
    num: "3",
    ctx: { clientName: "ANDROID", clientVersion: "19.29.37", androidSdkVersion: 30, osName: "Android", osVersion: "11", hl: "en", gl: "IN" },
    ua: UA.mobile,
  },
  {
    id: "mweb",
    num: "2",
    ctx: { clientName: "MWEB", clientVersion: "2.20241202.07.00", hl: "en", gl: "IN" },
    ua: UA.web,
  },
  {
    id: "web",
    num: "1",
    ctx: { clientName: "WEB", clientVersion: "2.20241202.07.00", hl: "en", gl: "IN" },
    ua: UA.web,
  },
];

// ── tiny utils ────────────────────────────────────────────────────────────────
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra },
  });

const err = (message, status = 502, detail = undefined) => json({ error: message, detail }, status);

const jsonPost = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`bad JSON from youtube (${r.status})`);
  }
  return data;
};

// ── InnerTube ─────────────────────────────────────────────────────────────────
function innertubeBody(client, extra) {
  return { context: { client: client.ctx }, ...extra };
}

async function innertube(client, endpoint, extra) {
  const headers = {
    "content-type": "application/json",
    "user-agent": client.ua,
    "x-youtube-client-name": client.num,
    "x-youtube-client-version": client.ctx.clientVersion,
    origin: "https://www.youtube.com",
  };
  return jsonPost(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`, innertubeBody(client, extra), headers);
}

const WEB = CLIENTS.find((c) => c.id === "mweb");

// ── renderer walking ──────────────────────────────────────────────────────────
function collect(node, keys, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 24) return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, keys, out, depth + 1);
    return out;
  }
  for (const k of keys) {
    if (node[k] && typeof node[k] === "object") out.push(node[k]);
  }
  for (const k in node) collect(node[k], keys, out, depth + 1);
  return out;
}

const textOf = (o) => {
  if (!o) return "";
  if (typeof o === "string") return o;
  if (o.simpleText) return o.simpleText;
  if (o.runs) return o.runs.map((r) => r.text || "").join("");
  if (o.accessibility?.accessibilityData?.label) return o.accessibility.accessibilityData.label;
  return "";
};

const durToSec = (s) => {
  const parts = String(s || "")
    .replace(/[^\d:]/g, "")
    .split(":")
    .filter(Boolean)
    .map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
};

const VIEWS = (t) => {
  const m = String(t || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?\s*views/i);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};

const CHANNEL = (v) =>
  v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
  v.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
  v.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
  "";

function normVideo(v) {
  if (!v || !v.videoId) return null;
  const thumbs = v.thumbnail?.thumbnails || v.thumbnail?.richThumbnail?.movingThumbnailRenderer?.thumbnail?.thumbnails || [];
  const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
  const live = !!v.badges?.some((b) => /LIVE/i.test(textOf(b.metadataBadgeRenderer?.label)));
  return {
    videoId: v.videoId,
    title: textOf(v.title) || "",
    author: textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText) || "",
    authorId: CHANNEL(v),
    thumbnail: thumb.startsWith("//") ? "https:" + thumb : thumb,
    lengthSeconds: durToSec(v.lengthText?.simpleText || textOf(v.lengthText)),
    viewCount: VIEWS(textOf(v.viewCountText) || textOf(v.shortViewCountText)),
    publishedText: textOf(v.publishedTimeText) || "",
    live,
  };
}

const VIDEO_KEYS = ["videoRenderer", "compactVideoRenderer", "gridVideoRenderer", "playlistVideoRenderer"];

function normalizeList(data, limit = 30) {
  const out = [];
  const seen = new Set();
  for (const key of VIDEO_KEYS) {
    for (const r of collect(data, [key])) {
      const v = normVideo(r);
      if (v && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push(v);
      }
      if (out.length >= limit * 2) break;
    }
    if (out.length) break;
  }
  return out.slice(0, limit);
}

// ── signature / n-param deciphering (best effort, cached per player js) ───────
const playerCache = new Map();

function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") j += 2;
    else if (src[j] === q) return j;
    else j++;
  }
  return src.length;
}

function balanced(src, start) {
  const open = src[start];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  return null;
}

function fnSource(js, name) {
  // NAME=function(...){...}   or   function NAME(...){...}
  let idx = js.search(new RegExp(`[^\\w$.]${name.replace(/\$/g, "\\$")}\\s*=\\s*function\\s*\\(`));
  let at = idx >= 0 ? js.indexOf("function", idx) : -1;
  if (at < 0) {
    const m = js.match(new RegExp(`function\\s+${name.replace(/\$/g, "\\$")}\\s*\\(`));
    if (m) at = m.index;
  }
  if (at < 0) return null;
  const braceStart = js.indexOf("{", js.indexOf(")", at));
  if (braceStart < 0) return null;
  const body = balanced(js, braceStart);
  if (!body) return null;
  return { name, code: `function ${name}${js.slice(js.indexOf("(", at), braceStart)}${body}` };
}

function objectSource(js, name, hintIndex = 0) {
  const re = new RegExp(`(?:var\\s+|,\\s*|;\\s*|^)${name.replace(/\$/g, "\\$")}\\s*=\\s*\\{`, "g");
  let m;
  const hits = [];
  while ((m = re.exec(js))) hits.push(m.index + m[0].length - 1);
  if (!hits.length) return null;
  const at = hits.find((i) => i >= hintIndex) ?? hits[0];
  const body = balanced(js, at);
  if (!body) return null;
  return { name, code: `var ${name}=${body};` };
}

function buildDecipher(js, fnName) {
  const fn = fnSource(js, fnName);
  if (!fn) return null;
  // helper object referenced inside the function, e.g. "XY.reverse(a)".
  // Take the first candidate that actually exists as `var NAME={...}` — skip
  // the function's own parameters (usually single letters like `a`).
  const params = (fn.code.match(/^function[^(]*\(([^)]*)\)/) || [])[1] || "";
  const paramSet = new Set(params.split(",").map((x) => x.trim()).filter(Boolean));
  const cands = [...new Set([...fn.code.matchAll(/([A-Za-z0-9_$]+)\.[A-Za-z0-9_$]+\(/g)].map((m) => m[1]))]
    .filter((n) => !paramSet.has(n) && n !== fnName && n !== "this");
  let code = fn.code;
  for (const name of cands) {
    const obj = objectSource(js, name);
    if (obj) { code = obj.code + "\n" + code; break; }
  }
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${code}\nreturn ${fnName};`);
    return factory();
  } catch {
    return null;
  }
}

function findSigName(js) {
  const patterns = [
    /\.sig\|\|\s*([a-zA-Z0-9_$]+)\(/,
    /\.set\(\s*"signature"\s*,\s*(?:encodeURIComponent\(\s*)?([a-zA-Z0-9_$]+)\(/,
    /c\s*&&\s*d\.set\(\s*[a-zA-Z0-9_$]+\s*,\s*(?:encodeURIComponent\(\s*)?([a-zA-Z0-9_$]+)\(/,
    /a\.set\(\s*"signature"\s*,\s*(?:encodeURIComponent\(\s*)?([a-zA-Z0-9_$]+)\(/,
  ];
  for (const re of patterns) {
    const m = js.match(re);
    if (m) return m[1];
  }
  return null;
}

function findNName(js) {
  const patterns = [
    /\.get\("n"\)\)\s*&&\s*\(\s*[a-zA-Z0-9_$]+\s*=\s*([a-zA-Z0-9_$]+)\(/,
    /\.get\("n"\)\)\s*&&\s*\([a-zA-Z0-9_$]+\s*=\s*([a-zA-Z0-9_$]+)\([a-zA-Z0-9_$]+\)/,
    /"n"\)\s*&&\s*\(\s*[a-zA-Z0-9_$]+\s*=\s*([a-zA-Z0-9_$]+)\(/,
  ];
  for (const re of patterns) {
    const m = js.match(re);
    if (m) return m[1];
  }
  return null;
}

async function playerJs(url) {
  if (playerCache.has(url)) return playerCache.get(url);
  const p = (async () => {
    const r = await fetch(url, { headers: { "user-agent": UA.web } });
    if (!r.ok) throw new Error("player js " + r.status);
    const text = await r.text();
    const sigName = findSigName(text);
    const nName = findNName(text);
    return {
      sig: sigName ? buildDecipher(text, sigName) : null,
      n: nName ? buildDecipher(text, nName) : null,
      sigName,
      nName,
      ts: (text.match(/"signatureTimestamp":(\d+)/) || [])[1],
    };
  })();
  playerCache.set(url, p);
  if (playerCache.size > 8) playerCache.delete(playerCache.keys().next().value);
  return p;
}

function cipherOf(f) {
  if (f.url) return { url: f.url, s: null, n: null };
  const raw = f.signatureCipher || f.cipher;
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  return { url: p.get("url"), s: p.get("s"), n: p.get("n"), sp: p.get("sp") || "sig" };
}

async function playableUrl(f) {
  const c = cipherOf(f);
  if (!c || !c.url) return null;
  let url = c.url;
  if (c.s) {
    const assets = f.__assets;
    if (!assets) return null;
    const js = await playerJs(assets);
    if (!js?.sig) return null;
    url += `&${c.sp}=${encodeURIComponent(js.sig(c.s))}`;
  }
  // n-param: without a valid value YouTube throttles / 403s
  try {
    const u = new URL(url);
    const n = u.searchParams.get("n");
    if (n && f.__assets) {
      const js = await playerJs(f.__assets);
      if (js?.n) u.searchParams.set("n", js.n(n));
      url = u.toString();
    }
  } catch {
    /* keep url as-is */
  }
  return url;
}

// ── routes ────────────────────────────────────────────────────────────────────
async function player(videoId) {
  const attempts = [];
  for (const client of CLIENTS) {
    let data;
    try {
      data = await innertube(client, "player", { videoId, contentCheckOk: true, racyCheckOk: true });
    } catch (e) {
      attempts.push(`${client.id}: ${e.message}`);
      continue;
    }
    const status = data?.playabilityStatus?.status || "UNKNOWN";
    const sd = data?.streamingData;
    if (status !== "OK" || !sd) {
      attempts.push(`${client.id}: ${status} ${data?.playabilityStatus?.reason || ""}`.trim());
      continue;
    }
    const assets =
      data?.assets?.js ||
      (data?.assets?.jsUrl ? (data.assets.jsUrl.startsWith("http") ? data.assets.jsUrl : "https://www.youtube.com" + data.assets.jsUrl) : "") ||
      (data?.playabilityStatus?.liveStreamability ? "" : "");

    const muxed = (sd.formats || []).filter((f) => f.url || f.signatureCipher || f.cipher);
    const adaptive = (sd.adaptiveFormats || []).filter((f) => (f.url || f.signatureCipher || f.cipher) && f.mimeType?.startsWith("video/"));

    const formats = [];
    for (const f of muxed) {
      f.__assets = assets;
      const u = await playableUrl(f).catch(() => null);
      if (u) {
        formats.push({
          itag: f.itag,
          quality: f.qualityLabel || (f.height ? `${f.height}p` : f.quality || "auto"),
          height: f.height || 0,
          mime: f.mimeType || "",
          url: u,
          kind: "muxed",
        });
      }
    }
    formats.sort((a, b) => b.height - a.height);
    if (!formats.length) {
      attempts.push(`${client.id}: no muxed format (${adaptive.length} adaptive only)`);
      continue;
    }

    const vd = data.videoDetails || {};
    return {
      ok: true,
      client: client.id,
      video: {
        videoId,
        title: vd.title || "",
        description: vd.shortDescription || "",
        author: vd.author || "",
        authorId: vd.channelId || "",
        viewCount: Number(vd.viewCount || 0),
        lengthSeconds: Number(vd.lengthSeconds || 0),
        live: !!vd.isLive,
        keywords: (vd.keywords || []).slice(0, 12),
        thumbnails: (vd.thumbnail?.thumbnails || []).map((t) => t.url),
      },
      formats: formats.map((f) => ({ ...f, url: `/api/media?u=${encodeURIComponent(f.url)}` })),
      attempts,
    };
  }
  return { ok: false, error: "no playable stream from any client", attempts };
}

async function search(q, page = 1) {
  const data = await innertube(WEB, "search", { query: q, params: page > 1 ? undefined : undefined });
  const items = normalizeList(data, 32);
  const tokens = collect(data, ["continuationItemRenderer"])
    .map((c) => c.continuationEndpoint?.continuationCommand?.token)
    .filter(Boolean);
  return { items, continuation: page > 1 ? null : tokens[0] || null };
}

async function searchMore(q, token) {
  const data = await innertube(WEB, "search", { query: q, continuation: token });
  return { items: normalizeList(data, 32) };
}

async function trending(region = "IN") {
  const client = { ...WEB, ctx: { ...WEB.ctx, gl: region } };
  const data = await innertube(client, "browse", { browseId: "FEtrending" });
  let items = normalizeList(data, 40);
  if (!items.length) {
    // fallback: plain search that behaves like a trending feed
    const alt = await innertube(client, "search", { query: `trending ${region}` });
    items = normalizeList(alt, 40);
  }
  return { items };
}

async function related(videoId) {
  const data = await innertube(WEB, "next", { videoId });
  return { items: normalizeList(data, 24) };
}

async function media(url, request) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return err("bad media url", 400);
  }
  const host = target.hostname;
  const allowed = /(^|\.)googlevideo\.com$/.test(host) || /(^|\.)youtube\.com$/.test(host) || /(^|\.)ytimg\.com$/.test(host);
  if (!allowed) return err("host not allowed: " + host, 400);

  const headers = new Headers({ "user-agent": UA.web, referer: "https://www.youtube.com/" });
  const range = request.headers.get("range");
  if (range) headers.set("range", range);

  const upstream = await fetch(target.toString(), { headers, redirect: "follow" });
  const out = new Headers();
  for (const h of ["content-length", "content-range", "accept-ranges", "content-type", "etag"]) {
    if (upstream.headers.get(h)) out.set(h, upstream.headers.get(h));
  }
  out.set("access-control-allow-origin", "*");
  out.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
  out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const ROUTES = [
  ["/api/health", async () => ({ ok: true, service: "streamvoid-worker", engine: "innertube", clients: CLIENTS.map((c) => c.id) })],
  ["/api/player", async (u) => player(u.searchParams.get("id") || "")],
  ["/api/search", async (u) => search(u.searchParams.get("q") || "", Number(u.searchParams.get("page") || 1))],
  ["/api/searchmore", async (u) => searchMore(u.searchParams.get("q") || "", u.searchParams.get("token") || "")],
  ["/api/trending", async (u) => trending((u.searchParams.get("region") || "IN").toUpperCase())],
  ["/api/related", async (u) => related(u.searchParams.get("id") || "")],
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }
    try {
      if (url.pathname === "/api/media" || url.pathname === "/api/thumb") {
        return media(url.searchParams.get("u") || "", request);
      }
      for (const [path, handler] of ROUTES) {
        if (url.pathname === path) return json(await handler(url));
      }
      return err("not found", 404, { routes: ["/api/health", "/api/player?id=", "/api/search?q=", "/api/trending?region=IN", "/api/related?id=", "/api/media?u="] });
    } catch (e) {
      return err(e && e.message ? e.message : "worker error", 502);
    }
  },
};

// exported for tests
export { findSigName, findNName, buildDecipher, fnSource, objectSource, balanced, normalizeList, normVideo, durToSec, VIEWS, player, search, trending, related };
