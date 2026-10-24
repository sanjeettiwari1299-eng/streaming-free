/**
 * v7.10 — the three things the live /api/selftest run exposed:
 *   1. bot-checks must not trip breakers (they are per-video, not per-client)
 *   2. mirrors must be ordered by who actually answers
 *   3. Cloudflare's 50-subrequest cap must be respected, so canary never lies
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_budget_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

const VID = "budgetVid01";
const PLAYER_JS = `var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()}};XY=function(a){a=a.split("");ABC.rv(a);return a.join("")};NX=function(a){a=a.split("");ABC.rz(a,1);return a.join("")};\nc&&d.set("signature",XY(decodeURIComponent(e)));if(f){var g;(g=a.get("n"))&&(g=NX(g),a.set("n",g))}`;
const TRENDING = JSON.stringify({
  contents: {
    a: [
      { videoRenderer: { videoId: "trend00001", title: { simpleText: "A" }, lengthText: { simpleText: "1:00" } } },
      { videoRenderer: { videoId: "trend00002", title: { simpleText: "B" }, lengthText: { simpleText: "1:00" } } },
      { videoRenderer: { videoId: "trend00003", title: { simpleText: "C" }, lengthText: { simpleText: "1:00" } } },
    ],
  },
});

let playerMode = "bot";        // bot | netfail | ok
let mirrorMode = "ok";         // ok | fail
let fetches = 0;

globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
globalThis.fetch = async (url) => {
  const u = String(url);
  fetches++;
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VISBUDGET"};</script>', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '21.26.364',", { status: 200 });
  if (u.includes("/youtubei/v1/player")) {
    if (playerMode === "netfail") throw new Error("ECONNRESET");
    if (playerMode === "bot")
      return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }), { status: 200 });
    return new Response(
      JSON.stringify({
        playabilityStatus: { status: "OK" },
        streamingData: { formats: [{ itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18", qualityLabel: "360p", height: 360, mimeType: "video/mp4" }] },
        videoDetails: { videoId: VID, title: "T", author: "A", lengthSeconds: "60", viewCount: "9" },
      }),
      { status: 200 }
    );
  }
  if (u.includes("/youtubei/v1/")) return new Response(TRENDING, { status: 200 });
  if (u.includes("/api/v1/videos/")) {
    if (mirrorMode === "fail") return new Response("nope", { status: 502 });
    return new Response(
      JSON.stringify({ title: "M", author: "M", lengthSeconds: 60, formatStreams: [{ itag: 18, resolution: "360p", url: "/videoplayback?itag=18" }] }),
      { status: 200 }
    );
  }
  return new Response("", { status: 404 });
};

const ENV = {};   // mirrors enabled by default

/* ── 1. a bot wall must not poison the ladder ────────────────────────────── */
W.resetBreakers();
playerMode = "bot";
mirrorMode = "ok";
const bot = await W.player(VID, { env: ENV });
check("a bot-walled video is rescued by the (un-poisoned) mirror pass", bot.ok === true && bot.pass === 4 && bot.client === "emergency-mirror", JSON.stringify({ ok: bot.ok, pass: bot.pass, c: bot.client }));
check("bot-checks leave every breaker alone", W.breakerSnapshot().length === 0, JSON.stringify(W.breakerSnapshot()).slice(0, 120));
check("the ladder actually ran (not short-circuited by cooling)", (bot.attempts || []).filter((a) => /\(retry\)/.test(a)).length >= 3, (bot.attempts || []).length);

/* ── 2. a broken client+version still cools down ─────────────────────────── */
W.resetBreakers();
playerMode = "netfail";
mirrorMode = "fail";
const net = await W.player(VID, { env: ENV });
check("network failures are still classified", net.ok === false && !!net.reason, net.reason);
check("network failures DO trip breakers", W.breakerSnapshot().length > 0, W.breakerSnapshot().length);
check("breakers carry a cooldown", W.breakerSnapshot().every((b) => b.cooling > 0));

/* ── 3. mirrors are ordered by who answers ───────────────────────────────── */
check("the working mirror is first", W.DEFAULT_MIRRORS[0] === "https://invidious.f5.si", W.DEFAULT_MIRRORS.join(","));
/* 8.7: nadeko serves its own bot-check, nerdvpn answers 401/403, melmac 526 —
   shipping them as defaults was pure 4xx noise, so they are opt-in now */
check("bot-walled mirrors are not defaults", !W.DEFAULT_MIRRORS.some((m) => /nadeko|nerdvpn|melmac/.test(m)), W.DEFAULT_MIRRORS.join(","));
check("default list still has a working host", W.DEFAULT_MIRRORS.length >= 1 && W.DEFAULT_MIRRORS.includes("https://invidious.f5.si"), W.DEFAULT_MIRRORS.join(","));
check("dead hosts can still be added on purpose", W.emergencyMirrors({ EMERGENCY_MIRRORS: "https://inv.nadeko.net" }).includes("https://inv.nadeko.net"));

/* ── 4. the subrequest budget is respected ───────────────────────────────── */
W.resetBreakers();
playerMode = "netfail";
mirrorMode = "fail";
fetches = 0;
const tight = await W.player(VID, { env: ENV, budget: { left: 12 } });
check("a tight budget stops the ladder early", (tight.attempts || []).some((a) => /subrequest budget/.test(a)), (tight.attempts || []).slice(-3).join(" | "));
check("the reserve is never spent by the ladder", tight.budgetLeft >= 0 && tight.budgetLeft <= 8, tight.budgetLeft);
check("a tight budget does not explode the fetch count", fetches <= 20, fetches);

/* ── 5. the mirror pass still runs when the ladder is out of budget ──────── */
W.resetBreakers();
playerMode = "bot";
mirrorMode = "ok";
const saved = await W.player(VID, { env: ENV, budget: { left: 10 } });
check("mirrors still save the video when the ladder is out of budget", saved.ok === true && saved.pass === 4 && saved.client === "emergency-mirror", JSON.stringify({ ok: saved.ok, pass: saved.pass, c: saved.client }));
check("and it is the first mirror that answers", (saved.attempts || []).some((a) => /invidious\.f5\.si: ok/.test(a)), (saved.attempts || []).slice(-2).join(" | "));

/* ── 6. canary is honest about the cap ───────────────────────────────────── */
W.resetBreakers();
playerMode = "ok";
const c1 = await (await W.default.fetch(new Request("https://w.dev/api/canary"), {})).json();
check("canary tests one video by default", c1.checked === 1 && c1.results.length === 1, JSON.stringify({ c: c1.checked, r: c1.results.length }));
check("one-video canary is a real 100%", c1.rate === "100%" && c1.passed === 1, c1.rate);

const c3 = await (await W.default.fetch(new Request("https://w.dev/api/canary?n=3&budget=8"), {})).json();
check("a budget too small for three videos skips instead of failing", c3.skipped >= 1, JSON.stringify({ tested: c3.checked, skipped: c3.skipped }));
check("skipped videos are labelled, not counted as failures", c3.results.filter((r) => r.skipped).every((r) => r.skipped === "subrequest budget" && r.ms === 0));
check("the rate only counts videos that were actually tested", c3.rate === (c3.checked ? Math.round((c3.passed / c3.checked) * 100) + "%" : "n/a"), c3.rate);
check("canary says why some videos were not tested", /subrequest/i.test(c3.note || ""), c3.note);
check("canary reports what budget is left", typeof c3.budgetLeft === "number", c3.budgetLeft);

/* ── 7. a normal canary still measures for real ──────────────────────────── */
W.resetBreakers();
playerMode = "bot";
mirrorMode = "ok";
const c4 = await (await W.default.fetch(new Request("https://w.dev/api/canary?n=1"), {})).json();
check("canary reaches the mirror pass when the ladder is walled", c4.passed === 1 && c4.results[0].pass === 4, JSON.stringify(c4.results[0]));

/* ── 8. health advertises the new scope ──────────────────────────────────── */
const health = await (await W.default.fetch(new Request("https://w.dev/api/health"), {})).json();
check("health explains the breaker scope", /bot-check/i.test(health.resilience.breakerScope || ""), health.resilience.breakerScope);
check("health points at a one-video canary", /n=1/.test(health.resilience.canary), health.resilience.canary);

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.log("FAIL  " + c.n + (c.e !== undefined ? "   → " + c.e : ""));
console.log(`\n${checks.length - failed.length}/${checks.length} budget/breaker checks passed`);
process.exit(failed.length ? 1 : 0);
