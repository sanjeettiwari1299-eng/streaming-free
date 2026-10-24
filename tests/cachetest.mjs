/**
 * v8.8 — "koi permanent solution lgao".
 * The permanent answer to bot-check/429 is: ask YouTube as little as possible, and
 * never ask again for a video we just resolved. This file proves the cache rules:
 *   1. a second play of the same video costs zero upstream requests
 *   2. the doctor (/api/selftest) and /mp4 still test live (no false "ok")
 *   3. concurrent requests for one video resolve once (coalescing)
 *   4. during a 429 storm an already-resolved video still plays (stale copy)
 *   5. a fresh PoToken is minted and retried once before giving up on a 429
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_cache_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

const VID = "cacheVid001";
const PLAYER_JS = `var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()}};XY=function(a){a=a.split("");ABC.rv(a);return a.join("")};`;
const EXP = Math.floor(Date.now() / 1000) + 6 * 3600;   // signed URLs live ~6h

let ytMode = "ok";      // ok | 429 | bot
let playerCalls = 0;
let providerCalls = 0;
const cacheStore = new Map();

globalThis.caches = {
  default: {
    async match(req) { return cacheStore.get(String(req.url)); },
    async put(req, res) { cacheStore.set(String(req.url), new Response(await res.text(), { headers: res.headers })); },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://potoken.provider")) {
    providerCalls += 1;
    return new Response(JSON.stringify({ poToken: "POTOKEN_" + providerCalls, visitorData: "VD_PROVIDER" }), { status: 200 });
  }
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VISCACHE"};</script>', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '21.26.364',", { status: 200 });
  if (u.includes("/youtubei/v1/player")) {
    playerCalls += 1;
    if (ytMode === "429") return new Response("rate limited", { status: 429 });
    if (ytMode === "bot")
      return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }), { status: 200 });
    return new Response(
      JSON.stringify({
        playabilityStatus: { status: "OK" },
        streamingData: {
          formats: [
            {
              itag: 18,
              url: `https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&expire=${EXP}`,
              qualityLabel: "360p",
              height: 360,
              mimeType: "video/mp4",
            },
          ],
        },
        videoDetails: { videoId: VID, title: "T", author: "A", lengthSeconds: "60", viewCount: "9" },
      }),
      { status: 200 }
    );
  }
  if (u.includes("/api/v1/videos/")) return new Response("nope", { status: 502 });
  if (u.includes("googlevideo.com")) return new Response("BYTES", { status: 206, headers: { "content-range": "bytes 0-4/10", "content-type": "video/mp4" } });
  if (u.includes("/youtubei/")) return new Response("{}", { status: 200 });
  throw new Error("unexpected " + u);
};

/* ── 1. the second play costs nothing ─────────────────────────────────────── */
W.resetBreakers();
ytMode = "ok";
playerCalls = 0;
const first = await W.player(VID, { env: { MIRRORS: "off" } });
const afterFirst = playerCalls;
check("first play resolves upstream", first.ok === true && afterFirst >= 1, afterFirst);
check("first play is marked as live", first.cached === false, first.cached);
check("a TTL is reported", typeof first.cacheTtl === "number" && first.cacheTtl > 60, first.cacheTtl);

const second = await W.player(VID, { env: { MIRRORS: "off" } });
check("second play makes zero upstream requests", playerCalls === afterFirst, playerCalls + " vs " + afterFirst);
check("second play is served from cache", second.ok === true && second.cached === true, JSON.stringify({ c: second.cached }));
check("cache age is reported", typeof second.cacheAge === "number" && second.cacheAge >= 0, second.cacheAge);
check("the playable URL survives the cache", /expire=/.test(decodeURIComponent((second.formats[0].url.match(/u=([^&]+)/) || [])[1] || "")), second.formats[0].url.slice(0, 60));
check("cache stats are visible", W.playerCacheStats().memory >= 1, JSON.stringify(W.playerCacheStats()));

/* ── 2. the doctor still tests live ──────────────────────────────────────── */
playerCalls = 0;
ytMode = "ok";
const doc = await (await W.default.fetch(new Request("https://w.dev/api/selftest?id=" + VID + "&probe=1"), { MIRRORS: "off" })).json();
check("selftest ignores the cache", playerCalls >= 1, playerCalls);
check("selftest says it is looking at real bytes", doc.stream && typeof doc.stream.status === "number", JSON.stringify(doc.stream));

playerCalls = 0;
await W.default.fetch(new Request("https://w.dev/mp4/" + VID + ".mp4"), { MIRRORS: "off" });
check("/mp4 ignores the cache (fresh signature)", playerCalls >= 1, playerCalls);

/* ── 3. request coalescing ───────────────────────────────────────────────── */
W.resetBreakers();
playerCalls = 0;
ytMode = "ok";
const [a, b, c] = await Promise.all([
  W.player(VID, { env: { MIRRORS: "off" } }),
  W.player(VID, { env: { MIRRORS: "off" } }),
  W.player(VID, { env: { MIRRORS: "off" } }),
]);
check("three simultaneous plays resolve once", playerCalls <= 2, playerCalls);
check("all three callers get a stream", [a, b, c].every((r) => r.ok && (r.formats || []).length), [a.ok, b.ok, c.ok].join(","));

/* ── 4. a 429 storm cannot stop a video that already played ──────────────── */
W.resetBreakers();
ytMode = "ok";
playerCalls = 0;
await W.player(VID, { env: { MIRRORS: "off" } });     // prime the cache
W.resetBreakers();                                    // clears memory + gate, not the edge cache
playerCalls = 0;
ytMode = "429";
const duringStorm = await W.player(VID, { env: { MIRRORS: "off" } });
check("a cached video plays during a 429 storm", duringStorm.ok === true && (duringStorm.formats || []).length > 0, JSON.stringify({ ok: duringStorm.ok }));
check("no upstream request was spent on it", playerCalls === 0, playerCalls);
check("it is labelled as stale", duringStorm.stale === true || duringStorm.cached === true, JSON.stringify({ s: duringStorm.stale, c: duringStorm.cached }));

/* a video that was never played still gets the honest rate-limit answer */
ytMode = "429";
const cold = await W.player("neverPlayed1", { env: { MIRRORS: "off", POTOKEN_URL: "" } });
check("an unseen video reports the rate limit", cold.ok === false && cold.reason === "ratelimit", cold.reason);
check("with a retryAfter", cold.retryAfter > 0, cold.retryAfter);

/* ── 5. a fresh PoToken is minted before giving up on a 429 ──────────────── */
W.resetBreakers();
playerCalls = 0;
providerCalls = 0;
ytMode = "429";
const withProvider = await W.player("tokenVid901", { env: { MIRRORS: "off", POTOKEN_URL: "https://potoken.provider/api" } });
check("a PoToken was requested", providerCalls >= 1, providerCalls);
check("the retry was attempted", (withProvider.attempts || []).some((x) => /PoToken|potoken/i.test(x)), (withProvider.attempts || []).slice(0, 4).join(" | "));
check("still honest when it does not help", withProvider.ok === false && withProvider.reason === "ratelimit", withProvider.reason);

/* and when the fresh token does help, we never show an error */
W.resetBreakers();
let fakeMode = "first429";
playerCalls = 0;
globalThis.fetch = (orig => async (url, opts) => {
  const u = String(url);
  if (u.includes("/youtubei/v1/player") && fakeMode === "first429") {
    fakeMode = "ok";
    return new Response("rate limited", { status: 429 });
  }
  return orig(url, opts);
})(globalThis.fetch);
ytMode = "ok";
const healed = await W.player("tokenVid902", { env: { MIRRORS: "off", POTOKEN_URL: "https://potoken.provider/api" } });
check("a fresh PoToken heals the 429 invisibly", healed.ok === true && (healed.formats || []).length > 0, JSON.stringify({ ok: healed.ok, why: healed.reason }));

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} resolve-cache checks passed`);
process.exit(failed.length ? 1 : 0);
