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

// bump this when the worker changes, so /api/health tells you which code is live
const BUILD = "8.8.0";

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
  // Studio / creator client — only meaningful with cookies (it is an account client)
  {
    id: "web_creator",
    num: "62",
    needsAuth: true,
    ctx: { clientName: "WEB_CREATOR", clientVersion: "1.20250101.00.00", hl: "en", gl: "IN" },
    ua: UA.web,
  },
  // visionOS app — a mobile-style client that is not part of the usual ladders
  {
    id: "visionos",
    num: "101",
    ctx: { clientName: "VISIONOS", clientVersion: "1.02", deviceMake: "Apple", deviceModel: "RealityDevice14,1", osName: "visionOS", osVersion: "2.0.21O209", hl: "en", gl: "IN" },
    ua: UA_IOS("1.02"),
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
  WEB_CREATOR: "1.20250101.00.00",
  VISIONOS: "1.02",
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
        needsAuth: !!spec.needsAuth,
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
      if (r.status === 429 || r.status >= 500) {
        const e = new Error("HTTP " + r.status);
        e.status = r.status;
        throw e;
      }
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

/* ── YouTube-wide gate ───────────────────────────────────────────────────────
   429/403 from InnerTube is not client-specific: every other client on this IP
   will get the same answer. Without this the ladder burns 20-40 subrequests
   (all 4xx in the Cloudflare metrics) and the user waits 20s for nothing.
   One strike → short cool-off, which the app honours via `retryAfter`. */
const YT_GATE = { until: 0, strikes: 0, status: 0, last: 0 };
const YT_GATE_MAX = 120000;
const ytGated = () => YT_GATE.until > Date.now();
const ytGateInfo = () => ({
  cooling: ytGated(),
  retryAfter: Math.max(0, Math.ceil((YT_GATE.until - Date.now()) / 1000)),
  strikes: YT_GATE.strikes,
  status: YT_GATE.status || 0,
});
const ytStrike = (status) => {
  const now = Date.now();
  // a single 429 is enough; successive ones back off exponentially
  YT_GATE.strikes = now - YT_GATE.last < 120000 ? YT_GATE.strikes + 1 : 1;
  YT_GATE.last = now;
  YT_GATE.status = status || 429;
  const wait = Math.min(YT_GATE_MAX, 20000 * Math.pow(2, YT_GATE.strikes - 1));
  YT_GATE.until = now + wait;
  return Math.ceil(wait / 1000);
};
const ytClear = () => {
  if (!YT_GATE.strikes && !YT_GATE.until) return;
  YT_GATE.strikes = 0;
  YT_GATE.until = 0;
  YT_GATE.status = 0;
};

// Which client actually delivered last time — retry it first instead of
// re-walking the whole ladder on every play (this is the main subrequest saver).
const WINNER = { id: "", version: "", ts: 0 };
const WINNER_TTL = 15 * 60 * 1000;
const winnerClient = () => (WINNER.id && Date.now() - WINNER.ts < WINNER_TTL ? WINNER : null);
const noteWinner = (c) => {
  if (!c || !c.id) return;
  WINNER.id = c.id;
  WINNER.version = String((c.ctx && c.ctx.clientVersion) || "");
  WINNER.ts = Date.now();
};

// Dead mirrors stay dead for a while: two 4xx/5xx answers → park the host.
const MIRROR_BREAKER = new Map(); // host -> { fails, until }
const mirrorCooling = (base) => {
  const b = MIRROR_BREAKER.get(base);
  return !!(b && b.until > Date.now());
};
const noteMirrorFail = (base) => {
  const b = MIRROR_BREAKER.get(base) || { fails: 0, until: 0 };
  b.fails += 1;
  b.until = Date.now() + Math.min(30 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, b.fails - 1));
  MIRROR_BREAKER.set(base, b);
};
const noteMirrorOk = (base) => MIRROR_BREAKER.delete(base);
const mirrorSnapshot = () =>
  [...MIRROR_BREAKER.entries()].map(([base, b]) => ({
    host: base.replace(/^https?:\/\//, "").split("/")[0],
    fails: b.fails,
    cooling: Math.max(0, Math.round((b.until - Date.now()) / 1000)),
  }));

/* ── player response cache (the real 429 killer) ─────────────────────────────
   A resolve is expensive and its signed URLs stay valid for hours. Remembering
   the last answer per video means: replay = 0 upstream calls, and a 429 storm
   cannot stop a video that was already played once today. Stored in the edge
   cache (survives isolates) with an in-memory layer in front. */
const PLAYER_TTL = 20 * 60 * 1000;          // fresh window
const PLAYER_MEM = new Map();               // key -> { at, data }
const PLAYER_MEM_MAX = 60;
const PLAYER_INFLIGHT = new Map();          // key -> Promise (request coalescing)

const playerCacheKey = (videoId, region, authed) =>
  `${videoId}|${String(region || "IN").toUpperCase()}|${authed ? "auth" : "anon"}`;
const playerCacheUrl = (key) => `https://sv.internal/player/${encodeURIComponent(key)}`;

/* how long may this response be reused? bounded by the signed URL's own expire */
function playerTtl(data) {
  let ttl = PLAYER_TTL;
  try {
    const raw = String(((data.formats || [])[0] || {}).url || "");
    const u = decodeURIComponent((raw.match(/[?&]u=([^&]+)/) || [])[1] || "");
    const exp = Number((u.match(/[?&]expire=([^&]+)/) || [])[1] || 0);
    if (exp) ttl = Math.min(ttl, Math.max(120000, exp * 1000 - Date.now() - 5 * 60 * 1000));
  } catch { /* keep the default */ }
  return ttl;
}

async function playerCacheGet(key, allowStale = false) {
  const mem = PLAYER_MEM.get(key);
  if (mem) {
    const age = Date.now() - mem.at;
    if (allowStale || age < mem.ttl) return { at: mem.at, data: mem.data, ttl: mem.ttl };
    PLAYER_MEM.delete(key);
  }
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const hit = await caches.default.match(new Request(playerCacheUrl(key)));
      if (hit && hit.ok !== false) {
        // clone: a cached Response body can be consumed only once
        let body = null;
        try { body = await hit.clone().json(); } catch { body = null; }
        if (body && body.data) {
          const age = Date.now() - Number(body.at || 0);
          const ttl = Number(body.ttl || PLAYER_TTL);
          PLAYER_MEM.set(key, { at: body.at, ttl, data: body.data });
          if (allowStale || age < ttl) return { at: body.at, data: body.data, ttl };
        }
      }
    }
  } catch { /* cache is best effort */ }
  return null;
}

async function playerCachePut(key, data) {
  const ttl = playerTtl(data);
  const at = Date.now();
  if (PLAYER_MEM.size >= PLAYER_MEM_MAX) PLAYER_MEM.delete(PLAYER_MEM.keys().next().value);
  PLAYER_MEM.set(key, { at, ttl, data });
  try {
    if (typeof caches !== "undefined" && caches.default) {
      await caches.default.put(
        new Request(playerCacheUrl(key)),
        new Response(JSON.stringify({ at, ttl, data }), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${Math.round(ttl / 1000)}` },
        })
      );
    }
  } catch { /* best effort */ }
  return ttl;
}

const playerCacheStats = () => ({
  memory: PLAYER_MEM.size,
  inflight: PLAYER_INFLIGHT.size,
  ttlSec: Math.round(PLAYER_TTL / 1000),
});

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
// hard = this client+version is broken (network, timeout, no formats) → cool it.
// soft = the *video* was rejected (bot wall, private, region, removed). Those are
// per-video, so cooling the client would poison the whole ladder for every other
// video — that exact bug pushed healthy videos onto the mirrors.
const noteFail = (c, hard = true) => {
  if (!hard) return;
  const k = breakerKey(c);
  const b = BREAKER.get(k) || { fails: 0, until: 0 };
  b.fails += 1;
  b.until = Date.now() / 1000 + Math.min(BREAKER_MAX, BREAKER_BASE * Math.pow(2, b.fails - 1));
  BREAKER.set(k, b);
  if (BREAKER.size > 60) BREAKER.delete(BREAKER.keys().next().value);
};
const resetPlayerCache = () => {
  PLAYER_MEM.clear();
  PLAYER_INFLIGHT.clear();
};

const resetBreakers = () => {
  resetPlayerCache();
  BREAKER.clear();
  MIRROR_BREAKER.clear();
  YT_GATE.until = 0;
  YT_GATE.strikes = 0;
  YT_GATE.status = 0;
  YT_GATE.last = 0;
  WINNER.id = "";
  WINNER.ts = 0;
};
const breakerSnapshot = () =>
  [...BREAKER.entries()].map(([key, b]) => ({
    key,
    fails: b.fails,
    cooling: Math.max(0, Math.round(b.until - Date.now() / 1000)),
  }));

// ── cookies (optional, secret-only) ───────────────────────────────────────────
// Accepts: browser "a=1; b=2" header string, Netscape cookies.txt, or JSON array.
function parseCookiesDetailed(raw) {
  const out = { header: "", format: "none", total: 0, expired: 0, dropped: 0 };
  if (!raw) return out;
  let text = String(raw).trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text) return out;

  const emit = (pairs, format) => {
    const clean = [];
    for (const p of pairs) {
      const i = p.indexOf("=");
      if (i <= 0) continue;
      const k = p.slice(0, i).trim();
      let v = p.slice(i + 1).trim();
      if (!k || /^cookie$/i.test(k)) continue;
      if (v.length > 2 && /^["']/.test(v) && /["']$/.test(v)) v = v.slice(1, -1);
      clean.push(k + "=" + v);
    }
    out.header = clean.join("; ");
    out.total = clean.length;
    out.format = format;
    return out;
  };

  // 1. browser extension JSON export (has expirationDate — expired cookies are skipped)
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const arr = Array.isArray(data) ? data : data.cookies || [];
      const now = Date.now() / 1000;
      const live = [];
      for (const c of arr) {
        if (!c || !c.name) { out.dropped++; continue; }
        if (c.expirationDate && Number(c.expirationDate) < now) { out.expired++; continue; }
        live.push(`${c.name}=${c.value ?? ""}`);
      }
      if (live.length || arr.length) return emit(live, "json");
    } catch { /* fall through */ }
  }

  // 2. Netscape cookies.txt
  if (text.includes("\t")) {
    const pairs = text
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const p = l.split("\t");
        return p.length >= 7 ? `${p[5]}=${p[6]}` : "";
      })
      .filter(Boolean);
    if (pairs.length) return emit(pairs, "netscape");
  }

  // 3. "Cookie: a=1; b=2" | newline separated | plain header string
  text = text.replace(/^cookie\s*:\s*/i, "").replace(/\r?\n+/g, "; ");
  const pairs = text.split(";").map((x) => x.trim()).filter(Boolean);
  return emit(pairs, "header");
}

function parseCookies(raw) {
  return parseCookiesDetailed(raw).header;
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

const ytCookieRaw = (env) =>
  String((env && (env.YT_COOKIES || env.YT_COOKIE || env.YOUTUBE_COOKIES || env.COOKIES)) || "");

/* Everything about the cookie secret, without ever printing a value. This is
   what tells "cookies set ho gaye par bot-check phir bhi aa raha hai" apart
   from "cookies worker tak pahunche hi nahi". */
function cookieReport(env, url) {
  const raw = ytCookieRaw(env);
  if (!raw.trim()) {
    return {
      configured: false,
      usable: false,
      note: "YT_COOKIES secret set nahi hai",
      fix: "Browser me youtube.com login karke extension (Get cookies.txt / EditThisCookie) se cookies export karein → Cloudflare → Worker → Settings → Variables and Secrets → YT_COOKIES me poori cookie string paste karein → Deploy.",
    };
  }
  const d = parseCookiesDetailed(raw);
  const h = d.header;
  const has = (n) => !!cookieValue(h, n);
  const auth = {
    SID: has("SID") || has("__Secure-1PSID") || has("__Secure-3PSID"),
    SAPISID: has("SAPISID") || has("__Secure-3PAPISID") || has("__Secure-1PAPISID"),
    HSID: has("HSID") || has("__Secure-1PSIDTS") || has("__Secure-3PSIDTS"),
    SSID: has("SSID") || has("__Secure-1PSID") || has("__Secure-3PSID"),
  };
  const missing = Object.keys(auth).filter((k) => !auth[k]);
  const keyOk = url ? keyAllowed(env, url) : true;
  const usable = !!h && !missing.length && keyOk;
  const note = !h
    ? "cookie string parse nahi hui (format samajh nahi aaya)"
    : !keyOk
      ? "SV_KEY mismatch — cookies jaan bujh ke block hain, app me wahi access key daalein"
      : missing.length
        ? "cookie export adhoora hai — ye zaroori cookies missing hain: " + missing.join(", ")
        : d.expired
          ? d.expired + " cookie(s) expire ho chuke the, unhe chhod diya"
          : "cookies ready hain";
  return {
    configured: true,
    usable,
    format: d.format,
    count: d.total,
    expiredSkipped: d.expired,
    dropped: d.dropped,
    keys: h.split("; ").map((x) => x.split("=")[0]).slice(0, 14),
    auth,
    missing,
    keyOk,
    note,
    fix: usable
      ? "cookies worker tak pahunch rahe hain — agar phir bhi bot-check aaye to IP/account level block hai: POTOKEN_URL (bgutil provider) ya usi IP se banaye gaye fresh cookies try karein."
      : !keyOk
        ? "Worker me SV_KEY set hai — app me Settings → Access key me bilkul wahi value daalein, warna worker cookies use nahi karega."
        : missing.length
          ? "Naya export lein: youtube.com pe logged-in hote hue cookies.txt (Netscape) ya header string — SID, HSID, SSID, SAPISID (ya __Secure-3P*) sab chahiye."
          : "Export dobara karein — browser me logged in rehte hue, saari youtube.com cookies ke saath.",
  };
}

function cookieAuth(env, url) {
  const raw = parseCookies(ytCookieRaw(env));
  if (!raw) return null;
  if (!keyAllowed(env, url)) return null;
  return raw;
}

// ── InnerTube ─────────────────────────────────────────────────────────────────
function innertubeBody(client, extra) {
  return { context: { client: client.ctx }, ...extra };
}

// A signed-out browser still carries these two cookies. Without them YouTube
// treats the request as a bot on consent/age walls — the exact errors we saw.
const consentCookies = (env) =>
  String((env && env.CONSENT) || "").toLowerCase() === "off" ? "" : "SOCS=CAI; CONSENT=YES+cb";

async function innertube(client, endpoint, extra, opts = {}) {
  const headers = {
    "content-type": "application/json",
    "user-agent": client.ua,
    "x-youtube-client-name": client.num,
    "x-youtube-client-version": client.ctx.clientVersion,
    origin: "https://www.youtube.com",
    "x-origin": "https://www.youtube.com",
    "accept-language": "en-US,en;q=0.9",
  };
  // YouTube's own clients send the visitor id in the header as well as the body;
  // a body-only visitor id is a known bot signal.
  if (opts.visitorData) headers["x-goog-visitor-id"] = opts.visitorData;
  // the watch page URL is the referer a real client would have sent
  if (opts.referer) headers.referer = opts.referer;
  if (endpoint === "player" && extra && extra.videoId) {
    headers.referer = `https://www.youtube.com/watch?v=${encodeURIComponent(extra.videoId)}`;
  }
  const cookies = opts.cookies || consentCookies(opts.env);
  if (cookies) {
    headers.cookie = cookies;
    headers["x-goog-authuser"] = "0";
    if (opts.authorization) headers.authorization = opts.authorization;
  }

  const body = innertubeBody(client, extra);
  if (opts.visitorData) body.context.client.visitorData = opts.visitorData;
  if (opts.poToken) body.serviceIntegrityDimensions = { poToken: opts.poToken };

  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`;
  let res;
  try {
    res = await fetchRetry(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      { retries: opts.retries ?? 1, timeout: opts.timeout ?? 9000 }
    );
  } catch (e) {
    const st = Number(e && e.status) || 0;
    if (st === 429 || st === 403) {
      const wait = ytStrike(st);
      const err = new Error(`youtube ${st === 429 ? "rate limit (429)" : "refused (403)"} — ${wait}s cooldown`);
      err.status = st;
      err.gate = wait;
      err.fatal = true;
      throw err;
    }
    throw e;
  }
  const text = await res.text();
  // 429 (rate limit) and a bare 403 are answered identically for every client on
  // this IP — record it once, stop the ladder, tell the app how long to wait.
  if (res.status === 429 || res.status === 403) {
    const wait = ytStrike(res.status);
    const e = new Error(`youtube ${res.status === 429 ? "rate limit (429)" : "refused (403)"} — ${wait}s cooldown`);
    e.status = res.status;
    e.gate = wait;
    e.fatal = true;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`bad JSON from youtube (${res.status})`);
  }
  ytClear();
  return parsed;
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
  "shortsLockupViewModel",
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

  const authorId = browseIdIn(meta) || cmd.browseEndpoint?.browseId || "";
  const author = rows.find((t) => !VIEWS_RE.test(t) && !AGO_RE.test(t) && !DUR_RE.test(t)) || "";
  const looksLikeTitle = (t) =>
    t && t.length > 3 && t !== author && !VIEWS_RE.test(t) && !AGO_RE.test(t) && !DUR_RE.test(t) &&
    !/^\d+(st|nd|rd|th)?$/.test(t);
  // title first from the metadata block, then anywhere in the node (shapes move it around)
  const title =
    textOf(meta.title) ||
    strings.find(looksLikeTitle) ||
    deepStrings(m).find(looksLikeTitle) ||
    textOf(m.accessibilityText) ||
    textOf(m.rendererContext?.accessibilityContext) ||
    // last resort: the longest string in the node is almost always the title
    (deepStrings(m)
      .filter((t) => t.length > 8 && t !== author && !VIEWS_RE.test(t) && !AGO_RE.test(t))
      .sort((a, b) => b.length - a.length)[0] || "");
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
      push(key === "lockupViewModel" ? normLockup(r) : key === "shortsLockupViewModel" ? shortFromLockup(r) : normVideo(r));
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
// ── why did it fail? (drives the UI panel + the escalation order) ────────────
const REASONS = {
  ratelimit: {
    label: "YouTube rate limit",
    needAuth: false,
    hint: "YouTube ne is IP se aayi request 429 se rok di. Worker khud kuch second ruk kar dobara koshish karega — PoToken (POTOKEN_URL) ya cookies lagane se ye kam hota hai.",
  },
  bot: {
    label: "YouTube bot-check",
    needAuth: true,
    hint: "YouTube is asking this IP to prove it is not a bot (PoToken). Cookies or a PoToken fix this.",
  },
  login: {
    label: "Login / members-only",
    needAuth: true,
    hint: "Private, members-only or age-restricted video. Optional cookies (YT_COOKIES) unlock these.",
  },
  age: {
    label: "Age restricted",
    needAuth: true,
    hint: "Age-restricted video — needs cookies from a signed-in account.",
  },
  region: {
    label: "Region locked",
    needAuth: true,
    hint: "Not available from this worker's region (or needs login).",
  },
  live: {
    label: "Live stream",
    needAuth: false,
    hint: "Live HLS streams are not muxed MP4 — open it on YouTube while it is live.",
  },
  unavailable: {
    label: "Unavailable",
    needAuth: false,
    hint: "Removed, private, or the client is no longer supported by YouTube.",
  },
  unknown: { label: "No stream", needAuth: false, hint: "" },
};

function classifyFailure(status, reason) {
  const st = String(status || "").toUpperCase();
  const r = String(reason || "").toLowerCase();
  if (/not a bot|sign in to confirm|bot.?check|po_?token/.test(r)) return "bot";
  if (/age|confirm your age/.test(r)) return "age";
  if (/country|region|not available in your/.test(r)) return "region";
  if (/members|join this channel|private video|login_required/.test(r)) return "login";
  if (st === "AGE_VERIFICATION_REQUIRED") return "age";
  if (st === "LOGIN_REQUIRED") return "login";
  if (/live event|is live|premieres in/.test(r)) return "live";
  if (/removed|deleted|no longer available|not available|no longer supported|unavailable/.test(r)) return "unavailable";
  return "unknown";
}

// ── PoToken: static secret, or an external provider (bgutil-compatible) ─────
const POTOKEN_CACHE = { key: "", token: "", visitorData: "", ts: 0 };
const POTOKEN_TTL = 30 * 60 * 1000;

async function getPoToken(env, visitorData, force = false) {
  const fixed = String((env && env.PO_TOKEN) || "").trim();
  // tolerate both "TOKEN" and "VISITOR_DATA:TOKEN"
  if (fixed) {
    const parts = fixed.split(":");
    return parts.length > 1 && /^[A-Za-z0-9_-]{8,}$/.test(parts[0])
      ? { poToken: parts.pop(), visitorData: parts.join(":"), source: "secret" }
      : { poToken: fixed, visitorData, source: "secret" };
  }
  const provider = String((env && env.POTOKEN_URL) || "").trim().replace(/\/+$/, "");
  if (!provider) return { poToken: "", visitorData, source: "" };

  const key = provider + "|" + (visitorData || "");
  if (!force && POTOKEN_CACHE.key === key && Date.now() - POTOKEN_CACHE.ts < POTOKEN_TTL) {
    return { poToken: POTOKEN_CACHE.token, visitorData: POTOKEN_CACHE.visitorData, source: "provider(cached)" };
  }
  try {
    const url = `${provider}${provider.includes("?") ? "&" : "?"}visitor_data=${encodeURIComponent(visitorData || "")}`;
    const r = await fetchRetry(url, { headers: { accept: "application/json", "user-agent": WEB_UA } }, { retries: 0, timeout: 6000 });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const token = d.poToken || d.po_token || d.potoken || "";
    const vd = d.visitorData || d.visitor_data || visitorData;
    if (token) {
      POTOKEN_CACHE.key = key;
      POTOKEN_CACHE.token = token;
      POTOKEN_CACHE.visitorData = vd;
      POTOKEN_CACHE.ts = Date.now();
      return { poToken: token, visitorData: vd, source: "provider" };
    }
    return { poToken: "", visitorData, source: "provider(empty)" };
  } catch (e) {
    return { poToken: "", visitorData, source: "provider error: " + e.message };
  }
}

// built-in last-resort extractors (Invidious-compatible API). Set MIRRORS=off to disable.
// ordered by what actually answered on 2026-10-23: f5.si ok, melmac 526,
// nerdvpn 401, nadeko 403 — dead ones stay last, never first
const DEFAULT_MIRRORS = [
  // only hosts that actually answered on 2026-10-23. The rest are opt-in through
  // EMERGENCY_MIRRORS, because nadeko serves its own bot-check, nerdvpn answers
  // 401/403 and melmac answers 526 — hitting them was pure 4xx noise.
  "https://invidious.f5.si",
];

// per-isolate scoreboard: which client actually delivers, per failure kind
const CLIENT_STATS = {};
const bumpStat = (id, field) => {
  const row = (CLIENT_STATS[id] = CLIENT_STATS[id] || { ok: 0, fail: 0, bot: 0, login: 0, other: 0, ratelimit: 0 });
  row[field] = (row[field] || 0) + 1;
};

async function tryClient(client, videoId, opts, attempts, tag) {
  const label = `${client.id}@${client.versionRoll || client.ctx.clientVersion}${tag ? "(" + tag + ")" : ""}`;
  let data;
  try {
    data = await innertube(
      client,
      "player",
      {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        // what the web player itself sends; some clients refuse without it
        playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
      },
      { ...opts, retries: 0, timeout: 7000 }
    );
  } catch (e) {
    if (e && e.fatal) {
      attempts.push(`${label}: ${e.message} [ratelimit]`);
      bumpStat(client.id, "ratelimit");
      if (opts.onFatal) opts.onFatal("ratelimit", e);
      return null;
    }
    if (opts.onFail) opts.onFail("unknown", client);
    attempts.push(`${label}: ${e.message}`);
    bumpStat(client.id, "fail");
    noteFail(client);
    return null;
  }
  const status = data?.playabilityStatus?.status || "UNKNOWN";
  const sd = data?.streamingData;
  if (status !== "OK" || !sd) {
    const reason = data?.playabilityStatus?.reason || "";
    const kind = classifyFailure(status, reason);
    if (opts.onFail) opts.onFail(kind, client);
    attempts.push(`${label}: ${status} ${reason}`.trim() + (kind !== "unknown" ? ` [${kind}]` : ""));
    bumpStat(client.id, kind === "bot" ? "bot" : kind === "login" || kind === "age" ? "login" : "other");
    bumpStat(client.id, "fail");
    // bot/login/age/region/unavailable are facts about the video, not the client
    noteFail(client, !["bot", "login", "age", "region", "unavailable"].includes(kind));
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
  bumpStat(client.id, "ok");
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
  const custom = String((env && env.EMERGENCY_MIRRORS) || "")
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const off = String((env && env.MIRRORS) || "").toLowerCase() === "off";
  return [...new Set([...custom, ...(off ? [] : DEFAULT_MIRRORS)])];
}

async function mirrorStream(videoId, mirrors, attempts = [], budget = null) {
  // two hosts per resolve is plenty: with five defaults every failed resolve was
  // burning five subrequests (and five 4xx in the metrics) for the same answer
  let tried = 0;
  for (const base of mirrors) {
    if (tried >= 2) {
      attempts.push(`mirror: ${mirrors.length - tried} more skipped (tried ${tried})`);
      break;
    }
    // parked after repeated failures — mirror hosts do not recover in seconds
    if (mirrorCooling(base)) {
      attempts.push(`mirror ${base}: skipped (cooling down)`);
      continue;
    }
    if (budget && budget.left <= 0) {
      attempts.push("mirror: subrequest budget reached");
      break;
    }
    if (budget) budget.left -= 1;
    tried += 1;
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
      noteMirrorOk(base);
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
          url: `/api/media?u=${encodeURIComponent(local(f.url))}&v=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(f.itag)}`,
          kind: "muxed",
        })),
        attempts: [...attempts, `mirror ${base}: ok`],
      };
    } catch (e) {
      noteMirrorFail(base);
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
// Cloudflare Workers (free) allow 50 subrequests per invocation; exceeding it
// makes *every* later fetch fail instantly with an opaque error. One player call
// can burn 20+ on its own, so the ladder runs on an explicit budget.
const SUB_CAP = 46;
const SUB_RESERVE = 8;          // never spent by the ladder: mirrors + media need it
const SUB_MIN_PER_VIDEO = 8;    // canary won't start a video with less than this

async function player(videoId, opts = {}) {
  const env = opts.env || {};
  const authed = !!opts.cookieHeader;
  const key = playerCacheKey(videoId, opts.region, authed);

  if (opts.noCache) return playerResolve(videoId, opts);

  // 1) a fresh answer means zero upstream calls
  const hit = await playerCacheGet(key);
  if (hit) {
    return { ...hit.data, cached: true, cacheAge: Math.round((Date.now() - hit.at) / 1000) };
  }

  // 2) the same video requested twice at once resolves once (request coalescing)
  const running = PLAYER_INFLIGHT.get(key);
  if (running) return running;

  const run = (async () => {
    const res = await playerResolve(videoId, opts);
    if (res && res.ok && (res.formats || []).length) {
      const ttl = await playerCachePut(key, res);
      return { ...res, cached: false, cacheTtl: Math.round(ttl / 1000) };
    }
    /* 3) rate-limited? a video played earlier today still plays — signed URLs
       live for hours, so the stale copy is a perfectly good answer */
    if (res && res.reason === "ratelimit") {
      const stale = await playerCacheGet(key, true);
      if (stale) {
        return {
          ...stale.data,
          cached: true,
          stale: true,
          cacheAge: Math.round((Date.now() - stale.at) / 1000),
          retryAfter: res.retryAfter,
          note: "YouTube rate limit — purane signed URL se chalaya (wo hours tak valid rehte hain)",
        };
      }
    }
    return res;
  })().finally(() => PLAYER_INFLIGHT.delete(key));
  PLAYER_INFLIGHT.set(key, run);
  return run;
}

async function playerResolve(videoId, opts = {}) {
  const env = opts.env || {};
  const attempts = [];
  const failures = [];
  const started = Date.now();
  const deadline = started + 26000;
  const budget = opts.budget || { left: SUB_CAP };
  const spend = (n = 1) => { budget.left = Math.max(0, budget.left - n); };
  const budgetLeft = () => budget.left;

  /* A recent 429/403 means every client will answer the same on this IP. Fail
     fast (one subrequest saved: none) and tell the app exactly how long to wait,
     instead of burning the whole ladder against a wall. */
  if (!opts.ignoreGate && ytGated()) {
    const gate = ytGateInfo();
    attempts.push(`youtube cooldown active — ${gate.retryAfter}s left (${gate.strikes} strike${gate.strikes === 1 ? "" : "s"}, HTTP ${gate.status})`);
    return {
      ok: false,
      error: "YouTube rate limit: thodi der baad khud try hoga",
      reason: "ratelimit",
      reasonLabel: REASONS.ratelimit.label,
      hint: REASONS.ratelimit.hint,
      needAuth: false,
      botCheck: false,
      cookiesUsed: !!opts.cookieHeader,
      poTokenUsed: false,
      attempts,
      failures: { ratelimit: 1 },
      retryAfter: gate.retryAfter,
      gate,
      ms: Date.now() - started,
      subrequests: 0,
      budgetLeft: budget.left,
    };
  }

  let { versions, source, visitorData } = await discoverVersions(env);
  spend(2);
  let ladder = buildClients(versions, opts.region || "IN");

  // PoToken (static secret or external provider) + the visitorData it belongs to
  const pt = await getPoToken(env, visitorData);
  let liveToken = pt.poToken;          // may be replaced by a forced refresh below
  if (pt.poToken) visitorData = pt.visitorData || visitorData;

  const noteFailKind = (kind) => {
    failures.push(kind);
  };

  let fatalReason = "";
  const runPass = async (clients, extraOpts, tag, useBreakers = true) => {
    let needAuthEarly = false;
    const seen = new Set();
    for (const client of clients) {
      if (ytGated()) {
        attempts.push(`${tag || "pass"} stopped: youtube cooldown (${ytGateInfo().retryAfter}s)`);
        fatalReason = "ratelimit";
        break;
      }
      if (Date.now() > deadline) {
        attempts.push(`${tag || "pass"} stopped: time budget reached`);
        break;
      }
      if (budgetLeft() <= SUB_RESERVE) {
        attempts.push(`${tag || "pass"} stopped: subrequest budget (${budgetLeft()} left, ${SUB_RESERVE} reserved for mirrors)`);
        break;
      }
      // tight budget → skip the second version of a client we already asked
      if (budgetLeft() < SUB_RESERVE + 12 && seen.has(client.id)) {
        attempts.push(`${client.id}@${client.ctx.clientVersion}: skipped (tight subrequest budget)`);
        continue;
      }
      seen.add(client.id);
      if (useBreakers && breakerCooling(client)) {
        attempts.push(`${client.id}@${client.ctx.clientVersion}: skipped (cooling down)`);
        continue;
      }
      spend(1);
      const res = await tryClient(
        client,
        videoId,
        {
          ...extraOpts,
          env,
          poToken: liveToken,
          onFatal: (kind) => {
            fatalReason = kind;
            noteFailKind(kind);
          },
          onFail: (kind) => {
            noteFailKind(kind);
            // a bot-check is not client-specific: stop burning the ladder, escalate instead.
            // pass 3 opts out on purpose — that pass exists to try *every* client.
            if (kind === "bot" && !extraOpts.cookies && !extraOpts.keepGoingOnBot) needAuthEarly = true;
          },
        },
        attempts,
        tag
      );
      if (res) return { res, needAuthEarly };
      if (needAuthEarly) {
        attempts.push(`${tag || "pass"}: bot-check detected → escalating to authenticated pass`);
        break;
      }
    }
    return { res: null, needAuthEarly };
  };

  const finish = (hit, pass, extra) => {
    noteWinner(ladder.find((c) => c.id === hit.client));
    return ({
    ...hit,
    versions,
    versionSource: source,
    pass,
    ms: Date.now() - started,
    poToken: !!pt.poToken,
    poTokenSource: pt.source,
    subrequests: SUB_CAP - budgetLeft(),
    ...extra,
  });
  };

  // anonymous passes never touch account-only clients (they can only answer LOGIN_REQUIRED)
  const anonLadder = ladder.filter((c) => !c.needsAuth);

  // pass 1 — fast anonymous subset (android_vr / ios / tv_embedded / android),
  // with whatever client delivered last time moved to the front
  const win = winnerClient();
  const fastBase = anonLadder.filter((c) => ["android_vr", "ios", "tv_embedded", "android", "visionos"].includes(c.id));
  const fast = win
    ? [...fastBase.filter((c) => c.id === win.id), ...fastBase.filter((c) => c.id !== win.id)]
    : fastBase;
  let out = await runPass(fast.length ? fast : anonLadder.slice(0, 4), { visitorData }, "");
  if (out.res) return finish(out.res, 1);

  /* A 429/403 on a datacenter IP is very often "you look like a bot" in disguise:
     with a *fresh* PoToken the exact same request usually sails through. So before
     telling the app to wait, mint a new token (provider) and try the fast pass once. */
  if (fatalReason === "ratelimit" && (env.POTOKEN_URL || env.PO_TOKEN) && !opts.ignoreGate) {
    attempts.push("rate limit → forcing a fresh PoToken and retrying once");
    POTOKEN_CACHE.ts = 0;
    const forced = await getPoToken(env, visitorData, true);
    if (forced.poToken && forced.poToken !== liveToken) {
      liveToken = forced.poToken;
      visitorData = forced.visitorData || visitorData;
      YT_GATE.until = 0;                       // one immediate, token-backed retry
      YT_GATE.strikes = 0;
      fatalReason = "";
      failures.length = 0;
      out = await runPass(fast.length ? fast : anonLadder.slice(0, 3), { visitorData }, "potoken");
      if (out.res) return finish(out.res, 1, { poTokenSource: "provider(refreshed)" });
    } else {
      attempts.push("PoToken provider ne naya token nahi diya (" + (forced.source || "empty") + ")");
    }
  }

  const sawBotCheck = out.needAuthEarly || failures.includes("bot");

  // pass 2 — cookies (bot-checks and login-required videos land here)
  const cookieHeader = opts.cookieHeader || "";
  if (cookieHeader && !ytGated()) {
    const auth = await sapisidHash(cookieHeader);
    const authClients = ladder.filter((c) => ["android_vr", "android", "ios", "web", "mweb", "tv_embedded", "web_embedded", "web_creator"].includes(c.id));
    out = await runPass(
      authClients,
      { visitorData, cookies: cookieHeader, authorization: auth },
      "auth",
      false
    );
    if (out.res) return finish(out.res, 2, { authed: true, healed: false });
  }

  // pass 3 — self-heal: re-discover versions, full ladder, breakers bypassed
  if (ytGated()) {
    attempts.push("self-heal pass skipped: youtube cooldown");
  } else {
  const fresh = await discoverVersions(env, true);
  versions = fresh.versions;
  source = fresh.source;
  visitorData = pt.poToken ? pt.visitorData || fresh.visitorData || visitorData : fresh.visitorData || visitorData;
  ladder = buildClients(versions, opts.region || "IN");
  // pass 3 keeps the cookies if we have them — it used to lose them right here
  const healAuth = cookieHeader ? await sapisidHash(cookieHeader) : "";
  out = await runPass(
    cookieHeader ? ladder : anonLadder,
    { visitorData, cookies: cookieHeader || undefined, authorization: healAuth || undefined, keepGoingOnBot: true },
    cookieHeader ? "auth+" : "retry",
    false
  );
  if (out.res) return finish(out.res, 3, { healed: true, authed: !!cookieHeader });
  }

  // pass 4 — independent extractors (Invidious-compatible), proxied through /api/media
  const mirrors = emergencyMirrors(env);
  if (mirrors.length && budgetLeft() > 0) {
    const m = await mirrorStream(videoId, mirrors, attempts, budget);
    if (m) return finish(m, 4, { authed: false, healed: false });
  } else if (mirrors.length) {
    attempts.push("mirrors skipped: subrequest budget exhausted");
  }

  // ── nothing worked: explain exactly why ───────────────────────────────────
  const counts = {};
  for (const k of failures) counts[k] = (counts[k] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // a cooldown is the most actionable reason there is — it wins over counts
  const kind = ytGated() || fatalReason === "ratelimit" ? "ratelimit" : top ? top[0] : "unknown";
  const info = REASONS[kind] || REASONS.unknown;

  return {
    ok: false,
    error: info.label + ": koi playable stream nahi mila",
    reason: kind,
    reasonLabel: info.label,
    hint: info.hint,
    needAuth: !!info.needAuth && !cookieHeader,
    botCheck: kind === "bot",
    cookiesUsed: !!cookieHeader,
    poTokenUsed: !!pt.poToken,
    poTokenSource: pt.source,
    attempts,
    failures: counts,
    ms: Date.now() - started,
    versions,
    versionSource: source,
    breakers: breakerSnapshot(),
    mirrors: mirrorSnapshot(),
    gate: ytGateInfo(),
    retryAfter: ytGateInfo().retryAfter || undefined,
    subrequests: SUB_CAP - budgetLeft(),
    budgetLeft: budgetLeft(),
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

// ── Comments ──────────────────────────────────────────────────────────────────
// The watch page's "next" response holds a comments continuation; feeding that
// token back gives commentEntityPayload rows. Everything is optional: any shape
// we do not recognise returns an empty, self-explaining result instead of 500.
const runsText = (runs) => (Array.isArray(runs) ? runs.map((r) => (r && r.text) || "").join("") : "");
const numOf = (v) => {
  if (typeof v === "number") return v;
  const n = Number(String(v || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function normalizeComments(data, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const p of collect(data, ["commentEntityPayload"])) {
    const id = p.commentId || (p.properties && p.properties.commentId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const content = (p.properties && p.properties.content && p.properties.content.content) || "";
    const author = p.author || {};
    const toolbar = p.toolbar || {};
    const text = String(content || "").trim();
    if (!text) continue;
    out.push({
      commentId: String(id),
      text: text.slice(0, 2000),
      author: author.displayName || author.name || "",
      authorId: author.channelId || "",
      avatar: author.avatarThumbnailUrl || "",
      published: (p.properties && p.properties.publishedTime) || "",
      likes: numOf(toolbar.likeCountNotliked || toolbar.likeCountLiked || toolbar.likeCountA11y),
      replies: numOf(toolbar.replyCount),
      creator: !!(author.isCreator || author.isOwner),
    });
    if (out.length >= limit) break;
  }
  if (!out.length) {
    for (const r of collect(data, ["commentRenderer"])) {
      const id = r.commentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const text = runsText(r.contentText && r.contentText.runs).trim();
      if (!text) continue;
      const thumbs = r.authorThumbnail && r.authorThumbnail.thumbnails;
      out.push({
        commentId: String(id),
        text: text.slice(0, 2000),
        author: runsText(r.authorText && r.authorText.runs),
        authorId: (r.authorEndpoint && r.authorEndpoint.browseEndpoint && r.authorEndpoint.browseEndpoint.browseId) || "",
        avatar: Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : "",
        published: runsText(r.publishedTimeText && r.publishedTimeText.runs),
        likes: numOf(r.voteCount && r.voteCount.simpleText),
        replies: numOf(r.replyCount && r.replyCount.simpleText) || 0,
        creator: !!r.authorCommentBadge,
      });
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

function commentCount(data) {
  const h = collect(data, ["commentsHeaderRenderer"])[0];
  const t = h && h.countText;
  const txt = (t && (t.simpleText || runsText(t.runs))) || "";
  const n = numOf(txt);
  if (n) return n;
  const hp = collect(data, ["commentsEntryPointHeaderRenderer"])[0];
  const t2 = hp && hp.commentCount;
  return numOf(t2 && (t2.simpleText || runsText(t2.runs)));
}

function commentsToken(data, first) {
  const fromSection = () => {
    const sections = collect(data, ["itemSectionRenderer"]);
    for (const sec of sections) {
      const sid = String(sec.sectionIdentifier || sec.targetId || "");
      if (!/comment/i.test(sid)) continue;
      const c = collect(sec, ["continuationItemRenderer"])[0];
      const tok = c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token;
      if (tok) return tok;
    }
    return "";
  };
  const fromEntry = () => {
    const entry = collect(data, ["commentsEntryPointHeaderRenderer", "engagementPanelSectionListRenderer"])
      .find((x) => JSON.stringify(x.panelIdentifier || x.targetId || "").match(/comment/i) || x.commentCount);
    if (!entry) return "";
    const c = collect(entry, ["continuationItemRenderer"])[0];
    return (c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token) || "";
  };
  const direct = fromSection() || fromEntry();
  if (direct) return direct;
  // last resort: every continuation in a comments response continues comments
  if (!first) {
    const all = collect(data, ["continuationItemRenderer"])
      .map((c) => c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token)
      .filter(Boolean);
    return all.length ? all[all.length - 1] : "";
  }
  return "";
}

async function comments(videoId, token, env = {}, url = new URL("https://x/")) {
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(String(videoId || ""))) return { ok: false, error: "valid video id required" };
  let data;
  let first = !token;
  try {
    if (!token) {
      const next = await listCall(env, url, "next", { videoId });
      token = commentsToken(next, true);
      if (!token) {
        const count = commentCount(next);
        return { ok: true, items: [], next: null, count, disabled: true, source: "no-comments-continuation" };
      }
      data = await listCall(env, url, "next", { continuation: token });
      first = false;
      if (!commentCount(next)) {
        const c = commentCount(data);
        if (c) data.__count = c;
      } else {
        data.__count = commentCount(next);
      }
    } else {
      data = await listCall(env, url, "next", { continuation: token });
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: [], next: null, count: 0 };
  }
  const items = normalizeComments(data, 20);
  const count = data.__count || commentCount(data) || 0;
  const next = commentsToken(data, first) || null;
  return { ok: true, items, next, count: count || items.length, source: "innertube", build: BUILD };
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
  const pickOf = (formats) => {
    const exact = (formats || []).find((f) => String(f.itag) === String(itag));
    return exact || (formats || [])[0] || null;
  };
  try {
    const fresh = await player(videoId, { env, noCache: true });
    if (fresh && fresh.ok) {
      const pick = pickOf(fresh.formats);
      if (pick && pick.url) {
        const raw = decodeURIComponent(pick.url.split("u=")[1].split("&")[0]);
        if (raw) return raw;
      }
    }
  } catch {
    /* fall through to the extractors */
  }
  // last resort: a mirror can still hand out a working URL when InnerTube is blocked
  try {
    const m = await mirrorStream(videoId, emergencyMirrors(env), []);
    if (m && m.ok) {
      const pick = pickOf(m.formats);
      if (pick && pick.url) return decodeURIComponent(pick.url.split("u=")[1].split("&")[0]) || pick.url;
    }
  } catch {
    /* nothing left */
  }
  return "";
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
    noCache: true,            // /mp4 and /api/stream exist to hand out a *fresh* signature
    cookieHeader: cookieAuth(env, urlObj),
    region: (urlObj.searchParams.get("region") || "IN").toUpperCase(),
  });
  if (!p.ok || !p.formats || !p.formats.length) {
    return json({ error: p.error || "no playable stream", attempts: (p.attempts || []).slice(-8) }, 502);
  }
  const want = urlObj.searchParams.get("itag");
  const wanted = want ? p.formats.filter((f) => String(f.itag) === String(want)) : [];
  /* a dead signature or an HTML body should never make /mp4/<id>.mp4 fail: walk
     the other muxed streams before giving up (each one is proxied + validated) */
  const order = [...wanted, ...p.formats.filter((f) => !wanted.includes(f))].slice(0, 3);
  let pick = order[0];
  let upstream = "";
  let mp4res = null;
  for (const f of order) {
    const up = decodeURIComponent(String(f.url || "").split("u=")[1]?.split("&")[0] || f.url || "");
    if (!up) continue;
    const r = await media(up, request, env);
    if (!mp4res) { pick = f; upstream = up; mp4res = r; }
    if (r.status < 400 && r.headers.get("x-sv-media-fail") !== "1") { pick = f; upstream = up; mp4res = r; break; }
  }
  if (!mp4res || !upstream) return json({ error: "no proxyable stream", attempts: (p.attempts || []).slice(-8) }, 502);

  const res = mp4res;
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

  const reqParams = new URL(request.url).searchParams;
  // /api/media carries v= + itag=; the pretty routes carry them in the path/query
  const pathId = (() => {
    try {
      const m = new URL(request.url).pathname.match(/^\/(?:api\/)?(?:file|mp4)\/([A-Za-z0-9_-]{6,15})\.mp4$/);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  })();
  const videoId = reqParams.get("v") || reqParams.get("id") || pathId || "";
  const itag = reqParams.get("itag") || "";
  const grab = () => fetchRetry(target.toString(), { headers: buildHeaders(), redirect: "follow" }, { retries: 1, timeout: 25000 });
  const swap = async () => {
    if (!videoId) return false;
    const next = await refreshedUrl(videoId, itag, env);
    if (!next || next === target.toString()) return false;
    try { target = new URL(next); } catch { return false; }
    return true;
  };

  // an expired signature can be spotted before spending the request
  const dead = (() => {
    const e = Number(target.searchParams.get("expire") || 0);
    return e > 0 && e * 1000 < Date.now() + 60000;
  })();
  let refreshed = dead && (await swap());

  let upstream = null;
  let lastStatus = 0;
  try {
    upstream = await grab();
    lastStatus = upstream.status;
  } catch (e) {
    // network hiccup: one more try after a short pause, then a fresh signature
    try {
      await sleep(300);
      upstream = await grab();
      lastStatus = upstream.status;
    } catch {
      if (await swap()) {
        try {
          upstream = await grab();
          lastStatus = upstream.status;
          refreshed = true;
        } catch {
          return err("upstream fetch failed: " + e.message, 502);
        }
      } else {
        return err("upstream fetch failed: " + e.message, 502);
      }
    }
  }

  // rejected / expired / gone → ask for a fresh URL and try again
  if ([401, 403, 404, 410].includes(upstream.status)) {
    if (!refreshed && (await swap())) {
      try {
        upstream = await grab();
        lastStatus = upstream.status;
        refreshed = true;
      } catch {
        /* keep the original response below */
      }
    }
  }

  /* A 403 is not the only way a stream dies: googlevideo can answer 200 with an
     HTML/JSON body (consent, "unavailable", a redirect page). The <video> tag
     turns that into MEDIA_ERR_SRC_NOT_SUPPORTED — the user-visible
     "format not supported" — so treat it as a failure and re-sign. */
  const isMediaCt = (ct) => !ct || /^(video\/|audio\/|application\/octet-stream|binary\/|application\/mp4|application\/x-mpegurl)/i.test(ct);
  const badBody = (r) => !r || !isMediaCt(r.headers.get("content-type") || "");

  if (upstream && upstream.ok && badBody(upstream)) {
    try { upstream.body?.cancel?.(); } catch {}
    if (!refreshed && (await swap())) {
      try {
        upstream = await grab();
        lastStatus = upstream.status;
        refreshed = true;
      } catch { /* keep going */ }
    }
    // still not media → ask the player for a different (lower) muxed stream
    if (badBody(upstream) && videoId) {
      const alt = await refreshedUrl(videoId, "", env).catch(() => "");
      if (alt && alt !== target.toString()) {
        try {
          target = new URL(alt);
          const r2 = await grab();
          if (!badBody(r2)) { upstream = r2; lastStatus = r2.status; refreshed = true; }
          else { try { r2.body?.cancel?.(); } catch {} }
        } catch { /* ignore */ }
      }
    }
  }

  // upstream broke (5xx / 429): back off once, then try a fresh signature
  if (upstream.status >= 500 || upstream.status === 429) {
    try {
      await sleep(250);
      upstream = await grab();
      lastStatus = upstream.status;
    } catch {
      /* ignore */
    }
    if (upstream.status >= 500 && (await swap())) {
      try {
        upstream = await grab();
        lastStatus = upstream.status;
        refreshed = true;
      } catch {
        /* ignore */
      }
    }
  }

  // never hand HTML/JSON to a <video> element: say it in JSON with a real status
  if (badBody(upstream) || upstream.status === 403 || upstream.status === 410) {
    try { upstream.body?.cancel?.(); } catch {}
    const failBody = JSON.stringify({
      error: "stream bytes not available (upstream " + upstream.status + ") — signature expired, retry",
      retry: true,
      itag: itag || undefined,
    });
    return new Response(failBody, {
      status: upstream.status === 403 ? 403 : 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "x-sv-media-fail",
        "x-sv-media-fail": "1",
        "cache-control": "no-store",
      },
    });
  }

  const out = new Headers();
  for (const h of ["content-length", "content-range", "accept-ranges", "content-type", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.get("content-type")) out.set("content-type", "video/mp4");
  if (!out.get("accept-ranges")) out.set("accept-ranges", "bytes");
  out.set("access-control-allow-origin", "*");
  out.set("access-control-expose-headers", "content-length, content-range, accept-ranges");
  out.set("cache-control", "no-store");
  if (refreshed) out.set("x-sv-refreshed", "1");
  out.set("x-sv-keepalive", "1");

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

// canary: run playback over a few live videos and report the pass rate
async function canary(u, env) {
  // one video per call by default: three player calls inside one invocation blow
  // through Cloudflare's 50-subrequest cap and report a fake 0%.
  const n = Math.max(1, Math.min(5, Number(u.searchParams.get("n") || 1)));
  const region = (u.searchParams.get("region") || "IN").toUpperCase();
  const cookieHeader = cookieAuth(env, u);
  const capAsked = Number(u.searchParams.get("budget") || 0);
  const budget = { left: capAsked > 0 ? Math.max(SUB_MIN_PER_VIDEO, Math.min(SUB_CAP, capAsked)) : SUB_CAP };
  let ids = [];
  try {
    const t = await trending(region, env, u);
    ids = (t.items || []).map((v) => v.videoId).filter(Boolean).slice(0, n);
  } catch (e) {
    return { ok: false, error: "could not list trending: " + e.message };
  }
  if (!ids.length) return { ok: false, error: "trending returned no ids" };

  const results = [];
  for (const id of ids) {
    const t0 = Date.now();
    if (budget.left < SUB_MIN_PER_VIDEO) {
      // honest: this video was not tested, it was not a failure
      results.push({ id, ok: false, skipped: "subrequest budget", ms: 0, pass: 0, client: null, reason: null, formats: [] });
      continue;
    }
    try {
      const r = await player(id, { env, cookieHeader, region, budget, noCache: true });
      results.push({
        id,
        ok: !!r.ok,
        ms: Date.now() - t0,
        pass: r.pass || 0,
        client: r.client || null,
        reason: r.reason || null,
        formats: (r.formats || []).map((f) => f.quality),
        budgetLeft: r.budgetLeft,
      });
    } catch (e) {
      results.push({ id, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  const tested = results.filter((r) => !r.skipped);
  const passed = tested.filter((r) => r.ok).length;
  return {
    ok: passed > 0,
    checked: tested.length,
    skipped: results.length - tested.length,
    passed,
    rate: tested.length ? Math.round((passed / tested.length) * 100) + "%" : "n/a",
    budgetLeft: budget.left,
    note: results.length > tested.length ? "some videos were not tested — Cloudflare caps subrequests per request; call canary again" : undefined,
    cookiesUsed: !!cookieHeader,
    results,
  };
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
  "/api/canary?n=1",
  "/api/selftest?id=",
  "/api/player?id=",
  "/api/search?q=",
  "/api/searchmore?q=&token=",
  "/api/trending?region=IN",
  "/api/shorts?region=IN",
  "/api/related?id=",
  "/api/comments?id=&token=",
  "/api/rss?channels=UC..,UC..",
  "/api/channel?q=@handle",
  "/api/sync?p=KEY  (GET/POST/DELETE)",
  "/api/sync/probe  (is Layerbase really connected?)",
  "/api/media?u=",
  "/mp4/{id}.mp4",
  "/api/stream?id=&itag=",
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
      <span class="b ok">build ${BUILD}</span>
      <span class="b ok">engine: innertube</span>
      <span class="b ${cookies ? "ok" : ""}">cookies: ${cookies ? "configured" : "not set"}</span>
      <span class="b ${keyed ? "ok" : ""}">SV_KEY: ${keyed ? "set (cookies need ?key=)" : "not set"}</span>
      <span class="b ${storeConfigured(env) ? "ok" : "off"}">store: ${storeConfigured(env) ? "layerbase libSQL" : "not configured"}</span>
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
    <p><a class="btn ghost" href="/api/selftest?id=dQw4w9WgXcQ&probe=1">/api/selftest?id=…&amp;probe=1 (doctor)</a><a class="btn ghost" href="/api/trending?region=IN">/api/trending</a><a class="btn ghost" href="/api/shorts?region=IN">/api/shorts</a></p>
    <p class="muted">Direct file: <code>/mp4/dQw4w9WgXcQ.mp4</code> · <code>?dl=1</code> download · <code>?itag=18</code> quality</p>
  </div>

  <p class="muted">This page is only shown at the root — every real endpoint lives under <code>/api/*</code> or <code>/mp4/*</code>.</p>
</div></body></html>`;
}

// ── cloud store: Layerbase libSQL over HTTPS (Hrana v2 pipeline) ─────────────
// Everything the app remembers lives here — no localStorage, no cookies holding
// content. Each write also trims that list, so "aage ka yaad, peeche ka bhool"
// and the DB can never creep past its cap. No TTL anywhere: nothing expires by
// time, only by cap.
const CAPS = { history: 300, subs: 150, likes: 500, watchlater: 300, playlists: 50, cfg: 1 };
const KIND_ALIAS = {
  hist: "history", history: "history",
  s: "subs", sub: "subs", subs: "subs", subscriptions: "subs",
  f: "likes", fav: "likes", favs: "likes", likes: "likes",
  w: "watchlater", wl: "watchlater", watchlater: "watchlater",
  p: "playlists", pls: "playlists", playlists: "playlists",
  c: "cfg", config: "cfg", cfg: "cfg",
};
const SYNC_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sv_store (uid TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, kind, id))",
  "CREATE INDEX IF NOT EXISTS sv_store_trim ON sv_store (uid, kind, pos DESC)",
];

const canonicalKind = (k) => KIND_ALIAS[String(k || "").toLowerCase()] || "";
const validProfileKey = (k) => /^[A-Za-z0-9_-]{16,64}$/.test(String(k || ""));

/* ── LIBSQL_URL normalizer ────────────────────────────────────────────────────
   Dashboard se jo bhi paste ho, usse ek hi shakal me le aao:
     https://db-xyz.sage.cloud.layerbase.dev
   Sab ye chalte hain (aur pehle toot rahe the):
     db-xyz.sage.cloud.layerbase.dev            (no scheme)
     libsql://db-xyz…  ·  http://db-xyz…
     https://db-xyz…/v2/pipeline                (endpoint copy kiya hua)
     https://db-xyz…/v2  ·  …/pipeline  ·  …/    (trailing bits)
     "https://db-xyz…"                          (quotes ke saath paste)
   Hrana endpoint khud add hota hai — isliye base me path kabhi nahi rakhte.  */
const LIBSQL_SUFFIXES = [/\/v2\/pipeline$/i, /\/v1\/pipeline$/i, /\/v3\/pipeline$/i, /\/pipeline$/i, /\/v2$/i, /\/v1$/i, /\/v3$/i, /\/http$/i, /\/sql$/i];
const libsqlRaw = (env) =>
  String((env && (env.LIBSQL_URL || env.LIBSQL_DATABASE_URL || env.LAYERBASE_URL || env.TURSO_DATABASE_URL)) || "");

/* Turso-style connection strings carry the token in the URL itself:
     libsql://db.cloud.layerbase.dev?authToken=eyJ…
   The dashboard's ".env download" prints exactly that, so a token that never
   made it into its own secret still works. */
function tokenFromUrl(raw) {
  const s = String(raw || "");
  const m = s.match(/[?&](?:authToken|auth_token|token)=([^&#\s]+)/i);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function normalizeLibsqlUrl(raw) {
  let s = String(raw || "").trim().replace(/^["'`\s]+|["'`\s]+$/g, "");
  if (!s) return "";
  s = s.replace(/\s+/g, "");
  s = s.replace(/^libsql:\/\//i, "https://").replace(/^(wss|ws|http):\/\//i, "https://");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/[?#].*$/, "");
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/\/+$/, "");
    for (const re of LIBSQL_SUFFIXES) s = s.replace(re, "");
    if (s === before) break;
  }
  try {
    const u = new URL(s);
    if (!u.hostname || !u.hostname.includes(".")) return "";
    return u.origin;                       // path hamesha drop — endpoint worker khud lagata hai
  } catch {
    return "";
  }
}

const libsqlBase = (env) => normalizeLibsqlUrl(libsqlRaw(env));

const libsqlToken = (env) => {
  const given = String(
    (env && (env.LIBSQL_TOKEN || env.LIBSQL_AUTH_TOKEN || env.LAYERBASE_TOKEN || env.TURSO_AUTH_TOKEN)) || ""
  );
  const cleaned = given
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^bearer\s+/i, "")
    .replace(/\s+/g, "");
  return cleaned || tokenFromUrl(libsqlRaw(env));
};

/* What kind of secret did we actually get? Layerbase hands out two very
   different credentials — the database auth token (a JWT) and the account API
   key (sk_…, for the Cloud REST API only). Naming the shape ends the guessing. */
function tokenShape(token) {
  const t = String(token || "");
  const parts = t.split(".").length;
  return {
    len: t.length,
    parts,
    prefix: t.slice(0, 6),
    dots: parts - 1,
    apiKey: /^sk[_-]/i.test(t),
    url: /^(https?|libsql|wss?):\/\//i.test(t),
    spaced: /\s/.test(t),
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t),
  };
}

/* ── JWT inspector ───────────────────────────────────────────────────────────
   Layerbase answers 401 with "The JWT is invalid" for four different mistakes:
   the secret is not a JWT, the JWT expired, the JWT was issued for another
   database, or the signing secret was rotated. We decode the payload (claims
   only, no verification) so the probe can name the real one instead of guessing.
   The token itself never leaves the worker. */
function b64urlJson(part) {
  try {
    const s = String(part || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
    return JSON.parse(atob(pad));
  } catch { return null; }
}

function decodeJwtInfo(token) {
  const t = String(token || "");
  const parts = t.split(".");
  const out = { jwt: parts.length === 3 && t.length > 40, parts: parts.length, len: t.length };
  if (!out.jwt) return out;
  const head = b64urlJson(parts[0]) || {};
  const p = b64urlJson(parts[1]) || {};
  const exp = Number(p.exp || 0);
  out.alg = String(head.alg || "");
  out.exp = exp || 0;
  out.expIso = exp ? new Date(exp * 1000).toISOString().slice(0, 10) : "";
  out.expired = !!exp && exp * 1000 < Date.now();
  out.dbId = String(p.id || p.db || p.database || p.dbid || "");
  out.scope = String(p.a || p.scope || "");
  out.iss = String(p.iss || "");
  out.sub = String(p.sub || "");
  return out;
}

/* does the token look like it belongs to the database in LIBSQL_URL? */
function jwtDbMatch(dbId, host) {
  if (!dbId || !host) return null;
  const first = String(host).split(".")[0].toLowerCase();
  const id = String(dbId).toLowerCase();
  if (!first || !id) return null;
  return first === id || first.includes(id) || id.includes(first);
}

/* What the worker actually parsed — so a wrong paste is visible, not guessed. */
function libsqlInfo(env) {
  const raw = libsqlRaw(env);
  const base = libsqlBase(env);
  const token = libsqlToken(env);
  const tk = decodeJwtInfo(token);
  const hadScheme = /^[a-z]+:\/\//i.test(raw.trim());
  const hadPath = /^[a-z]+:\/\/.*\//i.test(raw.trim().replace(/\/+$/, "") + "/x") && /\/[^/]+/.test(raw.trim().replace(/^[a-z]+:\/\//i, ""));
  return {
    configured: !!(base && token),
    urlGiven: !!raw.trim(),
    tokenGiven: !!token,
    normalized: base,
    host: base ? base.replace(/^https:\/\//, "") : "",
    endpoint: base ? base + "/v2/pipeline" : "",
    changed: !!raw.trim() && base !== raw.trim(),
    hadScheme,
    hadPath,
    tokenPrefix: token ? token.slice(0, 4) + "…" : "",
    tokenSource: String((env && (env.LIBSQL_TOKEN || env.LIBSQL_AUTH_TOKEN || env.LAYERBASE_TOKEN || env.TURSO_AUTH_TOKEN)) || "") ? "secret" : token ? "url" : "",
    shape: tokenShape(token),
    token: tk,
    dbMatch: jwtDbMatch(tk.dbId, base ? base.replace(/^https:\/\//, "").split("/")[0] : ""),
  };
}

const storeConfigured = (env) => !!(libsqlBase(env) && libsqlToken(env));

// Hrana v2 typed values
const T = (v) => ({ type: "text", value: String(v) });
const I = (v) => ({ type: "integer", value: String(Math.trunc(Number(v) || 0)) });

const SCHEMA_DONE = new Set();

async function libsqlPipeline(env, stmts) {
  const base = libsqlBase(env);
  const token = libsqlToken(env);
  if (!base || !token) throw new Error("cloud store not configured: set LIBSQL_URL + LIBSQL_TOKEN");
  const body = {
    requests: stmts
      .map((s) => ({ type: "execute", stmt: { sql: s.sql, args: s.args || [] } }))
      .concat([{ type: "close" }]),
  };
  const r = await fetchRetry(
    base + "/v2/pipeline",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    },
    { retries: 1, timeout: 9000 }
  );
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`layerbase returned non-JSON (HTTP ${r.status})`);
  }
  if (!r.ok) {
    const e = new Error(`layerbase HTTP ${r.status}${data && data.error ? ": " + data.error : ""}`);
    e.status = r.status;
    e.code = "http";
    throw e;
  }
  const out = [];
  for (const res of data.results || []) {
    if (res.type === "error") {
      const e = res.error || {};
      throw new Error("layerbase: " + (e.message || e.code || "query failed"));
    }
    if (res.type === "ok" && res.response && res.response.type === "execute") {
      const result = res.response.result || {};
      const cols = (result.cols || []).map((c) => c.name);
      const rows = (result.rows || []).map((row) => {
        const o = {};
        cols.forEach((c, i) => {
          const v = row[i];
          if (v == null) o[c] = null;
          else if (typeof v === "object" && "value" in v) o[c] = v.type === "integer" ? Number(v.value) : v.value;
          else o[c] = v;
        });
        return o;
      });
      out.push({ cols, rows, affected: result.affected_row_count || 0 });
    } else {
      out.push(null);
    }
  }
  return out;
}

/* Turn "layerbase HTTP 401: Unauthorized: The JWT is invalid" into the real
   cause. Used everywhere the store touches Layerbase, so the app, the probe and
   the sync error all say the same, actionable thing. */
function jwtVerdict(env, e) {
  const info = libsqlInfo(env);
  const tk = info.token || {};
  const status = (e && e.status) || 0;
  const msg = String((e && e.message) || "");
  const auth = status === 401 || status === 403 || /unauthor|invalid jwt|jwt is invalid|token/i.test(msg);
  if (!auth) return null;
  const jwt = { ...tk, dbMatch: info.dbMatch, host: info.host };
  if (!tk.jwt) {
    const sh = info.shape || {};
    const seen = `${sh.len || 0} chars, shuru "${sh.prefix || "?"}", ${sh.dots || 0} dot`;
    /* the single most common Layerbase mix-up: the account API key (sk_…) is for
       the Cloud REST API, while /v2/pipeline wants the database auth token */
    const error = sh.apiKey
      ? `LIBSQL_TOKEN me Layerbase ka personal API key (sk_…) hai — wo Cloud REST API ke liye hota hai, database ke liye nahi (${seen})`
      : sh.url
        ? "LIBSQL_TOKEN me URL paste ho gaya — ye secret database ka auth token maangta hai, URL alag LIBSQL_URL me jaata hai"
        : sh.spaced
          ? "LIBSQL_TOKEN me space ya line break hai — token ek hi line me, bina space ke paste karein"
          : `LIBSQL_TOKEN JWT nahi lag raha (${seen}; JWT 3 dot-separated parts hota hai, "eyJ…" se shuru)`;
    const hint = sh.apiKey
      ? "sk_ key Cloud API (cloud.layerbase.dev/v1) ke liye hai. Database chalane ke liye dashboard me apna DB kholein → Quick Connect / Connect panel → auth token (eyJ… wala, ~200+ chars) copy karein → Cloudflare → Worker → Settings → Variables and Secrets me LIBSQL_TOKEN = wahi token → Deploy."
      : "Layerbase → apna DB → Quick Connect → auth token (eyJ… wala) copy karein — URL nahi, API key nahi. Cloudflare → Worker → Settings → Variables and Secrets → LIBSQL_TOKEN update → Deploy. (Naam LIBSQL_AUTH_TOKEN bhi chalega, aur URL me ?authToken=… ho to wo bhi padh liya jaata hai.)";
    return { code: sh.apiKey ? "jwt-api-key" : "jwt-format", error, hint, jwt };
  }
  if (tk.expired) {
    return {
      code: "jwt-expired",
      error: "LIBSQL_TOKEN expire ho chuka hai (exp " + tk.expIso + ")",
      hint: "Layerbase → DB → Connect se naya token banayein, LIBSQL_TOKEN update karein, Deploy dabayein. Bina expiry wala token lein to ye dobara nahi aayega.",
      jwt,
    };
  }
  if (info.dbMatch === false) {
    return {
      code: "jwt-wrong-db",
      error: 'Token dusri database ka lag raha hai (token db "' + tk.dbId + '", URL host "' + info.host + '")',
      hint: "Workspace me kai DB ho sakte hain. Layerbase me jis DB ka token hai, usi DB ke Connect screen se URL bhi copy karein aur wahi LIBSQL_URL me daalein, phir Deploy dabayein.",
      jwt,
    };
  }
  return {
    code: "jwt-bad-signature",
    error: "Token ki signature invalid hai — rotate ho gaya ya adhoora paste hua",
    hint: "Layerbase → DB → Connect se token dobara copy karein (poora, bina line break ke). Bearer prefix ki zaroorat nahi, worker khud lagata hai. Phir LIBSQL_TOKEN update + Deploy.",
    jwt,
  };
}

// One-click setup check: does this worker actually reach Layerbase, sleep/wake
// included? Returns the round-trip time so "slow because it was hibernating" is
// visible instead of guessed.
async function storeProbe(env, uid = "") {
  const info = libsqlInfo(env);
  if (!storeConfigured(env)) {
    // secret to hai par parse nahi hui → yeh sabse common "link sahi hai par invalid" case hai
    const badUrl = info.urlGiven && !info.normalized;
    const badToken = info.urlGiven && info.normalized && !info.tokenGiven;
    return {
      ok: false,
      configured: false,
      backend: "layerbase-libsql",
      error: badUrl
        ? "LIBSQL_URL parse nahi hui — sirf host chahiye, jaise https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"
        : badToken
          ? "LIBSQL_TOKEN khali/galt hai (Bearer prefix ya quotes hata dein)"
          : "LIBSQL_URL + LIBSQL_TOKEN missing",
      url: {
        given: info.urlGiven,
        normalized: info.normalized,
        host: info.host,
        changed: info.changed,
        tokenGiven: info.tokenGiven,
        tokenPrefix: info.tokenPrefix,
        endpoint: info.endpoint,
      },
      steps: [
        "layerbase.com → sign in (free, no card)",
        "New Database → engine libSQL → Free plan → Create",
        "open the DB → Connect → copy the https://…cloud.layerbase.dev URL and the auth token",
        "Cloudflare → Workers → your worker → Settings → Variables → add LIBSQL_URL and LIBSQL_TOKEN as Secret",
        "/v2/pipeline ya trailing slash paste karne ki zaroorat nahi — worker khud lagata hai (ab handle bhi karta hai)",
        "hit this probe again — it should say ok:true in a few hundred ms",
      ],
    };
  }
  const t0 = Date.now();
  try {
    await ensureSchema(env);
    const stmts = [{ sql: "SELECT 1 AS ok", args: [] }];
    if (validProfileKey(uid)) stmts.push({ sql: "SELECT COUNT(*) AS n FROM sv_store WHERE uid = ?", args: [T(uid)] });
    const out = await libsqlPipeline(env, stmts);
    const rows = validProfileKey(uid) ? Number((out[1] && out[1].rows && out[1].rows[0] && out[1].rows[0].n) || 0) : null;
    return {
      ok: true,
      configured: true,
      backend: "layerbase-libsql",
      host: libsqlBase(env).replace(/^https?:\/\//, "").split("/")[0],
      endpoint: libsqlBase(env) + "/v2/pipeline",
      urlFixed: info.changed,
      originalUrl: info.changed ? info.normalized : undefined,
      latencyMs: Date.now() - t0,
      schema: "sv_store ready",
      rows,
      caps: CAPS,
      ttl: "none",
      wokeFromSleep: Date.now() - t0 > 1200,
    };
  } catch (e) {
    const jv = jwtVerdict(env, e);
    return {
      ok: false,
      configured: true,
      backend: "layerbase-libsql",
      latencyMs: Date.now() - t0,
      error: jv ? jv.error : /^layerbase/i.test(e.message) ? e.message : "layerbase: " + e.message,
      verdict: jv ? jv.code : "layerbase-error",
      jwt: jv ? jv.jwt : undefined,
      host: libsqlBase(env).replace(/^https?:\/\//, ""),
      endpoint: libsqlBase(env) + "/v2/pipeline",
      url: { given: info.urlGiven, normalized: info.normalized, changed: info.changed, tokenGiven: info.tokenGiven, tokenPrefix: info.tokenPrefix },
      hint: jv
        ? jv.hint
        : /restore|archiv/i.test(e.message)
        ? "database is archived — open the Layerbase dashboard and press Restore (data + backups are kept)"
        : /401|403|unauthor/i.test(e.message)
          ? "token galat hai — Layerbase dashboard → Connect se naya auth token copy karein (Bearer prefix ke bina), phir Cloudflare → Settings → Variables me LIBSQL_TOKEN update karke Deploy dabaein"
          : /404|not found|non-JSON/i.test(e.message)
            ? "host galat lag raha hai ya database delete ho gaya — Layerbase → Connect se poora https URL dobara copy karein (path ke bina)"
            : "check LIBSQL_URL (https://…cloud.layerbase.dev) and LIBSQL_TOKEN; a sleeping DB wakes on the first query in ~1-5s",
    };
  }
}

async function ensureSchema(env) {
  const base = libsqlBase(env);
  if (SCHEMA_DONE.has(base)) return;
  await libsqlPipeline(env, SYNC_SCHEMA.map((sql) => ({ sql })));
  SCHEMA_DONE.add(base);
}

function trimStmt(uid, kind) {
  const cap = CAPS[kind] || 1;
  return {
    sql: "DELETE FROM sv_store WHERE uid = ? AND kind = ? AND id NOT IN (SELECT id FROM sv_store WHERE uid = ? AND kind = ? ORDER BY pos DESC, id DESC LIMIT ?)",
    args: [T(uid), T(kind), T(uid), T(kind), I(cap)],
  };
}

// one upsert + one trim per kind; deletes chunked so we stay well inside the pipeline limit
function opsToStatements(uid, ops) {
  const stmts = [];
  let written = 0;
  for (const op of ops || []) {
    const kind = canonicalKind(op && op.kind);
    if (!kind) continue;
    if (op.clear) {
      stmts.push({ sql: "DELETE FROM sv_store WHERE uid = ? AND kind = ?", args: [T(uid), T(kind)] });
      continue;
    }
    const ups = (op.upsert || []).slice(-1000);
    for (const it of ups) {
      const id = String((it && (it.id || it.videoId || it.channelId)) || "").slice(0, 120);
      if (!id) continue;
      const pos = Number(it.pos) || Date.now();
      let data = it.data !== undefined ? it.data : it;
      let blob;
      try {
        blob = JSON.stringify(data);
      } catch {
        continue;
      }
      if (blob.length > 60000) blob = JSON.stringify({ videoId: id, title: "(too large)" });
      stmts.push({
        sql: "INSERT INTO sv_store (uid, kind, id, pos, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid, kind, id) DO UPDATE SET pos = excluded.pos, data = excluded.data",
        args: [T(uid), T(kind), T(id), I(pos), T(blob)],
      });
      written++;
    }
    const dels = (op.del || []).map((x) => String(x)).filter(Boolean);
    for (let i = 0; i < dels.length; i += 40) {
      const chunk = dels.slice(i, i + 40);
      stmts.push({
        sql: `DELETE FROM sv_store WHERE uid = ? AND kind = ? AND id IN (${chunk.map(() => "?").join(",")})`,
        args: [T(uid), T(kind), ...chunk.map(T)],
      });
    }
    if (ups.length || dels.length) stmts.push(trimStmt(uid, kind));
  }
  return { stmts, written };
}

const emptyStore = () => ({ history: [], subs: [], likes: [], watchlater: [], playlists: [], cfg: {} });

// Cache API snapshot: if Layerbase is asleep / unreachable, the last known
// profile still opens the app (edge cache, 1 year, never expires on its own).
const snapshotKey = (uid) => new Request(`https://sv-store.internal/${uid}`, { method: "GET" });

async function readSnapshot(uid) {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    const r = await caches.default.match(snapshotKey(uid));
    if (!r) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function writeSnapshot(uid, payload) {
  try {
    if (typeof caches === "undefined" || !caches.default) return false;
    await caches.default.put(
      snapshotKey(uid),
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", "cache-control": "max-age=31536000" },
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function syncGet(env, uid) {
  if (!validProfileKey(uid)) return { ok: false, error: "profile key must be 16-64 chars of [A-Za-z0-9_-]" };
  if (!storeConfigured(env)) {
    return { ok: false, configured: false, error: "cloud store not configured (add LIBSQL_URL + LIBSQL_TOKEN to the worker)" };
  }
  try {
    await ensureSchema(env);
    const [res] = await libsqlPipeline(env, [
      { sql: "SELECT kind, id, pos, data FROM sv_store WHERE uid = ? ORDER BY kind, pos DESC, id DESC", args: [T(uid)] },
    ]);
    const store = emptyStore();
    for (const row of (res && res.rows) || []) {
      const kind = canonicalKind(row.kind);
      if (!kind) continue;
      let data = {};
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (kind === "cfg") {
        store.cfg = data && typeof data === "object" ? data : {};
        continue;
      }
      const list = store[kind];
      if (Array.isArray(list)) list.push(data);
    }
    // a read is also the wake-up: a sleeping libSQL wakes in 1-5s, an archived
    // one needs a dashboard Restore — this flag tells the app which happened
    const payload = { ok: true, backend: "layerbase-libsql", store, caps: CAPS, at: Date.now() };
    writeSnapshot(uid, payload);
    return payload;
  } catch (e) {
    const jv = jwtVerdict(env, e);
    const snap = await readSnapshot(uid);
    if (snap && snap.store) {
      return { ...snap, ok: true, stale: true, backend: "edge-snapshot", warning: (jv && jv.error) || e.message };
    }
    return {
      ok: false,
      configured: true,
      error: (jv && jv.error) || e.message,
      hint: (jv && jv.hint) || "Layerbase free DB sleeps when idle (wakes in ~1-5s) and is archived after 14 idle days — open the dashboard and hit Restore.",
      verdict: jv ? jv.code : "layerbase-error",
      jwt: jv ? jv.jwt : undefined,
    };
  }
}

async function syncWrite(env, uid, body) {
  if (!validProfileKey(uid)) return { ok: false, error: "profile key must be 16-64 chars of [A-Za-z0-9_-]" };
  if (!storeConfigured(env)) return { ok: false, configured: false, error: "cloud store not configured (add LIBSQL_URL + LIBSQL_TOKEN to the worker)" };
  const ops = Array.isArray(body && body.ops) ? body.ops : body && body.kind ? [body] : [];
  const { stmts, written } = opsToStatements(uid, ops);
  if (!stmts.length) return { ok: true, written: 0, backend: "layerbase-libsql", caps: CAPS };
  try {
    await ensureSchema(env);
    for (let i = 0; i < stmts.length; i += 60) {
      await libsqlPipeline(env, stmts.slice(i, i + 60));
    }
    const kinds = [...new Set(ops.map((o) => canonicalKind(o.kind)).filter(Boolean))];
    const payload = { ok: true, written, backend: "layerbase-libsql", caps: CAPS, kinds, at: Date.now() };
    // refresh the edge snapshot with the post-write truth, cheaply: re-read only
    // when it is a small profile (<= 120 rows) — otherwise the next GET refreshes
    if (written <= 120) {
      try {
        const fresh = await syncGet(env, uid);
        if (fresh && fresh.ok) payload.store = fresh.store;
      } catch {
        /* snapshot is best effort */
      }
    }
    return payload;
  } catch (e) {
    const jv = jwtVerdict(env, e);
    return {
      ok: false,
      configured: true,
      error: (jv && jv.error) || e.message,
      hint: jv ? jv.hint : undefined,
      verdict: jv ? jv.code : "layerbase-error",
      jwt: jv ? jv.jwt : undefined,
      written: 0,
    };
  }
}

async function syncClear(env, uid, kind) {
  const k = canonicalKind(kind);
  if (!k) return { ok: false, error: "unknown kind" };
  return syncWrite(env, uid, { kind: k, clear: true });
}

async function syncImport(env, uid, body) {
  const store = (body && body.store) || {};
  const ops = [];
  for (const kind of Object.keys(CAPS)) {
    if (kind === "cfg") {
      if (store.cfg) ops.push({ kind, upsert: [{ id: "cfg", pos: 1, data: store.cfg }] });
      continue;
    }
    const list = store[kind];
    if (!Array.isArray(list) || !list.length) continue;
    ops.push({
      kind,
      upsert: list.slice(0, CAPS[kind]).map((v, i) => ({
        id: v.videoId || v.channelId || v.id,
        pos: Number(v.pos) || Date.now() - i,
        data: v,
      })),
    });
  }
  if (!ops.length) return { ok: false, error: "nothing to import" };
  const r = await syncWrite(env, uid, { ops });
  return { ...r, imported: ops.reduce((n, o) => n + o.upsert.length, 0) };
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
      const cookies = parseCookies(ytCookieRaw(env));
      return {
        ok: true,
        build: BUILD,
        service: "streamvoid-worker",
        engine: "innertube",
        clients: CLIENT_SPECS.map((c) => c.id),
        versions,
        versionSource: source,
        ladder: "2 versions per client (discovered, then baked fallback)",
        cookies: { ...cookieReport(env, u), used: !!(cookies && keyAllowed(env, u)) },
        versionCacheAge: Math.round(Date.now() / 1000 - VERSION_CACHE.ts) + "s",
        resilience: {
          visitorData: !!VERSION_CACHE.visitorData,
          gate: ytGateInfo(),
          mirrors: mirrorSnapshot(),
          playerCache: playerCacheStats(),
          winner: winnerClient() ? { client: WINNER.id, version: WINNER.version, ageSec: Math.round((Date.now() - WINNER.ts) / 1000) } : null,
          subrequestCap: SUB_CAP,
          breakers: breakerSnapshot(),
          emergencyMirrors: emergencyMirrors(env).length,
          poToken: !!(env && env.PO_TOKEN),
          poTokenProvider: !!(env && env.POTOKEN_URL),
          mirrorsDisabled: String((env && env.MIRRORS) || "").toLowerCase() === "off",
          passes: [
            "fast anonymous (android_vr/ios/tv_embedded/android)",
            "cookies on bot-check/login (YT_COOKIES, SV_KEY-gated)",
            "self-heal: fresh versions + full ladder, breakers bypassed",
            "independent extractors (Invidious API, proxied)",
          ],
          escalateOnBotCheck: true,
          breakerScope: "network/format failures only — bot-check and private videos never cool a client",
          canary: "/api/canary?n=1",
          clientIq: {
            headers: ["x-goog-visitor-id", "referer: watch?v=<id>", "x-origin"],
            consentCookies: consentCookies(env) ? "SOCS=CAI; CONSENT=YES+cb" : "off (CONSENT=off)",
            playbackContext: "html5Preference=HTML5_PREF_WANTS",
            accountOnly: CLIENT_SPECS.filter((c) => c.needsAuth).map((c) => c.id),
            selfHealWalksEveryClient: true,
            scoreboard: "/api/debug → clientStats",
          },
        },
        keepPlaying: {
          mediaSelfHeal: "expired/gone signature is re-resolved before and after the fetch",
          upstreamRetries: "network error → retry, 5xx → backoff + fresh signature",
          mirrorRefresh: "if InnerTube cannot re-resolve, mirrors hand out a fresh URL",
          stableUrl: "/api/stream?id=&itag= — no signature, resolves on every request",
        },
        store: {
          backend: "layerbase-libsql",
          configured: storeConfigured(env),
          caps: CAPS,
          ttl: "none — nothing expires, old items drop off at the cap",
          routes: ["GET /api/sync?p=", "POST /api/sync?p=", "DELETE /api/sync?p=&kind=", "POST /api/sync/import?p="],
          hint: storeConfigured(env) ? "ready" : "add LIBSQL_URL + LIBSQL_TOKEN (Layerbase → libSQL → Connect)",
          probe: "/api/sync/probe",
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
        ladder: ladder.map((c) => ({ id: c.id, version: c.ctx.clientVersion, needsAuth: !!c.needsAuth })),
        cookieHeaderPresent: !!ytCookieRaw(env),
        keyProtectsCookies: !!(env && env.SV_KEY),
        cookies: cookieReport(env, u),
        // who is actually delivering on this worker's IP (per isolate, resets on redeploy)
        clientStats: CLIENT_STATS,
        headers: {
          visitorId: "x-goog-visitor-id + body",
          referer: "https://www.youtube.com/watch?v=<id> on player calls",
          consentCookies: consentCookies(env) ? "SOCS=CAI; CONSENT=YES+cb" : "off (CONSENT=off)",
          playbackContext: "html5Preference=HTML5_PREF_WANTS",
        },
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
        noCache: true,          // the doctor must test YouTube live, never a cached answer
        cookieHeader: cookieAuth(env, u),
        region: (u.searchParams.get("region") || "IN").toUpperCase(),
      });
      /* ?probe=1 also pulls the first bytes through our own /api/media proxy, so a
         single URL answers both questions: "did we resolve?" and "does it play?" */
      let stream = null;
      if (u.searchParams.get("probe") === "1") {
        const first = (res.formats || [])[0];
        if (!first) {
          stream = { ok: false, status: 0, note: "no format to probe (player did not resolve)" };
        } else {
          try {
            const src = new URL(first.url, u.origin).toString();
            const r = await fetch(src, { headers: { range: "bytes=0-2047" } });
            const buf = await r.arrayBuffer();
            stream = {
              ok: r.status === 200 || r.status === 206,
              status: r.status,
              itag: first.itag,
              quality: first.quality,
              type: r.headers.get("content-type") || "",
              bytes: buf.byteLength,
              note: r.status === 403 ? "googlevideo ne 403 diya — signature/nsig toot gaya, worker dobara deploy karein" :
                r.status === 200 || r.status === 206 ? "bytes aa rahe hain — stream playable hai" : "unexpected status",
            };
          } catch (e) {
            stream = { ok: false, status: 0, note: "proxy fetch failed: " + String((e && e.message) || e) };
          }
        }
      }

      const ck = cookieReport(env, u);
      const verdict = (() => {
        if (!res.ok) {
          if (res.reason === "ratelimit") {
            return {
              code: "ratelimit",
              hi: "YouTube is IP ki requests rate-limit kar raha hai (429/403). " +
                (res.retryAfter ? res.retryAfter + " second me app khud dobara try karegi — aapko kuch karne ki zarurat nahi. " : "") +
                "Permanent fix: worker me POTOKEN_URL (bgutil provider) ya YT_COOKIES add karein, taaki requests allowed client jaisi lagein.",
            };
          }
          if (res.botCheck || res.needAuth) {
            // "cookies laga diye par bot-check phir bhi" — yahi wajah hoti hai
            if (!ck.configured) {
              return { code: "bot", hi: "YouTube bot-check aur cookies set nahi hain: worker me YT_COOKIES (throwaway account) ya POTOKEN_URL secret add karein → Deploy." };
            }
            if (!ck.keyOk) {
              return { code: "bot-key", hi: "Cookies set hain par SV_KEY mismatch ki wajah se worker unhe use nahi kar raha. App ke Settings → Access key me bilkul wahi SV_KEY daalein (ya worker se SV_KEY hata dein)." };
            }
            if (ck.missing.length) {
              return { code: "bot-cookies", hi: "Cookies pahunche par export adhoora hai — missing: " + ck.missing.join(", ") + ". SID/HSID/SSID/SAPISID sab chahiye; netscape cookies.txt ya poori header string paste karein." };
            }
            if (res.poTokenUsed || (env && (env.PO_TOKEN || env.POTOKEN_URL))) {
              return { code: "bot-ip", hi: "Cookies poore hain aur PoToken bhi try hua, phir bhi bot-check — ye IP-level block hai (Cloudflare Workers ka shared IP). Free fix: POTOKEN_URL provider (bgutil) chalu karein, ya worker ko aise account ke cookies dein jo us IP se pehle kabhi use na hua ho." };
            }
            return { code: "bot-potoken", hi: "Cookies theek hain par YouTube is IP par PoToken maang raha hai. POTOKEN_URL (bgutil-verify-token provider) secret add karein — uske bina datacenter IP par playback block rehta hai. /api/debug me clientStats dekhein." };
          }
          if (res.reason === "geo") return { code: "geo", hi: "Ye video is region me block hai — Settings → Region me IN ke alawa US/GB try karein." };
          if (res.reason === "age") return { code: "age", hi: "Age-restricted video: cookies chahiye (YT_COOKIES)." };
          return { code: "resolve", hi: "Stream resolve hi nahi hua — /api/debug?refresh=1 kholein aur clientStats dekhein." };
        }
        if (stream && !stream.ok) {
          return { code: "proxy", hi: "Resolve ho gaya par bytes nahi aa rahe (" + stream.status + "). Worker ka naya version deploy karein, phir dobara probe karein." };
        }
        return { code: "ok", hi: "Sab theek — resolve + bytes dono kaam kar rahe hain. Browser me video chalni chahiye." };
      })();

      return {
        ok: !!res.ok,
        video: id,
        ms: Date.now() - t0,
        pass: res.pass || 0,
        reason: res.reason || null,
        reasonLabel: res.reasonLabel || null,
        hint: res.hint || null,
        needAuth: !!res.needAuth,
        botCheck: !!res.botCheck,
        poTokenUsed: !!res.poTokenUsed,
        client: res.client || null,
        clientVersion: res.clientVersion || null,
        healed: !!res.healed,
        formats: (res.formats || []).map((f) => f.quality),
        attempts: (res.attempts || []).slice(-12),
        breakers: breakerSnapshot(),
        stream,
        cookies: ck,
        retryAfter: res.retryAfter || 0,
        gate: res.gate || ytGateInfo(),
        subrequests: res.subrequests,
        verdict,
      };
    },
  ],
  ["/api/player", async (u, env) => player(u.searchParams.get("id") || "", { env, cookieHeader: cookieAuth(env, u), region: (u.searchParams.get("region") || "IN").toUpperCase() })],
  ["/api/search", async (u, env) => search(u.searchParams.get("q") || "", Number(u.searchParams.get("page") || 1), env, u)],
  ["/api/searchmore", async (u, env) => searchMore(u.searchParams.get("q") || "", u.searchParams.get("token") || "", env, u)],
  ["/api/trending", async (u, env) => trending((u.searchParams.get("region") || "IN").toUpperCase(), env, u)],
  ["/api/related", async (u, env) => related(u.searchParams.get("id") || "", env, u)],
  ["/api/comments", async (u, env) => comments(u.searchParams.get("id") || "", u.searchParams.get("token") || "", env, u)],
  ["/api/shorts", async (u, env) => shorts((u.searchParams.get("region") || "IN").toUpperCase(), env, u)],
  ["/api/rss", async (u, env) => rss(env, u.searchParams.get("channels") || "", u)],
  ["/api/probe", async (u, env) => probe(u, env)],
  ["/api/canary", async (u, env) => canary(u, env)],
  ["/api/channel", async (u) => resolveChannel(u.searchParams.get("q") || u.searchParams.get("id") || "")],
];

export default {
  // Cron trigger (optional, free): a tiny write every few hours means the free
  // Layerbase DB never idles long enough to be archived (data is never deleted
  // either way — this just avoids the manual Restore click).
  async scheduled(event, env = {}, ctx) {
    try {
      if (!storeConfigured(env)) return;
      await ensureSchema(env);
      await libsqlPipeline(env, [
        {
          sql: "INSERT INTO sv_store (uid, kind, id, pos, data) VALUES ('__system', 'ping', 'ping', ?, '{}') ON CONFLICT(uid, kind, id) DO UPDATE SET pos = excluded.pos",
          args: [I(Math.floor(Date.now() / 1000))],
        },
      ]);
    } catch {
      /* a missed beat is harmless */
    }
  },
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,POST,DELETE,OPTIONS",
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
          return json({ ok: true, build: BUILD, service: "streamvoid-worker", routes: ROUTE_LIST, health: "/api/health" });
        }
        return new Response(landingPage(env), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      // cloud store — the app's only memory. GET reads the whole profile,
      // POST upserts + trims, DELETE clears one list.
      if (path === "/api/sync/probe" || path === "/api/store/probe") {
        return json(await storeProbe(env, (url.searchParams.get("p") || "").trim()));
      }
      if (path === "/api/sync" || path === "/api/sync/import") {
        const p = (url.searchParams.get("p") || url.searchParams.get("profile") || "").trim();
        if (request.method === "GET") return json(await syncGet(env, p));
        if (request.method === "DELETE") return json(await syncClear(env, p, url.searchParams.get("kind") || ""));
        if (request.method === "POST") {
          let body = {};
          try {
            body = await request.json();
          } catch {
            return err("body must be JSON", 400);
          }
          if (path === "/api/sync/import") return json(await syncImport(env, p, body));
          return json(await syncWrite(env, p, body));
        }
        return err("method not allowed", 405);
      }
      if (path === "/api/media" || path === "/api/thumb") {
        return media(url.searchParams.get("u") || "", request, env);
      }
      // pretty direct-file endpoints: /mp4/<id>.mp4 and /api/file/<id>.mp4
      const mp4 = path.match(/^\/(?:api\/)?(?:file|mp4)\/([A-Za-z0-9_-]{6,15})\.mp4$/);
      if (mp4) return directMp4(mp4[1], request, env);
      // stable stream URL: never carries a signature, re-resolves on every request.
      // <video src="/api/stream?id=…&itag=18"> keeps working even after a URL expires.
      if (path === "/api/stream") {
        const id = url.searchParams.get("id") || "";
        if (!id) return err("id required (or use /mp4/<id>.mp4)", 400);
        return directMp4(id, request, env);
      }
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
  comments,
  normalizeComments,
  // new: version discovery + cookies
  parseYtdlpVersions,
  discoverVersions,
  buildClients,
  CLIENT_SPECS,
  FALLBACK_VERSIONS,
  parseCookies,
  parseCookiesDetailed,
  cookieReport,
  ytCookieRaw,
  sapisidHash,
  sha1Hex,
  keyAllowed,
  cookieAuth,
  fetchRetry,
  breakerSnapshot,
  resetBreakers,
  ytGateInfo,
  mirrorSnapshot,
  playerCacheGet,
  playerCachePut,
  playerCacheStats,
  resetPlayerCache,
  winnerClient,
  YT_GATE,
  noteFail,
  noteOk,
  storeProbe,
  breakerCooling,
  emergencyMirrors,
  mirrorStream,
  refreshedUrl,
  directMp4,
  media,
  CLIENT_STATS,
  consentCookies,
  parseFeed,
  rss,
  resolveChannel,
  shorts,
  canary,
  REASONS,
  classifyFailure,
  getPoToken,
  DEFAULT_MIRRORS,
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
  CAPS,
  validProfileKey,
  canonicalKind,
  opsToStatements,
  libsqlBase,
  normalizeLibsqlUrl,
  libsqlInfo,
  libsqlToken,
  decodeJwtInfo,
  jwtVerdict,
  jwtDbMatch,
  libsqlPipeline,
  syncGet,
  syncWrite,
  syncImport,
  syncClear,
  storeConfigured,
  parseShorts,
  shortFromReel,
  shortFromLockup,
  makeShort,
  SHORT_MAX_SEC,
};
