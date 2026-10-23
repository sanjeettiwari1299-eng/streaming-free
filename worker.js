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

async function listCall(env, url, endpoint, extra) {
  const region = (url.searchParams.get("region") || "IN").toUpperCase();
  const cookieHeader = cookieAuth(env, url);

  const attemptWith = async (force) => {
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
      : order.slice(0, 4).map((client) => ({ client, opts: { visitorData } }));

    let lastError = null;
    for (const { client, opts } of candidates) {
      if (!client) continue;
      if (breakerCooling(client)) continue;
      try {
        const data = await innertube(client, endpoint, extra, { ...opts, retries: 0, timeout: 8000 });
        noteOk(client);
        if (data && (data.contents || data.onResponseReceivedActions || data.items)) return data;
        throw new Error("empty response");
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
    return await attemptWith(true); // self-heal: refresh versions, one more round
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

async function trending(region = "IN", env = {}, url = new URL("https://x/")) {
  const data = await listCall(env, url, "browse", { browseId: "FEtrending" });
  let items = normalizeList(data, 40);
  if (!items.length) {
    const alt = await listCall(env, url, "search", { query: `trending ${region}` });
    items = normalizeList(alt, 40);
  }
  return { items };
}

async function related(videoId, env = {}, url = new URL("https://x/")) {
  const data = await listCall(env, url, "next", { videoId });
  return { items: normalizeList(data, 24) };
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

async function rss(env, ids) {
  const list = [...new Set(String(ids || "").split(",").map((x) => x.trim()).filter((x) => /^UC[\w-]{10,}$/.test(x)))].slice(0, 30);
  if (!list.length) return { items: [], channels: [], errors: [] };

  const results = await Promise.all(
    list.map(async (id) => {
      try {
        const r = await fetchRetry(
          `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
          { headers: { "user-agent": WEB_UA, "accept-language": "en-US,en;q=0.9" } },
          { retries: 1, timeout: 8000 }
        );
        if (!r.ok) throw new Error("HTTP " + r.status);
        const parsed = parseFeed(await r.text());
        return { id, ...parsed };
      } catch (e) {
        return { id, items: [], channel: null, error: e.message };
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

  return {
    items: items.slice(0, 120),
    channels: results.filter((r) => r.channel).map((r) => r.channel),
    errors: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
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
  ["/api/rss", async (u, env) => rss(env, u.searchParams.get("channels") || "")],
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
    try {
      if (url.pathname === "/api/media" || url.pathname === "/api/thumb") {
        return media(url.searchParams.get("u") || "", request, env);
      }
      // pretty direct-file endpoints: /mp4/<id>.mp4 and /api/file/<id>.mp4
      const mp4 = url.pathname.match(/^\/(?:api\/)?(?:file|mp4)\/([A-Za-z0-9_-]{6,15})\.mp4$/);
      if (mp4) return directMp4(mp4[1], request, env);
      for (const [path, handler] of ROUTES) {
        if (url.pathname === path) return json(await handler(url, env));
      }
      return err("not found", 404, {
        routes: ["/api/health", "/api/debug", "/api/player?id=", "/api/search?q=", "/api/trending?region=IN", "/api/related?id=", "/api/media?u=", "/mp4/{id}.mp4"],
      });
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
};
