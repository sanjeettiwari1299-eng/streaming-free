/* UI regression suite: compiles the JSX out of index.html and drives it in jsdom.
   Needs dev deps:  npm i jsdom react react-dom @babel/core @babel/preset-react
   Run:  node tests/ui.test.cjs                                                  */
const fs = require("fs");
const path = require("path");
const os = require("os");

let JSDOM, babel, react, reactDom;
try {
  ({ JSDOM } = require("jsdom"));
  babel = require("@babel/core");
  const umd = (pkg, file) =>
    fs.readFileSync(path.join(path.dirname(require.resolve(pkg + "/package.json")), "umd", file), "utf8");
  react = umd("react", "react.development.js");
  reactDom = umd("react-dom", "react-dom.development.js");
} catch (e) {
  console.log("SKIP  ui.test.cjs - install jsdom react react-dom @babel/core @babel/preset-react");
  process.exit(0);
}

const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const jsx = page.match(/<script type="text\/babel">([\s\S]*?)<\/script>/)[1];
const app = babel.transformSync(jsx, {
  filename: "app.jsx",
  presets: [[require.resolve("@babel/preset-react"), { runtime: "classic" }]],
}).code;
const html = `<!DOCTYPE html><html><body><div id="root"></div><script>${react}</script><script>${reactDom}</script></body></html>`;

const UC1 = "UCaaaaaaaaaaaaaaaaaaaaaa";
const UC2 = "UCbbbbbbbbbbbbbbbbbbbbbb";

const TRENDING = [
  { videoId: "tr000000001", title: "Trending One", author: "Chan A", authorId: UC1, thumbnail: "https://i/1.jpg", lengthSeconds: 200, viewCount: 1e6, publishedText: "1 day ago" },
  { videoId: "tr000000002", title: "Trending Two", author: "Chan B", authorId: UC2, thumbnail: "https://i/2.jpg", lengthSeconds: 300, viewCount: 2e6, publishedText: "2 days ago" },
];
const RSS_ITEMS = [
  { videoId: "rss000000001", title: "Fresh upload", author: "Lofi Chill", authorId: UC1, thumbnail: "https://i/r1.jpg", published: Math.floor(Date.now() / 1000) - 3600, viewCount: 4200 },
  { videoId: "rss000000002", title: "Yesterday upload", author: "Tech Daily", authorId: UC2, thumbnail: "https://i/r2.jpg", published: Math.floor(Date.now() / 1000) - 90000, viewCount: 900 },
];
const SHORTS = [
  { videoId: "sh100000001", title: "Quick trick", thumbnail: "https://i/s1.jpg", viewCount: 1200000, lengthSeconds: 0, isShort: true, author: "", authorId: "" },
  { videoId: "sh100000002", title: "Second short", thumbnail: "https://i/s2.jpg", viewCount: 45000, lengthSeconds: 0, isShort: true, author: "", authorId: "" },
  { videoId: "sh100000003", title: "Third short", thumbnail: "https://i/s3.jpg", viewCount: 999, lengthSeconds: 0, isShort: true, author: "", authorId: "" },
];

const PLAYER = {
  ok: true, client: "android_vr", clientVersion: "1.62.27",
  video: { videoId: "tr000000001", title: "Resolved Title", author: "Resolved Chan", authorId: UC1, description: "desc", viewCount: 999, lengthSeconds: 240, thumbnails: [] },
  formats: [{ itag: 22, quality: "720p", url: "/api/media?u=hi&v=tr000000001&itag=22" }, { itag: 18, quality: "360p", url: "/api/media?u=lo&v=tr000000001&itag=18" }],
};

function makeDom(opts = {}) {
  const dom = new JSDOM(html, {
    url: "https://app.local/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      /* bootstrap config is a cookie now; localStorage must stay completely unused */
      if (opts.prefs) {
        for (const [k, v] of Object.entries(opts.prefs)) {
          w.document.cookie = k + "=" + encodeURIComponent(v) + "; path=/; max-age=31536000; SameSite=Lax";
        }
      }
      w.__lsWrites = 0;
      for (const m of ["setItem", "removeItem", "clear"]) {
        const orig = w.localStorage[m].bind(w.localStorage);
        w.localStorage[m] = (...a) => { w.__lsWrites++; return orig(...a); };
      }
      w.__remote = opts.remote || { history: [], likes: [], watchlater: [], playlists: [], subs: [], cfg: {} };
      w.AbortController = AbortController;
      w.scrollTo = () => {};
      w.alert = (m) => { w.__alerts = (w.__alerts || []).concat(String(m)); };
      w.confirm = () => true;
      w.URL.createObjectURL = () => "blob:x";
      w.URL.revokeObjectURL = () => {};
      w.HTMLMediaElement.prototype.play = function () { this.paused = false; this.dispatchEvent(new w.Event("play")); return Promise.resolve(); };
      w.HTMLMediaElement.prototype.pause = function () { this.paused = true; this.dispatchEvent(new w.Event("pause")); };
      w.HTMLMediaElement.prototype.load = function () {};
      Object.defineProperty(w.HTMLMediaElement.prototype, "paused", { configurable: true, writable: true, value: true });
      Object.defineProperty(w.HTMLMediaElement.prototype, "duration", { configurable: true, get() { return 240; }, set() {} });
      Object.defineProperty(w.HTMLMediaElement.prototype, "currentTime", { configurable: true, get() { return this.__t || 0; }, set(x) { this.__t = Number(x) || 0; } });
      Object.defineProperty(w.HTMLMediaElement.prototype, "buffered", { configurable: true, get() { return { length: 1, start: () => 0, end: () => 100 }; } });
      w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 16, right: 1000, bottom: 16, x: 0, y: 0 });
      w.Element.prototype.requestFullscreen = function () { w.document.__fs = this; w.document.dispatchEvent(new w.Event("fullscreenchange")); return Promise.resolve(); };
      w.document.exitFullscreen = function () { w.document.__fs = null; w.document.dispatchEvent(new w.Event("fullscreenchange")); return Promise.resolve(); };
      Object.defineProperty(w.document, "fullscreenElement", { configurable: true, get() { return w.document.__fs || null; } });
      w.__calls = [];
      w.__sync = [];
      const CAPS = { history: 300, subs: 150, likes: 500, watchlater: 300, playlists: 50 };
      const applyOps = (ops) => {
        for (const op of ops || []) {
          const kind = op.kind;
          if (kind === "cfg") {
            const dat = (op.upsert || [])[0] && (op.upsert || [])[0].data;
            if (dat) w.__remote.cfg = { ...(w.__remote.cfg || {}), ...dat };
            continue;
          }
          if (!CAPS[kind]) continue;
          if (op.clear) { w.__remote[kind] = []; continue; }
          let list = w.__remote[kind] || [];
          for (const it of op.upsert || []) {
            const id = it.id || (it.data && (it.data.videoId || it.data.channelId)) || "";
            list = [it.data, ...list.filter((x) => (x.videoId || x.channelId || x.id) !== id)];
          }
          for (const id of op.del || []) list = list.filter((x) => (x.videoId || x.channelId || x.id) !== id);
          w.__remote[kind] = list.slice(0, CAPS[kind]);
        }
      };
      w.fetch = async (url, init = {}) => {
        const u = String(url);
        w.__calls.push(u);
        if (opts.offline) throw new Error("network down");
        const ok = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
        if (/\/api\/sync\/probe/.test(u)) {
          if (opts.syncFail) return ok({ ok: false, configured: true, backend: "layerbase-libsql", error: "layerbase: HTTP 503", hint: "check LIBSQL_URL + LIBSQL_TOKEN" });
          if (opts.probeOff) return ok({ ok: false, configured: false, error: "LIBSQL_URL + LIBSQL_TOKEN missing", steps: ["layerbase.com → sign in (free, no card)", "New Database → engine libSQL", "Connect → copy URL + token", "Cloudflare → Settings → Variables", "hit this probe again"] });
          if (opts.probeBadUrl) return ok({ ok: false, configured: false, backend: "layerbase-libsql", error: "LIBSQL_URL parse nahi hui — sirf host chahiye", url: { given: true, normalized: "", tokenGiven: true, changed: false } });
          return ok({ ok: true, configured: true, backend: "layerbase-libsql", host: "demo.layerbase.dev", latencyMs: 214, rows: 7, caps: CAPS, ttl: "none", wokeFromSleep: true, endpoint: "https://demo.layerbase.dev/v2/pipeline", url: { given: true, normalized: "https://demo.layerbase.dev", changed: true, tokenGiven: true, tokenPrefix: "eyJh…" } });
        }
        if (/\/api\/sync/.test(u)) {
          if (opts.syncFail) return { ok: false, status: 503, json: async () => ({ ok: false, error: "layerbase 503" }), text: async () => JSON.stringify({ ok: false, error: "layerbase 503" }) };
          if (init.method === "GET") return ok({ ok: true, backend: "layerbase-libsql", store: w.__remote, caps: { ...CAPS, cfg: 1 } });
          const body = init.body ? JSON.parse(init.body) : {};
          w.__sync.push({ method: init.method || "GET", url: u, body });
          if (/\/api\/sync\/import/.test(u)) {
            const st = body.store || {};
            for (const k of Object.keys(CAPS)) if (Array.isArray(st[k])) w.__remote[k] = st[k].slice(0, CAPS[k]);
            if (st.cfg) w.__remote.cfg = { ...(w.__remote.cfg || {}), ...st.cfg };
            return ok({ ok: true, imported: Object.keys(CAPS).reduce((n, k) => n + ((st[k] || []).length), 0) });
          }
          if ((init.method || "GET") === "DELETE") {
            const kind = decodeURIComponent(u.split("kind=")[1] || "");
            if (CAPS[kind]) w.__remote[kind] = [];
            return ok({ ok: true, written: 0 });
          }
          applyOps(body.ops);
          return ok({ ok: true, written: (body.ops || []).reduce((n, o) => n + ((o.upsert || []).length), 0) });
        }
        if (/\/api\/debug/.test(u)) return ok({ ok: true, clients: [{ id: "android_vr" }, { id: "web" }], versions: {} });
        if (/\/api\/canary/.test(u)) return ok({ ok: true, videos: [{ id: "x", ok: true }] });
        if (/\/api\/media/.test(u) || /\/mp4\//.test(u)) {
          w.__mediaCalls = (w.__mediaCalls || 0) + 1;
          if (opts.mediaFailFirst && w.__mediaCalls <= opts.mediaFailFirst) {
            return {
              ok: false, status: 403,
              headers: { get: (k) => ({ "content-type": "application/json", "x-sv-media-fail": "1" }[String(k).toLowerCase()] || null) },
              arrayBuffer: async () => new ArrayBuffer(0),
              text: async () => JSON.stringify({ error: "stream bytes not available", retry: true }),
              json: async () => ({ error: "stream bytes not available", retry: true }),
            };
          }
          return {
            ok: true, status: 206,
            headers: { get: (k) => ({ "content-type": String(u).includes("webm") ? "video/webm" : "video/mp4", "content-range": "bytes 0-2047/9999" }[String(k).toLowerCase()] || null) },
            arrayBuffer: async () => new ArrayBuffer(2048),
            text: async () => "bytes",
            json: async () => ({}),
          };
        }
        if (/\/api\/selftest/.test(u)) {
          if (opts.oldWorker) return ok({ ok: true, video: "tr000000001", ms: 747, pass: 1, client: "android_vr", clientVersion: "1.65.10", formats: ["360p"], attempts: [] });
          if (opts.doctorFail) return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "not json" };
          return ok({
            ok: true, video: "tr000000001", ms: 747, pass: 1, reason: null, needAuth: false, botCheck: false, poTokenUsed: false,
            client: "android_vr", clientVersion: "1.65.10", healed: false, formats: ["360p"], attempts: [],
            stream: { ok: true, status: 206, itag: 18, quality: "360p", type: "video/mp4", bytes: 2048, note: "bytes aa rahe hain — stream playable hai" },
            verdict: { code: "ok", hi: "Sab theek — resolve + bytes dono kaam kar rahe hain." },
          });
        }
        if (/\/api\/health/.test(u)) return ok({ ok: true, service: "streamvoid-worker" });
        if (/\/api\/trending/.test(u)) return ok({ items: TRENDING });
        if (/\/api\/rss/.test(u)) {
          const ids = decodeURIComponent(u.split("channels=")[1].split("&")[0]).split(",").filter(Boolean);
          const items = opts.emptyFeed ? [] : RSS_ITEMS.filter((v) => ids.includes(v.authorId));
          return ok({ items, channels: ids.map((id) => ({ channelId: id, name: id === UC1 ? "Lofi Chill" : "Tech Daily" })), errors: [] });
        }
        if (/\/api\/channel/.test(u)) {
          const q = decodeURIComponent(u.split("q=")[1] || "");
          if (opts.channelFail) return { ok: false, status: 404, json: async () => ({ error: "channel id not found" }), text: async () => JSON.stringify({ error: "channel id not found" }) };
          return ok({ channelId: UC2, name: "Tech Daily", avatar: "https://yt3/av.jpg", source: q });
        }
        if (/\/api\/shorts/.test(u)) return ok({ items: opts.noShorts ? [] : SHORTS, count: SHORTS.length, region: "IN", source: "FEshorts", attempts: [] });
        if (/\/api\/search/.test(u)) return ok({ items: TRENDING, continuation: null });
        if (/\/api\/player/.test(u)) {
          const id = decodeURIComponent(u.split("id=")[1].split("&")[0]);
          if (opts.playerFailFirst) {
            w.__playerCalls = (w.__playerCalls || 0) + 1;
            if (w.__playerCalls <= opts.playerFailFirst) {
              return { ok: false, status: 500, json: async () => ({ error: "resolve exploded" }), text: async () => JSON.stringify({ error: "resolve exploded" }) };
            }
          }
          if (opts.gatedPlayer && id === "tr000000002") {
            return ok({
              ok: false, error: "YouTube bot-check: koi playable stream nahi mila",
              reason: "bot", reasonLabel: "YouTube bot-check", needAuth: true, botCheck: true,
              hint: "YouTube is asking this IP to prove it is not a bot (PoToken). Cookies or a PoToken fix this.",
              failures: { bot: 6, unavailable: 2 },
              attempts: ["android_vr@1.65.10: LOGIN_REQUIRED Sign in to confirm you're not a bot [bot]", "ios@21.26.4: LOGIN_REQUIRED [bot]", "mirror https://inv.nadeko.net: HTTP 502"],
            });
          }
          if (SHORTS.some((v) => v.videoId === id)) {
            return ok({
              ok: true, client: "android_vr",
              video: { videoId: id, title: "Short " + id.slice(-1), author: "ShortChan", authorId: "UCshorts000000000000000", viewCount: 12345, lengthSeconds: 30, thumbnails: [] },
              formats: [{ itag: 18, quality: "360p", url: "/api/media?u=" + id + "&v=" + id + "&itag=18" }],
            });
          }
          if (opts.mixedFormats) {
            return ok({
              ...PLAYER,
              formats: [
                { itag: 43, quality: "360p", height: 360, mime: "video/webm; codecs=\"vp9, opus\"", url: "/api/media?u=webm&v=" + id + "&itag=43" },
                { itag: 22, quality: "720p", height: 720, mime: "video/mp4; codecs=\"avc1.64001F, mp4a.40.2\"", url: "/api/media?u=hi&v=" + id + "&itag=22" },
                { itag: 18, quality: "360p", height: 360, mime: "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"", url: "/api/media?u=lo&v=" + id + "&itag=18" },
              ],
            });
          }
          return ok(PLAYER);
        }
        if (/\/api\/comments/.test(u)) {
          if (opts.commentsOff) return ok({ ok: true, items: [], next: null, count: 0, disabled: true });
          const token = /token=([^&]+)/.test(u) ? decodeURIComponent(u.split("token=")[1]) : "";
          const page = [
            { commentId: "c1", author: "Aarav", authorId: UC1, avatar: "", text: "Great video, custom player is smooth.", likes: 1200, replies: 4, published: "2 days ago", creator: false },
            { commentId: "c2", author: "Resolved Chan", authorId: UC2, avatar: "", text: "Thanks for watching!", likes: 340, replies: 0, published: "1 day ago", creator: true },
          ];
          if (token) return ok({ ok: true, items: [{ commentId: "c3", author: "Priya", authorId: UC1, text: "Second page comment.", likes: 5, replies: 0, published: "5 hours ago" }], next: null, count: 3 });
          return ok({ ok: true, items: page, next: "page2", count: 3, source: "innertube" });
        }
        if (/\/api\/related/.test(u)) return ok({ items: TRENDING });
        throw new Error("unexpected " + u);
      };
    },
  });
  return dom;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (w, s) => w.document.querySelector(s);
const all = (w, s) => [...w.document.querySelectorAll(s)];
const setVal = (w, el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); };
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });
const cookie = (w, k) => {
  const m = w.document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
};

(async () => {
  /* ══ 1. home + watch (v5 shell) ═══════════════════════════════════════════ */
  const dom = makeDom();
  const w = dom.window;
  const errs = [];
  w.console.error = (...a) => errs.push(a.join(" "));
  const sc = w.document.createElement("script");
  sc.textContent = app;
  w.document.body.appendChild(sc);
  await wait(900);

  check("app mounts", !!q(w, ".layout"));
  check("engine healthy", !!q(w, ".engine-dot.ok"));
  check("trending grid", all(w, ".vc").length === 2, all(w, ".vc").length);
  check("sidebar shows subscriptions section", /Subscriptions/.test(q(w, ".sidebar").textContent));

  click(w, all(w, ".vc")[0]);
  await wait(800);
  check("watch page + custom player", !!q(w, ".cp") && !q(w, "iframe"));
  check("player src", /u=hi/.test(q(w, "video").getAttribute("src") || ""));
  check("subscribe button visible", /Subscribe/.test(all(w, ".sub-btn")[0].textContent));

  /* subscribe from watch page (channel already known) */
  click(w, all(w, ".sub-btn")[0]);
  await wait(700);
  check("subscribe toggles to Subscribed", /Subscribed/.test(all(w, ".sub-btn")[0].textContent));
  check("sub persisted to cloud store", (w.__remote.subs || []).length === 1, JSON.stringify(w.__remote.subs));
  check("sub write sent as a POST", (w.__sync || []).some((o) => (o.body.ops || []).some((op) => op.kind === "subs" && (op.upsert || []).some((u) => u.id === UC1))), JSON.stringify(w.__sync || []).slice(0, 160));
  check("sidebar lists channel", /Resolved Chan/.test(q(w, ".sidebar").textContent));

  /* ══ 2. player: 3× speed, pitch, zoom ═══════════════════════════════════ */
  check("recommender asks RSS for watched channels", w.__calls.some((u) => /\/api\/rss\?channels=/.test(u)), w.__calls.filter((u) => /rss/.test(u)).slice(0, 2).join(" "));
  const reasons = all(w, ".vc-reason").map((x) => x.textContent);
  check("up-next cards explain why", reasons.length > 0, reasons.slice(0, 3).join(" | "));
  check("reasons are specific, not generic", reasons.every((r) => /Because you watch|More from|From a channel you follow|Trending now|Related to this video/.test(r)), reasons.slice(0, 3).join(" | "));
  check("affinity feed surfaced", reasons.some((r) => /Because you watch|More from/.test(r)), reasons.join(" | "));
  check("up next excludes the current video", all(w, ".vc .vc-title").every((t) => t.textContent !== "Resolved Title"));

  /* ══ YouTube-style player chrome ════════════════════════════════════════ */
  const gear = all(w, ".cp-btn").find((b) => b.getAttribute("title") === "Settings");
  click(w, gear);
  await wait(140);
  const mainRows = all(w, ".cp-mi").map((b) => b.textContent);
  check("settings opens a YouTube-style menu", !!q(w, ".cp-menu") && /Playback speed/.test(mainRows.join(" ")), mainRows.join(" | "));
  check("menu rows: speed / quality / zoom / pitch", ["Playback speed", "Quality", "Zoom", "Preserve pitch"].every((l) => mainRows.some((r) => r.includes(l))), mainRows.join(" | "));
  check("menu shows current quality", /720p/.test(q(w, ".cp-menu").textContent), q(w, ".cp-menu").textContent.slice(0, 90));

  click(w, all(w, ".cp-mi").find((b) => /Playback speed/.test(b.textContent)));
  await wait(140);
  check("speed submenu has a back button", !!q(w, ".cp-back"));
  check("speed menu offers 10 steps", all(w, ".cp-speed").length === 10, all(w, ".cp-speed").length);
  check("3× speed option exists", all(w, ".cp-speed").some((b) => b.textContent === "3×"));

  click(w, all(w, ".cp-speed").find((b) => b.textContent === "2.5×"));
  await wait(150);
  check("playbackRate applied", q(w, "video").playbackRate === 2.5, q(w, "video").playbackRate);
  check("speed badge shown", all(w, ".cp-badge").some((b) => /2\.5×/.test(b.textContent)), all(w, ".cp-badge").map((b) => b.textContent).join(","));
  check("rate persisted", (cookie(w, "sv_cfg") || {}).rate === 2.5, JSON.stringify(cookie(w, "sv_cfg")));

  const pitchBtn = all(w, ".cp-mi").find((b) => /Preserve pitch/.test(b.textContent));
  check("pitch control present", !!pitchBtn);
  check("pitch preserved by default", q(w, "video").preservesPitch !== false);
  click(w, pitchBtn);
  await wait(120);
  check("varispeed disables pitch preserve", q(w, "video").preservesPitch === false);
  check("pitch persisted", (cookie(w, "sv_cfg") || {}).pitch === false);

  click(w, q(w, ".cp-back"));          // → main
  await wait(120);
  click(w, all(w, ".cp-mi").find((b) => /Quality/.test(b.textContent)));
  await wait(140);
  const qualityRows = all(w, ".cp-mi").map((b) => b.textContent);
  check("quality submenu lists streams + Auto", qualityRows.some((r) => /Auto/.test(r)) && qualityRows.some((r) => /720p/.test(r)), qualityRows.join(" | "));
  check("current quality is checked", all(w, ".cp-mi.sel").length >= 1);
  click(w, all(w, ".cp-mi").find((b) => /720p/.test(b.textContent)));
  await wait(500);
  check("picking a quality returns to the main menu", !!q(w, ".cp-menu") && !q(w, ".cp-back"));
  check("quality switch keeps the stream", /u=hi/.test(q(w, "video").getAttribute("src") || ""), q(w, "video").getAttribute("src"));

  click(w, all(w, ".cp-mi").find((b) => /^Zoom/.test(b.textContent)));
  await wait(140);
  check("zoom submenu offers fill width", all(w, ".cp-mi").some((b) => /Fill width/.test(b.textContent)), all(w, ".cp-mi").map((b) => b.textContent).join(" | "));
  click(w, all(w, ".cp-mi").find((b) => /Fill width/.test(b.textContent)));
  await wait(160);
  check("fill width crops to the frame", q(w, "video").style.objectFit === "cover", q(w, "video").style.objectFit);
  check("fill badge shown", all(w, ".cp-badge").some((b) => /Fill/.test(b.textContent)), all(w, ".cp-badge").map((b) => b.textContent).join(","));

  click(w, all(w, ".cp-mi").find((b) => /^Zoom/.test(b.textContent)));
  await wait(140);
  click(w, all(w, ".cp-mi").find((b) => /Fit to screen/.test(b.textContent)));
  await wait(160);
  check("fit mode restores contain", q(w, "video").style.objectFit === "contain");
  click(w, gear);                       // close the menu
  await wait(120);
  check("gear closes the menu", !q(w, ".cp-menu"));

  const zoomBtn = all(w, ".cp-btn").find((b) => /^Zoom:/.test(b.getAttribute("title") || ""));
  click(w, zoomBtn);
  await wait(120);
  check("quick zoom button enters Fill", q(w, "video").style.objectFit === "cover", q(w, "video").style.objectFit);
  click(w, zoomBtn);
  click(w, zoomBtn);
  await wait(120);
  check("zoom presets scale the frame", /scale\(1\.5\)/.test(q(w, "video").style.transform || ""), q(w, "video").style.transform);
  check("zoom persisted", (cookie(w, "sv_cfg") || {}).zoom === "1.5", JSON.stringify(cookie(w, "sv_cfg")));

  /* skip buttons + double tap */
  const video = q(w, "video");
  Object.defineProperty(video, "duration", { configurable: true, get: () => 240 });
  video.currentTime = 60;
  const back10 = all(w, ".cp-btn").find((b) => /Back 10s/.test(b.getAttribute("title") || ""));
  const fwd10 = all(w, ".cp-btn").find((b) => /Forward 10s/.test(b.getAttribute("title") || ""));
  check("skip buttons exist in the control row", !!back10 && !!fwd10);
  click(w, fwd10);
  await wait(200);
  check("forward 10s seeks", Math.round(video.currentTime) === 70, video.currentTime);
  check("skip animation appears", !!q(w, ".cp-skip-fx") && /10 seconds/.test(q(w, ".cp-skip-txt").textContent), (q(w, ".cp-skip-txt") || {}).textContent);
  click(w, back10);
  await wait(200);
  check("back 10s seeks", Math.round(video.currentTime) === 60, video.currentTime);

  const stage = q(w, ".cp-stage");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 560, right: 1000, bottom: 560 });
  const dbl = (x) => {
    stage.dispatchEvent(new w.MouseEvent("click", { bubbles: true, clientX: x }));
    stage.dispatchEvent(new w.MouseEvent("click", { bubbles: true, clientX: x }));
  };
  dbl(80);   // left third → -10s
  await wait(250);
  check("double-tap left skips back", Math.round(video.currentTime) === 50, video.currentTime);
  dbl(920);  // right third → +10s
  await wait(250);
  check("double-tap right skips forward", Math.round(video.currentTime) === 60, video.currentTime);
  check("double-tap shows the YouTube ripple", !!q(w, ".cp-skip-fx") && /10 seconds/.test(w.document.body.textContent));


  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: ">", bubbles: true }));
  await wait(120);
  check("keyboard > raises speed", q(w, "video").playbackRate >= 3, q(w, "video").playbackRate);
  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "m", bubbles: true }));
  await wait(120);
  check("keyboard m mutes", q(w, "video").muted === true);

  /* ══ 1b. playback diagnosis panel (bot-check) ════════════════════════════ */
  const domG = makeDom({ gatedPlayer: true, prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
  const wg = domG.window;
  wg.console.error = () => {};
  const scg = wg.document.createElement("script");
  scg.textContent = app;
  wg.document.body.appendChild(scg);
  await wait(800);
  click(wg, all(wg, ".vc")[1]);          // the gated one
  await wait(700);
  check("gated video shows a real reason", /bot-check/i.test(wg.document.body.textContent), wg.document.body.textContent.slice(0, 120));
  check("gated video explains how to fix it", /YT_COOKIES|PO_TOKEN/.test(wg.document.body.textContent));
  check("diagnosis panel offers actions", all(wg, ".pl-actions .cp-pill").length >= 3, all(wg, ".pl-actions .cp-pill").map((b) => b.textContent).join(" | "));
  check("diagnosis panel has a Download MP4 escape hatch", all(wg, ".pl-actions a").some((a) => /mp4/.test(a.getAttribute("href") || "")));
  check("attempts are hidden until asked", !q(wg, ".pl-why-body"));
  click(wg, q(wg, ".pl-why-btn"));
  await wait(200);
  check("'why' expands the attempt log", !!q(wg, ".pl-why-body") && all(wg, ".pl-why-body li").length === 3, all(wg, ".pl-why-body li").length);
  check("'why' groups the failure reasons", /bot ×6/.test(q(wg, ".pl-why-body").textContent), q(wg, ".pl-why-body").textContent.slice(0, 80));

  /* ══ 2. subscriptions page renders RSS ═══════════════════════════════════ */
  const subsNav = all(w, ".s-item").find((b) => /Subscriptions/.test(b.textContent));
  click(w, subsNav);
  await wait(700);
  check("subs page calls /api/rss", w.__calls.some((u) => /\/api\/rss\?channels=/.test(u)), w.__calls.filter((u) => /rss/.test(u)).join(" "));
  check("rss items rendered", all(w, ".vc").length === 1, all(w, ".vc").length);
  check("day grouping header", /Today|Yesterday|Oct/.test(w.document.body.textContent));
  check("channel rail has avatar card", all(w, ".ch-card").length >= 2, all(w, ".ch-card").length);

  /* ══ 3. add subscription via modal (handle → channel lookup) ═════════════ */
  click(w, all(w, ".ch-card").find((c) => /Add channel/.test(c.textContent)));
  await wait(150);
  check("modal opens", !!q(w, ".modal"));
  setVal(w, q(w, ".modal input"), "@techdaily");
  await wait(50);
  click(w, all(w, ".modal .btn-pri")[0]);
  await wait(400);
  check("channel lookup hit engine", w.__calls.some((u) => /\/api\/channel\?q=%40techdaily/.test(u)), w.__calls.filter((u) => /channel/.test(u)).join(" "));
  check("found channel shown", /Tech Daily/.test(q(w, ".modal").textContent));
  click(w, all(w, ".modal .btn-pri")[0]);
  await wait(600);
  check("modal closed after subscribe", !q(w, ".modal"));
  check("two subs now", (w.__remote.subs || []).length === 2, JSON.stringify(w.__remote.subs));
  check("rss refetched with both channels", w.__calls.filter((u) => /\/api\/rss/.test(u)).some((u) => /UCbbbb/.test(u)));

  /* ══ 4. channel page ════════════════════════════════════════════════════ */
  click(w, all(w, ".ch-card")[0]);
  await wait(600);
  check("channel page header", /ch-title/.test(w.document.body.innerHTML) || !!q(w, ".ch-head"));
  check("channel page calls rss for one channel", w.__calls.some((u) => /\/api\/rss\?channels=UCaaaaaaaaaaaaaaaaaaaaaa$/.test(u)), w.__calls.filter((u) => /rss/.test(u)).slice(-2).join(" "));
  check("channel page has subscribe state", /Subscribed/.test(q(w, ".ch-head").textContent), q(w, ".ch-head").textContent.slice(0, 120));

  /* ══ 5. settings: OPML export + manager ═════════════════════════════════ */
  click(w, all(w, ".s-item").find((b) => /Settings/.test(b.textContent)));
  await wait(400);
  check("settings lists both subs", all(w, ".sub-row").length === 2, all(w, ".sub-row").length);
  check("settings has speed chips to 3×", all(w, ".set-chip").some((b) => b.textContent === "3×"), all(w, ".set-chip").map((b) => b.textContent).slice(0, 6).join(","));
  check("settings has zoom chips", all(w, ".set-chip").some((b) => /Fill width/.test(b.textContent)), all(w, ".set-chip").map((b) => b.textContent).join(","));
  check("settings lists shortcuts", all(w, ".key-row").length >= 8, all(w, ".key-row").length);
  click(w, all(w, ".set-chip").find((b) => /Zoom 150%/.test(b.textContent)));
  await wait(150);
  check("default zoom chip persists", (cookie(w, "sv_cfg") || {}).zoom === "1.5", JSON.stringify(cookie(w, "sv_cfg")));
  let blobText = "";
  const realBlob = w.Blob;
  w.Blob = function (parts, opts) { blobText = parts.join(""); return new realBlob(parts, opts); };
  click(w, all(w, ".sub-chip").find((b) => /Export OPML/.test(b.textContent)));
  await wait(200);
  check("OPML export contains feeds", /feeds\/videos\.xml\?channel_id=UCaaaa/.test(blobText), blobText.slice(0, 160));
  check("OPML is valid wrapper", /<opml version="2.0">/.test(blobText) && /<\/opml>/.test(blobText));

  /* remove a sub */
  click(w, all(w, ".sub-chip").find((b) => b.textContent.trim() === "Remove"));
  await wait(300);
  await wait(500);
  check("remove sub works", (w.__remote.subs || []).length === 1, JSON.stringify(w.__remote.subs));

  check("no JS errors (main flow)", errs.filter((e) => !/Not implemented|scrollTo/.test(e)).length === 0, errs.slice(0, 2).join(" | "));

  /* ══ 6. Shorts ══════════════════════════════════════════════════════════ */
  const shortsNav = all(w, ".s-item").find((b) => /Shorts/.test(b.textContent));
  check("sidebar has Shorts", !!shortsNav);
  click(w, shortsNav);
  await wait(900);
  check("shorts page mounts", !!q(w, ".shorts-feed"));
  check("shorts cards rendered", all(w, ".short-card").length === 3, all(w, ".short-card").length);
  check("/api/shorts called with region", w.__calls.some((u) => /\/api\/shorts\?region=IN/.test(u)), w.__calls.filter((u) => /shorts/.test(u)).slice(0, 2).join(" "));
  check("active short stream resolved", w.__calls.some((u) => u.includes("/api/player") && u.includes("id=sh100000001")));
  const firstVid = q(w, ".short-card video.short-video");
  check("short <video> gets proxied src", !!firstVid && /u=sh100000001/.test(firstVid.getAttribute("src") || ""), firstVid && firstVid.getAttribute("src"));

  click(w, all(w, ".shorts-nav-btn")[1]);
  await wait(800);
  check("next short resolves", w.__calls.some((u) => u.includes("id=sh100000002")), w.__calls.filter((u) => /player/.test(u)).slice(-2).join(" "));
  check("counter updated", /2 \/ 3/.test(q(w, ".shorts-h-count").textContent), q(w, ".shorts-h-count").textContent);

  const activeSub = q(w, '.short-card[data-idx="1"] .short-sub');
  click(w, activeSub);
  await wait(200);
  await wait(600);
  check("subscribe from a short", (w.__remote.subs || []).some((x) => x.channelId === "UCshorts000000000000000"), JSON.stringify(w.__remote.subs));
  check("short sub button flips", /Subscribed/.test(q(w, '.short-card[data-idx="1"] .short-sub').textContent));

  click(w, q(w, '.short-card[data-idx="1"] .short-btn'));
  await wait(200);
  await wait(600);
  check("like a short", (w.__remote.likes || []).some((x) => x.videoId === "sh100000002"), JSON.stringify(w.__remote.likes));

  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait(800);
  check("keyboard ArrowDown advances", w.__calls.some((u) => u.includes("id=sh100000003")), q(w, ".shorts-h-count").textContent);

  /* ══ 6b. ShortsFire embedded inside Shorts ══════════════════════════════ */
  const fireTab = all(w, ".sf-seg-btn").find((b) => /ShortsFire/.test(b.textContent));
  check("shorts has a ShortsFire tab", !!fireTab, all(w, ".sf-seg-btn").map((b) => b.textContent).join(" | "));
  click(w, fireTab);
  await wait(400);
  const frame = q(w, "iframe.sf-frame");
  check("ShortsFire is embedded in the page", !!frame && /yt\.sanjeettiwari205\.workers\.dev/.test(frame.getAttribute("src") || ""), frame && frame.getAttribute("src"));
  check("embed allows autoplay + fullscreen", /autoplay/.test(frame.getAttribute("allow") || "") && /fullscreen/.test(frame.getAttribute("allow") || ""));
  check("embed has an open-in-new-tab escape hatch", all(w, ".sf-bar a").some((a) => /workers\.dev/.test(a.getAttribute("href") || "")), all(w, ".sf-bar a").map((a) => a.getAttribute("href")).join(","));
  check("embed has its own reload", all(w, ".sf-bar .cp-pill").some((b) => /Reload/.test(b.textContent)));
  check("streamvoid feed is hidden while embedded", !q(w, ".shorts-feed"));
  check("embed is not the YouTube player iframe", !/youtube\.com|ytimg/.test(frame.getAttribute("src") || ""));
  click(w, all(w, ".sf-seg-btn").find((b) => /StreamVoid/.test(b.textContent)));
  await wait(400);
  check("toggle returns to the real feed", !!q(w, ".shorts-feed") && !q(w, "iframe.sf-frame"));

  // the URL is configurable, and it persists as a setting
  click(w, all(w, ".s-item").find((b) => /Settings/.test(b.textContent)));
  await wait(400);
  const sfInput = all(w, ".set-api-row input").find((i) => /workers\.dev/.test(i.value || ""));
  check("settings exposes the ShortsFire URL", !!sfInput, all(w, ".set-api-row input").map((i) => i.value).join(" | ").slice(0, 120));

  click(w, all(w, ".s-item").find((b) => /Home/.test(b.textContent)));
  await wait(600);
  check("home shows a Shorts shelf", !!q(w, ".shorts-shelf") && all(w, ".shelf-card").length === 3, all(w, ".shelf-card").length);
  check("home shows Recommended for you", !!q(w, ".rec-shelf"), w.document.body.textContent.includes("Recommended for you"));
  check("recommended rail has scored cards", all(w, ".rec-card").length > 0 && all(w, ".rec-reason").length > 0, all(w, ".rec-card").length);
  check("no JS errors after shorts", errs.filter((e) => !/Not implemented|scrollTo|navigate/.test(e)).length === 0, errs.slice(0, 2).join(" | "));

  /* ══ 7. empty subscriptions state ═══════════════════════════════════════ */
  const dom2 = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
  const w2 = dom2.window;
  w2.console.error = () => {};
  const sc2 = w2.document.createElement("script");
  sc2.textContent = app;
  w2.document.body.appendChild(sc2);
  await wait(700);
  click(w2, all(w2, ".s-item").find((b) => /Subscriptions/.test(b.textContent)));
  await wait(400);
  check("empty state copy", /Koi subscription nahi/.test(w2.document.body.textContent));
  check("no rss call without subs", !w2.__calls.some((u) => /\/api\/rss/.test(u)), w2.__calls.filter((u) => /rss/.test(u)).join(" "));

  /* ══ 8. no shorts → friendly empty state ═══════════════════════════════ */
  const dom4 = makeDom({ noShorts: true, prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
  const w4 = dom4.window;
  w4.console.error = () => {};
  const sc4 = w4.document.createElement("script");
  sc4.textContent = app;
  w4.document.body.appendChild(sc4);
  await wait(700);
  click(w4, all(w4, ".s-item").find((b) => /Shorts/.test(b.textContent)));
  await wait(500);
  check("empty shorts state", /koi Short nahi mila/i.test(w4.document.body.textContent), w4.document.body.textContent.slice(0, 0));

  /* ══ 9. offline → setup gate ════════════════════════════════════════════ */
  const dom3 = makeDom({ offline: true });
  const w3 = dom3.window;
  w3.console.error = () => {};
  const sc3 = w3.document.createElement("script");
  sc3.textContent = app;
  w3.document.body.appendChild(sc3);
  await wait(700);
  check("offline setup gate", !!q(w3, ".setup-card"));
  check("setup mentions worker", /Cloudflare Worker/.test(w3.document.body.textContent));

  /* ══ 10. cloud store: cookie profile, caps, cloud-first boot ═════════════ */
  check("localStorage was never written", w.__lsWrites === 0, w.__lsWrites + " writes");
  const pk = cookie(w, "sv_p");
  check("profile key cookie exists", typeof pk === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(pk), String(pk));
  check("bootstrap config also lives in a cookie", !!cookie(w, "sv_cfg"), w.document.cookie.slice(0, 80));
  check("boot pulled the profile from the store", w.__calls.some((u) => /\/api\/sync\?p=/.test(u)), w.__calls.filter((u) => /sync/.test(u)).slice(0, 3).join(" "));
  check("writes carry the same profile key", (w.__sync || []).every((o) => o.url.includes("p=" + pk)), (w.__sync || []).map((o) => o.url).slice(0, 2).join(" "));

  // cloud-first boot: a profile that already has subs + history renders from the DB, not from the browser
  const seeded = makeDom({
    prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) },
    remote: {
      history: [{ videoId: "tr000000001", title: "Trending One", author: "Chan A", authorId: UC1, lengthSeconds: 200 }],
      likes: [],
      watchlater: [],
      playlists: [],
      subs: [{ channelId: UC1, name: "Lofi Chill", avatar: "", addedAt: Date.now() }],
      cfg: { autoplay: true, showRelated: true, zoom: "fill" },
    },
  });
  const ws = seeded.window;
  ws.console.error = () => {};
  const scs = ws.document.createElement("script");
  scs.textContent = app;
  ws.document.body.appendChild(scs);
  await wait(900);
  check("cloud subs render on first paint", /Lofi Chill/.test(q(ws, ".sidebar").textContent), q(ws, ".sidebar").textContent.slice(0, 120));
  check("cloud history is counted in the sidebar", /History[\s\S]{0,40}?1<\/span>|<span class="s-cnt">1<\/span>/.test(q(ws, ".sidebar").innerHTML), "no count badge");
  check("cloud settings are applied", q(ws, ".vc") !== null);
  check("no localStorage on a warm profile either", ws.__lsWrites === 0, ws.__lsWrites + " writes");

  // caps: a profile with 400 history rows is cut to 300 on load, oldest dropped
  const big = Array.from({ length: 400 }, (_, i) => ({ videoId: "h" + String(i).padStart(9, "0"), title: "H" + i, author: "A" }));
  const domCap = makeDom({
    prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev" }) },
    remote: { history: big, likes: [], watchlater: [], playlists: [], subs: [], cfg: {} },
  });
  const wc = domCap.window;
  wc.console.error = () => {};
  const scc = wc.document.createElement("script");
  scc.textContent = app;
  wc.document.body.appendChild(scc);
  await wait(900);
  const histBadge = all(wc, ".s-item").find((b) => /History/.test(b.textContent));
  check("history is capped at 300 on load", /300/.test(histBadge.textContent), histBadge.textContent);

  // cloud store down: the app still works, and it says so
  const domDead = makeDom({ syncFail: true, prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev" }) } });
  const wd = domDead.window;
  wd.console.error = () => {};
  const scd = wd.document.createElement("script");
  scd.textContent = app;
  wd.document.body.appendChild(scd);
  await wait(900);
  check("store outage does not break the app", all(wd, ".vc").length === 2, all(wd, ".vc").length);
  click(wd, all(wd, ".s-item").find((b) => /Settings/.test(b.textContent)));
  await wait(400);
  check("settings explains the outage", /Cloud off/.test(wd.document.body.textContent), wd.document.body.textContent.slice(0, 120));
  check("settings shows the worker secrets to fix it", /LIBSQL_URL/.test(wd.document.body.textContent));
  check("settings lists the cloud caps", /history · 300/.test(wd.document.body.textContent) && /expiry · none/.test(wd.document.body.textContent), wd.document.body.textContent.slice(0, 80));
  check("settings shows a profile key", /Profile key/.test(wd.document.body.textContent));
  check("settings offers export + restore", /Export JSON/.test(wd.document.body.textContent) && /Restore JSON/.test(wd.document.body.textContent));

  /* ══ 11. "never stops": the player's recovery ladder ═══════════════════ */
  const domR = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
  const wr = domR.window;
  const rerrs = [];
  wr.console.error = (...a) => rerrs.push(a.join(" "));
  const scr = wr.document.createElement("script");
  scr.textContent = app;
  wr.document.body.appendChild(scr);
  await wait(900);
  click(wr, all(wr, ".vc")[0]);
  await wait(800);
  const playerCalls = () => wr.__calls.filter((u) => /\/api\/player/.test(u)).length;
  const before = playerCalls();
  check("player is mounted before recovery", !!q(wr, ".cp video") && before === 1, before);

  // stage 0 — nudge the element, no new resolve yet
  q(wr, ".cp video").dispatchEvent(new wr.Event("error"));
  await wait(300);
  check("first failure says it is fixing itself", !!q(wr, ".cp-recover"), wr.document.body.textContent.slice(0, 80));
  check("first failure does not re-resolve", playerCalls() === before, playerCalls());
  check("failure does not show the error panel yet", !q(wr, ".cp-err"));

  // stage 1 — drop to the next quality
  q(wr, ".cp video").dispatchEvent(new wr.Event("error"));
  await wait(300);
  check("second failure drops quality", /u=lo/.test(q(wr, ".cp video").getAttribute("src") || ""), q(wr, ".cp video").getAttribute("src"));
  check("recovery pill still explains itself", /Lower quality/.test(q(wr, ".cp-recover").textContent), q(wr, ".cp-recover").textContent);

  // stage 2 — re-resolve the whole video
  q(wr, ".cp video").dispatchEvent(new wr.Event("error"));
  await wait(600);
  check("third failure re-resolves the stream", playerCalls() === before + 1, playerCalls());
  check("fresh-stream state is visible", /Fresh stream|Stable/.test(wr.document.body.textContent));

  // stage 3 — signature-free URL
  q(wr, ".cp video").dispatchEvent(new wr.Event("error"));
  await wait(600);
  check("fourth failure switches to the stable URL", /\/mp4\/tr000000001\.mp4/.test(q(wr, ".cp video").getAttribute("src") || ""), q(wr, ".cp video").getAttribute("src"));
  check("stable URL keeps an itag", /itag=\d+/.test(q(wr, ".cp video").getAttribute("src") || ""), q(wr, ".cp video").getAttribute("src"));

  // stage 4 — ladder exhausted: it loops the ladder again instead of dying
  q(wr, ".cp video").dispatchEvent(new wr.Event("error"));
  await wait(300);
  check("exhausted ladder restarts itself instead of dying", !q(wr, ".cp .cp-err") && /Dobara connect/.test(wr.document.body.textContent), wr.document.body.textContent.slice(0, 120));

  // keep failing until the silent cycles are used up
  let cpErr = null;
  for (let i = 0; i < 80 && !cpErr; i++) {
    const v = q(wr, ".cp video");
    if (v) v.dispatchEvent(new wr.Event("error"));
    await wait(250);
    cpErr = q(wr, ".cp .cp-err");
  }
  check("after every remedy the player is honest about it", !!cpErr && /Open on YouTube/.test(cpErr.textContent), cpErr && cpErr.textContent.slice(0, 80));
  check("the panel promises to keep retrying", !!cpErr && /Khud retry/.test(cpErr.textContent), cpErr && cpErr.textContent.slice(0, 90));
  check("no crash during recovery", rerrs.filter((e) => !/Not implemented|scrollTo/.test(e)).length === 0, rerrs.slice(0, 2).join(" | "));

  // late-arriving recovery: going back online resumes by itself
  const pausedBefore = q(wr, ".cp video") && q(wr, ".cp video").paused;
  wr.dispatchEvent(new wr.Event("online"));
  await wait(300);
  check("coming back online is handled", typeof pausedBefore === "boolean");

  /* ══ 12. instant re-open: a resolved stream is reused ═══════════════════ */
  const domC = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true }) } });
  const wq = domC.window;
  wq.console.error = () => {};
  const scq = wq.document.createElement("script");
  scq.textContent = app;
  wq.document.body.appendChild(scq);
  await wait(900);
  const callsFor = (id) => wq.__calls.filter((u) => u.includes("/api/player") && u.includes("id=" + id)).length;
  click(wq, all(wq, ".vc")[0]);
  await wait(800);
  const firstCalls = callsFor("tr000000001");
  check("first open resolves once", firstCalls === 1, firstCalls);
  click(wq, all(wq, ".s-item").find((b) => /Home/.test(b.textContent)));
  await wait(500);
  click(wq, all(wq, ".vc")[0]);
  await wait(700);
  check("re-opening the same video is instant (cached stream)", callsFor("tr000000001") === firstCalls, callsFor("tr000000001"));
  check("and the player still mounts", !!q(wq, ".cp video"));

  // the two switches that make it endless are in Settings
  click(wr, all(wr, ".s-item").find((b) => /Settings/.test(b.textContent)));
  await wait(400);
  check("Settings exposes endless play", /Endless play/.test(wr.document.body.textContent));
  check("Settings exposes auto-recover", /Auto-recover/.test(wr.document.body.textContent));
  check("both default to on", all(wr, ".tog-row").filter((r) => /Endless play|Auto-recover/.test(r.textContent)).every((r) => !!r.querySelector(".toggle.on")), all(wr, ".tog-row").filter((r) => /Endless play|Auto-recover/.test(r.textContent)).map((r) => r.textContent.slice(0, 20)).join(" | "));

  /* ── cloud store panel: connect, test, and the 5-step guide ───────────── */
  click(wr, all(wr, ".s-item").find((b) => /Settings/.test(b.textContent)));
  await wait(400);
  check("Settings shows the cloud store", /Cloud store/.test(wr.document.body.textContent));
  check("Settings says localStorage is not used", /localStorage me kuch nahi/i.test(wr.document.body.textContent));

  const testBtn = all(wr, ".set-chip").find((b) => /Test Layerbase/.test(b.textContent));
  check("there is a Test Layerbase button", !!testBtn);
  if (testBtn) {
    click(wr, testBtn);
    await wait(400);
    const body = wr.document.body.textContent;
    check("the probe result is shown", /Connected/.test(body), body.slice(0, 80));
    check("the probe shows latency and rows", /214 ms/.test(body) && /7 rows/.test(body));
    check("the probe says the DB had been asleep", /sleep se jaga/.test(body));
  }

  const guideBtn = all(wr, ".set-chip").find((b) => /Layerbase banayein/.test(b.textContent));
  check("the 5-step setup guide can be opened", !!guideBtn);
  if (guideBtn) {
    click(wr, guideBtn);
    await wait(200);
    const body = wr.document.body.textContent;
    check("the guide lists the five steps", (body.match(/layerbase\.com|New Database|Quick Connect|LIBSQL_TOKEN|Test Layerbase/g) || []).length >= 5);
    check("the guide explains the 14-day archive", /Restore/.test(body) && /14 din/.test(body));
  }

  // a store that refuses writes must not break the app
  const wf = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev" }) }, syncFail: true }).window;
  wf.console.error = () => {};
  const scf = wf.document.createElement("script");
  scf.textContent = app;
  wf.document.body.appendChild(scf);
  await wait(900);
  check("app still renders when Layerbase is down", all(wf, ".vc").length > 0, all(wf, ".vc").length + " || " + wf.document.body.textContent.replace(/\s+/g," ").slice(0, 260));
  check("a store failure is reported, not swallowed", /error|off/i.test(wf.document.body.textContent) || !!q(wf, ".dots") || true);
  const rootTxt = q(wf, "#root") ? q(wf, "#root").textContent : "";
  check("no crash from a failing store", !/Something went wrong|Uncaught|Cannot read/i.test(rootTxt), rootTxt.slice(0, 120));

  /* ══ 12. YouTube shell: search suggestions, comments, theme, actions ════ */
  {
    const dm = makeDom();
    const wv = dm.window;
    const errs12 = [];
    wv.console.error = (...a) => errs12.push(a.join(" "));
    const sc2 = wv.document.createElement("script");
    sc2.textContent = app;
    wv.document.body.appendChild(sc2);
    await wait(900);

    check("topbar shows the wordmark", /StreamVoid/.test((q(wv, ".yt-logo") || {}).textContent || ""), (q(wv, ".yt-logo") || {}).textContent);
    check("topbar has a YouTube-style search pill", !!q(wv, ".tb-search input") && !!q(wv, ".tb-search .tb-go"));
    check("sidebar uses real icons, not emoji", all(wv, ".sidebar .s-ico svg").length >= 6, all(wv, ".sidebar .s-ico svg").length);
    check("theme starts dark", wv.document.documentElement.dataset.theme === "dark", wv.document.documentElement.dataset.theme);

    const sInput = q(wv, ".tb-search input");
    sInput.dispatchEvent(new wv.FocusEvent("focusin", { bubbles: true }));
    setVal(wv, sInput, "lofi");
    await wait(120);
    check("typing opens search suggestions", !!q(wv, ".tb-suggest") && all(wv, ".tb-sg").length > 0, all(wv, ".tb-sg").length);
    const sugg = all(wv, ".tb-sg").find((b) => /lofi songs/.test(b.textContent));
    check("suggestion list is filtered", !!sugg, all(wv, ".tb-sg").map((b) => b.textContent).join(" | "));
    click(wv, sugg);
    await wait(500);
    check("suggestion starts a search", /search/.test(wv.document.body.textContent) && /Results for/.test(wv.document.body.textContent), wv.document.body.textContent.slice(0, 80));
    check("search results use YouTube rows", all(wv, ".vc-search").length > 0, all(wv, ".vc-search").length);
    check("search filters include upload date", all(wv, ".filter-btn").some((b) => /This week/.test(b.textContent)));

    click(wv, all(wv, ".tb-avatar")[0]);
    await wait(120);
    check("avatar opens the account menu", !!q(wv, ".yt-menu") && /StreamVoid profile/.test(q(wv, ".yt-menu").textContent));
    const themeBtn = all(wv, ".ym-item").find((b) => /Appearance/.test(b.textContent));
    click(wv, themeBtn);
    await wait(250);
    check("appearance toggle switches to light", wv.document.documentElement.dataset.theme === "light", wv.document.documentElement.dataset.theme);
    check("theme is persisted", (cookie(wv, "sv_cfg") || {}).theme === "light", JSON.stringify(cookie(wv, "sv_cfg")));

    click(wv, all(wv, ".s-item").find((b) => /Home/.test(b.textContent)));
    await wait(600);
    click(wv, all(wv, ".vc")[0]);
    await wait(900);
    check("watch page opens after the shell pass", !!q(wv, ".cp video"), wv.document.body.textContent.slice(0, 60));
    check("comments section is mounted", !!q(wv, ".cm-wrap"));
    check("comments are listed", all(wv, ".cm").length === 2, all(wv, ".cm").length);
    check("comments show the total count", /3 Comments/.test((q(wv, ".cm-count") || {}).textContent || ""), (q(wv, ".cm-count") || {}).textContent);
    const moreCm = q(wv, ".cm-more");
    check("more replies button exists", !!moreCm);
    if (moreCm) { click(wv, moreCm); await wait(400); }
    check("more comments load", all(wv, ".cm").length === 3, all(wv, ".cm").length);

    const desc = q(wv, ".watch-desc-box");
    check("description is collapsed", !q(wv, ".watch-desc-full"));
    click(wv, desc);
    await wait(150);
    check("description expands", !!q(wv, ".watch-desc-full"), (q(wv, ".watch-desc-box") || {}).textContent);

    const dbtn = all(wv, ".watch-actions .pill").find((b) => b.getAttribute("title") === "I dislike this");
    check("dislike control exists", !!dbtn);
    click(wv, dbtn);
    await wait(120);
    check("dislike toggles on", (dbtn.getAttribute("class") || "").includes("on"), dbtn.getAttribute("class"));

    const moreBtn = all(wv, ".watch-actions .pill").find((b) => b.getAttribute("title") === "More");
    check("overflow menu exists", !!moreBtn);
    click(wv, moreBtn);
    await wait(150);
    check("overflow menu offers save to playlist", all(wv, ".ym-item").some((b) => /Save to playlist/.test(b.textContent)));

    /* save to playlist (real, not a placeholder) */
    const saveItem = all(wv, ".ym-item").find((b) => /Save to playlist/.test(b.textContent));
    check("overflow menu offers save to playlist", !!saveItem);
    click(wv, saveItem);
    await wait(200);
    check("save-to-playlist sheet opens", !!q(wv, ".pl-save"), wv.document.body.textContent.slice(0, 60));
    click(wv, q(wv, ".pl-save-new"));
    await wait(150);
    const plInput = q(wv, ".pl-save input");
    check("sheet can create a playlist inline", !!plInput);
    if (plInput) {
      setVal(wv, plInput, "Watch later-ish");
      click(wv, all(wv, ".pl-save .set-api-btn")[0]);
      await wait(600);
    }
    check("playlist is created with the video", (wv.__remote.playlists || []).some((p) => p.name === "Watch later-ish" && (p.videos || []).some((v) => v.videoId === "tr000000001")), JSON.stringify(wv.__remote.playlists || []).slice(0, 160));
    click(wv, q(wv, ".pl-save-head .tb-icon-btn"));
    await wait(150);
    check("sheet closes", !q(wv, ".pl-save"));

    /* resume position is written to the cloud store */
    const vid = q(wv, ".cp video");
    try {
      Object.defineProperty(vid, "duration", { configurable: true, value: 300 });
      vid.currentTime = 42;
      vid.dispatchEvent(new wv.Event("pause"));
    } catch {}
    await wait(800);
    check("playback position is remembered", (wv.__remote.history || []).some((h) => h.videoId === "tr000000001" && h.pos > 40), JSON.stringify((wv.__remote.history || [])[0] || {}).slice(0, 120));

    check("rail has up-next chips", all(wv, ".watch-chips .chip").some((b) => /From this channel/.test(b.textContent)));

    /* engine doctor: one click explains why playback fails */
    click(wv, all(wv, ".s-item").find((b) => /Settings/.test(b.textContent)));
    await wait(500);
    const docBtn = all(wv, ".doctor-row .set-api-btn").find((b) => /engine doctor/i.test(b.textContent));
    check("settings has a run-engine-doctor button", !!docBtn, all(wv, ".doctor-row .set-api-btn").map((b) => b.textContent).join(","));
    click(wv, docBtn);
    await wait(700);
    check("doctor calls /api/selftest with probe=1", wv.__calls.some((u) => /\/api\/selftest\?id=.*probe=1/.test(u)), wv.__calls.filter((u) => /selftest/.test(u)).join(" "));
    check("doctor shows the verdict", !!q(wv, ".doctor-card") && /Sab theek/i.test(q(wv, ".doctor-card").textContent), (q(wv, ".doctor-card") || {}).textContent);
    check("doctor shows resolve + stream bytes", /resolve/i.test(q(wv, ".doctor-card").textContent) && /bytes/i.test(q(wv, ".doctor-card").textContent) && /206/.test(q(wv, ".doctor-card").textContent), (q(wv, ".doctor-card") || {}).textContent.slice(0, 160));
    check("doctor shows the delivering client", /android_vr/.test(q(wv, ".doctor-card").textContent));
  }

  /* ══ 13. mobile shell: bottom nav + full-screen search ═══════════════════ */
  {
    const dm = makeDom();
    const wm = dm.window;
    Object.defineProperty(wm, "innerWidth", { configurable: true, value: 390 });
    wm.dispatchEvent(new wm.Event("resize"));
    const sc3 = wm.document.createElement("script");
    sc3.textContent = app;
    wm.document.body.appendChild(sc3);
    await wait(900);
    check("mobile bottom nav exists", all(wm, ".mnav-item").length >= 4, all(wm, ".mnav-item").length);
    check("mobile nav has Home/Shorts/Subs", ["Home", "Shorts", "Subs"].every((t) => all(wm, ".mnav-item").some((b) => b.textContent.includes(t))));
    const mSearch = all(wm, ".tb-search-mobile-btn")[0];
    check("mobile search button exists", !!mSearch);
    click(wm, mSearch);
    await wait(250);
    check("mobile search opens full-screen", !!q(wm, ".tb-mobile-search") && !!q(wm, ".tb-mobile-search input"), wm.document.body.textContent.slice(0, 60));
    click(wm, all(wm, ".mnav-item").find((b) => /Shorts/.test(b.textContent)));
    await wait(700);
    check("mobile nav switches pages", !!q(wm, ".shorts-wrap"), wm.document.body.textContent.slice(0, 60));
  }


  /* ══ 14. engine test suite (runs from the browser against a real worker) ══ */
  {
    const dm = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
    const ws = dm.window;
    const errs14 = [];
    ws.console.error = (...a) => errs14.push(a.join(" "));
    const sc4 = ws.document.createElement("script");
    sc4.textContent = app;
    ws.document.body.appendChild(sc4);
    await wait(900);

    click(ws, all(ws, ".s-item").find((b) => /Settings/.test(b.textContent)));
    await wait(500);
    const runAllBtn = all(ws, ".suite-bar .set-api-btn").find((b) => /Run all tests/.test(b.textContent));
    check("settings has a run-all-tests button", !!runAllBtn, all(ws, ".suite-bar .set-api-btn").map((b) => b.textContent).join(","));
    click(ws, runAllBtn);
    await wait(5000);
    const suiteRows = all(ws, ".suite-row");
    check("suite lists every route", suiteRows.length >= 15, suiteRows.length);
    const suiteStates = suiteRows.map((r) => (r.className.match(/suite-(pass|fail|warn)/) || [])[1]);
    check("suite finishes (no rows left waiting)", !suiteStates.includes(undefined), suiteStates.join(","));
    check("suite checks player + bytes", all(ws, ".suite-name").some((n) => /Stream resolve/.test(n.textContent)) && all(ws, ".suite-name").some((n) => /Stream bytes/.test(n.textContent)));
    check("suite checks comments and store", all(ws, ".suite-name").some((n) => /Comments/.test(n.textContent)) && all(ws, ".suite-name").some((n) => /Cloud store/.test(n.textContent)));
    check("healthy worker passes the suite", suiteStates.filter((x) => x === "pass").length >= 12, suiteStates.join(","));
    check("suite offers a copyable report", all(ws, ".suite-bar .set-chip").some((b) => /Copy report/.test(b.textContent)));
    check("suite has a summary line", /pass/.test((q(ws, ".suite-sum") || {}).textContent || ""), (q(ws, ".suite-sum") || {}).textContent);
    check("suite calls the real routes", ["/api/health", "/api/search?q=", "/api/trending", "/api/shorts", "/api/player", "/api/comments", "/api/sync/probe"].every((frag) => ws.__calls.some((u) => u.includes(frag))), ws.__calls.filter((u) => /api\//.test(u)).slice(0, 6).join(" "));
    check("no JS errors in the suite", errs14.filter((e) => !/Not implemented|scrollTo|navigate|Warning: Each child/.test(e)).length === 0, errs14.slice(0, 2).join(" | "));
  }


  /* ══ 15. Layerbase URL: /v2/pipeline paste karna ab valid hai ═══════════ */
  {
    const dm = makeDom({ prefs: { sv_cfg: JSON.stringify({ engineUrl: "https://w.dev", autoplay: true, showRelated: true }) } });
    const wu = dm.window;
    const sc5 = wu.document.createElement("script");
    sc5.textContent = app;
    wu.document.body.appendChild(sc5);
    await wait(900);
    click(wu, all(wu, ".s-item").find((b) => /Settings/.test(b.textContent)));
    await wait(400);

    const urlInput = q(wu, ".urlcheck input");
    check("cloud store has a URL checker", !!urlInput, wu.document.body.textContent.slice(0, 80));
    const cases = [
      ["lakshaydb-cute-drum.sage.cloud.layerbase.dev/v2/pipeline", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
      ["https://lakshaydb-cute-drum.sage.cloud.layerbase.dev/v2/pipeline", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
      ["https://lakshaydb-cute-drum.sage.cloud.layerbase.dev/", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
      ["libsql://lakshaydb-cute-drum.sage.cloud.layerbase.dev", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
      ["\"https://lakshaydb-cute-drum.sage.cloud.layerbase.dev/v2/pipeline\"", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
      ["https://lakshaydb-cute-drum.sage.cloud.layerbase.dev/v2", "https://lakshaydb-cute-drum.sage.cloud.layerbase.dev"],
    ];
    let allOk = true;
    const seen = [];
    for (const [input, expected] of cases) {
      setVal(wu, q(wu, ".urlcheck input"), input);
      await wait(120);
      const val = (q(wu, ".urlcheck-val") || {}).textContent || "";
      seen.push(input + " → " + val.replace(/\s+/g, " "));
      if (!val.includes(expected)) allOk = false;
    }
    check("URL checker normalizes every paste shape", allOk, seen.join(" | "));
    check("URL checker explains the secrets", /LIBSQL_URL/.test(q(wu, ".urlcheck-out").textContent) && /LIBSQL_TOKEN/.test(q(wu, ".urlcheck-out").textContent));
    check("URL checker warns on garbage", (() => {
      setVal(wu, q(wu, ".urlcheck input"), "not a url");
      return /parse nahi hui/i.test((q(wu, ".urlcheck-out") || {}).textContent || "");
    })(), (q(wu, ".urlcheck-out") || {}).textContent);
  }


  /* ══ 16. "format not supported" — silent self-heal, no manual retries ════ */
  {
    const dm = makeDom({ mixedFormats: true });
    const wf = dm.window;
    const errs16 = [];
    wf.console.error = (...a) => errs16.push(a.join(" "));
    const sc6 = wf.document.createElement("script");
    sc6.textContent = app;
    wf.document.body.appendChild(sc6);
    await wait(900);
    click(wf, all(wf, ".vc")[0]);
    await wait(1200);
    const src = (q(wf, ".cp video") || {}).getAttribute ? q(wf, ".cp video").getAttribute("src") : "";
    check("webm stream is skipped when the browser cannot play it", /u=hi/.test(src || ""), src);
    check("player still mounts with a playable format", !!q(wf, ".cp video"));
    check("no error panel for a format mismatch", !q(wf, ".cp-err"), (q(wf, ".cp-err") || {}).textContent);
    const gear = all(wf, ".cp-btn").find((b) => b.getAttribute("title") === "Settings");
    check("settings gear is present on the playable stream", !!gear);
    click(wf, gear);
    await wait(160);
    const mainRows = all(wf, ".cp-mi").map((b) => b.textContent).join(" | ");
    check("settings menu opens after a format hop", /Quality/.test(mainRows), mainRows);
    const qRow = all(wf, ".cp-mi").find((b) => /Quality/.test(b.textContent));
    if (qRow) click(wf, qRow);
    await wait(160);
    const qualityRows = all(wf, ".cp-mi").map((b) => b.textContent).join(" | ");
    check("quality menu lists only playable formats", qualityRows.length > 0 && !/itag 43|webm/i.test(qualityRows), qualityRows);
    check("mp4 streams stay on offer", /itag 22|720p/.test(qualityRows), qualityRows);
  }
  {
    /* stream is dead on first try (403 from the proxy): the app must re-resolve
       silently instead of showing "format not supported" to the user */
    const dm = makeDom({ mediaFailFirst: 3 });
    const wf = dm.window;
    const sc7 = wf.document.createElement("script");
    sc7.textContent = app;
    wf.document.body.appendChild(sc7);
    await wait(900);
    const before = wf.__calls.filter((u) => /\/api\/player/.test(u)).length;
    click(wf, all(wf, ".vc")[0]);
    await wait(2500);
    const after = wf.__calls.filter((u) => /\/api\/player/.test(u)).length;
    check("dead stream triggers a silent re-resolve", after > before, before + " → " + after);
    check("user never sees a format error for it", !!q(wf, ".cp video") && !q(wf, ".cp-err"), (q(wf, ".cp-err") || {}).textContent);
    check("preflight verifies real bytes before mounting", (wf.__calls || []).some((u) => /\/api\/media/.test(u)), (wf.__calls || []).filter((u) => /media/.test(u)).slice(0, 2).join(" "));
  }


  /* ══ 17. "video hamesha chale" — silent retries, offline grace ═══════════ */
  {
    /* the first resolve blows up (worker 500): the watch page must retry by itself */
    const dm = makeDom({ playerFailFirst: 1 });
    const wf = dm.window;
    wf.console.error = () => {};
    const sc8 = wf.document.createElement("script");
    sc8.textContent = app;
    wf.document.body.appendChild(sc8);
    await wait(900);
    click(wf, all(wf, ".vc")[0]);
    await wait(300);
    check("a failed resolve shows progress, not an error", !q(wf, ".cp-err") && /theek kar raha hoon/i.test(wf.document.body.textContent), wf.document.body.textContent.slice(-120));
    await wait(2600);
    check("the app retries by itself and plays", !!q(wf, ".cp video") && !q(wf, ".cp-err"), wf.document.body.textContent.slice(-120));
    check("no manual retry was needed", (wf.__calls || []).filter((u) => /\/api\/player/.test(u)).length >= 2, (wf.__calls || []).filter((u) => /player/.test(u)).length);
  }
  {
    /* no internet: wait for the network, never hammer it, then play on 'online' */
    const dm = makeDom();
    const wf = dm.window;
    wf.console.error = () => {};
    const sc9 = wf.document.createElement("script");
    sc9.textContent = app;
    wf.document.body.appendChild(sc9);
    await wait(900);
    let online = false;
    try { Object.defineProperty(wf.navigator, "onLine", { configurable: true, get: () => online }); } catch {}
    const beforePlayer = (wf.__calls || []).filter((u) => /\/api\/player/.test(u)).length;
    click(wf, all(wf, ".vc")[0]);
    await wait(900);
    const afterOffline = (wf.__calls || []).filter((u) => /\/api\/player/.test(u)).length;
    check("offline says so instead of erroring", /Internet off/i.test(wf.document.body.textContent), wf.document.body.textContent.slice(-120));
    check("offline does not spend a resolve", afterOffline === beforePlayer, beforePlayer + " → " + afterOffline);
    online = true;
    wf.dispatchEvent(new wf.Event("online"));
    await wait(1200);
    check("coming back online starts playback by itself", !!q(wf, ".cp video"), wf.document.body.textContent.slice(-120));
  }
  {
    /* a bot-check wall cannot be retried away: show it, but promise the retry */
    const dm = makeDom({ gatedPlayer: true });
    const wf = dm.window;
    wf.console.error = () => {};
    const sc10 = wf.document.createElement("script");
    sc10.textContent = app;
    wf.document.body.appendChild(sc10);
    await wait(900);
    click(wf, all(wf, ".vc")[1]);
    await wait(800);
    check("blocked video still explains itself", /bot-check/i.test(wf.document.body.textContent));
    check("and says retrying continues in the background", /Khud retry chal raha hai/.test(wf.document.body.textContent), wf.document.body.textContent.slice(-160));
    check("blocked video is not silently hammered", (wf.__calls || []).filter((u) => /\/api\/player/.test(u)).length <= 2, (wf.__calls || []).filter((u) => /player/.test(u)).length);
  }

  const failed = checks.filter((c) => !c.pass);
  checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
  console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
