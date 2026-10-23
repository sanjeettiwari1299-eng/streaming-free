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
        if (/\/api\/search/.test(u)) return ok({ items: TRENDING, continuation: null });
        if (/\/api\/player/.test(u)) return ok(PLAYER);
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

  /* ══ 6. empty subscriptions state ═══════════════════════════════════════ */
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

  /* ══ 7. offline → setup gate ════════════════════════════════════════════ */
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
