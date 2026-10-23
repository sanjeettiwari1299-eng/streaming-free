import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_shorts_${Date.now()}.mjs`);
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

/* ── fixtures ──────────────────────────────────────────────────────────────── */
const LOCKUP = (id, title, views) => ({
  shortsLockupViewModel: {
    entityId: `shorts-shelf-item-${id}`,
    overlayMetadata: {
      primaryText: { content: title },
      secondaryText: { content: views },
    },
    thumbnail: { sources: [{ url: `https://i.ytimg.com/vi/${id}/oar2.jpg`, width: 405, height: 720 }, { url: `https://i.ytimg.com/vi/${id}/oardefault.jpg`, width: 1080, height: 1920 }] },
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id }, browseEndpoint: { browseId: "UCchan1" } } },
  },
});

const REEL = (id, title, views) => ({
  reelItemRenderer: {
    videoId: id,
    headline: { simpleText: title },
    viewCountText: { simpleText: views },
    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/x.jpg` }] },
    ownerText: { runs: [{ text: "Chan" }] },
    navigationEndpoint: { reelWatchEndpoint: { videoId: id } },
  },
});

const lockupData = { contents: { a: [LOCKUP("shortAAAAA1", "First short", "1.2M views"), LOCKUP("shortBBBBB2", "Second short", "45K views"), LOCKUP("shortAAAAA1", "dupe", "1.2M views")] } };
const reelData = { contents: { b: [REEL("reelAAAAAA1", "Reely", "12K views")] } };

/* ── parsers ───────────────────────────────────────────────────────────────── */
const fromLockup = W.parseShorts(lockupData);
check("parses shortsLockupViewModel", fromLockup.length === 2, fromLockup.length);
check("dedupes lockups", fromLockup.filter((v) => v.videoId === "shortAAAAA1").length === 1);
check("title from overlayMetadata", fromLockup[0].title === "First short", fromLockup[0]?.title);
check("views parsed (1.2M)", fromLockup[0].viewCount === 1_200_000, fromLockup[0]?.viewCount);
check("views parsed (45K)", fromLockup[1].viewCount === 45_000, fromLockup[1]?.viewCount);
check("largest thumbnail wins", fromLockup[0].thumbnail.includes("oardefault"), fromLockup[0]?.thumbnail);
check("authorId from browseEndpoint", fromLockup[0].authorId === "UCchan1");
check("isShort flag", fromLockup.every((v) => v.isShort === true));

const fromReel = W.parseShorts(reelData);
check("parses reelItemRenderer", fromReel.length === 1 && fromReel[0].videoId === "reelAAAAAA1");
check("reel title", fromReel[0].title === "Reely");
check("reel author", fromReel[0].author === "Chan");

check("drops bogus ids", W.parseShorts({ a: [LOCKUP("ab", "x", "1 view")] }).length === 0);
check("fallback thumb is portrait oar", W.makeShort({ videoId: "abcdefghijk", title: "t" }).thumbnail.includes("oardefault.jpg"));
check("junk payload safe", W.parseShorts({ contents: "nope" }).length === 0);
check("junk null safe", W.parseShorts(null).length === 0);

/* ── normal videos get an isShort flag ─────────────────────────────────────── */
const vShort = W.normVideo({ videoId: "vid1234567", title: { simpleText: "t" }, lengthText: { simpleText: "0:42" } });
const vLong = W.normVideo({ videoId: "vid1234568", title: { simpleText: "t" }, lengthText: { simpleText: "12:00" } });
check("normVideo marks 42s as short", vShort.isShort === true);
check("normVideo leaves 12m alone", vLong.isShort === false);

/* ── shorts() ladder ──────────────────────────────────────────────────────── */
let mode = { shorts: "ok", search: "ok", trending: "ok" };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (u.startsWith("https://www.youtube.com/") && !u.includes("/youtubei/"))
    return new Response('<script>var ytcfg={"INNERTUBE_CLIENT_VERSION":"2.20260999.01.00","VISITOR_DATA":"VIS1"};', { status: 200 });
  if (u.includes("raw.githubusercontent.com"))
    return new Response("'clientName': 'ANDROID',\n'clientVersion': '19.50.1',", { status: 200 });
  if (u.includes("/youtubei/v1/browse")) {
    if (body.browseId === "FEshorts") {
      if (mode.shorts === "fail") return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
      if (mode.shorts === "empty") return new Response(JSON.stringify({ contents: { a: [] } }), { status: 200 });
      return new Response(JSON.stringify(lockupData), { status: 200 });
    }
    if (mode.trending === "nope") return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
    return new Response(JSON.stringify({ contents: { a: [{ videoRenderer: { videoId: "trend00001", title: { simpleText: "Trend short" }, lengthText: { simpleText: "0:30" }, viewCountText: { simpleText: "9K views" }, thumbnail: { thumbnails: [{ url: "https://i/t.jpg" }] } } }] } }), { status: 200 });
  }
  if (u.includes("/youtubei/v1/search")) {
    if (mode.search === "fail") return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
    return new Response(JSON.stringify({
      contents: { a: [
        { videoRenderer: { videoId: "srch000001", title: { simpleText: "Search short" }, lengthText: { simpleText: "0:55" }, viewCountText: { simpleText: "3K views" }, thumbnail: { thumbnails: [{ url: "https://i/s1.jpg" }] } } },
        { videoRenderer: { videoId: "srch000002", title: { simpleText: "Long video" }, lengthText: { simpleText: "14:20" } } },
      ] },
    }), { status: 200 });
  }
  throw new Error("unexpected " + u);
};

const live = await W.shorts("IN", {}, new URL("https://w.dev/api/shorts"));
check("shorts() uses FEshorts", live.items.length === 2 && live.source === "FEshorts", JSON.stringify({ s: live.source, n: live.items.length }));
check("shorts() keeps order", live.items[0].videoId === "shortAAAAA1");
check("shorts() reports attempts", Array.isArray(live.attempts) && live.attempts[0].found === 2);
check("shorts() caps at 40", live.items.length <= 40);

W.resetBreakers(); // each scenario starts from a clean ladder in the real world too
mode = { shorts: "empty", search: "ok", trending: "ok" };
const viaSearch = await W.shorts("IN", {}, new URL("https://w.dev/api/shorts"));
check("falls back to #shorts search", viaSearch.source === "search #shorts", JSON.stringify(viaSearch.attempts));
check("falls back filters >90s", viaSearch.items.length === 1 && viaSearch.items[0].videoId === "srch000001", JSON.stringify(viaSearch.items.map((i) => i.videoId)));

W.resetBreakers();
mode = { shorts: "fail", search: "fail", trending: "ok" };
const viaTrend = await W.shorts("IN", {}, new URL("https://w.dev/api/shorts"));
check("falls back to trending", viaTrend.source === "trending<=90s" && viaTrend.items.length === 1, JSON.stringify({ s: viaTrend.source, n: viaTrend.items.length }));
check("errors kept in attempts", viaTrend.attempts.some((a) => a.error), JSON.stringify(viaTrend.attempts));

W.resetBreakers();
mode = { shorts: "fail", search: "fail", trending: "nope" };
const dead = await W.shorts("IN", {}, new URL("https://w.dev/api/shorts"));
check("total failure is empty, not a throw", Array.isArray(dead.items) && dead.items.length === 0);

/* ── route ────────────────────────────────────────────────────────────────── */
W.resetBreakers();
mode = { shorts: "ok", search: "ok", trending: "ok" };
const res = await W.default.fetch(new Request("https://w.dev/api/shorts?region=US"), {});
const body = await res.json();
check("route /api/shorts", res.status === 200 && body.items.length === 2, res.status);
check("route passes region", body.region === "US", body.region);
const bad = await W.default.fetch(new Request("https://w.dev/api/shorts"), {}).then((r) => r.json());
check("route defaults region IN", bad.region === "IN");

const failed = checks.filter((c) => !c.pass);
checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
console.log(`\n${checks.length - failed.length}/${checks.length} Shorts checks passed`);
process.exit(failed.length ? 1 : 0);
