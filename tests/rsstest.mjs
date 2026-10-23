import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), "worker_rss.mjs");
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

const FEED = (id, name, items) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="alternate" href="https://www.youtube.com/channel/${id}"/>
 <id>yt:channel:${id}</id>
 <yt:channelId>${id}</yt:channelId>
 <title>${name}</title>
 <author><name>${name}</name><uri>https://www.youtube.com/channel/${id}</uri></author>
${items.map((it) => ` <entry>
  <id>yt:video:${it.videoId}</id>
  <yt:videoId>${it.videoId}</yt:videoId>
  <yt:channelId>${id}</yt:channelId>
  <title>${it.title}</title>
  <published>${it.published}</published>
  <author><name>${name}</name></author>
  <media:group>
   <media:title>${it.title}</media:title>
   <media:thumbnail url="https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg" width="480" height="360"/>
   <media:description>${it.desc || ""}</media:description>
   <media:community><media:statistics views="${it.views || 0}"/><media:starRating count="${it.likes || 0}" average="5"/></media:community>
  </media:group>
 </entry>`).join("\n")}
</feed>`;

const UC1 = "UCaaaaaaaaaaaaaaaaaaaaaa";
const UC2 = "UCbbbbbbbbbbbbbbbbbbbbbb";
const UC3 = "UCcccccccccccccccccccccc";

const feeds = {
  [UC1]: FEED(UC1, "Lofi &amp; Chill", [
    { videoId: "vidA0000001", title: "Rainy night mix", published: "2026-10-22T10:00:00+00:00", views: 12345, likes: 99, desc: "chill <b>beats</b>" },
    { videoId: "vidA0000002", title: "Deep focus", published: "2026-10-20T09:00:00+00:00", views: 555 },
  ]),
  [UC2]: FEED(UC2, "Tech Daily", [
    { videoId: "vidB0000001", title: "New phone review", published: "2026-10-23T01:00:00+00:00", views: 999000, likes: 5000 },
  ]),
};

// InnerTube channel "Videos" tab payload (what the worker now uses when the XML feed 404s)
const browsePayload = (id, name, vids) =>
  JSON.stringify({
    metadata: { channelMetadataRenderer: { title: name, avatar: { thumbnails: [{ url: "https://yt3/av-" + id + ".jpg" }] } } },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: vids.map((v) => ({ richItemRenderer: { content: { videoRenderer: {
          videoId: v.videoId,
          title: { simpleText: v.title },
          ownerText: { runs: [{ text: name, navigationEndpoint: { browseEndpoint: { browseId: id } } }] },
          publishedTimeText: { simpleText: v.ago },
          lengthText: { simpleText: v.len || "10:00" },
          viewCountText: { simpleText: v.views || "10K views" },
          thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` }] },
        } } } })) } } } }],
      },
    },
  });

const browseVideos = {
  [UC1]: [{ videoId: "vidA0000003", title: "Browse newest", ago: "2 hours ago", views: "50K views" }],
  [UC2]: [{ videoId: "vidB0000002", title: "Browse tech", ago: "1 day ago" }],
};

let feedMode = "ok"; // "ok" | "dead" (YouTube retired it)
let browseMode = "ok";

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/channel_id=(UC[\w-]+)/);
  if (u.includes("/feeds/videos.xml")) {
    if (feedMode === "dead") return new Response("404 page", { status: 404 });
    const f = m && feeds[m[1]];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(f, { status: 200 });
  }
  if (u.includes("/youtubei/v1/")) {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const id = body.browseId;
    if (u.includes("/youtubei/v1/browse") && id) {
      if (browseMode === "fail") return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
      const vids = browseVideos[id];
      if (!vids) return new Response(JSON.stringify({ contents: {} }), { status: 200 });
      const name = id === UC1 ? "Lofi & Chill" : "Tech Daily";
      return new Response(browsePayload(id, name, vids), { status: 200 });
    }
    return new Response(JSON.stringify({ contents: {} }), { status: 200 });
  }
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/") && /^https:\/\/www\.youtube\.com\/?$/.test(u))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"VIS1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '19.50.1',", { status: 200 });
  if (u.includes("youtube.com/@") || u.includes("youtube.com/c/")) {
    return new Response('<html><meta property="og:title" content="Some Channel - YouTube"><meta property="og:image" content="https://yt3.ggpht.com/av.jpg"><script>{"channelId":"' + UC3 + '"}</script></html>', { status: 200 });
  }
  throw new Error("unexpected " + u);
};

/* ── parseFeed ─────────────────────────────────────────────────────────────── */
const parsed = W.parseFeed(feeds[UC1]);
check("parseFeed channel id", parsed.channel.channelId === UC1);
check("parseFeed channel name decoded", parsed.channel.name === "Lofi & Chill", parsed.channel.name);
check("parseFeed items", parsed.items.length === 2, parsed.items.length);
check("parseFeed videoId", parsed.items[0].videoId === "vidA0000001");
check("parseFeed sorted fields", parsed.items[0].title === "Rainy night mix" && parsed.items[0].viewCount === 12345 && parsed.items[0].likes === 99);
check("parseFeed published epoch", parsed.items[0].published > 1_700_000_000, parsed.items[0].published);
check("parseFeed thumbnail", parsed.items[0].thumbnail.includes("hqdefault.jpg"));
check("parseFeed description decoded", parsed.items[0].description.includes("<b>beats</b>"), parsed.items[0].description);
check("parseFeed bogus xml safe", W.parseFeed("<html>nope</html>").items.length === 0);

/* ── rss() merge + sort ────────────────────────────────────────────────────── */
const merged = await W.rss({}, `${UC1},${UC2}`);
check("rss merges channels", merged.items.length === 3, merged.items.length);
check("rss sorted newest first", merged.items[0].videoId === "vidB0000001", merged.items.map((i) => i.videoId).join(","));
check("rss returns channel metadata", merged.channels.length === 2 && merged.channels.some((c) => c.name === "Tech Daily"));
check("rss reports per-channel errors", (await W.rss({}, `${UC1},UCdoesnotexist000000`)).errors.length === 1);
check("rss dedupes ids", (await W.rss({}, `${UC1},${UC1}`)).items.length === 2);
check("rss rejects junk ids", (await W.rss({}, "nope,,123")).items.length === 0);
check("rss caps at 30 channels", typeof merged.items === "object");

/* ── XML feed retired → InnerTube channel Videos tab ──────────────────────── */
check("parseRelDate hours", Math.abs(W.parseRelDate("2 hours ago") - (Date.now() / 1000 - 7200)) < 5);
check("parseRelDate days", Math.abs(W.parseRelDate("Streamed 3 days ago") - (Date.now() / 1000 - 3 * 86400)) < 5, W.parseRelDate("Streamed 3 days ago"));
check("parseRelDate months", Math.abs(W.parseRelDate("1 month ago") - (Date.now() / 1000 - 2592000)) < 5);
check("parseRelDate junk", W.parseRelDate("") === 0 && W.parseRelDate("streamed live") === 0);

feedMode = "dead";
const viaBrowse = await W.rss({}, `${UC1},${UC2}`, new URL("https://w.dev/api/rss"));
check("falls back to channel browse when feed is dead", viaBrowse.items.length === 2, JSON.stringify(viaBrowse.items.map((i) => i.videoId)));
check("browse items carry approximate epoch", viaBrowse.items.every((i) => i.published > 1_700_000_000));
check("browse items carry publishedText", viaBrowse.items.some((i) => /hours ago/.test(i.publishedText)), JSON.stringify(viaBrowse.items.map((i) => i.publishedText)));
check("newest browse item sorts first", viaBrowse.items[0].videoId === "vidA0000003", viaBrowse.items.map((i) => i.videoId).join(","));
check("browse items keep their per-channel order", viaBrowse.items.map((i) => i.videoId).join(",") === "vidA0000003,vidB0000002", viaBrowse.items.map((i) => i.videoId).join(","));
check("sources map reports innertube", viaBrowse.sources[UC1] === "innertube" && viaBrowse.sources[UC2] === "innertube", JSON.stringify(viaBrowse.sources));
check("feedDead flag set", viaBrowse.feedDead === true);
check("browse gives channel name + avatar", viaBrowse.channels.some((c) => c.name === "Tech Daily" && /av-UCb/.test(c.avatar || "")), JSON.stringify(viaBrowse.channels));
check("browse author filled from ownerText", viaBrowse.items.every((i) => i.author === "Lofi & Chill" || i.author === "Tech Daily"), viaBrowse.items.map((i) => i.author).join(","));
check("feed retired only after the channel proved it exists", W.FEED_STATE.deadUntil > Date.now() && W.FEED_STATE.fails > 0, JSON.stringify(W.FEED_STATE));
const beforeCalls = W.FEED_STATE.fails;
await W.rss({}, UC2, new URL("https://w.dev/api/rss"));
check("no feed request once retired", W.FEED_STATE.fails === beforeCalls);
check("unknown channel errors, does not throw", (await W.rss({}, "UCdoesnotexist000000")).errors.length === 1);

const savedMode = feedMode;
feedMode = "ok";
W.FEED_STATE.deadUntil = 0; W.FEED_STATE.fails = 0; // pretend the feed is healthy again
const backToFeed = await W.rss({}, UC1, new URL("https://w.dev/api/rss"));
check("feed used again when it comes back", backToFeed.sources[UC1] === "feed", JSON.stringify(backToFeed.sources));
feedMode = savedMode;

/* ── resolveChannel ────────────────────────────────────────────────────────── */
const byId = await W.resolveChannel(UC2);
check("resolve by UC id", byId.channelId === UC2);
const byUrl = await W.resolveChannel(`https://www.youtube.com/channel/${UC1}`);
check("resolve by /channel/ url", byUrl.channelId === UC1);
const byHandle = await W.resolveChannel("@mkbhd");
check("resolve by @handle", byHandle.channelId === UC3, JSON.stringify(byHandle));
check("resolve returns name + avatar", byHandle.name === "Some Channel" && byHandle.avatar.includes("yt3"), JSON.stringify(byHandle));
let threw = false;
try { await W.resolveChannel(""); } catch { threw = true; }
check("resolve empty throws", threw);

/* ── routes ────────────────────────────────────────────────────────────────── */
W.FEED_STATE.deadUntil = 0; W.FEED_STATE.fails = 0;
feedMode = "ok";
const r1 = await (await W.default.fetch(new Request(`https://w.dev/api/rss?channels=${UC1},${UC2}`), {})).json();
check("route /api/rss", r1.items.length === 3 && r1.channels.length === 2, JSON.stringify({ n: r1.items.length, c: r1.channels.length }));
const r2 = await (await W.default.fetch(new Request("https://w.dev/api/channel?q=@mkbhd"), {})).json();
check("route /api/channel", r2.channelId === UC3, JSON.stringify(r2).slice(0, 90));
const r3 = await W.default.fetch(new Request("https://w.dev/api/channel?q="), {});
check("route /api/channel error", r3.status >= 400, r3.status);

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} RSS checks passed`);
process.exit(failed.length ? 1 : 0);
