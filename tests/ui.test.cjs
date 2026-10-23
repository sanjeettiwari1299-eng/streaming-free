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
      if (opts.prefs) for (const [k, v] of Object.entries(opts.prefs)) w.localStorage.setItem(k, v);
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
      w.fetch = async (url) => {
        const u = String(url);
        w.__calls.push(u);
        if (opts.offline) throw new Error("network down");
        const ok = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
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
          return ok(PLAYER);
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
  await wait(200);
  check("subscribe toggles to Subscribed", /Subscribed/.test(all(w, ".sub-btn")[0].textContent));
  check("sub persisted", JSON.parse(w.localStorage.getItem("sv_subs") || "[]").length === 1);
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
  check("rate persisted", JSON.parse(w.localStorage.getItem("sv_cfg") || "{}").rate === 2.5, w.localStorage.getItem("sv_cfg"));

  const pitchBtn = all(w, ".cp-mi").find((b) => /Preserve pitch/.test(b.textContent));
  check("pitch control present", !!pitchBtn);
  check("pitch preserved by default", q(w, "video").preservesPitch !== false);
  click(w, pitchBtn);
  await wait(120);
  check("varispeed disables pitch preserve", q(w, "video").preservesPitch === false);
  check("pitch persisted", JSON.parse(w.localStorage.getItem("sv_cfg") || "{}").pitch === false);

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
  check("zoom persisted", JSON.parse(w.localStorage.getItem("sv_cfg") || "{}").zoom === "1.5", w.localStorage.getItem("sv_cfg"));

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
  check("two subs now", JSON.parse(w.localStorage.getItem("sv_subs") || "[]").length === 2);
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
  check("default zoom chip persists", JSON.parse(w.localStorage.getItem("sv_cfg") || "{}").zoom === "1.5", w.localStorage.getItem("sv_cfg"));
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
  check("remove sub works", JSON.parse(w.localStorage.getItem("sv_subs") || "[]").length === 1);

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
  check("subscribe from a short", JSON.parse(w.localStorage.getItem("sv_subs") || "[]").some((x) => x.channelId === "UCshorts000000000000000"), w.localStorage.getItem("sv_subs"));
  check("short sub button flips", /Subscribed/.test(q(w, '.short-card[data-idx="1"] .short-sub').textContent));

  click(w, q(w, '.short-card[data-idx="1"] .short-btn'));
  await wait(200);
  check("like a short", (JSON.parse(w.localStorage.getItem("sv_f") || "[]")).some((x) => x.videoId === "sh100000002"));

  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await wait(800);
  check("keyboard ArrowDown advances", w.__calls.some((u) => u.includes("id=sh100000003")), q(w, ".shorts-h-count").textContent);

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

  const failed = checks.filter((c) => !c.pass);
  checks.forEach((c) => console.log((c.pass ? "PASS  " : "FAIL  ") + c.n + (c.pass || !c.e ? "" : "  -> " + c.e)));
  console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
