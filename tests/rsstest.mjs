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

globalThis.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/channel_id=(UC[\w-]+)/);
  if (u.includes("/feeds/videos.xml")) {
    const f = m && feeds[m[1]];
    if (!f) return new Response("not found", { status: 404 });
    return new Response(f, { status: 200 });
  }
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
const r1 = await (await W.default.fetch(new Request(`https://w.dev/api/rss?channels=${UC1},${UC2}`), {})).json();
check("route /api/rss", r1.items.length === 3 && r1.channels.length === 2);
const r2 = await (await W.default.fetch(new Request("https://w.dev/api/channel?q=@mkbhd"), {})).json();
check("route /api/channel", r2.channelId === UC3, JSON.stringify(r2).slice(0, 90));
const r3 = await W.default.fetch(new Request("https://w.dev/api/channel?q="), {});
check("route /api/channel error", r3.status >= 400, r3.status);

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} RSS checks passed`);
process.exit(failed.length ? 1 : 0);
