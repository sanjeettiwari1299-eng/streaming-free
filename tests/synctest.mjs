/**
 * Cloud store tests — Layerbase libSQL (Hrana v2 pipeline over HTTPS).
 *
 * The worker is pointed at a fake Layerbase endpoint whose SQL actually runs on
 * SQLite (node:sqlite), so the statements we ship are the statements that are
 * tested: the schema, the upsert, and the trim that enforces every cap.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const mod = path.join(os.tmpdir(), `worker_sync_${Date.now()}.mjs`);
fs.writeFileSync(mod, src);
const W = await import("file://" + mod + "?v=" + Date.now());

const checks = [];
const check = (n, c, e) => checks.push({ n, pass: !!c, e });

/* ── fake Layerbase: real SQLite behind a Hrana v2 pipeline ───────────────── */
const db = new DatabaseSync(":memory:");
const enc = (v) => {
  if (v == null) return { type: "null" };
  if (typeof v === "number") return { type: "integer", value: String(v) };
  return { type: "text", value: String(v) };
};
const dec = (v) => {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  if (v.type === "null") return null;
  if (v.type === "integer" || v.type === "float") return Number(v.value);
  return v.value;
};

const server = { mode: "ok", calls: 0, lastSql: [], auth: [], error: "" };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://fake.layerbase.dev")) {
    return new Response(JSON.stringify({ error: "unexpected host " + u }), { status: 400 });
  }
  if (server.mode === "down") return new Response("upstream down", { status: 503 });
  if (server.mode === "jwt") {
    return new Response(JSON.stringify({ error: "Unauthorized: The JWT is invalid" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const body = JSON.parse(opts.body || "{}");
  server.calls++;
  server.auth.push((opts.headers || {}).authorization || "");
  const results = [];
  for (const req of body.requests || []) {
    if (req.type === "close") {
      results.push({ type: "ok", response: { type: "close" } });
      continue;
    }
    const sql = req.stmt.sql;
    const args = (req.stmt.args || []).map(dec);
    server.lastSql.push(sql);
    try {
      const st = db.prepare(sql);
      if (/^\s*(select|pragma)/i.test(sql)) {
        const rows = st.all(...args);
        const cols = rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [];
        results.push({
          type: "ok",
          response: {
            type: "execute",
            result: { cols, rows: rows.map((r) => Object.values(r).map(enc)), affected_row_count: 0 },
          },
        });
      } else {
        const info = st.run(...args);
        results.push({
          type: "ok",
          response: { type: "execute", result: { cols: [], rows: [], affected_row_count: Number(info.changes || 0) } },
        });
      }
    } catch (e) {
      results.push({ type: "error", error: { message: e.message, code: "SQL_ERROR" } });
    }
  }
  return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
};

// Cache API shim (the stale-snapshot fallback)
const snapshotCache = new Map();
globalThis.caches = {
  default: {
    async match(r) {
      const v = snapshotCache.get(r.url);
      return v === undefined ? undefined : new Response(v);
    },
    async put(r, res) {
      snapshotCache.set(r.url, await res.text());
      return true;
    },
  },
};

const ENV = { LIBSQL_URL: "https://fake.layerbase.dev", LIBSQL_TOKEN: "tok_test_123" };
const KEY = "abcDEF0123456789_-XY";
const row = (uid) => db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid = ?").get(uid).c;
const vid = (i) => ({ videoId: "vid" + String(i).padStart(8, "0"), title: "T" + i, author: "A" });

/* ── 1. config detection ──────────────────────────────────────────────────── */
check("store is detected as configured", W.storeConfigured(ENV) === true);
check("missing token = not configured", W.storeConfigured({ LIBSQL_URL: "https://x" }) === false);
check("libsql:// scheme is rewritten", W.libsqlBase({ LIBSQL_URL: "libsql://db.layerbase.dev/" }) === "https://db.layerbase.dev");

const off = await W.syncGet({}, KEY);
check("unconfigured read fails soft", off.ok === false && off.configured === false, JSON.stringify(off));
const offW = await W.syncWrite({}, KEY, { kind: "history", upsert: [{ id: "x", data: {} }] });
check("unconfigured write fails soft", offW.ok === false && offW.configured === false);

/* ── 2. profile key validation ────────────────────────────────────────────── */
check("short keys are rejected", W.validProfileKey("abc") === false);
check("bad characters are rejected", W.validProfileKey("abcDEF0123456789$$$$") === false);
check("22-char keys are accepted", W.validProfileKey(KEY) === true);
const bad = await W.syncGet(ENV, "nope");
check("a bad key never reaches the DB", bad.ok === false && /16-64/.test(bad.error), bad.error);

/* ── 3. schema + round trip ──────────────────────────────────────────────── */
const w1 = await W.syncWrite(ENV, KEY, {
  ops: [
    { kind: "history", upsert: [{ id: "v1", pos: 100, data: { videoId: "v1", title: "one" } }] },
    { kind: "subs", upsert: [{ id: "UC1", pos: 50, data: { channelId: "UC1", name: "Chan" } }] },
    { kind: "cfg", upsert: [{ id: "cfg", pos: 1, data: { autoplay: false, theater: true } }] },
  ],
});
check("write succeeds", w1.ok === true && w1.written === 3, JSON.stringify(w1).slice(0, 140));
check("schema exists after first write", db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='sv_store'").get().c === 1);
check("index exists too", db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='sv_store_trim'").get().c === 1);
check("token is sent as a bearer", server.auth.every((a) => a === "Bearer tok_test_123"));

const g1 = await W.syncGet(ENV, KEY);
check("read returns the profile", g1.ok === true && g1.backend === "layerbase-libsql", JSON.stringify(g1).slice(0, 120));
check("history comes back", g1.store.history.length === 1 && g1.store.history[0].title === "one");
check("subs come back", g1.store.subs.length === 1 && g1.store.subs[0].channelId === "UC1");
check("cfg comes back as an object", g1.store.cfg && g1.store.cfg.theater === true);
check("caps ship with the payload", g1.caps.history === 300 && g1.caps.subs === 150);

/* ── 4. the cap: aage ka yaad, peeche ka bhool ───────────────────────────── */
const many = Array.from({ length: 340 }, (_, i) => ({ id: vid(i).videoId, pos: 1000 + i, data: vid(i) }));
const w2 = await W.syncWrite(ENV, KEY, { kind: "history", upsert: many });
check("bulk write is accepted", w2.ok === true && w2.written === 340);
check("history is trimmed to 300", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='history'").get(KEY).c === 300);
const g2 = await W.syncGet(ENV, KEY);
check("the newest survive", g2.store.history[0].videoId === vid(339).videoId, g2.store.history[0].videoId);
check("the oldest are gone", !g2.store.history.some((v) => v.videoId === vid(0).videoId));
check("newest first", g2.store.history[1].videoId === vid(338).videoId);

// a second write with 400 new items must still land on exactly 300
await W.syncWrite(ENV, KEY, { kind: "history", upsert: Array.from({ length: 400 }, (_, i) => ({ id: vid(1000 + i).videoId, pos: 9000 + i, data: vid(1000 + i) })) });
check("cap holds after repeated floods", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='history'").get(KEY).c === 300);

/* ── 5. other caps ───────────────────────────────────────────────────────── */
await W.syncWrite(ENV, KEY, { kind: "subs", upsert: Array.from({ length: 200 }, (_, i) => ({ id: "UC" + i, pos: i, data: { channelId: "UC" + i, name: "C" + i } })) });
check("subs cap at 150", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='subs'").get(KEY).c === 150);
await W.syncWrite(ENV, KEY, { kind: "likes", upsert: Array.from({ length: 520 }, (_, i) => ({ id: "L" + i, pos: i, data: { videoId: "L" + i } })) });
check("likes cap at 500", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='likes'").get(KEY).c === 500);
await W.syncWrite(ENV, KEY, { kind: "cfg", upsert: [{ id: "cfg", pos: 2, data: { volume: 0.4 } }] });
check("cfg keeps exactly one row", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='cfg'").get(KEY).c === 1);
const g3 = await W.syncGet(ENV, KEY);
check("cfg was replaced, not duplicated", g3.store.cfg.volume === 0.4 && g3.store.cfg.theater === undefined);

/* ── 6. aliases, junk and oversized payloads ─────────────────────────────── */
await W.syncWrite(ENV, KEY, { kind: "wl", upsert: [{ id: "W1", pos: 5, data: { videoId: "W1" } }] });
const g4 = await W.syncGet(ENV, KEY);
check("short kind names are canonicalised", g4.store.watchlater.length === 1);
const junk = await W.syncWrite(ENV, KEY, { ops: [{ kind: "nonsense", upsert: [{ id: "x" }] }] });
check("unknown kinds are ignored, not stored", junk.ok === true && junk.written === 0);
const huge = "x".repeat(70000);
await W.syncWrite(ENV, KEY, { kind: "watchlater", upsert: [{ id: "BIG", pos: 9, data: { videoId: "BIG", blob: huge } }] });
const bigRow = db.prepare("SELECT data FROM sv_store WHERE uid=? AND kind='watchlater' AND id='BIG'").get(KEY);
check("a 70KB item is stubbed, never stored raw", bigRow.data.length < 4000, bigRow.data.slice(0, 60));

/* ── 7. delete + clear ───────────────────────────────────────────────────── */
const d1 = await W.syncWrite(ENV, KEY, { kind: "history", del: [vid(329).videoId] });
check("single delete works", d1.ok === true && !db.prepare("SELECT 1 FROM sv_store WHERE uid=? AND kind='history' AND id=?").get(KEY, vid(329).videoId));
const clear = await W.syncClear(ENV, KEY, "history");
check("clear removes the whole list", clear.ok === true && db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='history'").get(KEY).c === 0);
check("clear leaves other lists alone", db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid=? AND kind='likes'").get(KEY).c === 500);

/* ── 8. profiles are isolated ────────────────────────────────────────────── */
const KEY2 = "zzzYYY0123456789_-QW";
await W.syncWrite(ENV, KEY2, { kind: "likes", upsert: [{ id: "Z1", pos: 1, data: { videoId: "Z1" } }] });
const g5 = await W.syncGet(ENV, KEY2);
check("a second profile sees only its own rows", g5.store.likes.length === 1 && g5.store.subs.length === 0);
check("the first profile is untouched", (await W.syncGet(ENV, KEY)).store.likes.length === 500);

/* ── 9. import (the one-time localStorage rescue) ────────────────────────── */
const KEY3 = "impPPP0123456789_-QR";
const imp = await W.syncImport(ENV, KEY3, {
  store: { history: [vid(1), vid(2)], cfg: { autoplay: true }, subs: [{ channelId: "UC9", name: "Nine" }] },
});
check("import reports what it took", imp.ok === true && imp.imported === 4, JSON.stringify(imp).slice(0, 120));
const g6 = await W.syncGet(ENV, KEY3);
check("imported history lands newest-first", g6.store.history.length === 2 && g6.store.history[0].videoId === vid(1).videoId);
check("imported cfg lands", g6.store.cfg.autoplay === true);
const imp2 = await W.syncImport(ENV, KEY3, { store: {} });
check("empty import is refused", imp2.ok === false);

/* ── 10. Layerbase sleeps / dies → edge snapshot keeps the app alive ─────── */
snapshotCache.clear();
const g7 = await W.syncGet(ENV, KEY); // warms the snapshot
check("a good read writes a snapshot", snapshotCache.size > 0);
server.mode = "down";
const g8 = await W.syncGet(ENV, KEY);
check("outage falls back to the snapshot", g8.ok === true && g8.backend === "edge-snapshot" && g8.stale === true, JSON.stringify(g8).slice(0, 120));
check("the snapshot still holds the data", g8.store.likes.length === 500 && g8.store.subs.length === 150);
check("the failure is reported, not hidden", /503/.test(g8.warning || ""), g8.warning);
const wDown = await W.syncWrite(ENV, KEY, { kind: "history", upsert: [{ id: "H9", pos: 1, data: { videoId: "H9" } }] });
check("a failed write says so instead of lying", wDown.ok === false && /503/.test(wDown.error || ""), wDown.error);
server.mode = "ok";

const KEY4 = "coldCOLD0123456789_-ZZ";
const g9 = await W.syncGet(ENV, KEY4);
check("a never-seen profile reads as empty, not as an error", g9.ok === true && g9.store.history.length === 0);

/* ── 11. HTTP surface (the routes the app actually calls) ────────────────── */
const ORIGIN = "https://worker.example";
const req = (method, url, body) =>
  W.default.fetch(new Request(ORIGIN + url, body ? { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } } : { method }), ENV);

const rGet = await req("GET", "/api/sync?p=" + KEY);
const rGetBody = await rGet.json();
check("GET /api/sync serves the profile", rGet.status === 200 && rGetBody.ok === true && rGetBody.store.subs.length === 150);
const rPost = await req("POST", "/api/sync?p=" + KEY, { kind: "likes", upsert: [{ id: "HTTP1", pos: 99, data: { videoId: "HTTP1" } }] });
const rPostBody = await rPost.json();
check("POST /api/sync writes", rPost.status === 200 && rPostBody.ok === true && rPostBody.written === 1);
const rDel = await req("DELETE", "/api/sync?p=" + KEY + "&kind=likes");
check("DELETE /api/sync clears", rDel.status === 200 && (await rDel.json()).ok === true);
const rImp = await req("POST", "/api/sync/import?p=" + KEY3, { store: { watchlater: [vid(7)] } });
check("POST /api/sync/import works over HTTP", rImp.status === 200 && (await rImp.json()).imported === 1);
const rBad = await req("PUT", "/api/sync?p=" + KEY);
check("wrong method is a 405", rBad.status === 405);
const rNoKey = await req("GET", "/api/sync?p=short");
check("bad key over HTTP is a clean JSON error", rNoKey.status === 200 && (await rNoKey.json()).ok === false);

/* ── 12. health + landing page advertise the store ───────────────────────── */
const health = await (await W.default.fetch(new Request(ORIGIN + "/api/health"), ENV)).json();
check("health reports the store backend", health.store && health.store.backend === "layerbase-libsql" && health.store.configured === true);
check("health publishes the caps", health.store.caps.history === 300 && health.store.caps.subs === 150);
check("health says nothing expires", /none/i.test(health.store.ttl), health.store.ttl);
const landing = await (await W.default.fetch(new Request(ORIGIN + "/"), ENV)).text();
check("landing page shows the store badge", /store: layerbase libSQL/.test(landing));
const landingOff = await (await W.default.fetch(new Request(ORIGIN + "/"), {})).text();
check("landing page warns when unconfigured", /store: not configured/.test(landingOff));

/* ── 13. scheduled heartbeat keeps the free DB out of the archive ────────── */
const before = db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid='__system'").get().c;
await W.default.scheduled({}, ENV, {});
await W.default.scheduled({}, ENV, {});
const beat = db.prepare("SELECT COUNT(*) c FROM sv_store WHERE uid='__system' AND kind='ping'").get().c;
check("cron heartbeat writes once, not once per run", before === 0 && beat === 1, `${before} → ${beat}`);
const schedQuiet = await W.default.scheduled({}, {}, {});
check("scheduled() is a no-op without config", schedQuiet === undefined);

/* ── 14. statements we ship are the statements tested ────────────────────── */
const { stmts } = W.opsToStatements(KEY, [{ kind: "history", upsert: [{ id: "a", data: {} }], del: ["b"] }]);
check("one upsert + one delete + one trim", stmts.length === 3, stmts.map((s) => s.sql.slice(0, 22)).join(" | "));
check("trim is the last statement", /^DELETE FROM sv_store WHERE uid = \? AND kind = \? AND id NOT IN/.test(stmts[2].sql));
check("trim carries the cap as an integer arg", stmts[2].args[4].type === "integer" && stmts[2].args[4].value === "300");
check("opsToStatements drops unknown kinds", W.opsToStatements(KEY, [{ kind: "xx", upsert: [{ id: "a" }] }]).stmts.length === 0);

/* ── 15. setup probe: "is Layerbase really connected?" ───────────────────── */
const probeOff = await W.storeProbe({}, "");
check("probe says not configured when secrets are missing", probeOff.ok === false && probeOff.configured === false);
check("probe hands back the setup steps", Array.isArray(probeOff.steps) && probeOff.steps.length >= 5, (probeOff.steps || []).length);
check("probe tells you the path is not needed", probeOff.steps.join(" ").includes("/v2/pipeline"), probeOff.steps.join(" | ").slice(0, 160));

/* the "link sahi hai par invalid" bug: a pasted endpoint URL must still work */
const ENV_PATHY = { ...ENV, LIBSQL_URL: String(ENV.LIBSQL_URL || "").replace(/\/+$/, "") + "/v2/pipeline" };
const probePathy = await W.storeProbe(ENV_PATHY, KEY);
check("probe accepts a pasted /v2/pipeline URL", probePathy.ok === true, JSON.stringify({ ok: probePathy.ok, err: probePathy.error }));
check("probe reports the normalized endpoint", /\/v2\/pipeline$/.test(String(probePathy.endpoint || "")) && !/pipeline\/v2\/pipeline/.test(String(probePathy.endpoint || "")), probePathy.endpoint);
const probeNoScheme = await W.storeProbe({ ...ENV, LIBSQL_URL: String(ENV.LIBSQL_URL || "").replace(/^https?:\/\//, "") }, KEY);
check("probe accepts a URL without a scheme", probeNoScheme.ok === true, JSON.stringify({ ok: probeNoScheme.ok, err: probeNoScheme.error }));
const probeGarbage = await W.storeProbe({ ...ENV, LIBSQL_URL: "not a url" }, KEY);
check("probe explains an unparseable URL", probeGarbage.ok === false && /parse nahi hui/i.test(probeGarbage.error || ""), probeGarbage.error);
check("probe shows what it parsed", probeGarbage.url && probeGarbage.url.given === true, JSON.stringify(probeGarbage.url));
check("steps name the two secrets", probeOff.steps.join(" ").includes("LIBSQL_URL") && probeOff.steps.join(" ").includes("LIBSQL_TOKEN"));

const probe = await W.storeProbe(ENV, KEY);
check("probe reports ok against a live store", probe.ok === true && probe.configured === true, JSON.stringify(probe).slice(0, 120));
check("probe reports the host, not the token", probe.host === "fake.layerbase.dev" && !JSON.stringify(probe).includes(ENV.LIBSQL_TOKEN), probe.host);
check("probe reports a latency", typeof probe.latencyMs === "number" && probe.latencyMs >= 0, probe.latencyMs);
check("probe counts this profile's rows", typeof probe.rows === "number" && probe.rows > 0, probe.rows);
check("probe promises no TTL", probe.ttl === "none" && probe.caps.history === 300);

server.mode = "down";
const probeBad = await W.storeProbe(ENV, KEY);
check("probe surfaces a real failure", probeBad.ok === false && /boom|layerbase/i.test(probeBad.error || ""), probeBad.error);
check("probe explains how to fix it", /LIBSQL_URL|wake|Restore/i.test(probeBad.hint || ""), probeBad.hint);
server.mode = "ok";

const viaRoute = await (await W.default.fetch(new Request("https://w.dev/api/sync/probe?p=" + KEY), ENV)).json();
check("probe is reachable over HTTP", viaRoute.ok === true && viaRoute.backend === "layerbase-libsql");
const healthProbe = await (await W.default.fetch(new Request("https://w.dev/api/health"), ENV)).json();
check("health points at the probe", healthProbe.store.probe === "/api/sync/probe");

/* ── "The JWT is invalid" — 4 alag wajah, alag message ──────────────────── */
const b64j = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mkJwt = (payload) => "eyJhbGciOiJFZERTQSJ9." + b64j(payload) + ".c2lnbmF0dXJl";
const nowSec = Math.floor(Date.now() / 1000);
const HOST = "https://fake.layerbase.dev";

const jwtLive = W.decodeJwtInfo(mkJwt({ id: "fake", a: "rw", exp: nowSec + 86400 }));
check("decodeJwtInfo reads a real JWT", jwtLive.jwt === true && jwtLive.parts === 3 && jwtLive.expired === false, JSON.stringify(jwtLive));
check("decodeJwtInfo reads db id + scope", jwtLive.dbId === "fake" && jwtLive.scope === "rw", JSON.stringify(jwtLive));
const jwtDead = W.decodeJwtInfo(mkJwt({ id: "fake", exp: nowSec - 60 }));
check("decodeJwtInfo spots an expired token", jwtDead.expired === true && /^\d{4}-\d{2}-\d{2}$/.test(jwtDead.expIso), JSON.stringify(jwtDead));
check("decodeJwtInfo rejects a non-JWT secret", W.decodeJwtInfo("sk_live_abc").jwt === false);
check("decodeJwtInfo survives garbage", W.decodeJwtInfo("a.b.c").jwt === false && W.decodeJwtInfo("").parts === 1);
check("jwtDbMatch compares the host label", W.jwtDbMatch("fake", "fake.layerbase.dev") === true && W.jwtDbMatch("other", "fake.layerbase.dev") === false);
check("jwtDbMatch is honest when unsure", W.jwtDbMatch("", "fake.layerbase.dev") === null);

const vExpired = W.jwtVerdict({ ...ENV, LIBSQL_TOKEN: mkJwt({ id: "fake", exp: nowSec - 60 }) }, { status: 401, message: "layerbase HTTP 401: Unauthorized: The JWT is invalid" });
check("401 + expired token → jwt-expired", vExpired && vExpired.code === "jwt-expired" && /expire/i.test(vExpired.error), JSON.stringify(vExpired).slice(0, 120));
const vOther = W.jwtVerdict({ ...ENV, LIBSQL_TOKEN: mkJwt({ id: "someone-else", exp: nowSec + 999 }) }, { status: 401 });
check("401 + other database → jwt-wrong-db", vOther && vOther.code === "jwt-wrong-db" && /dusri database/i.test(vOther.error), JSON.stringify(vOther).slice(0, 120));
const vFormat = W.jwtVerdict({ ...ENV, LIBSQL_TOKEN: "glpat-not-a-jwt" }, { status: 401 });
check("401 + non-JWT secret → jwt-format", vFormat && vFormat.code === "jwt-format" && /LIBSQL_TOKEN/i.test(vFormat.error), JSON.stringify(vFormat).slice(0, 120));
const vApiKey = W.jwtVerdict({ ...ENV, LIBSQL_TOKEN: "sk_live_4f8a2c1b9d7e" }, { status: 401 });
check("sk_ API key gets its own verdict", vApiKey && vApiKey.code === "jwt-api-key", JSON.stringify(vApiKey).slice(0, 120));
check("sk_ verdict explains it is the Cloud API key", /Cloud REST API|cloud\.layerbase\.dev/i.test(vApiKey.error), vApiKey.error);
check("sk_ verdict points at Quick Connect", /Quick Connect/i.test(vApiKey.hint), vApiKey.hint);
check("tokenShape describes the secret", (() => {
  const sh = W.libsqlInfo({ ...ENV, LIBSQL_TOKEN: "sk_live_abc" }).shape;
  return sh.apiKey === true && sh.len === 11 && sh.prefix === "sk_liv" && sh.dots === 0;
})(), JSON.stringify(W.libsqlInfo({ ...ENV, LIBSQL_TOKEN: "sk_live_abc" }).shape));

const vSig = W.jwtVerdict({ ...ENV, LIBSQL_TOKEN: mkJwt({ id: "fake", exp: nowSec + 999 }) }, { status: 401 });
check("401 + good-looking token → jwt-bad-signature", vSig && vSig.code === "jwt-bad-signature", JSON.stringify(vSig).slice(0, 120));
check("non-auth failures are left alone", W.jwtVerdict(ENV, { status: 503, message: "upstream down" }) === null);
check("every JWT verdict carries a fix", [vExpired, vOther, vFormat, vSig].every((v) => /Layerbase|Cloudflare|Deploy/.test(v.hint)), vSig.hint);

/* token ke saare naam + URL me chhupa authToken */
const liveTok = mkJwt({ id: "fake", exp: nowSec + 86400 });
check("LIBSQL_AUTH_TOKEN is accepted", W.libsqlToken({ LIBSQL_URL: HOST, LIBSQL_AUTH_TOKEN: liveTok }) === liveTok);
check("TURSO_AUTH_TOKEN is accepted", W.libsqlToken({ LIBSQL_URL: HOST, TURSO_AUTH_TOKEN: liveTok }) === liveTok);
check("?authToken= in the URL is read", W.libsqlToken({ LIBSQL_URL: "libsql://fake.layerbase.dev?authToken=" + liveTok }) === liveTok);
check("that URL still normalizes to a clean host", W.libsqlBase({ LIBSQL_URL: "libsql://fake.layerbase.dev?authToken=" + liveTok }) === HOST);
check("LIBSQL_DATABASE_URL works as the URL", W.libsqlBase({ LIBSQL_DATABASE_URL: "fake.layerbase.dev/v2/pipeline" }) === HOST);
check("secret beats URL token", W.libsqlToken({ LIBSQL_URL: "libsql://fake.layerbase.dev?authToken=" + mkJwt({ id: "x", exp: 1 }), LIBSQL_TOKEN: liveTok }) === liveTok);
check("token source is reported", W.libsqlInfo({ LIBSQL_URL: "libsql://fake.layerbase.dev?authToken=" + liveTok }).tokenSource === "url");

server.mode = "jwt";
const probeSk = await W.storeProbe({ ...ENV, LIBSQL_TOKEN: "sk_live_4f8a2c1b9d7e" }, "FRESHKEY0123456789");
check("probe flags the account API key", probeSk.ok === false && /API key/i.test(probeSk.error || ""), probeSk.error);
check("probe verdict is jwt-api-key", probeSk.verdict === "jwt-api-key", probeSk.verdict);
const _unused = 0;

const probeJwt = await W.storeProbe(ENV, KEY);
check("probe turns the 401 into a real reason", probeJwt.ok === false && /jwt|token|expire/i.test(probeJwt.error || ""), probeJwt.error);
check("probe names the verdict", /^jwt-/.test(probeJwt.verdict || ""), probeJwt.verdict);
check("probe never echoes the token", !JSON.stringify(probeJwt).includes(ENV.LIBSQL_TOKEN), JSON.stringify(probeJwt).slice(0, 120));
const snapJwt = await W.syncGet(ENV, KEY);
check("a 401 still serves the cached snapshot", snapJwt && snapJwt.ok === true && snapJwt.stale === true, JSON.stringify(snapJwt).slice(0, 120));
const syncJwt = await W.syncGet(ENV, "FRESHKEY0123456789");
check("sync failure carries the same hint", syncJwt && syncJwt.ok !== true && /jwt|token/i.test(syncJwt.error || "") && !!syncJwt.hint, JSON.stringify(syncJwt).slice(0, 160));
server.mode = "ok";

/* ── report ──────────────────────────────────────────────────────────────── */
const failed = checks.filter((c) => !c.pass);
for (const c of failed) console.log("FAIL  " + c.n + (c.e !== undefined ? "   → " + c.e : ""));
console.log(`\n${checks.length - failed.length}/${checks.length} cloud-store checks passed`);
process.exit(failed.length ? 1 : 0);
