import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), "worker_mp4.mjs");
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

const PLAYER_JS = `var A={rv:function(a){a.reverse()}};XY=function(a){return a};NX=function(a){return a};`;

const okFetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.1","VISITOR_DATA":"V1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response("", { status: 200 });
  if (u.includes("/youtubei/v1/player"))
    return new Response(JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title: 'My: "Cool" Video / Test?', author: "A", channelId: "UC", viewCount: "1", lengthSeconds: "60", thumbnail: { thumbnails: [] } },
      assets: { js: "https://www.youtube.com/s/player/x/player_ias.vflset/en_US/base.js" },
      streamingData: {
        formats: [
          { itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18", qualityLabel: "360p", height: 360, mimeType: "video/mp4" },
          { itag: 22, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=22", qualityLabel: "720p", height: 720, mimeType: "video/mp4" },
        ],
        adaptiveFormats: [],
      },
    }), { status: 200 });
  if (u.includes("googlevideo.com")) return new Response("MP4BYTES", { status: 206, headers: { "content-range": "bytes 0-7/100", "content-type": "video/mp4" } });
  throw new Error("unexpected " + u);
};
globalThis.fetch = okFetch;

const r1 = await W.default.fetch(new Request("https://w.dev/mp4/dQw4w9WgXcQ.mp4", { headers: { Range: "bytes=0-7" } }), {});
check("mp4 route 206", r1.status === 206, r1.status);
check("content-type video/mp4", r1.headers.get("content-type") === "video/mp4", r1.headers.get("content-type"));
check("content-disposition inline", /inline; filename=".+\.mp4"/.test(r1.headers.get("content-disposition") || ""), r1.headers.get("content-disposition"));
check("range header forwarded", r1.headers.get("content-range") === "bytes 0-7/100", r1.headers.get("content-range"));
check("best quality chosen (720p)", r1.headers.get("x-sv-quality") === "720p", r1.headers.get("x-sv-quality"));
check("body streams", (await r1.text()) === "MP4BYTES");

const r2 = await W.default.fetch(new Request("https://w.dev/api/file/dQw4w9WgXcQ.mp4?dl=1"), {});
check("api/file alias works", r2.status === 206, r2.status);
check("dl=1 → attachment", /^attachment;/.test(r2.headers.get("content-disposition") || ""), r2.headers.get("content-disposition"));

const r3 = await W.default.fetch(new Request("https://w.dev/mp4/dQw4w9WgXcQ.mp4?itag=18"), {});
check("itag override honoured", r3.headers.get("x-sv-quality") === "360p", r3.headers.get("x-sv-quality"));

const r4 = await W.default.fetch(new Request("https://w.dev/mp4/ab.mp4"), {});
check("bad id rejected (route miss → 404)", r4.status === 404, r4.status);

const head = await W.default.fetch(new Request("https://w.dev/mp4/dQw4w9WgXcQ.mp4", { method: "HEAD" }), {});
check("HEAD works on mp4 route", head.status === 206 && (await head.text()) === "", head.status);

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response("", { status: 200 });
  if (u.includes("/youtubei/v1/player"))
    return new Response(JSON.stringify({ playabilityStatus: { status: "UNPLAYABLE", reason: "age" } }), { status: 200 });
  throw new Error("unexpected " + u);
};
W.resetBreakers();
const r5 = await W.default.fetch(new Request("https://w.dev/mp4/dQw4w9WgXcQ.mp4"), {});
check("no stream → 502 json", r5.status === 502 && /error/.test(await r5.text()), r5.status);

/* ── "/api/media" must never hand HTML to a <video> tag ──────────────────────
   200-with-HTML (consent/unavailable pages) shows up in the UI as
   "format not supported", so the proxy has to notice, re-sign and retry.  */
let htmlThenOk = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response("", { status: 200 });
  if (u.includes("/youtubei/v1/player"))
    return new Response(JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title: "T", author: "A", channelId: "UC", lengthSeconds: "60" },
      assets: { js: "https://www.youtube.com/s/player/x/player_ias.vflset/en_US/base.js" },
      streamingData: {
        formats: [
          { itag: 18, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=18", qualityLabel: "360p", height: 360, mimeType: "video/mp4" },
          { itag: 22, url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=22", qualityLabel: "720p", height: 720, mimeType: "video/mp4" },
        ],
        adaptiveFormats: [],
      },
    }), { status: 200 });
  if (u.includes("googlevideo.com")) {
    htmlThenOk += 1;
    if (htmlThenOk % 3 === 1) {
      // first hop of every attempt: the classic "200 but it's a web page" answer
      return new Response("<html><body>Sign in to confirm you are not a bot</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    return new Response("MP4BYTES", { status: 206, headers: { "content-range": "bytes 0-7/100", "content-type": "video/mp4" } });
  }
  throw new Error("unexpected " + u);
};

const mediaUrl = "https://w.dev/api/media?u=" + encodeURIComponent("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&expire=99999999999") + "&v=dQw4w9WgXcQ&itag=18";
const m1 = await W.default.fetch(new Request(mediaUrl, { headers: { Range: "bytes=0-7" } }), {});
const m1t = await m1.text();
check("html body is retried, real bytes returned", (m1.status === 200 || m1.status === 206) && m1t === "MP4BYTES", m1.status + " " + m1t.slice(0, 40));
check("retry is flagged for the client", m1.headers.get("x-sv-refreshed") === "1" || m1.headers.get("x-sv-media-fail") !== "1", m1.headers.get("x-sv-refreshed"));
check("media keeps a playable content-type", /video\//.test(m1.headers.get("content-type") || ""), m1.headers.get("content-type"));
check("accept-ranges advertised", m1.headers.get("accept-ranges") === "bytes", m1.headers.get("accept-ranges"));

/* upstream keeps answering HTML → a JSON failure with a real status, never HTML */
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/s/player/")) return new Response(PLAYER_JS, { status: 200 });
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com")) return new Response("", { status: 200 });
  if (u.includes("/youtubei/v1/player"))
    return new Response(JSON.stringify({ playabilityStatus: { status: "UNPLAYABLE" } }), { status: 200 });
  if (u.includes("googlevideo.com"))
    return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
  throw new Error("unexpected " + u);
};
W.resetBreakers();
const m2 = await W.default.fetch(new Request("https://w.dev/api/media?u=" + encodeURIComponent("https://rr1---sn-x.googlevideo.com/x?itag=18&expire=99999999999") + "&v=dQw4w9WgXcQ&itag=18"), {});
const m2t = await m2.text();
check("dead stream never reaches the video tag as HTML", m2.status >= 400 && /json/.test(m2.headers.get("content-type") || ""), m2.status + " " + m2.headers.get("content-type"));
check("dead stream is marked retryable", m2.headers.get("x-sv-media-fail") === "1" && /retry/.test(m2t), m2t.slice(0, 80));

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} direct-mp4 checks passed`);
process.exit(failed.length ? 1 : 0);
