/**
 * v9.0 — "CF ki alag alag IP se request jaye, ek hi IP se nahi".
 * Cloudflare khud egress IP nahi chunne deta, isliye ek relay pool add kiya:
 *   1. InnerTube calls pool ke through rotate hoti hain (round-robin)
 *   2. relay mar jaye to park + direct fallback (app band nahi hoti)
 *   3. video bytes kabhi relay se nahi jaate (bandwidth)
 *   4. /api/egress batata hai ki kaun sa relay zinda hai
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_egress_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

const VID = "egressVid01";
const PLAYER_JS = `var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()}};XY=function(a){a=a.split("");ABC.rv(a);return a.join("")};`;
const hits = { relayA: 0, relayB: 0, direct: 0, media: 0 };
let relayAMode = "ok";    // ok | 500 | auth

globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://relay-a.example/")) {
    hits.relayA += 1;
    if (relayAMode === "500") return new Response("relay down", { status: 500 });
    if (relayAMode === "auth") return new Response("pay up", { status: 402 });
    // relay passes the inner target through verbatim in real life; here we just
    // answer with the same payload the origin would
    return origin(u);
  }
  if (u.startsWith("https://relay-b.example/")) { hits.relayB += 1; return origin(u); }
  if (u.includes("googlevideo.com")) { hits.media += 1; return new Response("BYTES", { status: 206, headers: { "content-range": "bytes 0-4/10", "content-type": "video/mp4" } }); }
  hits.direct += 1;
  return origin(u);
};

const origin = async (u) => {
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.includes("youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VISEGRESS"};</script>', { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response("'clientName': 'ANDROID',\n'clientVersion': '21.26.364',", { status: 200 });
  if (u.includes("/youtubei/v1/player"))
    return new Response(JSON.stringify({
      playabilityStatus: { status: "OK" },
      streamingData: { formats: [{ itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&expire=" + (Math.floor(Date.now() / 1000) + 3600), qualityLabel: "360p", height: 360, mimeType: "video/mp4" }] },
      videoDetails: { videoId: VID, title: "T", author: "A", lengthSeconds: "60", viewCount: "9" },
    }), { status: 200 });
  if (u.includes("/youtubei/")) return new Response("{}", { status: 200 });
  return new Response("ok", { status: 200 });
};

const reset = () => { Object.keys(hits).forEach((k) => (hits[k] = 0)); W.resetBreakers(); };
const POOL = { MIRRORS: "off", PROXY_URLS: "https://relay-a.example/fetch?url={url},https://relay-b.example/?u=" };

/* 1. pool parsing + url building */
check("both templates are parsed", W.proxyList(POOL).length === 2, W.proxyList(POOL).join(","));
check("{url} template encodes the target", W.proxyList(POOL)[0].includes("{url}"));
check("empty env = direct mode", W.proxyList({}).length === 0);

/* 2. requests rotate through the pool */
reset();
await W.player(VID, { env: POOL, noCache: true });
check("innerTube call went through a relay", hits.relayA + hits.relayB >= 1, JSON.stringify(hits));
check("version discovery also goes through the pool", hits.direct <= 1, "direct " + hits.direct);

reset();
await W.player("egressVid02", { env: POOL, noCache: true });
await W.player("egressVid03", { env: POOL, noCache: true });
check("rotation uses more than one relay", hits.relayA > 0 && hits.relayB > 0, JSON.stringify(hits));

/* 3. video bytes never go through a relay */
reset();
await W.default.fetch(new Request("https://w.dev/api/media?u=" + encodeURIComponent("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18")), POOL);
check("video bytes skip the relay (bandwidth)", hits.media >= 1 && hits.relayA + hits.relayB === 0, JSON.stringify(hits));

/* 4. a dead relay is parked and the healthy one takes over */
reset();
W.resetBreakers();
relayAMode = "500";
await W.player("egressVid04", { env: POOL, noCache: true });
const snap = W.proxySnapshot(POOL);
check("the dead relay is parked", snap.some((p) => p.host === "relay-a.example" && p.cooling > 0), JSON.stringify(snap));
check("the healthy relay still served", hits.relayB >= 1, JSON.stringify(hits));
check("a parked relay is skipped next time", await (async () => {
  const before = hits.relayA;
  await W.player("egressVid05", { env: POOL, noCache: true });
  return hits.relayA === before;
})());

/* 5. whole pool dead → direct, app still plays */
reset();
W.resetBreakers();
relayAMode = "auth";
const allDead = { MIRRORS: "off", PROXY_URLS: "https://relay-a.example/fetch?url={url}" };
const directPlay = await W.player("egressVid06", { env: allDead, noCache: true });
check("with the pool down we go direct", hits.direct >= 1, hits.direct);
check("and the video still resolves", directPlay.ok === true && (directPlay.formats || []).length > 0, JSON.stringify({ ok: directPlay.ok }));
relayAMode = "ok";

/* 6. /api/egress reports the truth */
reset();
const eg = await (await W.default.fetch(new Request("https://w.dev/api/egress"), POOL)).json();
check("egress route answers", eg.ok === true && eg.pool === 2, JSON.stringify({ p: eg.pool }));
check("it explains the rotation", /relay|rotate/i.test(eg.hint), eg.hint.slice(0, 60));
const egDirect = await (await W.default.fetch(new Request("https://w.dev/api/egress"), {})).json();
check("no pool → direct mode is stated", egDirect.mode.includes("direct"), egDirect.mode);
const egTest = await (await W.default.fetch(new Request("https://w.dev/api/egress?test=1"), POOL)).json();
check("?test=1 actually pokes each relay", egTest.proxies.every((p) => p.ok === true && p.status === 200), JSON.stringify(egTest.proxies));

/* 7. health shows the pool */
const health = await (await W.default.fetch(new Request("https://w.dev/api/health"), POOL)).json();
check("health reports the egress pool", health.resilience.egress.pool === 2, JSON.stringify(health.resilience.egress));

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} egress-pool checks passed`);
process.exit(failed.length ? 1 : 0);
