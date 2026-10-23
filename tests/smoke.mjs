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
  if (u.includes("/youtubei/v1/search")) {
    if (mode.search === "fail") return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
    return new Response(SEARCH, { status: 200 });
  }
  if (u.includes("/youtubei/v1/browse") || u.includes("/youtubei/v1/next"))
    return new Response(SEARCH, { status: 200 });
  if (u.includes("googlevideo.com")) return new Response("bytes", { status: 206, headers: { "content-range": "bytes 0-4/100", "content-type": "video/mp4" } });
  throw new Error("unexpected " + u);
};

/* decipher + normalizers */
check("durToSec", W.durToSec("1:02:03") === 3723);
check("VIEWS", W.VIEWS("1.2M views") === 1200000);
const list = W.normalizeList(JSON.parse(SEARCH), 10);
check("normalizeList", list.length === 2 && list[0].title === "Hello World" && list[0].lengthSeconds === 605);
/* ── 2026 shapes: lockupViewModel + generic fallback ─────────────────────── */
const LOCKUP = {
  contents: {
    x: [
      {
        lockupViewModel: {
          contentId: "dQw4w9WgXcQ",
          contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
          metadata: {
            lockupMetadataViewModel: {
              title: { content: "Never Gonna Give You Up (Official Video)" },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [
                    {
                      metadataParts: [
                        { text: { content: "Rick Astley", command: { innertubeCommand: { browseEndpoint: { browseId: "UCuAXFkgsw1L7xaCfnd5JJOw" } } } } },
                        { text: { content: "1.6B views" } },
                        { text: { content: "16 years ago" } },
                      ],
                    },
                  ],
                },
              },
            },
          },
          contentImage: {
            thumbnailViewModel: {
              image: { sources: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg", width: 720, height: 404 }, { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", width: 480, height: 360 }] },
              overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "3:33" } }] } }],
            },
          },
          onTap: { innertubeCommand: { watchEndpoint: { videoId: "dQw4w9WgXcQ" } } },
        },
      },
      { lockupViewModel: { contentId: "not-an-id", metadata: { lockupMetadataViewModel: { title: { content: "junk" } } } } },
      { lockupViewModel: { contentId: "abcdefghijk", metadata: { lockupMetadataViewModel: { title: { content: "Second one" } } }, onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: "abcdefghijk" } } } } },
    ],
  },
};

const lockItems = W.normalizeList(LOCKUP, 10);
check("parses lockupViewModel", lockItems.length === 2, JSON.stringify(lockItems.map((v) => v.videoId)));
check("lockup title", lockItems[0].title === "Never Gonna Give You Up (Official Video)", lockItems[0].title);
check("lockup author from metadata row", lockItems[0].author === "Rick Astley", lockItems[0].author);
check("lockup authorId from browseEndpoint", lockItems[0].authorId === "UCuAXFkgsw1L7xaCfnd5JJOw", lockItems[0].authorId);
check("lockup views", lockItems[0].viewCount === 1_600_000_000, lockItems[0].viewCount);
check("lockup publishedText", lockItems[0].publishedText === "16 years ago", lockItems[0].publishedText);
check("lockup duration from badge", lockItems[0].lengthSeconds === 213, lockItems[0].lengthSeconds);
check("lockup biggest thumbnail", /hq720/.test(lockItems[0].thumbnail), lockItems[0].thumbnail);
check("lockup drops junk ids", !lockItems.some((v) => v.videoId === "not-an-id"));

const UNKNOWN = { a: [{ weirdNewRenderer: { videoId: "xyz12345678", headline: { content: "Unknown shape video" }, metadataText: { content: "77K views" }, publishedText: { content: "3 days ago" }, thumbnail: { thumbnails: [{ url: "https://i/u.jpg", width: 320, height: 180 }] } } }] };
const genItems = W.normalizeList(UNKNOWN, 10);
check("generic fallback finds unknown renderers", genItems.length === 1 && genItems[0].videoId === "xyz12345678", JSON.stringify(genItems));
check("generic fallback keeps title", genItems[0].title === "Unknown shape video", genItems[0] && genItems[0].title);
check("generic fallback keeps views", genItems[0].viewCount === 77000, genItems[0] && genItems[0].viewCount);
check("generic fallback keeps thumbnail", /i\/u\.jpg/.test(genItems[0].thumbnail), genItems[0] && genItems[0].thumbnail);
check("no duplicates across shapes", W.normalizeList({ x: [{ videoRenderer: { videoId: "sameVid1234", title: { simpleText: "A" } } }, { lockupViewModel: { contentId: "sameVid1234", metadata: { lockupMetadataViewModel: { title: { content: "A dup" } } } } }] }, 10).length === 1);

const hist = W.rendererHistogram(LOCKUP);
check("renderer histogram", hist.some((h) => h.name === "lockupViewModel" && h.count === 3), JSON.stringify(hist).slice(0, 80));

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
/* a warm breaker must not blank a primary list call: self-heal round bypasses cooldowns */
W.resetBreakers();
mode.search = "fail";
const h1 = await W.default.fetch(new Request("https://w.dev/api/health"), {});
await W.default.fetch(new Request("https://w.dev/api/search?q=breaker"), {}).catch(() => {});
const cooling = W.breakerSnapshot();
check("failed list call trips breakers", cooling.length > 0, JSON.stringify(cooling).slice(0, 80));
mode.search = "ok";
const recovered = await (await W.default.fetch(new Request("https://w.dev/api/search?q=hello"), {})).json();
check("self-heal bypasses breaker cooldown", (recovered.items || []).length > 0, JSON.stringify(recovered).slice(0, 90));
W.resetBreakers();

const nf = await W.default.fetch(new Request("https://w.dev/nope"), {});
check("404 unknown", nf.status === 404);
const nfBody = await nf.json();
check("404 explains itself", nfBody.detail && Array.isArray(nfBody.detail.routes) && nfBody.detail.routes.includes("/api/rss?channels=UC..,UC.."), JSON.stringify(nfBody.detail || {}).slice(0, 90));
check("404 includes path + hint", nfBody.detail.path === "/nope" && !!nfBody.detail.hint);

/* root = status page, not a 404 */
const root = await W.default.fetch(new Request("https://w.dev/"), {});
const rootHtml = await root.text();
check("root serves status page", root.status === 200 && /StreamVoid worker is running/.test(rootHtml), root.status);
check("root page lists every route", W.ROUTE_LIST.every((r) => rootHtml.includes(r)), W.ROUTE_LIST.filter((r) => !rootHtml.includes(r)).join(" | "));
check("root page shows health link", rootHtml.includes('href="/api/health"'));
const rootJson = await W.default.fetch(new Request("https://w.dev/?format=json"), {});
const rootJsonBody = await rootJson.json();
check("root ?format=json", rootJsonBody.ok === true && rootJsonBody.routes.length === W.ROUTE_LIST.length);
const rootSlash = await W.default.fetch(new Request("https://w.dev/api/health/"), {});
check("trailing slash tolerated", rootSlash.status === 200, rootSlash.status);
const fav = await W.default.fetch(new Request("https://w.dev/favicon.ico"), {});
check("favicon 204", fav.status === 204, fav.status);
const opt = await W.default.fetch(new Request("https://w.dev/api/health", { method: "OPTIONS" }), {});
check("OPTIONS", opt.status === 204);

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} worker smoke checks passed`);
process.exit(failed.length ? 1 : 0);
