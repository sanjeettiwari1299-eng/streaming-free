/**
 * "Video kabhi band na ho" — proxy-level self-healing.
 *
 * Every case here is a stream dying mid-play and the proxy fixing it without
 * the page ever seeing an error: expired signatures, 403/410, 5xx, network
 * blips, and the signature-free /api/stream URL.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_keep_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

const VID = "keepAlive01";
const OLD = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1000000000&itag=18&id=" + VID;
const FRESH = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=9999999999&itag=18&id=" + VID;
const LIVE = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=9999999999&itag=18&id=live";

const PLAN = { media: [], player: [], mirror: [], urls: [] };
const okMedia = (status = 200, body = "VIDEOBYTES") =>
  new Response(body, { status, headers: { "content-type": "video/mp4", "content-length": String(body.length), "accept-ranges": "bytes" } });

// a player response with one fresh format
const PLAYER_JSON = {
  playabilityStatus: { status: "OK" },
  streamingData: {
    formats: [
      { itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E"', qualityLabel: "360p", bitrate: 500000, contentLength: "1200", url: FRESH },
    ],
  },
  videoDetails: { videoId: VID, title: "Keep alive", author: "Test", lengthSeconds: "60", viewCount: "10" },
};

globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  PLAN.urls.push(u);

  // player / potoken / version-discovery endpoints
  if (u.includes("/youtubei/v1/player")) {
    PLAN.player.push(u);
    const step = PLAN.player.length;
    if (PLAN.playerMode === "fail") return new Response(JSON.stringify({ playabilityStatus: { status: "UNPLAYABLE" } }), { status: 200 });
    // the first call in a test that expects a *third* death gets a broken stream
    return new Response(JSON.stringify(PLAN.playerJson || PLAYER_JSON), { status: 200 });
  }
  if (u.includes("/youtubei/v1/")) {
    return new Response(JSON.stringify({ contents: {} }), { status: 200 });
  }
  if (u.includes("/api/v1/videos/")) {
    PLAN.mirror.push(u);
    if (PLAN.mirrorMode === "fail") return new Response("nope", { status: 502 });
    return new Response(
      JSON.stringify({
        title: "Mirror video",
        author: "Mirror chan",
        lengthSeconds: 60,
        formatStreams: [{ itag: 18, resolution: "360p", url: "/videoplayback?expire=9999999999&itag=18" }],
      }),
      { status: 200 }
    );
  }
  if (u.includes("googlevideo.com")) {
    PLAN.media.push(u);
    const n = PLAN.media.length;
    if (PLAN.mediaMode === "always403") return okMedia(403, "");
    if (PLAN.mediaMode === "403once") return n === 1 ? okMedia(403, "") : okMedia(200, "FRESHBODY");
    if (PLAN.mediaMode === "410") return okMedia(410, "");
    if (PLAN.mediaMode === "410once") return n === 1 ? okMedia(410, "") : okMedia(200, "AFTER410");
    if (PLAN.mediaMode === "500") return n <= 2 ? okMedia(500, "") : okMedia(200, "AFTERRETRY");
    if (PLAN.mediaMode === "throw") {
      if (n === 1) throw new Error("ECONNRESET");
      return okMedia(200, "AFTERNET");
    }
    return okMedia(200, "PLAIN");
  }
  return new Response("", { status: 404 });
};

const mediaGet = (q, method = "GET") => {
  const p = new URLSearchParams(q);
  return W.media(p.get("u") || "", new Request("https://worker.example/api/media?" + q, { method }), {});
};

/* ── 1. expired signature is re-signed before the request ─────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "ok";
let r = await mediaGet("u=" + encodeURIComponent(OLD) + "&v=" + VID + "&itag=18");
check("expired URL still serves bytes", r.status === 200, r.status);
check("expiry was detected and swapped", r.headers.get("x-sv-refreshed") === "1", [...r.headers.keys()].join(","));
check("fresh URL was actually used", PLAN.media.some((u) => u.includes("expire=9999999999")), PLAN.media.join(" | "));
check("the old URL was never fetched", !PLAN.media.some((u) => u.includes("expire=1000000000")), PLAN.media.join(" | "));
check("body streams through", (await r.text()) === "PLAIN");

/* ── 2. a healthy URL is not re-signed ───────────────────────────────────── */
PLAN.media = []; PLAN.player = [];
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18");
check("live URL is not re-resolved", PLAN.player.length === 0 && PLAN.media.length === 1, `${PLAN.player.length} player calls`);
check("no refreshed header on a healthy stream", !r.headers.get("x-sv-refreshed"));

/* ── 3. 403 mid-playback → new signature, transparent retry ──────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "403once";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18");
check("403 is healed silently", r.status === 200 && (await r.text()) === "FRESHBODY", r.status);
check("403 triggered exactly one re-resolve", PLAN.player.length === 1, PLAN.player.length);
check("403 retry is flagged", r.headers.get("x-sv-refreshed") === "1");

/* ── 4. 410 gone → same treatment ────────────────────────────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "410once";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18");
check("410 is healed silently", r.status === 200 && (await r.text()) === "AFTER410", r.status);
check("410 re-resolved once", PLAN.player.length === 1, PLAN.player.length);

/* ── 5. upstream 5xx → backoff + retry ───────────────────────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "500";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18");
check("5xx is retried until it works", r.status === 200 && (await r.text()) === "AFTERRETRY", r.status + " after " + PLAN.media.length + " tries");
check("5xx needed more than one attempt", PLAN.media.length >= 2, PLAN.media.length);

/* ── 6. network throw → retry, no user-visible failure ───────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "throw";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18");
check("connect reset is retried", r.status === 200 && (await r.text()) === "AFTERNET", r.status);

/* ── 7. no v= → nothing to re-resolve, honest 403 instead of a hang ──────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "always403";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&itag=18");
check("without a video id the status is honest", r.status === 403, r.status);
check("and we did not call the player blindly", PLAN.player.length === 0);

/* ── 8. HEAD keeps working through the repair path ───────────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "403once";
r = await mediaGet("u=" + encodeURIComponent(LIVE) + "&v=" + VID + "&itag=18", "HEAD");
check("HEAD is healed too", r.status === 200 && r.body === null, r.status);
check("HEAD keeps content-length", r.headers.get("content-length") === "9", r.headers.get("content-length"));

/* ── 9. Range is forwarded, so seeking survives a repair ─────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "403once";
const ranged = new Request("https://worker.example/api/media?u=" + encodeURIComponent(LIVE) + "&v=" + VID, { headers: { range: "bytes=100-199" } });
const seenRanges = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = async (u, o = {}) => {
  if (String(u).includes("googlevideo")) seenRanges.push(new Headers(o.headers).get("range"));
  return baseFetch(u, o);
};
r = await W.media(LIVE, ranged, {});
check("range header is forwarded on the retry", seenRanges.includes("bytes=100-199"), seenRanges.join(","));
globalThis.fetch = baseFetch;

/* ── 10. refreshedUrl falls back to a mirror when InnerTube is blocked ───── */
PLAN.playerMode = "fail"; PLAN.mirrorMode = "ok"; PLAN.player = []; PLAN.mirror = [];
const fromMirror = await W.refreshedUrl(VID, "18", {});
check("mirror hands out a fresh URL when InnerTube fails", /videoplayback/.test(fromMirror), fromMirror);
check("the mirror extractor was called", PLAN.mirror.length >= 1, PLAN.mirror.length);
PLAN.mirrorMode = "fail";
const nothing = await W.refreshedUrl(VID, "18", {});
check("when everything fails it returns empty, not garbage", nothing === "", String(nothing));
PLAN.playerMode = "ok"; PLAN.mirrorMode = "ok";

/* ── 11. /api/stream — the signature-free URL ────────────────────────────── */
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "ok";
const streamRes = await W.default.fetch(new Request(`https://worker.example/api/stream?id=${VID}&itag=18`), {});
check("/api/stream serves the video", streamRes.status === 200, streamRes.status);
check("/api/stream is a real mp4", /video\/mp4/.test(streamRes.headers.get("content-type") || ""), streamRes.headers.get("content-type"));
check("/api/stream reports the quality", !!streamRes.headers.get("x-sv-quality"), streamRes.headers.get("x-sv-quality"));
check("/api/stream resolves per request (that is the point)", PLAN.player.length >= 1);
const badStream = await W.default.fetch(new Request("https://worker.example/api/stream"), {});
check("/api/stream without an id is a clean 400", badStream.status === 400, badStream.status);

// the pretty /mp4 route can heal too: the id comes from the path
PLAN.media = []; PLAN.player = []; PLAN.mediaMode = "ok";
const mp4Res = await W.default.fetch(new Request(`https://worker.example/mp4/${VID}.mp4?itag=18`), {});
check("/mp4/<id>.mp4 resolves and streams", mp4Res.status === 200 && /video\/mp4/.test(mp4Res.headers.get("content-type") || ""), mp4Res.status);
check("/mp4 carries the video id for repairs", !!mp4Res.headers.get("x-sv-video-id"), mp4Res.headers.get("x-sv-video-id"));

/* ── 12. health advertises the guarantees ────────────────────────────────── */
const health = await (await W.default.fetch(new Request("https://worker.example/api/health"), {})).json();
check("health documents the self-heal", !!health.keepPlaying && /expire/i.test(health.keepPlaying.mediaSelfHeal), JSON.stringify(health.keepPlaying || {}).slice(0, 80));
check("health documents retries", /retry/i.test(health.keepPlaying.upstreamRetries));
check("health documents the stable URL", /\/api\/stream/.test(health.keepPlaying.stableUrl));

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.log("FAIL  " + c.n + (c.e !== undefined ? "   → " + c.e : ""));
console.log(`\n${checks.length - failed.length}/${checks.length} keep-playing checks passed`);
process.exit(failed.length ? 1 : 0);
