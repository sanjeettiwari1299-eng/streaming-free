import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), "worker_smoke.mjs");
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

const PLAYER_JS = `
var ABC={rz:function(a,b){a.splice(0,b)},rv:function(a){a.reverse()},sw:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}};
XY=function(a){a=a.split("");ABC.sw(a,2);ABC.rz(a,1);ABC.rv(a);return a.join("")};
NX=function(a){a=a.split("");ABC.rv(a);ABC.rz(a,1);return a.join("")};
c&&d.set("signature",XY(decodeURIComponent(e)));if(f){var g;(g=a.get("n"))&&(g=NX(g),a.set("n",g))}
`;
const SEARCH = JSON.stringify({ contents: { a: [{ videoRenderer: { videoId: "v1", title: { runs: [{ text: "Hello " }, { text: "World" }] }, ownerText: { runs: [{ text: "Chan" }] }, lengthText: { simpleText: "10:05" }, viewCountText: { simpleText: "1.2M views" }, publishedTimeText: { simpleText: "2 days ago" }, thumbnail: { thumbnails: [{ url: "https://i/x.jpg" }] } } },
  { videoRenderer: { videoId: "v2", title: { simpleText: "Two" }, ownerText: { runs: [{ text: "C2" }] } } },
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOK" } } } }] } });

let mode = { player: "ok" };
let calls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const client = body?.context?.client?.clientName || "";
  calls.push({ u, client });

  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20260999.01.00","VISITOR_DATA":"VIS1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '19.50.1',", { status: 200 });
  if (u.includes("/youtubei/v1/player")) {
    if (mode.player === "fail") return new Response(JSON.stringify({ playabilityStatus: { status: "UNPLAYABLE", reason: "nope" } }), { status: 200 });
    return new Response(JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title: "Test Video", author: "Chan", channelId: "UC1", viewCount: "12345", lengthSeconds: "120", thumbnail: { thumbnails: [] } },
      assets: { js: "https://www.youtube.com/s/player/z/player_ias.vflset/en_US/base.js" },
      streamingData: {
        formats: [
          { itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&n=abc", qualityLabel: "360p", height: 360, mimeType: "video/mp4" },
          { itag: 22, signatureCipher: "s=SIGVAL&sp=sig&url=" + encodeURIComponent("https://rr1---sn-x.googlevideo.com/videoplayback?itag=22&n=abc"), qualityLabel: "720p", height: 720, mimeType: "video/mp4" },
        ],
        adaptiveFormats: [],
      },
    }), { status: 200 });
  }
  if (u.includes("/youtubei/v1/search") || u.includes("/youtubei/v1/browse") || u.includes("/youtubei/v1/next"))
    return new Response(SEARCH, { status: 200 });
  if (u.includes("googlevideo.com")) return new Response("bytes", { status: 206, headers: { "content-range": "bytes 0-4/100", "content-type": "video/mp4" } });
  throw new Error("unexpected " + u);
};

/* decipher + normalizers */
check("durToSec", W.durToSec("1:02:03") === 3723);
check("VIEWS", W.VIEWS("1.2M views") === 1200000);
const list = W.normalizeList(JSON.parse(SEARCH), 10);
check("normalizeList", list.length === 2 && list[0].title === "Hello World" && list[0].lengthSeconds === 605);
const sigFn = W.buildDecipher(PLAYER_JS, "XY");
check("sig decipher built", typeof sigFn === "function");
if (sigFn) {
  const ref = "abcdef".split("");
  const sw = (a, b) => { const c = a[0]; a[0] = a[b % a.length]; a[b % a.length] = c; };
  sw(ref, 2); ref.splice(0, 1); ref.reverse();
  check("sig transform reference", sigFn("abcdef") === ref.join(""), sigFn("abcdef"));
}

/* player happy path */
W.resetBreakers();
const p = await W.player("happyVid001", {});
check("player ok", p.ok === true, JSON.stringify(p.attempts || []).slice(0, 120));
check("formats sorted 720 first", p.formats[0].quality === "720p", p.formats.map((f) => f.quality).join(","));
check("cipher sig applied", /sig=/.test(decodeURIComponent(p.formats[0].url)), decodeURIComponent(p.formats[0].url).slice(-40));
check("n transformed", !/n=abc/.test(decodeURIComponent(p.formats[0].url)));
check("visitorData sent", calls.length > 0);
check("format url has v+itag", /v=happyVid001/.test(p.formats[0].url) && /itag=22/.test(p.formats[0].url), p.formats[0].url);

/* lists */
const s = await W.search("lofi", 1, {}, new URL("https://w.dev/api/search"));
check("search + continuation", s.items.length === 2 && s.continuation === "TOK");
const t = await W.trending("IN", {}, new URL("https://w.dev/api/trending"));
check("trending", t.items.length === 2);

/* resilience */
mode.player = "fail";
W.resetBreakers();
const fail1 = await W.player("failVid", {});
check("all-fail returns structured error", fail1.ok === false && Array.isArray(fail1.attempts), fail1.error);
check("breaker lists failed clients", Array.isArray(fail1.breakers) && fail1.breakers.length > 0, JSON.stringify(fail1.breakers).slice(0, 80));
W.resetBreakers();
mode.player = "ok";

/* media + refresh */
const mediaRes = await W.default.fetch(new Request("https://w.dev/api/media?u=" + encodeURIComponent("https://rr1---sn-x.googlevideo.com/videoplayback?a=1"), { headers: { Range: "bytes=0-4" } }), {});
check("media range passthrough", mediaRes.status === 206 && mediaRes.headers.get("content-range") === "bytes 0-4/100");
const badHost = await W.default.fetch(new Request("https://w.dev/api/media?u=" + encodeURIComponent("https://evil.com/x")), {});
check("media allowlist", badHost.status === 400, badHost.status);

/* routes */
const h = await (await W.default.fetch(new Request("https://w.dev/api/health"), {})).json();
check("health ok + resilience", h.ok === true && !!h.resilience, JSON.stringify(h.resilience || {}).slice(0, 60));
const st = await (await W.default.fetch(new Request("https://w.dev/api/selftest?id=happyVid001"), {})).json();
check("selftest ok", st.ok === true && typeof st.ms === "number", JSON.stringify(st).slice(0, 80));
const mp4 = await W.default.fetch(new Request("https://w.dev/mp4/happyVid001.mp4", { headers: { Range: "bytes=0-4" } }), {});
check("mp4 route", mp4.status === 206 && mp4.headers.get("content-type") === "video/mp4", mp4.status);
const nf = await W.default.fetch(new Request("https://w.dev/nope"), {});
check("404 unknown", nf.status === 404);
const opt = await W.default.fetch(new Request("https://w.dev/api/health", { method: "OPTIONS" }), {});
check("OPTIONS", opt.status === 204);

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} worker smoke checks passed`);
process.exit(failed.length ? 1 : 0);
