/**
 * Dev preview server — NOT needed in production.
 *
 * Production = static index.html + your Cloudflare Worker (worker.js).
 * This file only exists so you can open the app locally and see the real UI +
 * custom player working without deploying anything: it serves index.html and
 * answers /api/* with mock data + Google's public sample MP4s.
 *
 *   node dev-server.mjs         → http://localhost:3000
 *   PORT=8080 node dev-server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CDN = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample";

const SAMPLES = [
  { file: "BigBuckBunny.mp4", thumb: "images/BigBuckBunny.jpg", title: "Big Buck Bunny", author: "Blender Foundation", sec: 596, views: 8400000, ago: "2 years ago" },
  { file: "ElephantsDream.mp4", thumb: "images/ElephantsDream.jpg", title: "Elephants Dream", author: "Blender Foundation", sec: 653, views: 3100000, ago: "3 years ago" },
  { file: "ForBiggerBlazes.mp4", thumb: "images/ForBiggerBlazes.jpg", title: "For Bigger Blazes", author: "Google Samples", sec: 15, views: 1200000, ago: "5 years ago" },
  { file: "ForBiggerEscapes.mp4", thumb: "images/ForBiggerEscapes.jpg", title: "For Bigger Escapes", author: "Google Samples", sec: 15, views: 980000, ago: "5 years ago" },
  { file: "ForBiggerFun.mp4", thumb: "images/ForBiggerFun.jpg", title: "For Bigger Fun", author: "Google Samples", sec: 60, views: 760000, ago: "5 years ago" },
  { file: "ForBiggerJoyrides.mp4", thumb: "images/ForBiggerJoyrides.jpg", title: "For Bigger Joyrides", author: "Google Samples", sec: 15, views: 640000, ago: "5 years ago" },
  { file: "ForBiggerMeltdowns.mp4", thumb: "images/ForBiggerMeltdowns.jpg", title: "For Bigger Meltdowns", author: "Google Samples", sec: 15, views: 520000, ago: "5 years ago" },
  { file: "Sintel.mp4", thumb: "images/Sintel.jpg", title: "Sintel", author: "Blender Foundation", sec: 888, views: 4100000, ago: "4 years ago" },
  { file: "SubaruOutbackOnStreetAndDirt.mp4", thumb: "images/SubaruOutbackOnStreetAndDirt.jpg", title: "Subaru Outback on Street and Dirt", author: "Garage419", sec: 594, views: 2400000, ago: "6 years ago" },
  { file: "TearsOfSteel.mp4", thumb: "images/TearsOfSteel.jpg", title: "Tears of Steel", author: "Blender Foundation", sec: 734, views: 2900000, ago: "3 years ago" },
  { file: "VolkswagenGTIReview.mp4", thumb: "images/VolkswagenGTIReview.jpg", title: "Volkswagen GTI Review", author: "Garage419", sec: 402, views: 1500000, ago: "6 years ago" },
  { file: "WeAreGoingOnBullrun.mp4", thumb: "images/WeAreGoingOnBullrun.jpg", title: "We Are Going On Bullrun", author: "Garage419", sec: 240, views: 890000, ago: "6 years ago" },
];

const item = (s, i) => ({
  videoId: "demo" + String(i).padStart(8, "0"),
  title: s.title,
  author: s.author,
  authorId: "UCdemo" + i,
  thumbnail: `${CDN}/${s.thumb}`,
  lengthSeconds: s.sec,
  viewCount: s.views,
  publishedText: s.ago,
  live: false,
});

const ITEMS = SAMPLES.map(item);

// mock Shorts: portrait-ish cards that still play a real sample file
const SHORTS = SAMPLES.slice(0, 8).map((smp, i) => {
  const id = "demoSh" + String(i).padStart(6, "0");
  return {
    videoId: id,
    title: smp.title + " #shorts",
    author: smp.author,
    authorId: "UCdemo" + (i % 3),
    thumbnail: `${CDN}/${smp.thumb}`,
    lengthSeconds: 30,
    viewCount: 100000 + i * 37000,
    publishedText: "1 day ago",
    live: false,
    isShort: true,
  };
});

const byId = new Map(ITEMS.map((v, i) => [v.videoId, { ...v, sample: SAMPLES[i] }]));
for (const sh of SHORTS) {
  if (!byId.has(sh.videoId)) byId.set(sh.videoId, { ...sh, sample: SAMPLES.find((s) => s.title === sh.title.replace(" #shorts", "")) || SAMPLES[0] });
}

const COMMENT_AUTHORS = [
  ["Aarav Mehta", "UCdemo0"], ["Priya Sharma", "UCdemo1"], ["Rahul Verma", "UCdemo2"],
  ["Sneha Iyer", "UCdemo3"], ["Dev Patel", "UCdemo4"], ["Kabir Singh", "UCdemo5"],
  ["Ananya Rao", "UCdemo6"], ["Vikram Joshi", "UCdemo7"], ["Neha Gupta", "UCdemo8"],
  ["Arjun Nair", "UCdemo9"], ["Ishita Bose", "UCdemo10"], ["Rohan Das", "UCdemo11"],
];
const COMMENT_TEXTS = [
  "Bhai ye quality dekh ke maza aa gaya 🔥",
  "Custom player + no ads = instant subscribe. Great work!",
  "Explanation bilkul crisp hai, time waste nahi hua.",
  "Watched this twice already. The editing is next level.",
  "Background music ka naam kya hai? Please reply 🙏",
  "Finally a front-end that respects the viewer. No login, no tracking.",
  "The timestamps in this video are incredibly helpful.",
  "Meri playlist me save ho gaya. Keep uploading!",
  "Shorts me bhi same energy chahiye, waiting for that update.",
  "Underrated channel fr. Sharing this with my friends.",
  "Comment section bhi connect ho gaya — full YouTube feel now.",
  "Serverless setup is genius. Bookmarked the repo.",
];
const COMMENTS = COMMENT_AUTHORS.map(([author, authorId], i) => ({
  commentId: "cm" + String(i + 1).padStart(6, "0"),
  author,
  authorId,
  avatar: "",
  text: COMMENT_TEXTS[i % COMMENT_TEXTS.length],
  likes: [2400, 1890, 731, 655, 512, 447, 380, 265, 190, 95, 44, 12][i] || 0,
  replies: [12, 7, 4, 3, 9, 2, 0, 5, 1, 0, 0, 0][i] || 0,
  published: (i + 1) + " days ago",
  creator: i < 2,
}));

const json = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
};

/* ── dev cloud store: same contract as the worker's Layerbase route ─────────
   In-memory + capped, so the UI's sync path is real even without Layerbase.   */
const CAPS = { history: 300, subs: 150, likes: 500, watchlater: 300, playlists: 50, cfg: 1 };
const DB = new Map();                                   // profileKey → { kind: Map(id → {pos,data}) }
const KIND = { hist: "history", history: "history", s: "subs", subs: "subs", f: "likes", likes: "likes", w: "watchlater", wl: "watchlater", watchlater: "watchlater", p: "playlists", playlists: "playlists", c: "cfg", cfg: "cfg" };
const bucket = (p, kind) => {
  if (!DB.has(p)) DB.set(p, new Map());
  const prof = DB.get(p);
  if (!prof.has(kind)) prof.set(kind, new Map());
  return prof.get(kind);
};
const trim = (p, kind) => {
  const m = bucket(p, kind);
  const cap = CAPS[kind] || 1;
  if (m.size <= cap) return;
  const sorted = [...m.entries()].sort((a, b) => b[1].pos - a[1].pos);
  for (const [id] of sorted.slice(cap)) m.delete(id);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
const syncRead = (p) => {
  const store = { history: [], subs: [], likes: [], watchlater: [], playlists: [], cfg: {} };
  const prof = DB.get(p) || new Map();
  for (const [kind, m] of prof) {
    const rows = [...m.values()].sort((a, b) => b.pos - a.pos).map((r) => r.data);
    if (kind === "cfg") store.cfg = rows[0] || {};
    else store[kind] = rows;
  }
  return store;
};
const syncWrite = (p, ops) => {
  let written = 0;
  for (const op of ops || []) {
    const kind = KIND[String(op.kind || "").toLowerCase()];
    if (!kind) continue;
    const m = bucket(p, kind);
    if (op.clear) { m.clear(); continue; }
    for (const it of op.upsert || []) {
      const id = it.id || it.videoId || it.channelId;
      if (!id) continue;
      m.set(String(id), { pos: Number(it.pos) || Date.now(), data: it.data !== undefined ? it.data : it });
      written++;
    }
    for (const id of op.del || []) m.delete(String(id));
    trim(p, kind);
  }
  return { written };
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (u.pathname === "/api/sync" || u.pathname === "/api/sync/import") {
    const p = (u.searchParams.get("p") || "").trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(p)) return json(res, { ok: false, error: "profile key must be 16-64 chars of [A-Za-z0-9_-]" });
    if (req.method === "GET") return json(res, { ok: true, backend: "dev-memory", store: syncRead(p), caps: CAPS, at: Date.now() });
    if (req.method === "DELETE") { bucket(p, KIND[u.searchParams.get("kind")] || "").clear(); return json(res, { ok: true, written: 0, caps: CAPS }); }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (u.pathname === "/api/sync/import") {
        const store = body.store || {};
        const ops = Object.keys(CAPS).map((kind) => kind === "cfg"
          ? { kind, upsert: [{ id: "cfg", pos: 1, data: store.cfg || {} }] }
          : { kind, upsert: (store[kind] || []).map((v, i) => ({ id: v.videoId || v.channelId || v.id, pos: Number(v.pos) || Date.now() - i, data: v })) });
        const r = syncWrite(p, ops);
        return json(res, { ok: true, ...r, imported: r.written, caps: CAPS });
      }
      return json(res, { ok: true, ...syncWrite(p, body.ops || []), caps: CAPS, backend: "dev-memory" });
    }
    return json(res, { ok: false, error: "method not allowed" }, 405);
  }
  if (u.pathname === "/api/health") {
    return json(res, { ok: true, service: "dev-preview", mode: "mock", note: "production = your Cloudflare Worker" });
  }
  if (u.pathname === "/api/trending") return json(res, { items: ITEMS });
  if (u.pathname === "/api/shorts")
    return json(res, { items: SHORTS, count: SHORTS.length, region: (u.searchParams.get("region") || "IN").toUpperCase(), source: "demo", attempts: [{ source: "demo", found: SHORTS.length }] });
  if (u.pathname === "/api/search") {
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const hits = ITEMS.filter((v) => !q || v.title.toLowerCase().includes(q) || v.author.toLowerCase().includes(q));
    return json(res, { items: hits.length ? hits : ITEMS, continuation: null });
  }
  if (u.pathname === "/api/searchmore") return json(res, { items: [] });
  if (u.pathname === "/api/comments") {
    const id = u.searchParams.get("id") || "";
    const token = Number(u.searchParams.get("token") || 0) || 0;
    const items = COMMENTS.slice(token, token + 5);
    const next = token + 5 < COMMENTS.length ? String(token + 5) : null;
    return json(res, { ok: true, items, next, count: COMMENTS.length, source: "dev-mock" });
  }
  if (u.pathname === "/api/related") {
    const id = u.searchParams.get("id");
    return json(res, { items: ITEMS.filter((v) => v.videoId !== id) });
  }
  if (u.pathname === "/api/rss") {
    const ids = (u.searchParams.get("channels") || "").split(",").filter(Boolean);
    const now = Math.floor(Date.now() / 1000);
    const items = [];
    const channels = [];
    const errors = [];
    ids.forEach((id, idx) => {
      const mine = ITEMS.filter((v) => v.authorId === id);
      if (!mine.length) errors.push({ channelId: id, error: "no mock feed" });
      else channels.push({ channelId: id, name: mine[0].author, avatar: null });
      mine.forEach((v, k) => items.push({ ...v, published: now - (idx * 7200 + k * 30000) }));
    });
    items.sort((a, b) => b.published - a.published);
    return json(res, { items, channels, errors });
  }
  if (u.pathname === "/api/channel") {
    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return json(res, { error: "q required" }, 400);
    const hit = ITEMS.find((v) => v.author.toLowerCase().replace(/\s+/g, "").includes(q.replace(/^@/, "").toLowerCase().replace(/\s+/g, "")));
    if (!hit) return json(res, { error: "channel not found in dev preview" }, 404);
    return json(res, { channelId: hit.authorId, name: hit.author, avatar: null, source: q });
  }
  if (u.pathname === "/api/player") {
    const id = u.searchParams.get("id");
    const v = byId.get(id) || byId.get(ITEMS[0].videoId);
    return json(res, {
      ok: true,
      client: "demo",
      video: { videoId: v.videoId, title: v.title, author: v.author, authorId: v.authorId, viewCount: v.viewCount, lengthSeconds: v.lengthSeconds, description: "Dev preview me Google ke public sample MP4 chal rahe hain. Production me worker.js YouTube se real streams deta hai.", thumbnails: [v.thumbnail] },
      formats: [
        { itag: 137, quality: "1080p", height: 1080, url: `${CDN}/${v.sample.file}`, kind: "muxed" },
        { itag: 18, quality: "480p", height: 480, url: `${CDN}/ForBiggerBlazes.mp4`, kind: "muxed" },
      ],
      attempts: [],
    });
  }
  if (u.pathname.startsWith("/api/")) return json(res, { error: "not found in dev preview" }, 404);

  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const full = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  const ext = path.extname(full);
  const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => console.log(`StreamVoid dev preview → http://localhost:${PORT} (mock engine)`));
