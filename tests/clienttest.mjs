/**
 * v7.9 client IQ — the request has to look like a real YouTube client, and the
 * ladder has to use every client whose version we already discover.
 *
 * Everything here is checked against the actual outgoing request: headers,
 * cookies, body, and which clients get tried in which pass.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_client_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

const VID = "dQw4w9WgXcQ";
const PLAYER_JS = `var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()}};XY=function(a){a=a.split("");ABC.rv(a);return a.join("")};NX=function(a){a=a.split("");ABC.rz(a,1);return a.join("")};\nc&&d.set("signature",XY(decodeURIComponent(e)));if(f){var g;(g=a.get("n"))&&(g=NX(g),a.set("n",g))}`;
const okPlayer = JSON.stringify({
  playabilityStatus: { status: "OK" },
  streamingData: { formats: [{ itag: 18, mimeType: 'video/mp4; codecs="avc1"', qualityLabel: "360p", contentLength: "1000", url: "https://rr1---sn-x.googlevideo.com/videoplayback?expire=9999999999&itag=18" }] },
  videoDetails: { videoId: VID, title: "T", author: "A", lengthSeconds: "10", viewCount: "5" },
});

let requests = [];
let mode = "ok";          // ok | bot
let env = {};

globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VIS_fixed_123"};</script>', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '21.26.364',\n'clientName': 'VISIONOS',\n'clientVersion': '1.02',\n'clientName': 'WEB_CREATOR',\n'clientVersion': '1.20260708.06.00',", { status: 200 });
  if (u.includes("/youtubei/v1/player")) {
    const h = new Headers(opts.headers || {});
    const body = JSON.parse(opts.body || "{}");
    requests.push({ headers: h, body, client: body?.context?.client?.clientName });
    if (mode === "bot") {
      return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }), { status: 200 });
    }
    return new Response(okPlayer, { status: 200 });
  }
  if (u.includes("/youtubei/v1/")) return new Response(JSON.stringify({ contents: {} }), { status: 200 });
  return new Response("", { status: 404 });
};

const reset = () => { requests = []; };

/* ── 1. headers look like a real client ──────────────────────────────────── */
reset(); mode = "ok";
const p1 = await W.player(VID, { env: {} });
check("playback still works", p1.ok === true && p1.formats.length === 1, JSON.stringify(p1).slice(0, 100));
const r1 = requests[0];
check("visitor id is sent as a header", !!r1.headers.get("x-goog-visitor-id"), [...r1.headers.keys()].join(","));
check("header visitor id matches the body", r1.headers.get("x-goog-visitor-id") === r1.body.context.client.visitorData, r1.headers.get("x-goog-visitor-id") + " vs " + r1.body.context.client.visitorData);
check("referer is the watch page", r1.headers.get("referer") === "https://www.youtube.com/watch?v=" + VID, r1.headers.get("referer"));
check("x-origin is sent", r1.headers.get("x-origin") === "https://www.youtube.com");
check("playbackContext is present", r1.body.playbackContext?.contentPlaybackContext?.html5Preference === "HTML5_PREF_WANTS", JSON.stringify(r1.body.playbackContext || {}));
check("content/racy check flags stay", r1.body.contentCheckOk === true && r1.body.racyCheckOk === true);
check("client name/version headers match the body", r1.headers.get("x-youtube-client-version") === r1.body.context.client.clientVersion);

/* ── 2. consent cookies by default (no account needed) ───────────────────── */
check("signed-out requests carry the consent cookies", /SOCS=CAI/.test(r1.headers.get("cookie") || "") && /CONSENT=YES/.test(r1.headers.get("cookie") || ""), r1.headers.get("cookie"));
check("consentCookies() reports the default", /SOCS=CAI/.test(W.consentCookies({})));
check("CONSENT=off disables them", W.consentCookies({ CONSENT: "off" }) === "");
reset();
await W.player(VID, { env: { CONSENT: "off" } });
check("CONSENT=off really removes the cookie header", !/SOCS=/.test(requests[0].headers.get("cookie") || ""), requests[0].headers.get("cookie"));

/* ── 3. account cookies replace the defaults, they do not stack ──────────── */
reset(); mode = "bot";
await W.player(VID, { env: {}, cookieHeader: "SID=abc; HSID=def; SSID=ghi; SAPISID=xyz" });
const authReq = requests.find((r) => /SID=abc/.test(r.headers.get("cookie") || ""));
check("a bot-check escalates to the cookie pass", !!authReq, requests.map((r) => r.client).join(","));
check("user cookies are used", !!authReq && /SID=abc/.test(authReq.headers.get("cookie")));
check("consent cookies are not glued onto the account cookies", !!authReq && !/SOCS=/.test(authReq.headers.get("cookie") || ""), authReq && authReq.headers.get("cookie"));
check("SAPISIDHASH authorization is attached", !!authReq && /^SAPISIDHASH /.test(authReq.headers.get("authorization") || ""), authReq && authReq.headers.get("authorization"));

/* ── 4. every client whose version we discover is actually used ──────────── */
reset(); mode = "bot";
await W.player(VID, { env: {} });
const tried = new Set(requests.map((r) => r.client));
check("visionOS client is in the ladder", tried.has("VISIONOS"), [...tried].join(","));
check("anonymous ladder never wastes a call on Studio", !tried.has("WEB_CREATOR"));

reset();
await W.player(VID, { env: {}, cookieHeader: "SID=abc; HSID=def; SSID=ghi; SAPISID=xyz" });
const triedAuth = new Set(requests.map((r) => r.client));
check("with cookies the Studio client is tried", triedAuth.has("WEB_CREATOR"), [...triedAuth].join(","));

/* ── 5. pass 3 (self-heal) keeps the cookies ─────────────────────────────── */
reset();
const p3 = await W.player(VID, { env: {}, cookieHeader: "SID=abc; HSID=def; SSID=ghi; SAPISID=xyz" });
check("a fully blocked ladder still reports a bot-check", p3.ok === false && p3.reason === "bot", JSON.stringify({ ok: p3.ok, r: p3.reason }));
const retryCalls = requests.filter((r) => /SID=abc/.test(r.headers.get("cookie") || ""));
check("self-heal pass carries cookies too", retryCalls.length > 1, retryCalls.length);
check("auth+ pass is labelled differently", (p3.attempts || []).some((a) => /\(auth\+\)/.test(a)), (p3.attempts || []).slice(-3).join(" | "));

/* ── 6. the scoreboard knows who delivers ────────────────────────────────── */
reset(); mode = "ok";
for (const k of Object.keys(W.CLIENT_STATS)) delete W.CLIENT_STATS[k];
const good = await W.player(VID, { env: {} });
await W.player(VID, { env: { CONSENT: "off" } });
check("a success is counted", W.CLIENT_STATS[good.client] && W.CLIENT_STATS[good.client].ok >= 1, JSON.stringify(W.CLIENT_STATS));
reset(); mode = "bot";
for (const k of Object.keys(W.CLIENT_STATS)) delete W.CLIENT_STATS[k];
await W.player(VID, { env: {} });
check("a bot-check is counted as bot", Object.values(W.CLIENT_STATS).some((r) => r.bot >= 1), JSON.stringify(W.CLIENT_STATS).slice(0, 120));
check("failures are counted too", Object.values(W.CLIENT_STATS).some((r) => r.fail >= 1));

/* ── 7. /api/debug exposes the scoreboard + what we send ─────────────────── */
const dbg = await (await W.default.fetch(new Request("https://w.example/api/debug"), {})).json();
check("debug exposes clientStats", !!dbg.clientStats && typeof dbg.clientStats === "object");
check("debug lists the new clients", dbg.ladder.some((c) => c.id === "visionos") && dbg.ladder.some((c) => c.id === "web_creator"));
check("debug marks Studio as account-only", dbg.ladder.find((c) => c.id === "web_creator").needsAuth === true);
check("debug documents the headers we send", /x-goog-visitor-id/.test(dbg.headers.visitorId) && /watch\?v=/.test(dbg.headers.referer));
check("debug reports the consent cookies", /SOCS=CAI/.test(dbg.headers.consentCookies));

/* ── 8. anonymous never leaks cookies onto clients that refuse them ──────── */
reset(); mode = "ok";
await W.player(VID, { env: {} });
check("no SID on anonymous calls", requests.every((r) => !/SID=/.test(r.headers.get("cookie") || "")));

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.log("FAIL  " + c.n + (c.e !== undefined ? "   → " + c.e : ""));
console.log(`\n${checks.length - failed.length}/${checks.length} client-IQ checks passed`);
process.exit(failed.length ? 1 : 0);
