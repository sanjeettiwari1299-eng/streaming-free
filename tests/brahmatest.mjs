import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_brahma_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });
const store = new Map();
globalThis.caches = {
  default: {
    async match(r) { const v = store.get(r.url); return v === undefined ? undefined : new Response(v); },
    async put(r, res) { store.set(r.url, await res.text()); },
  },
};

/* ── mock YouTube ─────────────────────────────────────────────────────────── */
const PLAYER_JS = `var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()}};XY=function(a){a=a.split("");ABC.rv(a);return a.join("")};NX=function(a){a=a.split("");ABC.rz(a,1);return a.join("")};\nc&&d.set("signature",XY(decodeURIComponent(e)));if(f){var g;(g=a.get("n"))&&(g=NX(g),a.set("n",g))}`;
const SEARCH = JSON.stringify({ contents: { a: [{ videoRenderer: { videoId: "trend00001", title: { simpleText: "Trend one" }, lengthText: { simpleText: "4:00" }, viewCountText: { simpleText: "1M views" }, ownerText: { runs: [{ text: "C1" }] } } }, { videoRenderer: { videoId: "trend00002", title: { simpleText: "Trend two" }, lengthText: { simpleText: "6:00" } } }] } });

let mode = { player: "ok", playability: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" };
let posts = [];
let providerCalls = 0;
let mirrorCalls = 0;
let mirrorMode = "ok";

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VIS1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '19.50.1',", { status: 200 });

  if (u.includes("/youtubei/v1/player")) {
    posts.push({ client: body?.context?.client?.clientName, visitorData: body?.context?.client?.visitorData, poToken: body?.serviceIntegrityDimensions?.poToken, cookies: (opts.headers || {}).cookie || "" });
    const hasCookie = /SID=/.test((opts.headers || {}).cookie || "");
    if (mode.player === "auth-only" && !hasCookie) {
      return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }), { status: 200 });
    }
    if (mode.player === "ok" || mode.player === "auth-only") {
      return new Response(JSON.stringify({
        playabilityStatus: { status: "OK" },
        videoDetails: { title: "Working Video", author: "Chan", channelId: "UC1", viewCount: "1000", lengthSeconds: "120", thumbnail: { thumbnails: [] } },
        assets: { js: "https://www.youtube.com/s/player/z/player_ias.vflset/en_US/base.js" },
        streamingData: { formats: [{ itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18", qualityLabel: "360p", height: 360, mimeType: "video/mp4" }], adaptiveFormats: [] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ playabilityStatus: { status: mode.playability, reason: mode.reason } }), { status: 200 });
  }
  if (u.includes("/youtubei/v1/browse") || u.includes("/youtubei/v1/search") || u.includes("/youtubei/v1/next"))
    return new Response(SEARCH, { status: 200 });

  if (u.includes("potoken") || u.includes("bgutil")) {
    providerCalls += 1;
    return new Response(JSON.stringify({ poToken: "PROV_TOKEN", visitorData: "PROV_VISITOR" }), { status: 200 });
  }
  if (/\/api\/v1\/videos\//.test(u)) {
    mirrorCalls += 1;
    if (mirrorMode === "fail") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({
      title: "Mirror Video", author: "MirrorChan", authorId: "UCm", viewCount: 5, lengthSeconds: 60,
      formatStreams: [{ url: "/videoplayback?itag=18", resolution: "360p", type: "video/mp4", itag: "18" }],
    }), { status: 200 });
  }
  throw new Error("unexpected " + u);
};

const env = () => ({ MIRRORS: "off" });

/* ── 1. classification table ──────────────────────────────────────────────── */
check("bot-check classified", W.classifyFailure("LOGIN_REQUIRED", "Sign in to confirm you're not a bot") === "bot");
check("plain login classified", W.classifyFailure("LOGIN_REQUIRED", "This video is private") === "login");
check("age classified", W.classifyFailure("AGE_VERIFICATION_REQUIRED", "") === "age");
check("region classified", W.classifyFailure("UNPLAYABLE", "The uploader has not made this video available in your country") === "region");
check("members-only classified", W.classifyFailure("UNPLAYABLE", "Join this channel to get access") === "login");
check("removed classified", W.classifyFailure("UNPLAYABLE", "This video has been removed by the uploader") === "unavailable");
check("no-longer-supported classified", W.classifyFailure("ERROR", "YouTube is no longer supported in this application or device") === "unavailable");
check("unknown fallback", W.classifyFailure("WHATEVER", "something odd") === "unknown");
check("every reason has a label + hint", ["bot", "login", "age", "region", "live", "unavailable", "unknown"].every((k) => W.REASONS[k] && W.REASONS[k].label && W.REASONS[k].hint !== undefined), JSON.stringify(Object.keys(W.REASONS)));

/* ── 2. bot-check escalates early instead of burning the ladder ───────────── */
mode = { player: "fail", playability: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" };
posts = [];
W.resetBreakers();
const botFail = await W.player("gatedVid001", { env: env() });
check("bot-check failure is reported as a reason", botFail.ok === false && botFail.reason === "bot", JSON.stringify({ r: botFail.reason, a: botFail.attempts?.length }));
check("failure carries a human label + hint", /bot-check/i.test(botFail.reasonLabel) && /cookie|PoToken/i.test(botFail.hint), botFail.reasonLabel + " | " + botFail.hint);
check("needAuth is set so the UI can offer cookies", botFail.needAuth === true);
check("botCheck flag", botFail.botCheck === true);
check("escalation stops the anonymous ladder early", botFail.attempts.some((a) => /escalating to authenticated pass/.test(a)), botFail.attempts.slice(0, 3).join(" | "));
check("fewer attempts than the full ladder", posts.length <= 6, posts.length);
check("failure counts are grouped", botFail.failures && botFail.failures.bot >= 1, JSON.stringify(botFail.failures));

/* ── 3. cookies unlock the same video (pass 2) ────────────────────────────── */
mode = { player: "auth-only" };   // anonymous blocked, cookies allowed
posts = [];
W.resetBreakers();
const authed = await W.player("gatedVid001", {
  env: { MIRRORS: "off", YT_COOKIES: "SID=abc; HSID=def; SSID=ghi; SAPISID=xyz", SV_KEY: "k1" },
  cookieHeader: "SID=abc; HSID=def; SSID=ghi; SAPISID=xyz",
});
check("cookies path still plays", authed.ok === true && authed.pass === 2 && authed.authed === true, JSON.stringify({ p: authed.pass, a: authed.authed }));
check("auth request really carried cookies", posts.some((p) => /SID=abc/.test(p.cookies)));

/* ── 4. PoToken: static secret is attached to every request ───────────────── */
mode = { player: "ok" };
posts = [];
W.resetBreakers();
const withPt = await W.player("tokVid0001", { env: { MIRRORS: "off", PO_TOKEN: "STATIC_TOKEN_123456789" } });
check("static PoToken is sent", posts.every((p) => p.poToken === "STATIC_TOKEN_123456789"), JSON.stringify(posts.map((p) => p.poToken)));
check("poToken reported in the result", withPt.poToken === true && withPt.poTokenSource === "secret", withPt.poTokenSource);

/* ── 5. PoToken: "visitorData:token" pair form ────────────────────────────── */
posts = [];
W.resetBreakers();
const paired = await W.getPoToken({ PO_TOKEN: "VISITOR_FROM_SECRET:TOKEN_PART_2" }, "ctxVisitor");
check("paired PoToken form splits", paired.poToken === "TOKEN_PART_2" && paired.visitorData === "VISITOR_FROM_SECRET", JSON.stringify(paired));

/* ── 6. PoToken provider (bgutil-compatible) + cache ──────────────────────── */
providerCalls = 0;
posts = [];
W.resetBreakers();
const viaProvider = await W.player("provVid001", { env: { MIRRORS: "off", POTOKEN_URL: "https://potoken.example/api" } });
check("provider token used", posts.some((p) => p.poToken === "PROV_TOKEN"), JSON.stringify(posts.map((p) => p.poToken)));
check("provider visitorData wins", posts.some((p) => p.visitorData === "PROV_VISITOR"), JSON.stringify(posts.map((p) => p.visitorData)));
check("provider source reported", viaProvider.poTokenSource === "provider", viaProvider.poTokenSource);
posts = [];
W.resetBreakers();
await W.player("provVid002", { env: { MIRRORS: "off", POTOKEN_URL: "https://potoken.example/api" } });
check("provider token is cached", providerCalls === 1, providerCalls);
check("cached token still attached", posts.some((p) => p.poToken === "PROV_TOKEN"));

/* ── 7. mirrors: defaults, opt-out, custom, and pass 4 ────────────────────── */
check("default mirrors exist", W.emergencyMirrors({}).length >= 3, W.emergencyMirrors({}).length);
check("MIRRORS=off disables defaults", W.emergencyMirrors({ MIRRORS: "off" }).length === 0);
check("custom mirrors are merged", W.emergencyMirrors({ EMERGENCY_MIRRORS: "https://m1.dev/" }).some((x) => x === "https://m1.dev"));

mode = { player: "fail", playability: "UNPLAYABLE", reason: "This video is unavailable" };
mirrorCalls = 0;
mirrorMode = "ok";
posts = [];
W.resetBreakers();
const viaMirror = await W.player("mirrorVid01", { env: { EMERGENCY_MIRRORS: "https://m1.dev" } });
check("last resort is the mirror extractor", viaMirror.ok === true && viaMirror.pass === 4 && viaMirror.client === "emergency-mirror", JSON.stringify({ ok: viaMirror.ok, pass: viaMirror.pass }));
check("mirror stream is proxied, not raw", /\/api\/media\?u=/.test(viaMirror.formats[0].url), viaMirror.formats[0].url);
check("mirror failures also reported when dead", await (async () => {
  mirrorMode = "fail";
  W.resetBreakers();
  const dead = await W.player("mirrorVid02", { env: { EMERGENCY_MIRRORS: "https://m1.dev" } });
  return dead.ok === false && dead.attempts.some((a) => /mirror https:\/\/m1.dev/.test(a));
})());

/* ── 8. unavailable gets the right label, no auth noise ───────────────────── */
mode = { player: "fail", playability: "UNPLAYABLE", reason: "This video has been removed by the uploader" };
W.resetBreakers();
const gone = await W.player("goneVid0001", { env: { MIRRORS: "off" } });
check("removed video reports 'Unavailable'", gone.reason === "unavailable" && /Unavailable/.test(gone.reasonLabel), gone.reasonLabel);
check("no cookie nag for a removed video", gone.needAuth === false);

/* ── 9. canary reports a pass rate ────────────────────────────────────────── */
mode = { player: "ok" };
W.resetBreakers();
const res = await W.default.fetch(new Request("https://w.dev/api/canary?n=2"), {});
const cbody = await res.json();
check("canary route answers", res.status === 200 && cbody.checked === 2, JSON.stringify({ s: res.status, c: cbody.checked }));
check("canary reports a rate", cbody.rate === "100%" && cbody.passed === 2, cbody.rate);
check("canary lists per-video detail", Array.isArray(cbody.results) && cbody.results.every((r) => r.id && typeof r.ms === "number"));

/* ── 10. player route passes the diagnosis through ────────────────────────── */
mode = { player: "fail", playability: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" };
W.resetBreakers();
const pr = await (await W.default.fetch(new Request("https://w.dev/api/player?id=gatedVid001"), {})).json();
check("player route exposes reason/hint", pr.ok === false && pr.reason === "bot" && !!pr.hint, JSON.stringify({ r: pr.reason }));
const st = await (await W.default.fetch(new Request("https://w.dev/api/selftest?id=gatedVid001"), {})).json();
check("selftest exposes the reason", st.ok === false && st.reason === "bot" && st.needAuth === true, JSON.stringify({ r: st.reason, n: st.needAuth }));

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} resilience checks passed`);
process.exit(failed.length ? 1 : 0);
