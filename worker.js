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
 * Self-maintaining bits:
 *   • client versions are discovered at runtime (youtube.com HTML + yt-dlp source)
 *     and cached for 6h, with a 2-version ladder per client as a safety net
 *   • optional cookies (wrangler secret YT_COOKIES) unlock age-restricted /
 *     members-only videos; they are only used when the request carries SV_KEY
 *
 * No Piped, no Invidious, no API key, no VM.
 */

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA = {
  web: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  mobile: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
};

// ── clients (spec) ────────────────────────────────────────────────────────────
// `uaFn` gets the discovered version so mobile UAs stay in sync with the ladder.
const UA_IOS = (v) => `com.google.ios.youtube/${v} (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)`;
const UA_ANDROID = (v) => `com.google.android.youtube/${v} (Linux; U; Android 11) gzip`;
const UA_VR = (v) => `com.google.android.apps.youtube.vr.oculus/${v} (Linux; U; Android 12L) gzip`;

const CLIENT_SPECS = [
  {
    id: "android_vr",
    num: "28",
    ctx: { clientName: "ANDROID_VR", clientVersion: "1.60.19", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L", hl: "en", gl: "IN", utcOffsetMinutes: 330 },
    uaFn: UA_VR,
  },
  {
    id: "ios",
    num: "5",
    ctx: { clientName: "IOS", clientVersion: "19.45.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.1.0.22B83", hl: "en", gl: "IN" },
    uaFn: UA_IOS,
  },
  {
    id: "tv_embedded",
    num: "85",
    ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", clientScreen: "EMBED", thirdParty: { embedUrl: "https://www.youtube.com/" }, hl: "en", gl: "IN" },
    ua: UA.web,
  },
  {
    id: "android",
    num: "3",
    ctx: { clientName: "ANDROID", clientVersion: "19.29.37", androidSdkVersion: 30, osName: "Android", osVersion: "11", hl: "en", gl: "IN" },
    uaFn: UA_ANDROID,
  },
  { id: "mweb", num: "2", ctx: { clientName: "MWEB", clientVersion: "2.20241202.07.00", hl: "en", gl: "IN" }, ua: UA.web },
  { id: "web", num: "1", ctx: { clientName: "WEB", clientVersion: "2.20241202.07.00", hl: "en", gl: "IN" }, ua: UA.web },
  {
    id: "web_embedded",
    num: "56",
    ctx: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "2.20241202.07.00", clientScreen: "EMBED", hl: "en", gl: "IN" },
    ua: UA.web,
  },
  { id: "tvhtml5", num: "7", ctx: { clientName: "TVHTML5", clientVersion: "7.20250101.10.00", hl: "en", gl: "IN" }, ua: UA.web },
  {
    id: "android_testsuite",
    num: "30",
    ctx: { clientName: "ANDROID_TESTSUITE", clientVersion: "1.9", androidSdkVersion: 30, osName: "Android", osVersion: "11", hl: "en", gl: "IN" },
    uaFn: UA_ANDROID,
  },
];

// Baked-in fallbacks — only used when discovery fails.
const FALLBACK_VERSIONS = {
  ANDROID_VR: "1.60.19",
  IOS: "19.45.4",
  ANDROID: "19.29.37",
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: "2.0",
  MWEB: "2.20241202.07.00",
  WEB: "2.20241202.07.00",
  WEB_EMBEDDED_PLAYER: "2.20241202.07.00",
  TVHTML5: "7.20250101.10.00",
  ANDROID_TESTSUITE: "1.9",
};

const VERSION_TTL = 6 * 3600; // seconds
let VERSION_CACHE = { ts: 0, versions: null, source: {} };

// Cache API with in-memory fallback (works without any binding).
async function cachedText(tag, url, ttl, init, noCache = false) {
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const key = new Request(`https://sv.internal/${tag}`);
      if (!noCache) {
        const hit = await caches.default.match(key);
        if (hit) return await hit.text();
      }
      const r = await fetch(url, init);
      if (r.ok) {
        const text = await r.text();
        await caches.default.put(key, new Response(text, { headers: { "cache-control": `max-age=${ttl}` } }));
        return text;
      }
      return "";
    }
  } catch {
    /* fall through to a plain fetch */
  }
  try {
    const r = await fetch(url, init);
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}

const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Parse yt-dlp's INNERTUBE client table: 'clientName': 'X', … 'clientVersion': 'Y'
function parseYtdlpVersions(py) {
  const out = {};
  if (!py) return out;
  const src = py.length > 4_000_000 ? py.slice(0, 4_000_000) : py;
  const re = /clientName['"]?\s*:\s*['"]([A-Z0-9_]+)['"][\s\S]{0,400}?clientVersion['"]?\s*:\s*['"]([\d.]+)['"]/g;
  for (const m of src.matchAll(re)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

// Discover current client versions. Never throws — always returns usable numbers.
async function discoverVersions(env, force = false) {
  const now = Date.now() / 1000;
  if (!force && VERSION_CACHE.versions && now - VERSION_CACHE.ts < VERSION_TTL) return VERSION_CACHE;

  const versions = { ...FALLBACK_VERSIONS };
  const source = {};

  // 1) WEB/MWEB straight from YouTube's homepage payload
  const html = await cachedText(
    "yt_web",
    "https://www.youtube.com/",
    12 * 3600,
    { headers: { "user-agent": WEB_UA, "accept-language": "en-US,en;q=0.9" } },
    force
  );
  const visitorData =
    (html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) || [])[1] ||
    (env && env.VISITOR_DATA) ||
    "";
  const webVer = (html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([\d.]+)"/) || [])[1];
  if (webVer) {
    versions.WEB = webVer;
    versions.MWEB = webVer;
    source.WEB = source.MWEB = "youtube.com";
  }

  // 2) Mobile / TV clients from yt-dlp (they track these daily)
  const py = await cachedText(
    "ytdlp_base",
    "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py",
    6 * 3600,
    { headers: { "user-agent": WEB_UA } }
  );
  const fromYtdlp = parseYtdlpVersions(py);
  for (const name of Object.keys(fromYtdlp)) {
    // youtube.com is authoritative for the web client — don't let yt-dlp downgrade it
    if (source[name] === "youtube.com") continue;
    versions[name] = fromYtdlp[name];
    source[name] = "yt-dlp";
  }

  // Explicit override wins: e.g. wrangler secret CLIENT_VERSIONS='{"ANDROID":"19.50.1"}'
  if (env && env.CLIENT_VERSIONS) {
    try {
      const over = JSON.parse(env.CLIENT_VERSIONS);
      for (const k of Object.keys(over)) {
        versions[k] = String(over[k]);
        source[k] = "env";
      }
    } catch {
      /* ignore malformed override */
    }
  }

  // web-family clients track the WEB version unless yt-dlp knows better
  for (const name of ["WEB_EMBEDDED_PLAYER", "MWEB", "TVHTML5"]) {
    if (!source[name] && versions.WEB) {
      versions[name] = versions[name] || versions.WEB;
    }
  }

  VERSION_CACHE = { ts: now, versions, source, visitorData };
  return VERSION_CACHE;
}

// Build the ladder: every client twice (discovered version, then baked fallback)
function buildClients(versions, region = "IN") {
  const v = { ...FALLBACK_VERSIONS, ...(versions || {}) };
  const out = [];
  for (const spec of CLIENT_SPECS) {
    const name = spec.ctx.clientName;
    const wanted = [v[name], spec.ctx.clientVersion].filter((x, i, a) => x && a.indexOf(x) === i);
    for (const ver of wanted) {
      out.push({
        id: spec.id,
        num: spec.num,
        versionRoll: ver,
        ctx: { ...spec.ctx, clientVersion: ver, gl: region },
        ua: spec.uaFn ? spec.uaFn(ver) : spec.ua,
      });
    }
  }
  return out;
}

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

// ── resilience layer ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms + Math.random() * ms * 0.5);

// fetch with retries for transient failures (429 / 5xx / network) + per-try timeout
async function fetchRetry(url, init = {}, { retries = 1, timeout = 9000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(jitter(150 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// Per client+version circuit breaker: stop hammering a combination YouTube just rejected.
const BREAKER = new Map(); // key -> { fails, until }
const BREAKER_BASE = 40; // seconds
const BREAKER_MAX = 5 * 60;
const breakerKey = (c) => `${c.id}@${c.ctx.clientVersion}`;
const breakerCooling = (c) => {
  const b = BREAKER.get(breakerKey(c));
  return !!(b && b.until > Date.now() / 1000);
};
const noteOk = (c) => BREAKER.delete(breakerKey(c));
const noteFail = (c) => {
  const k = breakerKey(c);
  const b = BREAKER.get(k) || { fails: 0, until: 0 };
  b.fails += 1;
  b.until = Date.now() / 1000 + Math.min(BREAKER_MAX, BREAKER_BASE * Math.pow(2, b.fails - 1));
  BREAKER.set(k, b);
  if (BREAKER.size > 60) BREAKER.delete(BREAKER.keys().next().value);
};
const resetBreakers = () => BREAKER.clear();
const breakerSnapshot = () =>
  [...BREAKER.entries()].map(([key, b]) => ({
    key,
    fails: b.fails,
    cooling: Math.max(0, Math.round(b.until - Date.now() / 1000)),
  }));

// ── cookies (optional, secret-only) ───────────────────────────────────────────
// Accepts: browser "a=1; b=2" header string, Netscape cookies.txt, or JSON array.
function parseCookies(raw) {
  if (!raw) return "";
  const text = String(raw).trim();
  if (!text) return "";
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : data.cookies || [];
      const pairs = arr
        .map((c) => (c && c.name ? `${c.name}=${c.value ?? ""}` : ""))
        .filter(Boolean);
      if (pairs.length) return pairs.join("; ");
    } catch {
      /* fall through */
    }
  }
  if (text.includes("\t")) {
    const pairs = text
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const p = l.split("\t");
        return p.length >= 7 ? `${p[5]}=${p[6]}` : "";
      })
      .filter(Boolean);
    if (pairs.length) return pairs.join("; ");
  }
  return text.replace(/\r?\n+/g, "; ").replace(/;\s*;/g, ";").replace(/^;\s*|;\s*$/g, "");
}

const cookieValue = (header, name) => {
  const m = header.match(new RegExp(`(?:^|;\\s*)${name.replace(/[$]/g, "\\$")}=([^;]+)`));
  return m ? m[1].trim() : "";
};

async function sha1Hex(input) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SAPISIDHASH — required by the WEB client for account-scoped playback
async function sapisidHash(cookieHeader, origin = "https://www.youtube.com") {
  const sapisid = cookieValue(cookieHeader, "SAPISID") || cookieValue(cookieHeader, "__Secure-3PAPISID");
  if (!sapisid) return "";
  const ts = Math.floor(Date.now() / 1000);
  const hex = await sha1Hex(`${ts} ${sapisid} ${origin}`);
  return `SAPISIDHASH ${ts}_${hex}`;
}

// Access key guard: cookies are only ever used for callers that know SV_KEY.
function keyAllowed(env, url) {
  if (!env || !env.SV_KEY) return true; // no key configured → worker is private-ish anyway
  const given = url.searchParams.get("key") || "";
  if (given.length !== String(env.SV_KEY).length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ String(env.SV_KEY).charCodeAt(i);
  return diff === 0;
}

function cookieAuth(env, url) {
  const raw = env && env.YT_COOKIES ? parseCookies(env.YT_COOKIES) : "";
  if (!raw) return null;
  if (!keyAllowed(env, url)) return null;
  return raw;
}

// ── InnerTube ─────────────────────────────────────────────────────────────────
function innertubeBody(client, extra) {
  return { context: { client: client.ctx }, ...extra };
}

async function innertube(client, endpoint, extra, opts = {}) {
  const headers = {
    "content-type": "application/json",
    "user-agent": client.ua,
    "x-youtube-client-name": client.num,
    "x-youtube-client-version": client.ctx.clientVersion,
    origin: "https://www.youtube.com",
    "accept-language": "en-US,en;q=0.9",
  };
  if (opts.cookies) {
    headers.cookie = opts.cookies;
    headers["x-goog-authuser"] = "0";
    if (opts.authorization) headers.authorization = opts.authorization;
  }

  const body = innertubeBody(client, extra);
  if (opts.visitorData) body.context.client.visitorData = opts.visitorData;
  if (opts.poToken) body.serviceIntegrityDimensions = { poToken: opts.poToken };

  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`;
  const res = await fetchRetry(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    { retries: opts.retries ?? 1, timeout: opts.timeout ?? 9000 }
  );
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`bad JSON from youtube (${res.status})`);
  }
}

const listClient = (ladder) => ladder.find((c) => c.id === "mweb") || ladder[0];

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
  if (typeof o === "number") return String(o);
  if (o.simpleText) return o.simpleText;
  // newer renderers use a plain `content` string (shorts lockups, overlay metadata)
  if (typeof o.content === "string") return o.content;
  if (o.runs) return o.runs.map((r) => r.text || "").join("");
  if (o.accessibility?.accessibilityData?.label) return o.accessibility.accessibilityData.label;
  // …and some wrap it one level deeper: { text: { content } } / { text: { simpleText } }
  if (o.text && typeof o.text === "object") return textOf(o.text);
  if (o.title && typeof o.title === "object" && (o.title.content || o.title.simpleText || o.title.runs)) return textOf(o.title);
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
  const secs = durToSec(v.lengthText?.simpleText || textOf(v.lengthText));
  return {
    videoId: v.videoId,
    title: textOf(v.title) || "",
    author: textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText) || "",
    authorId: CHANNEL(v),
    thumbnail: thumb.startsWith("//") ? "https:" + thumb : thumb,
    lengthSeconds: secs,
    viewCount: VIEWS(textOf(v.viewCountText) || textOf(v.shortViewCountText)),
    publishedText: textOf(v.publishedTimeText) || "",
    live,
    // ≤60s uploads are published as Shorts; the UI uses this for the pill / viewer
    isShort: secs > 0 && secs <= 60,
  };
}

const VIDEO_KEYS = [
  "videoRenderer",
  "compactVideoRenderer",
  "gridVideoRenderer",
  "playlistVideoRenderer",
  "videoWithContextRenderer",
  // 2025/26 shape: search, channel Videos tab and home now mostly use lockups
  "lockupViewModel",
];

const ID_RE11 = /^[A-Za-z0-9_-]{11}$/;
const DUR_RE = /^\d{1,2}(:\d{2}){1,2}$/;
const VIEWS_RE = /[\d.,]+\s*[KMB]?\s*views/i;
const AGO_RE = /(ago|premiered|streamed|scheduled)/i;

// every string inside a subtree (bounded), used by the generic extractor below
function deepStrings(node, out = [], budget = { n: 400 }, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12 || budget.n <= 0) return out;
  if (Array.isArray(node)) {
    for (const x of node) deepStrings(x, out, budget, depth + 1);
    return out;
  }
  // `content`/`simpleText` wrappers, plus bare `text`/`label` (badge overlays use those)
  for (const k of ["simpleText", "content", "text", "label"]) {
    if (typeof node[k] === "string" && node[k].trim()) {
      out.push(node[k]);
      budget.n -= 1;
    }
  }
  if (Array.isArray(node.runs)) {
    const t = node.runs.map((r) => r.text || "").join("").trim();
    if (t) {
      out.push(t);
      budget.n -= 1;
    }
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === "object") deepStrings(v, out, budget, depth + 1);
  }
  return out;
}

function deepThumbs(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 10) return out;
  if (Array.isArray(node)) {
    for (const x of node) deepThumbs(x, out, depth + 1);
    return out;
  }
  for (const k of ["thumbnails", "sources"]) {
    if (Array.isArray(node[k])) {
      for (const t of node[k]) if (t && typeof t.url === "string") out.push(t);
    }
  }
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === "object") deepThumbs(v, out, depth + 1);
  }
  return out;
}

const biggestThumb = (node) => {
  const list = deepThumbs(node).filter((t) => /^https?:/.test(t.url || ""));
  if (!list.length) return "";
  list.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return list[0].url;
};

const browseIdIn = (node) => {
  const b = collect(node, ["browseEndpoint"]).find((x) => /^UC[\w-]{10,}$/.test(x.browseId || ""));
  return b ? b.browseId : "";
};

// lockupViewModel / any future shape: pull the id, then read the metadata rows
function normLockup(m) {
  if (!m) return null;
  const cmd = m.onTap?.innertubeCommand || m.rendererContext?.commandContext?.onTap?.innertubeCommand || {};
  const rawId = String(
    m.contentId ||
      m.entityId ||
      cmd.videoId ||
      cmd.watchEndpoint?.videoId ||
      cmd.reelWatchEndpoint?.videoId ||
      ""
  ).replace(/^shorts-shelf-item-/, "");
  if (!ID_RE11.test(rawId)) return null;

  const meta = m.metadata?.lockupMetadataViewModel || m.metadataViewModel || {};
  const strings = deepStrings(meta);
  const rows = collect(meta, ["metadataParts"]).flat().map((p) => textOf(p.text)).filter(Boolean);

  const title =
    textOf(meta.title) ||
    strings.find((t) => t.length > 3 && !VIEWS_RE.test(t) && !AGO_RE.test(t) && !DUR_RE.test(t)) ||
    "";
  const authorId = browseIdIn(meta) || cmd.browseEndpoint?.browseId || "";
  const author = rows.find((t) => t !== title && !VIEWS_RE.test(t) && !AGO_RE.test(t) && !DUR_RE.test(t)) || "";
  const viewsText = rows.find((t) => VIEWS_RE.test(t)) || strings.find((t) => VIEWS_RE.test(t)) || "";
  const agoText = rows.find((t) => AGO_RE.test(t)) || strings.find((t) => AGO_RE.test(t)) || "";
  // duration usually lives in a thumbnail overlay badge, i.e. outside the metadata block
  const allStrings = deepStrings(m);
  const durText = allStrings.find((t) => DUR_RE.test(t)) || "";
  const secs = durToSec(durText);
  const thumb = biggestThumb(m.contentImage || m.thumbnail || m);
  const live = /\bLIVE\b/.test(allStrings.join(" "));

  return {
    videoId: rawId,
    title,
    author,
    authorId,
    thumbnail: thumb || `https://i.ytimg.com/vi/${rawId}/mqdefault.jpg`,
    lengthSeconds: secs,
    viewCount: VIEWS(viewsText),
    publishedText: agoText,
    publishedAt: agoText,
    live,
    isShort: secs > 0 && secs <= 60,
  };
}

// last resort: any object in the payload that carries a plausible 11-char video id
function genericVideos(data, limit = 30) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 22 || out.length >= limit * 2) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    const id =
      (ID_RE11.test(node.videoId || "") && node.videoId) ||
      (ID_RE11.test(node.contentId || "") && node.contentId) ||
      (ID_RE11.test(node.entityId || "") && node.entityId) ||
      (node.watchEndpoint && ID_RE11.test(node.watchEndpoint.videoId || "") && node.watchEndpoint.videoId) ||
      (node.reelWatchEndpoint && ID_RE11.test(node.reelWatchEndpoint.videoId || "") && node.reelWatchEndpoint.videoId);
    if (id && !seen.has(id)) {
      const strings = deepStrings(node);
      const title = strings.find((t) => t.length > 3 && !VIEWS_RE.test(t) && !AGO_RE.test(t) && !DUR_RE.test(t)) || "";
      if (title) {
        seen.add(id);
        const secs = durToSec(strings.find((t) => DUR_RE.test(t)) || "");
        out.push({
          videoId: id,
          title,
          author: "",
          authorId: browseIdIn(node),
          thumbnail: biggestThumb(node) || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          lengthSeconds: secs,
          viewCount: VIEWS(strings.find((t) => VIEWS_RE.test(t)) || ""),
          publishedText: strings.find((t) => AGO_RE.test(t)) || "",
          publishedAt: "",
          live: false,
          isShort: secs > 0 && secs <= 60,
        });
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data);
  return out.slice(0, limit);
}

function normalizeList(data, limit = 30) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (v && v.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push(v);
    }
  };
  const collectKey = (key) => {
    let found = 0;
    for (const r of collect(data, [key])) {
      push(key === "lockupViewModel" ? normLockup(r) : normVideo(r));
      found += 1;
      if (found >= 80 || out.length >= limit * 2) break;
    }
    return found;
  };
  // walk every known shape — one payload can mix renderers and lockups
  for (const key of VIDEO_KEYS) collectKey(key);
  // nothing matched a shape we know → scan for anything that looks like a video
  if (!out.length) for (const v of genericVideos(data, limit)) push(v);
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
// One player request for one client. Returns null when this client can't serve it.
async function tryClient(client, videoId, opts, attempts, tag) {
  const label = `${client.id}@${client.versionRoll || client.ctx.clientVersion}${tag ? "(" + tag + ")" : ""}`;
  let data;
  try {
    data = await innertube(
      client,
      "player",
      { videoId, contentCheckOk: true, racyCheckOk: true },
      { ...opts, retries: 0, timeout: 7000 }
    );
  } catch (e) {
    attempts.push(`${label}: ${e.message}`);
    noteFail(client);
    return null;
  }
  const status = data?.playabilityStatus?.status || "UNKNOWN";
  const sd = data?.streamingData;
  if (status !== "OK" || !sd) {
    attempts.push(`${label}: ${status} ${data?.playabilityStatus?.reason || ""}`.trim());
    noteFail(client);
    return null;
  }
  const assets =
    data?.assets?.js ||
    (data?.assets?.jsUrl
      ? data.assets.jsUrl.startsWith("http")
        ? data.assets.jsUrl
        : "https://www.youtube.com" + data.assets.jsUrl
      : "");

  const muxed = (sd.formats || []).filter((f) => f.url || f.signatureCipher || f.cipher);
  const adaptive = (sd.adaptiveFormats || []).filter(
    (f) => (f.url || f.signatureCipher || f.cipher) && f.mimeType?.startsWith("video/")
  );

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
    attempts.push(`${label}: no muxed format (${adaptive.length} adaptive only)`);
    noteFail(client);
    return null;
  }

  const vd = data.videoDetails || {};
  noteOk(client);
  return {
    ok: true,
    client: client.id,
    clientVersion: client.ctx.clientVersion,
    authed: !!opts.cookies,
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
    formats: formats.map((f) => ({
      ...f,
      url: `/api/media?u=${encodeURIComponent(f.url)}&v=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(f.itag)}`,
    })),
    attempts,
  };
}

// ── emergency mirrors (opt-in via env, last resort only) ────────────────────
// Only Invidious with local=true is usable here: the instance proxies the bytes,
// so the URL is not tied to our IP. Piped direct URLs would 403.
function emergencyMirrors(env) {
  return String((env && env.EMERGENCY_MIRRORS) || "")
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

async function mirrorStream(videoId, mirrors, attempts = []) {
  for (const base of mirrors) {
    try {
      const r = await fetchRetry(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?fields=title,author,authorId,viewCount,lengthSeconds,published,description,formatStreams,recommendedVideos`, {
        headers: { "user-agent": WEB_UA, accept: "application/json" },
      }, { retries: 0, timeout: 8000 });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const streams = (d.formatStreams || []).filter((f) => f && f.url);
      if (!streams.length) throw new Error("no formatStreams");
      streams.sort((a, b) => parseInt(b.resolution || b.quality || 0) - parseInt(a.resolution || a.quality || 0));
      const local = (u) => (/local=true/.test(u) ? u : `${base}${u.startsWith("/") ? "" : "/"}${u}${u.includes("?") ? "&" : "?"}local=true`);
      return {
        ok: true,
        client: "emergency-mirror",
        clientVersion: "",
        authed: false,
        video: {
          videoId,
          title: d.title || "",
          description: d.description || "",
          author: d.author || "",
          authorId: d.authorId || "",
          viewCount: Number(d.viewCount || 0),
          lengthSeconds: Number(d.lengthSeconds || 0),
          live: false,
          thumbnails: [],
        },
        formats: streams.slice(0, 4).map((f) => ({
          itag: f.itag,
          quality: f.resolution || f.quality || "auto",
          height: parseInt(f.resolution || 0) || 0,
          mime: f.type || "video/mp4",
          url: `/api/media?u=${encodeURIComponent(local(f.url))}&itag=${encodeURIComponent(f.itag)}`,
          kind: "muxed",
        })),
        attempts: [...attempts, `mirror ${base}: ok`],
      };
    } catch (e) {
      attempts.push(`mirror ${base}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Resolve a playable stream — multi-pass, self-healing:
 *   1. anonymous ladder (breaker-aware, 25s budget)
 *   2. if everything failed: force version + visitorData re-discovery, try again
 *   3. authenticated pass with cookies (only if the caller proved SV_KEY)
 *   4. emergency mirrors (only if EMERGENCY_MIRRORS is configured)
 */
async function player(videoId, opts = {}) {
  const env = opts.env || {};
  const attempts = [];
  const deadline = Date.now() + 25000;
  const poToken = (env && env.PO_TOKEN) || "";

  let { versions, source, visitorData } = await discoverVersions(env);
  let ladder = buildClients(versions, opts.region || "IN");

  const runPass = async (clients, extraOpts, tag, useBreakers = true) => {
    for (const client of clients) {
      if (Date.now() > deadline) {
        attempts.push(`${tag || "pass"} stopped: time budget reached`);
        return null;
      }
      if (useBreakers && breakerCooling(client)) {
        attempts.push(`${client.id}@${client.ctx.clientVersion}: skipped (cooling down)`);
        continue;
      }
      const res = await tryClient(client, videoId, { ...extraOpts, poToken }, attempts, tag);
      if (res) return res;
    }
    return null;
  };

  // pass 1 — anonymous
  let hit = await runPass(ladder, { visitorData }, "");
  if (hit) return { ...hit, versions, versionSource: source, pass: 1 };

  // pass 2 — self-heal: refresh versions + visitorData, retry anonymously
  const fresh = await discoverVersions(env, true);
  versions = fresh.versions;
  source = fresh.source;
  visitorData = fresh.visitorData || visitorData;
  ladder = buildClients(versions, opts.region || "IN");
  hit = await runPass(ladder, { visitorData }, "retry", false);
  if (hit) return { ...hit, versions, versionSource: source, pass: 2, healed: true };

  // pass 3 — cookies (only with a valid SV_KEY), SAPISIDHASH for web-family clients
  const cookieHeader = opts.cookieHeader || "";
  if (cookieHeader) {
    const auth = await sapisidHash(cookieHeader);
    const authClients = ladder.filter((c) =>
      ["android", "web", "ios", "tv_embedded", "web_embedded"].includes(c.id)
    );
    for (const client of authClients) {
      if (Date.now() > deadline) break;
      const needsHash = client.id === "web" || client.id === "web_embedded";
      const res = await tryClient(
        client,
        videoId,
        { visitorData, cookies: cookieHeader, authorization: needsHash ? auth : "" },
        attempts,
        "auth"
      );
      if (res) return { ...res, authed: true, versions, versionSource: source, pass: 3 };
    }
  }

  // pass 4 — emergency mirrors (disabled unless configured)
  const mirrors = emergencyMirrors(env);
  if (mirrors.length) {
    const m = await mirrorStream(videoId, mirrors, attempts);
    if (m) return { ...m, versions, versionSource: source, pass: 4 };
  }

  return {
    ok: false,
    error: cookieHeader
      ? "no playable stream (anonymous + authenticated + mirrors all failed)"
      : "no playable stream from any client",
    attempts,
    versions,
    versionSource: source,
    cookiesUsed: !!cookieHeader,
    breakers: breakerSnapshot(),
  };
}

async function listCall(env, url, endpoint, extra, callOpts = {}) {
  const region = (url.searchParams.get("region") || "IN").toUpperCase();
  const cookieHeader = cookieAuth(env, url);

  const attemptWith = async (force, bypassBreakers = false) => {
    const { versions, visitorData } = await discoverVersions(env, force);
    const ladder = buildClients(versions, region);
    const order = [
      ladder.find((c) => c.id === "mweb"),
      ladder.find((c) => c.id === "web"),
      ladder.find((c) => c.id === "android_vr"),
      ...ladder,
    ].filter(Boolean);

    const candidates = cookieHeader
      ? [
          { client: order[0], opts: { visitorData } },
          { client: ladder.find((c) => c.id === "web"), opts: { visitorData, cookies: cookieHeader, authorization: await sapisidHash(cookieHeader) } },
          { client: ladder.find((c) => c.id === "android_vr"), opts: { visitorData, cookies: cookieHeader } },
        ]
      : order.slice(0, 6).map((client) => ({ client, opts: { visitorData } }));

    let lastError = null;
    for (const { client, opts } of candidates) {
      if (!client) continue;
      // ignoreCooling: last-resort fallbacks and the self-heal round still try even when
      // other calls just tripped the breakers (a warm breaker must not blank the page)
      if (!bypassBreakers && !callOpts.ignoreCooling && breakerCooling(client)) continue;
      try {
        const data = await innertube(client, endpoint, extra, { ...opts, retries: 0, timeout: 8000 });
        noteOk(client);
        if (
          data &&
          (data.contents ||
            data.onResponseReceivedActions ||
            data.onResponseReceivedEndpoints ||
            data.continuationContents ||
            data.items ||
            data.header ||
            data.frameworkUpdates)
        )
          return data;
        throw new Error("empty response from " + client.id + " (keys: " + (data && typeof data === "object" ? Object.keys(data).slice(0, 6).join(",") : typeof data) + ")");
      } catch (e) {
        lastError = e;
        noteFail(client);
      }
    }
    if (!lastError) lastError = new Error("all clients cooling down");
    throw lastError;
  };

  try {
    return await attemptWith(false);
  } catch {
    // self-heal: re-discover versions and this time ignore breaker cooldowns — a cooldown
    // tripped by another endpoint must not turn into a blank list
    return await attemptWith(true, true);
  }
}

async function search(q, page = 1, env = {}, url = new URL("https://x/")) {
  const data = await listCall(env, url, "search", { query: q, params: page > 1 ? undefined : undefined });
  const items = normalizeList(data, 32);
  const tokens = collect(data, ["continuationItemRenderer"])
    .map((c) => c.continuationEndpoint?.continuationCommand?.token)
    .filter(Boolean);
  return { items, continuation: page > 1 ? null : tokens[0] || null };
}

async function searchMore(q, token, env = {}, url = new URL("https://x/")) {
  const data = await listCall(env, url, "search", { query: q, continuation: token });
  return { items: normalizeList(data, 32) };
}

async function trending(region = "IN", env = {}, url = new URL("https://x/"), callOpts = {}) {
  const attempts = [];
  const sources = [
    { kind: "browse", extra: { browseId: "FEtrending" }, name: "FEtrending" },
    { kind: "browse", extra: { browseId: "FEwhat_to_watch" }, name: "FEwhat_to_watch" },
    { kind: "browse", extra: { browseId: "FEexplore" }, name: "FEexplore" },
    { kind: "search", extra: { query: "trending " + region + " today" }, name: "search trending" },
  ];
  for (const src of sources) {
    try {
      const data = await listCall(env, url, src.kind, src.extra, { ...callOpts, ignoreCooling: src.name !== "FEtrending" });
      const items = normalizeList(data, 40);
      attempts.push({ source: src.name, found: items.length });
      if (items.length) return { items, source: src.name, attempts };
    } catch (e) {
      attempts.push({ source: src.name, error: String((e && e.message) || e) });
    }
  }
  return { items: [], source: null, attempts };
}

async function related(videoId, env = {}, url = new URL("https://x/")) {
  const data = await listCall(env, url, "next", { videoId });
  return { items: normalizeList(data, 24) };
}

// ── Shorts ────────────────────────────────────────────────────────────────────
const SHORT_MAX_SEC = 90;
const ID_RE = /^[A-Za-z0-9_-]{6,15}$/;
const shortThumb = (id) => `https://i.ytimg.com/vi/${id}/oardefault.jpg`;

function makeShort(x) {
  if (!x || !ID_RE.test(x.videoId || "")) return null;
  const views = typeof x.views === "number" ? x.views : VIEWS(x.views);
  const thumb = x.thumb && /^https?:/.test(x.thumb) ? x.thumb : shortThumb(x.videoId);
  return {
    videoId: x.videoId,
    title: x.title || "",
    author: x.author || "",
    authorId: x.authorId || "",
    thumbnail: thumb,
    lengthSeconds: x.lengthSeconds || 0,
    viewCount: views,
    publishedText: x.publishedText || "",
    live: false,
    isShort: true,
  };
}

// older shape: reelItemRenderer { videoId, headline, viewCountText, thumbnail, navigationEndpoint }
function shortFromReel(r) {
  if (!r) return null;
  const nav = r.navigationEndpoint || {};
  const thumbs = r.thumbnail?.thumbnails || r.thumbnail?.richThumbnail?.movingThumbnailRenderer?.thumbnail?.thumbnails || [];
  return makeShort({
    videoId: r.videoId || nav.reelWatchEndpoint?.videoId || nav.watchEndpoint?.videoId || "",
    title: textOf(r.headline) || textOf(r.title),
    views: textOf(r.viewCountText) || textOf(r.shortViewCountText),
    author: textOf(r.ownerText) || textOf(r.longBylineText) || textOf(r.channelTitle),
    authorId: CHANNEL(r),
    thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
  });
}

// current shape: shortsLockupViewModel { entityId, overlayMetadata, thumbnailViewModel, onTap }
function shortFromLockup(m) {
  if (!m) return null;
  const cmd = m.onTap?.innertubeCommand || m.rendererContext?.commandContext?.onTap?.innertubeCommand || {};
  const id = String(m.entityId || "").replace(/^shorts-shelf-item-/, "") ||
    cmd.reelWatchEndpoint?.videoId || cmd.watchEndpoint?.videoId || "";
  let sources = m.thumbnail?.sources || m.thumbnailViewModel?.image?.sources || [];
  if (!sources.length) {
    // the shape moves around: pick the biggest image + the first UC channel ref anywhere in the node
    const anySources = collect(m, ["sources"]).flat().filter((x) => x && x.url);
    sources = anySources.length ? anySources : [];
  }
  const sorted = sources.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  const primary = m.overlayMetadata?.primaryText;
  const secondary = m.overlayMetadata?.secondaryText;
  const viewsText = textOf(secondary) || textOf(m.viewCountText);
  const browseHit = collect(m, ["browseEndpoint"]).find((b) => /^UC[\w-]{10,}$/.test(b.browseId || ""));
  const author =
    textOf(m.overlayMetadata?.bylineText) || textOf(m.channelTitle) || textOf(browseHit?.browseEndpointContextSupportedConfigs?.noop) || "";
  return makeShort({
    videoId: id,
    title: textOf(primary) || textOf(m.accessibilityText),
    views: viewsText,
    author,
    authorId: cmd.browseEndpoint?.browseId || browseHit?.browseId || "",
    thumb: sorted.length ? sorted[0].url : "",
  });
}

function parseShorts(data, limit = 40) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (v && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push(v);
    }
  };
  for (const r of collect(data, ["reelItemRenderer"])) {
    push(shortFromReel(r));
    if (out.length >= limit * 2) break;
  }
  for (const m of collect(data, ["shortsLockupViewModel"])) {
    push(shortFromLockup(m));
    if (out.length >= limit * 2) break;
  }
  return out.slice(0, limit);
}

async function shorts(region = "IN", env = {}, url = new URL("https://x/")) {
  const attempts = [];
  let items = [];

  // 1. the real Shorts feed
  try {
    const data = await listCall(env, url, "browse", { browseId: "FEshorts" });
    items = parseShorts(data, 40);
    attempts.push({ source: "FEshorts", found: items.length });
  } catch (e) {
    attempts.push({ source: "FEshorts", error: String((e && e.message) || e) });
  }

  // 2. #shorts search, then trim by duration
  if (!items.length) {
    try {
      const data = await listCall(env, url, "search", { query: "#shorts" }, { ignoreCooling: true });
      items = parseShorts(data, 40);
      if (!items.length) {
        items = normalizeList(data, 60)
          .filter((v) => v.lengthSeconds > 0 && v.lengthSeconds <= SHORT_MAX_SEC)
          .map((v) => makeShort({ ...v, views: v.viewCount, thumb: v.thumbnail }))
          .filter(Boolean);
      }
      attempts.push({ source: "search #shorts", found: items.length });
    } catch (e) {
      attempts.push({ source: "search #shorts", error: String((e && e.message) || e) });
    }
  }

  // 3. last resort: short items already in trending
  if (!items.length) {
    try {
      const t = await trending(region, env, url, { ignoreCooling: true });
      items = (t.items || [])
        .filter((v) => v.lengthSeconds > 0 && v.lengthSeconds <= SHORT_MAX_SEC)
        .map((v) => makeShort({ ...v, views: v.viewCount, thumb: v.thumbnail }))
        .filter(Boolean);
      attempts.push({ source: "trending<=90s", found: items.length });
    } catch (e) {
      attempts.push({ source: "trending<=90s", error: String((e && e.message) || e) });
    }
  }

  const used = attempts.filter((a) => a.found > 0).pop();
  return { items: items.slice(0, 40), count: Math.min(items.length, 40), region, source: used ? used.source : null, attempts };
}

function mirrorHosts(env) {
  return emergencyMirrors(env).map((u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean);
}

// Re-resolve a stream URL when the signed one expired / got rejected mid-playback.
async function refreshedUrl(videoId, itag, env) {
  try {
    const fresh = await player(videoId, { env });
    if (!fresh || !fresh.ok) return "";
    const exact = fresh.formats.find((f) => String(f.itag) === String(itag));
    const pick = exact || fresh.formats[0];
    if (!pick) return "";
    const raw = decodeURIComponent(pick.url.split("u=")[1].split("&")[0]);
    return raw;
  } catch {
    return "";
  }
}

// ── direct .mp4 endpoint ──────────────────────────────────────────────────────
// /mp4/<videoId>.mp4 (also /api/file/<id>.mp4) resolves the best muxed stream and
// streams it through the proxy with a real video/mp4 content-type, so the URL works
// in a browser tab, <video>, VLC, ffmpeg, etc. Add ?dl=1 for an attachment download.
async function directMp4(videoId, request, env) {
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) return err("bad video id", 400);
  const urlObj = new URL(request.url);
  const p = await player(videoId, {
    env,
    cookieHeader: cookieAuth(env, urlObj),
    region: (urlObj.searchParams.get("region") || "IN").toUpperCase(),
  });
  if (!p.ok || !p.formats || !p.formats.length) {
    return json({ error: p.error || "no playable stream", attempts: (p.attempts || []).slice(-8) }, 502);
  }
  const want = urlObj.searchParams.get("itag");
  const pick = (want && p.formats.find((f) => String(f.itag) === String(want))) || p.formats[0];
  const upstream = decodeURIComponent(pick.url.split("u=")[1].split("&")[0]);

  const res = await media(upstream, request, env);
  const headers = new Headers(res.headers);
  const safeTitle = String(p.video.title || videoId)
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .slice(0, 60) || videoId;
  const disp = urlObj.searchParams.get("dl") === "1" ? "attachment" : "inline";
  headers.set("content-type", "video/mp4");
  headers.set("content-disposition", `${disp}; filename="${safeTitle}.mp4"`);
  headers.set("x-sv-video-id", videoId);
  headers.set("x-sv-quality", pick.quality || "");
  headers.set("x-sv-client", p.client || "");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "content-length, content-range, accept-ranges, x-sv-quality, x-sv-client");
  return new Response(res.body, { status: res.status, headers });
}

async function media(url, request, env = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return err("bad media url", 400);
  }
  const host = target.hostname;
  const allowed =
    /(^|\.)googlevideo\.com$/.test(host) ||
    /(^|\.)youtube\.com$/.test(host) ||
    /(^|\.)ytimg\.com$/.test(host) ||
    mirrorHosts(env).includes(host);
  if (!allowed) return err("host not allowed: " + host, 400);

  const range = request.headers.get("range") || "";
  const buildHeaders = () => {
    const h = new Headers({ "user-agent": UA.web, referer: "https://www.youtube.com/" });
    if (range) h.set("range", range);
    return h;
  };

  let upstream = null;
  let lastStatus = 0;
  try {
    upstream = await fetchRetry(target.toString(), { headers: buildHeaders(), redirect: "follow" }, { retries: 1, timeout: 25000 });
    lastStatus = upstream.status;
  } catch (e) {
    return err("upstream fetch failed: " + e.message, 502);
  }

  // expired / rejected signature → ask YouTube for a fresh URL, retry once
  let refreshed = false;
  if (upstream.status === 403 || upstream.status === 410 || upstream.status === 404) {
    const reqParams = new URL(request.url).searchParams;
    const videoId = reqParams.get("v") || "";
    const itag = reqParams.get("itag") || "";
    if (videoId) {
      const next = await refreshedUrl(videoId, itag, env);
      if (next && next !== target.toString()) {
        try {
          upstream = await fetchRetry(next, { headers: buildHeaders(), redirect: "follow" }, { retries: 1, timeout: 25000 });
          lastStatus = upstream.status;
          refreshed = true;
        } catch {
          /* keep original response below */
        }
      }
    }
  }

  const out = new Headers();
  for (const h of ["content-length", "content-range", "accept-ranges", "content-type", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("access-control-allow-origin", "*");
  out.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
  out.set("cache-control", "no-store");
  if (refreshed) out.set("x-sv-refreshed", "1");

  if (request.method === "HEAD") {
    try {
      upstream.body?.cancel?.();
    } catch {
      /* ignore */
    }
    return new Response(null, { status: upstream.status, headers: out });
  }

  return new Response(upstream.body, { status: upstream.status || lastStatus, headers: out });
}

// ── RSS subscriptions (channel feeds) ────────────────────────────────────────
// YouTube publishes per-channel feeds at /feeds/videos.xml?channel_id=UC…
// They have no CORS headers, so the browser can only reach them through us.
function parseFeed(xml) {
  if (!xml) return { items: [], channel: null };
  const pick = (re, str = xml) => {
    const m = str.match(re);
    return m ? m[1] : "";
  };
  const decode = (t) =>
    String(t || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");

  const channelId = pick(/<yt:channelId>([^<]+)<\/yt:channelId>/);
  const channelName = decode(pick(/<author>\s*<name>([^<]*)<\/name>/));

  const items = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const videoId = pick(/<yt:videoId>([^<]+)<\/yt:videoId>/, e);
    if (!videoId) continue;
    const thumb =
      pick(/<media:thumbnail[^>]*url="([^"]+)"/, e) || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const views = pick(/<media:statistics[^>]*views="(\d+)"/, e);
    const rating = pick(/<media:starRating[^>]*count="(\d+)"/, e);
    items.push({
      videoId,
      title: decode(pick(/<title>([\s\S]*?)<\/title>/, e)),
      author: channelName || decode(pick(/<author>\s*<name>([^<]*)<\/name>/, e)),
      authorId: pick(/<yt:channelId>([^<]+)<\/yt:channelId>/, e) || channelId,
      publishedText: "",
      publishedAt: pick(/<published>([^<]+)<\/published>/, e),
      published: Math.floor(new Date(pick(/<published>([^<]+)<\/published>/, e)).getTime() / 1000) || 0,
      viewCount: Number(views || 0),
      likes: Number(rating || 0),
      lengthSeconds: 0,
      thumbnail: thumb,
      live: false,
      description: decode(pick(/<media:description>([\s\S]*?)<\/media:description>/, e)).slice(0, 300),
    });
  }
  return {
    items,
    channel: channelId ? { channelId, name: channelName, feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` } : null,
  };
}

// YouTube retired https://www.youtube.com/feeds/videos.xml (404 since Oct 2026), so the
// feed is only a *first try*: if it is gone we read the channel's Videos tab through
// InnerTube and rebuild the same shape. Kept for the day the feed comes back.
const FEED_STATE = { deadUntil: 0, lastError: "", fails: 0 };
const FEED_RETRY_MS = 6 * 3600 * 1000;

const REL_UNITS = {
  second: 1, sec: 1, minute: 60, min: 60, hour: 3600, hr: 3600,
  day: 86400, week: 604800, month: 2592000, year: 31536000,
};

// "2 hours ago" / "Streamed 3 days ago" / "Premiered 1 month ago" -> epoch seconds
function parseRelDate(text, now = Date.now() / 1000) {
  const t = String(text || "").toLowerCase().replace(/,/g, "");
  const m = t.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month|year)s?\s+ago/);
  if (!m) return 0;
  const unit = REL_UNITS[m[2]] || 0;
  if (!unit) return 0;
  return Math.round(now - Number(m[1]) * unit);
}

const CHANNEL_VIDEOS_PARAMS = [
  "EgZ2aWRlb3PyBgQKAjoA", // Videos tab, default (newest first)
  "EgZ2aWRlb3M%3D", // Videos tab, plain
  "", // no params: the channel home (still lists uploads)
];

async function channelBrowse(env, url, channelId, limit = 15) {
  let lastError = null;
  for (const params of CHANNEL_VIDEOS_PARAMS) {
    try {
      const extra = { browseId: channelId };
      if (params) extra.params = params;
      const data = await listCall(env, url, "browse", extra, { ignoreCooling: true });
      const raw = normalizeList(data, limit);
      const meta = collect(data, ["channelMetadataRenderer"])[0] || null;
      const header = collect(data, ["pageHeaderRenderer"])[0] || null;
      const headerTitle = textOf(header?.pageTitle);
      const avatar =
        meta?.avatar?.thumbnails?.slice(-1)[0]?.url ||
        collect(data, ["avatar"])[0]?.thumbnails?.slice(-1)[0]?.url ||
        "";
      if (raw.length) {
        const now = Date.now() / 1000;
        const items = raw.map((v, i) => ({
          ...v,
          // browse gives relative text, not a timestamp: approximate, keep order
          published: parseRelDate(v.publishedText, now) || Math.round(now - i * 1800),
          publishedAt: v.publishedText || "",
          description: "",
        }));
        return {
          items,
          channel: { channelId, name: headerTitle || textOf(meta?.title) || "", avatar },
          source: "innertube",
        };
      }
      lastError = new Error("empty channel listing");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("channel listing failed");
}

async function channelFeed(env, url, channelId) {
  // 1. the (now usually dead) XML feed, until it 404s once — then skip for 6h
  if (Date.now() > FEED_STATE.deadUntil) {
    try {
      const r = await fetchRetry(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
        { headers: { "user-agent": WEB_UA, "accept-language": "en-US,en;q=0.9" } },
        { retries: 0, timeout: 6000 }
      );
      if (r.ok) {
        const parsed = parseFeed(await r.text());
        if (parsed.items.length) {
          FEED_STATE.fails = 0;
          return { ...parsed, source: "feed" };
        }
      }
      // a 404 here may just mean "this channel is wrong", so only retire the feed
      // once the channel listing proves the channel *does* exist (see below)
      FEED_STATE.lastError = "HTTP " + r.status;
      FEED_STATE.fails = (FEED_STATE.fails || 0) + 1;
    } catch (e) {
      FEED_STATE.deadUntil = Date.now() + FEED_RETRY_MS;
      FEED_STATE.lastError = String((e && e.message) || e);
    }
  }
  // 2. InnerTube channel Videos tab
  const viaBrowse = await channelBrowse(env, url, channelId, 15);
  // channel exists (we just listed its videos) but the feed did not serve it → retire the feed
  if (viaBrowse.items.length && FEED_STATE.fails) FEED_STATE.deadUntil = Date.now() + FEED_RETRY_MS;
  return viaBrowse;
}

async function rss(env, ids, url = new URL("https://x/")) {
  const list = [...new Set(String(ids || "").split(",").map((x) => x.trim()).filter((x) => /^UC[\w-]{10,}$/.test(x)))].slice(0, 30);
  if (!list.length) return { items: [], channels: [], errors: [], sources: {} };

  const results = await Promise.all(
    list.map(async (id) => {
      try {
        const got = await channelFeed(env, url, id);
        return { id, ...got };
      } catch (e) {
        return { id, items: [], channel: null, error: String((e && e.message) || e) };
      }
    })
  );

  const items = [];
  const seen = new Set();
  for (const r of results) {
    for (const it of r.items) {
      if (seen.has(it.videoId)) continue;
      seen.add(it.videoId);
      items.push(it);
    }
  }
  items.sort((a, b) => b.published - a.published);

  const sources = {};
  for (const r of results) if (r.source) sources[r.id] = r.source;

  return {
    items: items.slice(0, 120),
    channels: results
      .filter((r) => r.channel || r.items.length)
      .map((r) => ({ channelId: r.id, name: r.channel?.name || r.items[0]?.author || "", avatar: r.channel?.avatar || "" })),
    errors: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    sources,
    feedDead: Date.now() < FEED_STATE.deadUntil,
    note: "YouTube's RSS endpoint (feeds/videos.xml) returns 404 since Oct 2026 — the channel Videos tab is used instead; same data, no login.",
  };
}

// Resolve a channel from a URL / @handle / video id — used by "Subscribe".
async function resolveChannel(input) {
  const raw = String(input || "").trim();
  if (/^UC[\w-]{10,}$/.test(raw)) return { channelId: raw };
  if (!raw) throw new Error("empty input");

  let target = raw;
  const idInUrl = raw.match(/channel\/(UC[\w-]{10,})/);
  if (idInUrl) return { channelId: idInUrl[1] };
  if (!/^https?:/i.test(raw)) {
    target = raw.startsWith("@") ? `https://www.youtube.com/${raw}` : `https://www.youtube.com/@${raw}`;
  }
  const r = await fetchRetry(target, { headers: { "user-agent": WEB_UA, "accept-language": "en-US,en;q=0.9" } }, { retries: 1, timeout: 9000 });
  if (!r.ok) throw new Error("channel page HTTP " + r.status);
  const html = await r.text();
  const channelId = (html.match(/"channelId":"(UC[\w-]{10,})"/) || [])[1] || (html.match(/channel\/(UC[\w-]{10,})/) || [])[1];
  if (!channelId) throw new Error("channel id not found (private or wrong link?)");
  const title =
    (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] ||
    (html.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
  const avatar = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || "";
  return { channelId, name: title.replace(/\s*-\s*YouTube$/, ""), avatar, source: target };
}

// renderer histogram — tells us what shape YouTube is serving right now
function rendererHistogram(data, limit = 24) {
  const counts = {};
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 24) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    for (const k in node) {
      if (/(Renderer|ViewModel)$/.test(k)) counts[k] = (counts[k] || 0) + 1;
      const v = node[k];
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

async function probe(u, env) {
  const q = u.searchParams.get("q") || "lofi";
  const kind = u.searchParams.get("endpoint") === "browse" ? "browse" : "search";
  const extra = kind === "browse" ? { browseId: u.searchParams.get("browseId") || "FEtrending" } : { query: q };
  const t0 = Date.now();
  const out = { kind, extra, ms: 0, client: null, ok: false };
  try {
    const { versions, visitorData } = await discoverVersions(env);
    const ladder = buildClients(versions, (u.searchParams.get("region") || "IN").toUpperCase());
    const results = [];
    for (const client of [ladder.find((c) => c.id === "mweb"), ladder.find((c) => c.id === "web"), ladder.find((c) => c.id === "android_vr")].filter(Boolean)) {
      try {
        const data = await innertube(client, kind, extra, { visitorData, retries: 0, timeout: 9000 });
        const items = normalizeList(data, 5);
        const sampleNode =
          collect(data, ["lockupViewModel"])[0] ||
          collect(data, ["videoRenderer"])[0] ||
          collect(data, ["reelItemRenderer"])[0] ||
          null;
        results.push({
          client: client.id + "@" + client.ctx.clientVersion,
          keys: data && typeof data === "object" ? Object.keys(data) : [],
          renderers: rendererHistogram(data),
          parsed: items.length,
          first: items[0] || null,
          sample: sampleNode ? JSON.stringify(sampleNode).slice(0, 2500) : null,
        });
        if (items.length) {
          out.ok = true;
          out.client = client.id;
          out.results = results;
          break;
        }
      } catch (e) {
        results.push({ client: client.id + "@" + client.ctx.clientVersion, error: String((e && e.message) || e) });
      }
    }
    out.results = results;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.ms = Date.now() - t0;
  return out;
}

// one list, used by the landing page and the 404 body (no drift)
const ROUTE_LIST = [
  "/api/health",
  "/api/debug",
  "/api/probe?q=lofi",
  "/api/selftest?id=",
  "/api/player?id=",
  "/api/search?q=",
  "/api/searchmore?q=&token=",
  "/api/trending?region=IN",
  "/api/shorts?region=IN",
  "/api/related?id=",
  "/api/rss?channels=UC..,UC..",
  "/api/channel?q=@handle",
  "/api/media?u=",
  "/mp4/{id}.mp4",
];

function landingPage(env) {
  const cookies = !!(env && env.YT_COOKIES);
  const keyed = !!(env && env.SV_KEY);
  const app = (env && env.APP_URL) || "";
  const rows = ROUTE_LIST.map(
    (r) => `<a class="r" href="${r.replace(/\{id\}|\.\.|@handle|=$|UC\.\./g, "")}"><code>${r}</code></a>`
  ).join("\n      ");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>StreamVoid worker · running</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0f0f0f;color:#f1f1f1;font:15px/1.6 system-ui,-apple-system,Roboto,sans-serif;padding:32px 20px}
.w{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;background:#2ecc71;box-shadow:0 0 10px #2ecc71}
.sub{color:#aaa;margin:0 0 24px}
.card{background:#181818;border:1px solid #303030;border-radius:14px;padding:16px 18px;margin-bottom:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.7px;color:#9a9a9a;margin:0 0 10px}
.r{display:block;padding:7px 10px;border-radius:8px;color:#3ea6ff;text-decoration:none}
.r:hover{background:#212121}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#e8e8e8}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.b{font-size:12px;padding:3px 10px;border-radius:999px;background:#212121;color:#bbb;border:1px solid #303030}
.b.ok{color:#7ee2a8;border-color:#2b5a3f}
.b.off{color:#f0b27a;border-color:#5a452b}
a.btn{display:inline-block;padding:10px 16px;border-radius:10px;background:#fff;color:#0f0f0f;font-weight:600;text-decoration:none;margin:0 8px 8px 0}
a.btn.ghost{background:#272727;color:#eee}
p{margin:8px 0}
.muted{color:#9a9a9a;font-size:13px}
</style></head><body><div class="w">
  <h1><span class="dot"></span>StreamVoid worker is running</h1>
  <p class="sub">Serverless YouTube engine — InnerTube + media proxy + RSS. No API key.</p>

  <div class="card">
    <h2>Status</h2>
    <div class="badges">
      <span class="b ok">engine: innertube</span>
      <span class="b ${cookies ? "ok" : ""}">cookies: ${cookies ? "configured" : "not set"}</span>
      <span class="b ${keyed ? "ok" : ""}">SV_KEY: ${keyed ? "set (cookies need ?key=)" : "not set"}</span>
    </div>
    <p style="margin-top:14px"><a class="btn" href="/api/health">/api/health</a><a class="btn ghost" href="/?format=json">same as JSON</a>${app ? `<a class="btn ghost" href="${app}">Open the app</a>` : ""}</p>
    <p class="muted">App me Settings → Engine URL me is worker ka URL daalo, phir search/trending/shorts/playback chalu ho jayega.</p>
  </div>

  <div class="card">
    <h2>Routes</h2>
    ${rows}
  </div>

  <div class="card">
    <h2>Quick test</h2>
    <p class="muted">In links ko kholke dekho — sab JSON aana chahiye:</p>
    <p><a class="btn ghost" href="/api/selftest?id=dQw4w9WgXcQ">/api/selftest?id=dQw4w9WgXcQ</a><a class="btn ghost" href="/api/trending?region=IN">/api/trending</a><a class="btn ghost" href="/api/shorts?region=IN">/api/shorts</a></p>
    <p class="muted">Direct file: <code>/mp4/dQw4w9WgXcQ.mp4</code> · <code>?dl=1</code> download · <code>?itag=18</code> quality</p>
  </div>

  <p class="muted">This page is only shown at the root — every real endpoint lives under <code>/api/*</code> or <code>/mp4/*</code>.</p>
</div></body></html>`;
}

function notFound(url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const near = ROUTE_LIST
    .map((r) => r.split("?")[0].replace(/\{id\}|\/.*\{.*\}/, ""))
    .filter((r) => r.startsWith(path) || path.startsWith(r));
  return err("not found", 404, {
    path: url.pathname,
    routes: ROUTE_LIST,
    hint: path === "/" ? "Open / for the status page, or /api/health for JSON." : "Check the route spelling — no trailing slash needed.",
    didYouMean: [...new Set(near)].slice(0, 6),
  });
}

const ROUTES = [
  [
    "/api/health",
    async (u, env) => {
      const { versions, source } = await discoverVersions(env);
      const cookies = env && env.YT_COOKIES ? parseCookies(env.YT_COOKIES) : "";
      return {
        ok: true,
        service: "streamvoid-worker",
        engine: "innertube",
        clients: CLIENT_SPECS.map((c) => c.id),
        versions,
        versionSource: source,
        ladder: "2 versions per client (discovered, then baked fallback)",
        cookies: cookies
          ? {
              configured: true,
              used: keyAllowed(env, u),
              keys: cookies.split("; ").map((x) => x.split("=")[0]).slice(0, 12),
              note: keyAllowed(env, u) ? "cookies enabled for this caller" : "SV_KEY mismatch → cookies NOT used",
            }
          : { configured: false },
        versionCacheAge: Math.round(Date.now() / 1000 - VERSION_CACHE.ts) + "s",
        resilience: {
          visitorData: !!VERSION_CACHE.visitorData,
          breakers: breakerSnapshot(),
          emergencyMirrors: emergencyMirrors(env).length,
          poToken: !!(env && env.PO_TOKEN),
          passes: ["anonymous", "self-heal(versions+visitor)", "cookies(SV_KEY)", "emergency mirrors"],
        },
      };
    },
  ],
  [
    "/api/debug",
    async (u, env) => {
      const { versions, source } = await discoverVersions(env, u.searchParams.get("refresh") === "1");
      const ladder = buildClients(versions, (u.searchParams.get("region") || "IN").toUpperCase());
      return {
        ok: true,
        versions,
        source,
        ladder: ladder.map((c) => ({ id: c.id, version: c.ctx.clientVersion })),
        cookieHeaderPresent: !!(env && env.YT_COOKIES),
        keyProtectsCookies: !!(env && env.SV_KEY),
      };
    },
  ],
  [
    "/api/selftest",
    async (u, env) => {
      const id = u.searchParams.get("id") || "dQw4w9WgXcQ";
      const t0 = Date.now();
      const res = await player(id, {
        env,
        cookieHeader: cookieAuth(env, u),
        region: (u.searchParams.get("region") || "IN").toUpperCase(),
      });
      return {
        ok: !!res.ok,
        video: id,
        ms: Date.now() - t0,
        pass: res.pass || 0,
        client: res.client || null,
        clientVersion: res.clientVersion || null,
        healed: !!res.healed,
        formats: (res.formats || []).map((f) => f.quality),
        attempts: (res.attempts || []).slice(-12),
        breakers: breakerSnapshot(),
      };
    },
  ],
  ["/api/player", async (u, env) => player(u.searchParams.get("id") || "", { env, cookieHeader: cookieAuth(env, u), region: (u.searchParams.get("region") || "IN").toUpperCase() })],
  ["/api/search", async (u, env) => search(u.searchParams.get("q") || "", Number(u.searchParams.get("page") || 1), env, u)],
  ["/api/searchmore", async (u, env) => searchMore(u.searchParams.get("q") || "", u.searchParams.get("token") || "", env, u)],
  ["/api/trending", async (u, env) => trending((u.searchParams.get("region") || "IN").toUpperCase(), env, u)],
  ["/api/related", async (u, env) => related(u.searchParams.get("id") || "", env, u)],
  ["/api/shorts", async (u, env) => shorts((u.searchParams.get("region") || "IN").toUpperCase(), env, u)],
  ["/api/rss", async (u, env) => rss(env, u.searchParams.get("channels") || "", u)],
  ["/api/probe", async (u, env) => probe(u, env)],
  ["/api/channel", async (u) => resolveChannel(u.searchParams.get("q") || u.searchParams.get("id") || "")],
];

export default {
  async fetch(request, env = {}) {
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
    // tolerate a single trailing slash: /api/health/ === /api/health
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/") {
        // human-friendly status page; ?format=json / Accept: application/json for machines
        const wantJson = url.searchParams.get("format") === "json" || /application\/json/.test(request.headers.get("accept") || "");
        if (wantJson) {
          return json({ ok: true, service: "streamvoid-worker", routes: ROUTE_LIST, health: "/api/health" });
        }
        return new Response(landingPage(env), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      if (path === "/api/media" || path === "/api/thumb") {
        return media(url.searchParams.get("u") || "", request, env);
      }
      // pretty direct-file endpoints: /mp4/<id>.mp4 and /api/file/<id>.mp4
      const mp4 = path.match(/^\/(?:api\/)?(?:file|mp4)\/([A-Za-z0-9_-]{6,15})\.mp4$/);
      if (mp4) return directMp4(mp4[1], request, env);
      for (const [route, handler] of ROUTES) {
        if (path === route) return json(await handler(url, env));
      }
      return notFound(url);
    } catch (e) {
      return err(e && e.message ? e.message : "worker error", 502);
    }
  },
};

// exported for tests
export {
  findSigName,
  findNName,
  buildDecipher,
  fnSource,
  objectSource,
  balanced,
  normalizeList,
  normVideo,
  durToSec,
  VIEWS,
  player,
  search,
  trending,
  related,
  // new: version discovery + cookies
  parseYtdlpVersions,
  discoverVersions,
  buildClients,
  CLIENT_SPECS,
  FALLBACK_VERSIONS,
  parseCookies,
  sapisidHash,
  sha1Hex,
  keyAllowed,
  cookieAuth,
  fetchRetry,
  breakerSnapshot,
  resetBreakers,
  noteFail,
  noteOk,
  breakerCooling,
  emergencyMirrors,
  mirrorStream,
  refreshedUrl,
  directMp4,
  parseFeed,
  rss,
  resolveChannel,
  shorts,
  probe,
  rendererHistogram,
  normLockup,
  genericVideos,
  channelBrowse,
  channelFeed,
  parseRelDate,
  FEED_STATE,
  landingPage,
  notFound,
  ROUTE_LIST,
  parseShorts,
  shortFromReel,
  shortFromLockup,
  makeShort,
  SHORT_MAX_SEC,
};
