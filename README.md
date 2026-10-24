# StreamVoid — serverless YouTube front-end + custom player

`index.html` (whole app, one file) + `worker.js` (Cloudflare Worker, free tier).
**No API key. No Google login. No Piped/Invidious. No server/VPS. No YouTube iframe. No localStorage.**
Search · Trending · **Shorts** (+ **ShortsFire** embed) · **RSS subscriptions** · watch page · **comments** ·
hand-built player. Self-healing playback: **video kabhi band na ho** — 5-step player recovery, proxy re-signing, endless play.

---

## v9.0 — YouTube-jaisa UI (poora shell dobara likha)

Pehle wala UI "YouTube-inspired" tha; ab shell YouTube web jaisa hai — layout, spacing, icons, menus, sab.

| Kya | Ab kaise |
| --- | --- |
| **Logo + topbar** | red play mark + StreamVoid wordmark, 56px bar, guide button, centered search pill with clear + search button, mic |
| **Search** | live suggestions (recent searches cookie me, aapke device par), `/` shortcut se focus, voice search (jahan browser support kare) |
| **Right rail** | Create menu (playlist / subscribe / Studio), notification bell with badge + channel list, avatar menu (history, liked, watch later, theme, settings, cloud state) |
| **Sidebar** | SVG icons (koi emoji nahi), You section, subscriptions with avatars + "show more", Explore (Trending/Music/Gaming/News/Sports/Learning/Podcasts), 72px mini rail on tablets |
| **Home** | sticky chip bar, 310px+ responsive grid, hover "Watch later / Share" on thumbnails, card action menu (save, playlist, copy link, YouTube), Shorts shelf (9:16 cards), Recommended shelf |
| **Watch page** | title + channel row + subscribe/bell, segmented Like/Dislike, Share, Download, Save, overflow menu, expandable description, comments, Up next rail with All / From this channel chips + autoplay toggle |
| **Comments (naya)** | worker ka `/api/comments` — InnerTube `next` ki comments continuation se real comments: author, avatar, likes, replies, creator badge, "show more" paging |
| **Search page** | YouTube-style result rows (360px thumb, 18px title, channel avatar, snippet), This week / Live / Shorts filters, relevance / upload date / view count sort, grid toggle |
| **Channel page** | banner + 128px avatar + handle + tabs (Home/Videos/Shorts/Playlists/About) |
| **Theme** | dark (default) aur light — avatar menu ya Settings → Appearance se, cookie + cloud me save |
| **Mobile** | bottom nav (Home · Shorts · Create · Subs · You), full-screen mobile search, single-column feed, scrollable action pills |
| **Errors** | engine/setup/galat stream messages waise hi honest, par ab card ke andar YouTube-style banners me |

Comments optional hain: agar worker purana ho ya kisi video par comments band hon, section khud bata deta hai
("YouTube par comments dekhein") — watch page kabhi nahi tootta.

---

## "Koi video nahi chal rahi" — 3-minute checklist

Screen par jo panel aata hai wahi sach bolta hai. Us panel me **Engine doctor** button hai; wo ek hi request me
do cheezein batata hai: stream resolve hua ya nahi, aur bytes aa rahe hain ya nahi.

```
GET https://<your-worker>.workers.dev/api/selftest?id=dQw4w9WgXcQ&probe=1
```

| `verdict.code` | Matlab | Fix |
| --- | --- | --- |
| `ok` | resolve + bytes dono theek | browser me chalni chahiye; app me ek baar hard-refresh (Ctrl+Shift+R) |
| `bot` | YouTube bot-check (datacenter IP) | worker secret `YT_COOKIES` (throwaway Google account ka cookie header) ya `POTOKEN_URL` add karein → Deploy |
| `proxy` | resolve hua par stream 403/0 bytes | worker ka **naya version** deploy karein (purana `BUILD` chal raha hai) |
| `resolve` | player hi fail | `/api/debug?refresh=1` kholein, `clientStats` dekhein; `?refresh=1` se client versions dobara discover hote hain |
| `geo` / `age` | region block / age wall | Settings → Region badlein, ya `YT_COOKIES` daalein |

**Poora test suite (17 checks):** Settings → YouTube engine → **▶ Run all tests**. Ye tumhare browser se worker ke
saare routes hit karta hai — health/build, debug, search (+page 2), trending, shorts, channel, rss, player,
**stream bytes (2 KB proxy)**, related, comments, `/mp4/<id>.mp4`, canary, cloud store probe, CORS — aur har row par
pass/warn/fail + ms deta hai. **Copy report** se poora text copy ho jata hai (issue bhejne ke liye).

App ke andar bhi wahi doctor hai: **Settings → YouTube engine → Run engine doctor** (ya video fail hone par
error panel me **Engine doctor**) — video id daalo, ek click me resolve + bytes + client + attempts dikh jate hain.

Sabse pehle ye confirm karein ki deploy naya hai:

```
GET https://<your-worker>.workers.dev/api/health      → build: "8.6.0"
```

Purana build dikhe to Cloudflare → Workers → apna worker → Edit code → **poora `worker.js` paste** → Deploy.
Uske baad app me Settings → **Save & test**.

> **Note:** `PROBE` wala `?probe=1` extra hai — bina uske `/api/selftest?id=...` sirf resolve check karta hai.

### "Format not supported" 2–3 baar aata tha, phir chal jati thi

Wo galti video ki nahi thi — proxy kabhi-kabhi YouTube ka **HTML error page** (ya 403 JSON) 200 me wrap karke
`<video>` ko de deta tha, aur browser usko `MEDIA_ERR_SRC_NOT_SUPPORTED` bana deta tha. Ab dono taraf fix hai:

| Layer | Kya karta hai |
| --- | --- |
| worker `/api/media` | body ka `content-type` check karta hai; HTML/JSON mile to stream cancel karke **naya URL sign** karta hai, phir dusra muxed stream try karta hai. Phir bhi fail ho to `<video>` ko kabhi HTML nahi bhejta — `403/502` + `x-sv-media-fail: 1` JSON bhejta hai |
| app (player) | `playableFormats()` sirf wahi stream rakhta hai jo browser ka `canPlayType` maanta hai (mp4 pehle), `preflightStream()` play karne se **pehle** 2 byte Range maang ke bytes verify karta hai, `verifyStream()` tak 3 format try karta hai |
| app (watch page) | resolve → verify fail ho to **chupchap 2 baar aur** re-resolve karta hai ("Stream refresh ho raha hai… attempt 2/3"), user ko error tabhi dikhta hai jab teeno fail hon |
| app (player error) | video me code 3/4 aaya to player **agli untried format** pe jump karta hai, phir `onRefresh()` — isliye ab manual retry ki zarurat nahi |

Yani agar pehli koshish me hi bytes kharab hain, app khud 2–3 second me dusra stream le aata hai — user ko sirf
"refresh ho raha hai" dikhta hai, "format not supported" nahi.

### "Video hamesha chalti rahe" — kya-kya khud handle hota hai

| Situation | App ka behaviour |
| --- | --- |
| resolve fail (worker 500 / timeout) | 6 silent tries, backoff 0.9s → 2s → 4s → 7s → 12s; phir bhi fail to panel jo **15s me khud retry** karta rehta hai |
| stream bytes nahi aaye | naya URL sign, dubara verify — user ko sirf "Khud theek kar raha hoon… (try n/6)" |
| playback ruk gaya / codec error | nudge → lower quality → fresh stream → `/mp4/<id>.mp4` (bina signature) → poora ladder **3 baar** dobara; uske baad hi panel, aur wo bhi auto-retry |
| `/mp4/<id>.mp4` | worker khud ek dead quality ko chhod ke agli muxed stream try karta hai |
| internet off | koi request nahi jaati, "Internet off — wapas aate hi chal jayegi"; `online` event par khud play |
| worker down | health 12s me ek baar chupchap check hota hai; worker aate hi app apne aap theek |
| video end | next recommendation → trending fallback → `endless` mode me wahi video loop |

Sirf do cheezein retry se theek nahi hoti: **age wall** aur **region block** (unke liye `YT_COOKIES` / Region setting),
aur **bot-check** (worker me `YT_COOKIES` ya `POTOKEN_URL`). Wahan panel asli reason batata hai — par retry background
me chalta rehta hai, to cookie lagane ke baad bina reload video chal padti hai.

---

## "Cookies set kar diye, bot-check phir bhi aa raha hai"

Bot-check ke 4 alag karan hote hain, aur ab app/worker bata dete hain kaun sa hai:

```
GET https://<worker>/api/health        → cookies: { configured, usable, count, missing[], keyOk, note, fix }
GET https://<worker>/api/selftest?id=dQw4w9WgXcQ&probe=1 → verdict.code
```

| `verdict.code` | Matlab | Fix |
| --- | --- | --- |
| `bot` | cookies worker tak pahunche hi nahi | `YT_COOKIES` secret add karein → Deploy |
| `bot-key` | `SV_KEY` set hai par app wahi key nahi bhej raha → worker cookies **jaan bujh ke** use nahi kar raha | Settings → Access key me wahi `SV_KEY` daalein, ya worker se `SV_KEY` hata dein |
| `bot-cookies` | cookies pahunche par export **adhoora** (`missing` me naam dikhte hain) | SID, HSID, SSID, SAPISID (ya `__Secure-3P*`) sab chahiye — naya export lein |
| `bot-potoken` | cookies theek, par YouTube is IP par **PoToken** maang raha hai | `POTOKEN_URL` (bgutil-verify-token provider) secret add karein |
| `bot-ip` | cookies + PoToken dono theek, phir bhi block | IP-level block hai (Cloudflare shared IP) — doosra PoToken provider, ya usi IP se banaye gaye fresh cookies |

**App me checker:** Settings → **Cookie checker (YT_COOKIES)** me cookies paste karein — browser me hi parse hota hai
(header string, Netscape `cookies.txt`, ya JSON export — teeno). Wo dikhata hai: kaunsi cookie mili, kaunsi missing hai,
kitni expire ho chuki hain, aur **Copy clean string** se ready-to-paste `YT_COOKIES` value mil jaati hai.

> Cookies kisi ko bhejte nahi — checker browser me hi kaam karta hai. Secret me `Cookie:` prefix, quotes, newlines,
> `cookies.txt` ya JSON — sab chalte hai (worker khud saaf karta hai). Cookie ke naam `YT_COOKIE` / `YOUTUBE_COOKIES` /
> `COOKIES` bhi accepted hain.

## `layerbase HTTP 401: Unauthorized: The JWT is invalid` — asli wajah

Ye ek hi message **chaar alag** galtiyon ke liye aata hai. Ab worker aur app dono token ko **decode** karke
(strictly claims, bina verify) exact wajah batate hain — token kahin network par nahi jaata.

| `verdict` | Matlab | Fix |
| --- | --- | --- |
| `jwt-format` | `LIBSQL_TOKEN` me JWT hi nahi hai (3 dot-separated parts chahiye, `eyJ…`) | Layerbase → DB → **Connect** → **auth token** copy karein. URL/API key nahi. |
| `jwt-expired` | Token ki `exp` nikal gayi (probe `exp` date dikhata hai) | Naya token banayein → `LIBSQL_TOKEN` update → **Deploy** |
| `jwt-wrong-db` | Token ka `id` claim `LIBSQL_URL` ke host se match nahi karta (workspace me kai DB?) | Dono cheezein **usi** DB ke Connect screen se copy karein |
| `jwt-bad-signature` | Token adhoora paste hua / rotate ho gaya | Poora token dobara copy karein (line break ke bina), phir Deploy |

Check karne ke 2 tareeke:

```
GET https://<worker>/api/sync/probe?p=<profile-key>     → { ok:false, verdict:"jwt-expired", jwt:{...claims} }
```

**App me:** Settings → Cloud store → **Test Layerbase** (verdict + claims dikhata hai), ya
**Layerbase checker** me apna `LIBSQL_TOKEN` paste karein — wo browser me hi decode karke batata hai ki token
expire hua hai, kisi dusri DB ka hai, ya paste hi galat hua. (Token sirf tumhare browser me decode hota hai.)

> 401 ke waqt bhi app khatam nahi hoti: worker edge snapshot se last-known profile de deta hai (`ok:true, stale:true`),
> isliye history/likes/subs dikhte rehte hain jab tak token theek na ho.

## Why a worker at all? (the honest bit)

A browser cannot talk to YouTube directly, for two reasons:

1. **CORS** — `youtube.com/youtubei/*` sends no `Access-Control-Allow-Origin`, so `fetch()` from a page is blocked.
2. **IP-bound streams** — the `googlevideo.com` URLs in a player response are signed for the IP that requested
   them. Even with a CORS proxy, the URL dies when played from your machine.

A Cloudflare Worker (free, serverless, no machine to maintain) solves both: it calls YouTube's own InnerTube
API and proxies the media bytes. That replaces Piped/Invidious completely — no third-party video infra.

Playback stays 100% custom: a plain `<video>` element with our own YouTube-style chrome.

---

## Setup (2 minutes, once)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create Worker** → Deploy.
2. Open **Edit code**, paste all of `worker.js`, **Deploy**.
3. Open `https://<your-worker>.workers.dev/` → worker ka status page (saari routes ki list), ya
   `https://<your-worker>.workers.dev/api/health` → `{"ok":true,...}`
4. Open StreamVoid → **Settings → YouTube engine** → paste the worker URL → **Save & test**.
   The dot turns green and full search/trending/playback goes live.
5. **Cloud store (the app's memory):** <https://layerbase.com> → *Create libSQL* (free, no card) →
   copy the HTTPS URL + token → Cloudflare Worker → **Settings → Variables** →

   | Secret | Value |
   | --- | --- |
   | `LIBSQL_URL` | `https://<db>.cloud.layerbase.dev` (the `libsql://` form also works) |
   | `LIBSQL_TOKEN` | the bearer token from the dashboard |

   Then open **Settings → Cloud store** in the app and hit **🔌 Test Layerbase** — it answers with the
   host, the round-trip latency and how many rows this profile has. Green = synced.

`index.html` can be hosted anywhere static (GitHub Pages, Netlify, S3, or just opened locally).

### `LIBSQL_URL` ka sahi format (aur jo bhi paste ho jaye)

Secret me sirf **host** chahiye — `/v2/pipeline` worker khud lagata hai. Lekin galti se endpoint copy ho jaye
to bhi `v8.2` ab sambhal leta hai:

| Tumne paste kiya | Worker kya use karta hai |
| --- | --- |
| `lakshaydb-cute-drum.sage.cloud.layerbase.dev` | ✅ wahi |
| `…/v2/pipeline` · `…/v2/pipeline/` · `…/v2` · `…/pipeline` | ✅ path hata ke host |
| `libsql://…` · `http://…` · `wss://…` | ✅ `https://…` |
| `"https://…"` (quotes ke saath) | ✅ quotes hata ke |
| token: `Bearer eyJ…` · `"eyJ…"` | ✅ prefix/quotes hata ke |

App me checker bhi hai: **Settings → Cloud store → Layerbase URL checker** — URL paste karo, normalized value
+ exact secret steps dikh jate hain. `/api/sync/probe` ab batata hai worker ne kya parse kiya (`url.normalized`,
`endpoint`, `changed`, `tokenPrefix`) taaki "link sahi hai par invalid" jaisa guess-work khatam ho.

### Layerbase banayein — exact clicks

1. <https://layerbase.com> → sign in (email/GitHub). Card nahi lagta.
2. Dashboard → **New Database** → engine **libSQL** → plan **Free** → **Create** (~10–60 s).
3. DB kholein → **Connect / Quick Connect** → do cheezein copy karein:
   - **URL**: `https://<db>.cloud.layerbase.dev`
   - **auth token**: lamba string (yehi `LIBSQL_TOKEN` hai)
4. Cloudflare → Workers → apna worker → **Settings → Variables and Secrets → Add**:
   `LIBSQL_URL` aur `LIBSQL_TOKEN`, dono **Secret** type → **Save and Deploy**.
5. Worker par `GET /api/sync/probe` kholein (`https://<worker>.workers.dev/api/sync/probe`) — aisa aana chahiye:

   ```json
   {"ok":true,"configured":true,"backend":"layerbase-libsql","host":"<db>.cloud.layerbase.dev",
    "latencyMs":214,"schema":"sv_store ready","rows":7,"caps":{...},"ttl":"none"}
   ```

   `ok:false` + `configured:false` = secrets missing. `configured:true` + error = URL/token galat, ya DB archived.

### Kab tak free, kab tak chalega (honest)

| Cheez | Free tier |
| --- | --- |
| Price | **$0/mo**, no card, **koi trial clock nahi — plan expire nahi hota** |
| Limits | 2 databases · 5 GB storage · 20 concurrent connections |
| Idle 15 min | DB **so jata hai**; agli query ~1–5 s me jaga deti hai (app `wokeFromSleep` bata deta hai) |
| Idle 14 din | DB **archive** ho jata hai — dashboard me ek click **Restore**, 10–30 s, data + backups safe |
| Archive me 90 din | live resources reclaim hote hain, **latest backup restorable rehta hai** |

Practical matlab: **time limit nahi hai**, bas mahine me kam se kam ek baar app kholein (ya `GET /api/sync/probe`)
taaki 14-din archive na ho. Hamara data itna chhota hai (300 history + 150 subs + 500 likes ≈ 1–3 MB) ki
5 GB kabhi nahi bharta — cap server-side hai, TTL kahin nahi.

**Backup:** Settings → Cloud store → **Export JSON** (poora profile ek file me) aur **Import** se wapas.
Profile key cookie kho gayi to data DB me pada rehta hai par app use nahi dhoondh paega — isliye
**Copy profile link** se link sambhal ke rakhein.

---

## "Clients auto-update hote hain na?" — kya khud chalta hai, kya nahi

Teen cheezein **live** update hoti hain, bina redeploy:

| Kya | Kahan se | Kitni der me |
| --- | --- | --- |
| Client **versions** (`ANDROID_VR`, `IOS`, `WEB`, `VISIONOS`, …) | `youtube.com` ka page + yt-dlp ki `_base.py` table | 6 ghante (cache), `?refresh=1` se turant |
| **signatureTimestamp** (web clients) | player JS se, per video | har resolve par |
| **nsig** transform (`n` param) | player JS ko parse karke, live | har resolve par |

Live worker par aaj yahi dikh raha tha: `ANDROID_VR 1.65.10`, `IOS 21.26.4`, `ANDROID 21.26.364`,
`MWEB/WEB 2.20261022.01.00` (aaj ka), source `youtube.com` + `yt-dlp`.

**Par version auto-update ≠ bot-check ka ilaaj.** Do cheezein khud update **nahi** hoti hain:

1. **Attestation** — PoToken (BotGuard) / Play Integrity / DeviceCheck. Ye token hi decide karta hai ki
   "bot" milega ya stream, aur worker me `eval` banned hai. Isliye `POTOKEN_URL` / `YT_COOKIES` chahiye.
2. **Client list + request shape** — YouTube naya client add kare, ya header/referer/consent badle, to code
   update karna padta hai. Isi liye v7.9 me request ko asli client jaisa banaya gaya:

### v7.9 — client IQ

| Change | Why |
| --- | --- |
| `x-goog-visitor-id` header (body ke saath match) | body-only visitor id ek known bot signal hai |
| `referer: https://www.youtube.com/watch?v=<id>` + `x-origin` | asli client yahi bhejta hai |
| consent cookies `SOCS=CAI; CONSENT=YES+cb` (bina login) | EU consent / "sign in to confirm your age" wall, `CONSENT=off` se band |
| `playbackContext.html5Preference = HTML5_PREF_WANTS` | web player khud bhejta hai |
| **`visionOS`** + **`WEB_CREATOR`** clients | inke versions pehle se discover ho rahe the par ladder me use hi nahi hote the; Studio client sirf cookies ke saath |
| account-only clients anonymous pass se hatae | `LOGIN_REQUIRED` par time waste nahi |
| pass 3 (self-heal) **poora ladder** chalta hai aur **cookies retain** karta hai | pehle bot par wahi pe ruk jata tha, aur pass 3 cookies kho deta tha |
| `/api/debug → clientStats` | kaun actually deliver kar raha hai — andaza nahi, scoreboard |

Honest: ye sab **probability** badhata hai, guarantee nahi. Asli jump `YT_COOKIES` / `POTOKEN_URL` se aata hai.

### v8.0 — teen live bugs (jo khud worker ne pakde)

v7.9 live chal raha tha (`selftest` = 130 ms, `android_vr`), par usi ke `canary?n=3` ne **0%** dikhaya jabki
video chal raha tha. Wajah teen:

| Bug | Kya ho raha tha | Fix |
| --- | --- | --- |
| **Breaker poisoning** | bot-check / private / region wall par bhi `noteFail()` chalta tha → **ek** gated video poore ladder ko 5 min ke liye thanda kar deta tha, aur `canary` loop me `player()` har client "cooling" dekhkar turant `reason:"unknown"`, `ms:0` lauta deta tha → **jhoota 0%** | breaker sirf **network / timeout / no-formats** (client ki galti) par trip hota hai. `bot`, `login`, `age`, `region`, `unavailable` **video ki** sachchai hai, client ki nahi — breaker ko chhua bhi nahi jaata |
| **Mirror order ulta** | jo mirror mar rahe the wo pehle: `inv.nadeko.net` 403, `nerdvpn` 401, `melmac` 526 — aur jo chalta tha (`invidious.f5.si`) **sabse last** | order ab: `f5.si` → `melmac` → `nerdvpn` → `nadeko` |
| **Subrequest budget** | Cloudflare free tier: **50 subrequests per request**. Ek `player()` ~30 kharch karta hai; `canary?n=3` ek hi request me teen chalata tha → cap cross, saare aage ke fetch instant fail → fake 0% | ladder ek explicit budget par chalta hai (`SUB_CAP 46`, `SUB_RESERVE 8` mirrors/media ke liye): budget khatam = ladder rukta hai, mirror pass phir bhi chalta hai, aur `canary` jo video **test hi nahi hui** use `skipped` bolta hai — `passed`/`rate` me jhooth nahi |

Ab `canary` default **ek** video leta hai (`?n=3` tabhi jab aapko pata ho ki budget hai), aur response me
`skipped`, `budgetLeft` aur `note` aata hai. `player` response me bhi `budgetLeft` hai.

---

## Secrets cheat-sheet (exact values)

Cloudflare → your Worker → **Settings → Variables and Secrets** → *Add* (type **Secret** for all of these).

| Name | Required? | What to paste |
| --- | --- | --- |
| `SV_KEY` | recommended once cookies are used | any random string, e.g. `sv-9f3c1a77`. The app must send the same value: **Settings → YouTube engine → Access key** |
| `YT_COOKIES` | the big one | a YouTube cookie string from a signed-in (throwaway) account — formats below |
| `PO_TOKEN` | optional | one static token, or `VISITOR_DATA:TOKEN` |
| `POTOKEN_URL` | optional | HTTP endpoint of a bgutil-style provider, e.g. `http://192.168.1.20:4416/get_potoken` |
| `EMERGENCY_MIRRORS` | optional | extra Invidious-compatible bases, comma separated |
| `MIRRORS` | optional | `off` disables the built-in mirror list |
| `LIBSQL_URL` + `LIBSQL_TOKEN` | for the app's memory | Layerbase libSQL HTTPS URL + bearer token |
| `APP_URL` | optional | link put on the worker's status page |

### `YT_COOKIES` — four accepted shapes

1. **Cookie header string** (easiest):
   ```
   SID=g.a000...; HSID=AbC...; SSID=AxY...; SAPISID=9f2...; APISID=x1...; __Secure-1PSID=g.a000...; __Secure-3PSID=g.a000...; __Secure-1PAPISID=9f2...; __Secure-3PAPISID=9f2...; LOGIN_INFO=AFmmF2...; VISITOR_INFO1_LIVE=abcd1234; PREF=tz=Asia.Calcutta
   ```
2. **JSON** exported by a cookie extension: `[{"name":"SID","value":"..."}, …]` (or `{"cookies":[…]}`).
3. **Netscape `cookies.txt`** (7 tab-separated columns, e.g. from *Get cookies.txt LOCALLY*).
4. **`key=value` lines**, one per line — converted to a single header.

The ones that matter: `SID`, `HSID`, `SSID`, `SAPISID` (+ `APISID`) — plus `__Secure-1PSID`,
`__Secure-3PSID`, `__Secure-1PAPISID`, `__Secure-3PAPISID` for the web clients. `SAPISIDHASH` is computed by the
worker from `SAPISID`, so never paste an authorization header.

**How to get them:** open an incognito window → sign in to the throwaway account → `youtube.com` →
DevTools → **Network** → click any request to `youtube.com` → **Request Headers → cookie** → copy the whole
value. (Or DevTools → **Application → Cookies → https://www.youtube.com**, copy name/value pairs.)

**Gotcha:** if `SV_KEY` is set and the app does not send it, cookies are **ignored on purpose**. Check
`/api/health` → `cookies.used` must be `true`, otherwise it says `"SV_KEY mismatch → cookies NOT used"`.

### `PO_TOKEN`

- Value A: the raw token (long `base64url`-ish string, 100+ chars).
- Value B: `VISITOR_DATA:TOKEN` — use this when you know which visitor the token was minted for; the worker
  sends that visitorData with the token.
- Or skip `PO_TOKEN` and set `POTOKEN_URL` to a running
  [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider). The worker calls
  `…?visitor_data=<vd>` and expects `{"poToken":"…","visitorData":"…"}`, caching the pair for 30 min.

Honest limits: a **static token dies within hours** and is tied to its visitor data, and Cloudflare Workers
forbid `eval`, so BotGuard cannot be solved inside the worker. Cookies last weeks/months and fix the same
bot-check — so **cookies first, PoToken as a bonus**, both can be set at once.

Never commit these values, never paste them in chat, and use a throwaway account: a cookie string is a full
session (password-equivalent).

### Verify in 30 seconds

1. `/api/health` → `cookies.configured` + `cookies.used` (and `SV_KEY` badge on the status page).
2. `/api/canary?n=3&key=<SV_KEY>` → `rate` + per-video `pass` (1 = anonymous, 2 = cookie pass, 4 = mirror).
3. `/api/selftest?id=dQw4w9WgXcQ&key=<SV_KEY>` → `cookiesUsed`, `poTokenUsed`, `poTokenSource`, `reason` if it fails.

---

## What the worker does

| Route | Purpose |
| --- | --- |
| `GET /` | status page: worker running, links to every route (`?format=json` for machines). Never a 404 |
| `GET /api/health` | connection check, **`build`** (which worker version is live), discovered client versions, cookie state |
| `GET /api/probe?q=&endpoint=search\|browse` | debug aid: per-client top-level keys, renderer histogram, parsed count, capped raw sample — use it when YouTube changes shape |
| `GET /api/debug` | full client ladder + version sources (`?refresh=1` re-discovers) |
| `GET /api/selftest?id=` | end-to-end check: which pass/client worked, ms, breaker state |
| `GET /api/search?q=` | InnerTube `search` → normalized video list (+ continuation token) |
| `GET /api/searchmore?q=&token=` | next page |
| `GET /api/trending?region=IN` | InnerTube `browse` `FEtrending` |
| `GET /api/shorts?region=IN` | Shorts feed: `browse` `FEshorts` (`shortsLockupViewModel` + `reelItemRenderer`), falling back to `#shorts` search, then to short items in trending |
| `GET /api/player?id=` | InnerTube `player` with a client ladder (android_vr → ios → tv_embedded → android → mweb → web), picks muxed MP4, rewrites URLs to the proxy |
| `GET /api/related?id=` | InnerTube `next` → Up next list |
| `GET /api/comments?id=&token=` | InnerTube `next` → comments continuation → `{items, next, count}`; author, avatar, likes, replies, creator badge. Token sirf paging ke liye |
| `GET /api/rss?channels=UC…,UC…` | fetch + merge YouTube RSS feeds for up to 30 channels → `{items, channels, errors}` (dedupe, newest first, per-channel failure isolated) |
| `GET /api/channel?q=` | resolve anything you paste (`@handle`, `/channel/UC…`, `/c/name`, bare `UC…`) → `{channelId, name, avatar}` |
| `GET /api/media?u=` | **Range-aware** byte proxy for `googlevideo.com` (host allowlist) |
| `GET /mp4/<id>.mp4` | direct file endpoint: resolves the best muxed stream and serves it as `video/mp4` (Range/HEAD supported). `?itag=` picks a quality, `?dl=1` forces a download |
| `GET /api/file/<id>.mp4` | same as above (alias) |

Unknown paths return a JSON 404 that tells you *what* you asked for and lists every valid route
(`{error:"not found", detail:{path, routes, hint, didYouMean}}`). A trailing slash is tolerated
(`/api/health/` works), and `/favicon.ico` is a quiet 204.

**Parsing is shape-tolerant.** YouTube keeps moving list data between renderers. `normalizeList()` reads every
renderer it knows (`videoRenderer`, `compactVideoRenderer`, `gridVideoRenderer`, `playlistVideoRenderer`,
`videoWithContextRenderer`) **and** the 2025/26 `lockupViewModel`, then — if none match — falls back to a
generic scan that finds any object carrying a plausible 11-char video id and rebuilds the item from the strings
and thumbnails in that subtree. Bad id → dropped; duplicates → merged. If lists ever come back empty again,
`/api/probe` prints what shape YouTube is serving so it can be taught in one line.

Signature handling: if a format comes back as `signatureCipher`, the worker fetches the video's `base.js`,
extracts the sig and `n` transform functions and applies them (`buildDecipher`). Plain `url` formats skip all of that.

**Why isn't the player handed a raw `.mp4` link?** Because `googlevideo.com` URLs are signed for the IP that
requested them — a link minted by the worker 403s in your browser. So `/api/player` returns
`/api/media?u=…` (the proxy) and there is a separate human-friendly `/mp4/<id>.mp4` endpoint for the same bytes:

```
https://<worker>/mp4/dQw4w9WgXcQ.mp4              → inline video/mp4 (works in a tab, <video>, VLC, ffmpeg)
https://<worker>/mp4/dQw4w9WgXcQ.mp4?dl=1         → attachment download
https://<worker>/mp4/dQw4w9WgXcQ.mp4?itag=18      → pick a specific quality
```

---

## Video kabhi band na ho — the self-healing stream

"A one-off fix" is not a thing here; every layer that can die has a next step that does not need you.

### Player ladder (browser)

A stall or a dead signature is not an error, it is a queue of remedies. Position is carried through all of them.

| # | What happens | Why it works |
| --- | --- | --- |
| 0 | *Reconnecting…* — reload the element at the same position | the buffer hiccuped, not the URL |
| 1 | *Lower quality…* — next format down | the current track is too heavy / codec refused |
| 2 | *Fresh stream…* — re-resolve `/api/player` | the signed URL expired mid-playback |
| 3 | *Stable stream…* — switch to `/mp4/<id>.mp4?itag=` | this URL carries **no signature**, the worker resolves on every request |
| 4 | honest error panel with Retry / Open on YouTube | only after four remedies failed |

- **Watchdog:** no `currentTime` progress for ~9s while playing → the ladder runs. `stalled`/`waiting` start the same clock, and one escalation per 14s max, so it never fights the buffer.
- **Memory survives the remount:** stage, chosen quality and playback position live outside the component (`REC`), so step 2's re-resolve does not silently restart the ladder at 0.
- **Online / tab-back:** `online` or a visible tab resumes by itself (`autoRecover`).
- **Instant hand-off:** after 12s of watching, the next video is resolved in the background; a resolved stream is cached 6 minutes, so going back to a video — or looping — starts immediately. A retry *always* bypasses that cache, because the cached URL is what just died.

### Proxy ladder (worker)

`/api/media` and the pretty routes repair themselves before the browser sees anything:

- **Expired signature is detected before the request** (`expire=` in the past) → re-resolve first, no wasted fetch.
- **401 / 403 / 404 / 410** → fresh signature from `/api/player`, retried once (`x-sv-refreshed: 1`).
- **5xx / 429** → 250ms backoff, retry, then one fresh signature.
- **Network reset** → retry, then a fresh signature.
- **InnerTube blocked entirely** → `refreshedUrl()` falls back to the mirror extractors for a working URL.
- **Range headers survive every retry**, so seeking keeps working after a repair.
- **`/api/stream?id=&itag=`** is the signature-free URL: no expiry, resolves per request, ideal for shaky networks or long pauses.

### Endless play (never a dead end)

`Ended` → next recommendation → if recommendations are empty, **trending** → if that fails too, **the same video loops**. Both `Endless play` and `Auto-recover` are switches in Settings (on by default), so you can turn the chattiness off.

**Honest limit:** if YouTube bot-checks the worker's IP for a specific video, no client-side ladder can conjure a stream — that needs `YT_COOKIES`/`PO_TOKEN` (see the secrets cheat-sheet). What the ladder guarantees is that a *transient* failure (buffer, expiry, 5xx, network blip, one bad quality) never reaches you as "video stopped".

---

## Jab video na chale — the escalation ladder

Real YouTube does not just hand over streams: it fingerprints the client and, on a growing share of videos
(new uploads, Shorts, anything it finds suspicious), answers `LOGIN_REQUIRED — Sign in to confirm you're not a
bot`. No client list can talk its way past that; something has to *prove* the request is legitimate. So playback
escalates instead of dying:

| Pass | What it does | Why it exists |
| --- | --- | --- |
| 1 · fast anonymous | `android_vr`, `ios`, `tv_embedded`, `android` only | most videos, in ~200ms |
| 2 · cookies | same ladder + `YT_COOKIES` (web family also gets `SAPISIDHASH`) | the single biggest fix for bot-checks, members-only and age-restricted videos |
| 3 · self-heal | re-discover every client version, full ladder, breakers bypassed | YouTube rotated a client version or an earlier endpoint tripped a breaker |
| 4 · independent extractors | Invidious-compatible mirrors, stream still proxied through `/api/media` | last resort, survives an InnerTube-side change |

A **bot-check short-circuits the ladder**: the first `LOGIN_REQUIRED … not a bot` reply stops the anonymous pass
instead of burning 16 attempts, and jumps straight to pass 2. That is why failures come back in ~1–2s with a
reason instead of a 25s timeout.

### PoToken

`PO_TOKEN` (a static token) or `POTOKEN_URL` (a [bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
-compatible provider) are attached as `serviceIntegrityDimensions.poToken` on **every** player call, paired with
the `visitorData` the token was minted for (the provider's own `visitorData` wins), cached 30 min. A static
secret accepts both `TOKEN` and `VISITOR_DATA:TOKEN`.

Honest limit: Cloudflare Workers forbid `eval`, so BotGuard cannot be solved *inside* the worker. Either supply a
token (provider / secret — this is what people run alongside yt-dlp) or use cookies.

### Every failure explains itself

`/api/player` returns a classified diagnosis instead of a bare error:

```json
{ "ok": false, "reason": "bot", "reasonLabel": "YouTube bot-check", "needAuth": true,
  "hint": "YouTube is asking this IP to prove it is not a bot (PoToken)…",
  "failures": { "bot": 6, "unavailable": 2 }, "attempts": ["android_vr@1.65.10: LOGIN_REQUIRED … [bot]"] }
```

The watch page turns that into a panel: the reason, what fixes it, **Retry**, **Fresh URL**, **Download MP4**
(`/mp4/<id>.mp4`, works even when the player refuses) and **Open on YouTube** — plus a **Why?** disclosure with
the grouped failure counts and the last 14 attempts.

### Canary

`GET /api/canary` runs playback over **one** of today's trending videos and returns `passed`, `rate` and a
per-video reason. One click tells you whether the whole setup is healthy or which layer broke.

`?n=3` bhi chalta hai par ek hi request me Cloudflare ka **50 subrequest** cap hai — tab `skipped` aur
`budgetLeft` dekhna: jo video `skipped` hai wo **fail nahi hui**, bas test nahi hui. Isi liye default `n=1` hai.

`MIRRORS=off` disables the built-in extractor list; `EMERGENCY_MIRRORS=https://a,https://b` adds your own.

---

## Memory lives in Layerbase, not the browser

`localStorage` is never written — not for settings, not for history, not for a single byte. The database is the
app's memory, so the same profile opens on any device and clearing site data cannot wipe your subscriptions.

Why **Layerbase libSQL** and not Cloudflare KV/D1:

| | Free tier | Why it decides it |
| --- | --- | --- |
| **Layerbase libSQL** | 2 DBs, 5 GB, **no row meters**, no expiry | one HTTPS endpoint a Worker can call; a writing-heavy history never becomes a quota graph |
| KV | 1 GB, **1,000 writes/day** | one write per watched video = quota gone in an afternoon |
| D1 | 5 GB, 100k rows written/day | fine, but row metering + a Cloudflare-only binding |

The worker talks to libSQL over **HTTPS (Hrana v2 pipeline)** with `fetch` — no `@libsql/client`, no npm, the
worker stays one pasteable file.

### One table, one trim

```sql
CREATE TABLE sv_store (
  uid TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  pos INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (uid, kind, id)
);
```

Every write is `upsert → trim`, in the same pipeline:

```sql
DELETE FROM sv_store WHERE uid = ? AND kind = ? AND id NOT IN (
  SELECT id FROM sv_store WHERE uid = ? AND kind = ? ORDER BY pos DESC LIMIT ?
);
```

So the list can never creep: **aage ka yaad, peeche ka bhool**.

| list | cap | what happens at the cap |
| --- | --- | --- |
| history | 300 | 301st video pushes the oldest out |
| subscriptions | 150 | oldest channel drops |
| likes | 500 | oldest like drops |
| watch later | 300 | oldest drops |
| playlists | 50 | oldest playlist drops |
| settings | 1 | replaced in place |

**No TTL anywhere.** Nothing expires by time — only the cap removes rows, and only the oldest ones. The client
cannot raise a cap: the trim runs server-side on every write.

### The profile key (still no login)

The first visit mints a random 22-character key and stores it in a cookie (`sv_p`, 10 years, `SameSite=Lax`).
That key *is* the account:

- **Copy device link** in Settings → `app.html#p=<key>` → open it anywhere for the same profile.
- **Export / Restore JSON** in Settings → your own backup, independent of any provider.
- Lose the key and the data is still in the DB, but nothing points at it — export a backup if it matters.

Only the engine URL + access key are kept in a second cookie (`sv_cfg`), because a database cannot tell you its
own address before you connect to it. That is the *only* thing the browser remembers.

### When Layerbase is unreachable

A free libSQL database hibernates after 15 minutes idle and **wakes in ~1–5s on the next request** — a read is
the wake-up, so the app's first `GET /api/sync` usually absorbs it. If it is archived (14 idle days), the
dashboard's one-click Restore brings it back; data is never deleted.

Meanwhile the worker never leaves you with a blank app:

1. **Edge snapshot** — every successful read is cached (`caches.default`, 1 year), so an outage still opens the
   last known profile, flagged `stale`.
2. **In-memory** — new clicks keep working and are re-queued with backoff; nothing is dropped while the tab is open.
3. **Honest UI** — Settings → Cloud store shows `Synced / Loading / Cloud off` plus the exact error.

Optional: add a **Cron Trigger** (`0 */6 * * *`) to the worker — `scheduled()` writes one heartbeat row, which
keeps the free DB out of the 14-day archive. Not required, just one less click.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/sync?p=KEY` | whole profile in one round-trip (used at boot) |
| `POST /api/sync?p=KEY` | `{ops:[{kind, upsert:[{id,pos,data}], del:[id], clear}]}` → write + trim |
| `DELETE /api/sync?p=KEY&kind=` | empty one list |
| `POST /api/sync/import?p=KEY` | one-shot bulk restore (the Settings *Restore JSON* button) |

`/api/health` reports `store: {backend, configured, caps, ttl:"none"}` so you can tell at a glance whether the
worker can actually reach Layerbase.

---

## Subscriptions = channel feeds (no account, no login)

Subscribe to a channel once and its uploads show up in your Subscriptions page. No Google account, no OAuth,
no API key.

**Heads-up (Oct 2026): YouTube retired its RSS endpoint.** `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`
now returns **404** for every channel (`?playlist_id=` too). So the worker tries the feed first, and when it is
gone it reads the channel's **Videos tab through InnerTube** and rebuilds the exact same shape — same fields,
same sorting, no login, still keyless. The feed is retried every 6 hours, so the moment YouTube brings it back
the worker goes back to real RSS without a code change. `/api/rss` reports which path was used per channel:

```json
{ "items": [...], "channels": [...], "errors": [],
  "sources": { "UCxxxx": "feed", "UCyyyy": "innertube" },
  "feedDead": true }
```

Only one 404 retires the feed *after* the channel listing proves the channel exists — a typo'd channel id can't
fool it. The InnerTube path costs 1 request per channel (the feed path is 1 too), so the quota math is unchanged.

Why the worker has to proxy all of this: the feed sends no CORS header, and InnerTube has no CORS at all, so a
page can't read either directly. `/api/rss?channels=A,B,C` fetches everything **in parallel** (8s timeout each),
merges, dedupes by video id, sorts newest-first and caps the result. If one channel fails you still get the rest —
the failure is listed in `errors[]` and the UI shows a small warning instead of an empty page.

One trade-off on the InnerTube path: it gives *"2 hours ago"* instead of a real timestamp, so the worker parses
the relative text and stores an approximate epoch (it keeps YouTube's order), which is what the day-grouping in
the Subscriptions page uses.

In the app:

- **Subscribe** — button under any video, on the channel page, or **Add channel** in the sidebar
  (paste `@mkbhd`, a channel URL, or a `UC…` id — `/api/channel` resolves it; name + avatar come back too).
- **Subscriptions page** — day-grouped feed (*Today / Yesterday / date*) across every channel you follow,
  with a channel rail on the left showing avatars and a per-channel filter.
- **Channel page** — banner, avatar, handle, subscriber line, subscribe/unsubscribe, and its uploads.
- **Manage** — Settings → Subscriptions: remove individual channels, **Export OPML**
  (`streamvoid-subscriptions.opml`) and **Import OPML** (drops the file in, it pulls the `channel_id`s out and
  subscribes). OPML stays as the standard interchange format — note that reading the exported feeds in a
  third-party RSS reader depends on YouTube's endpoint coming back, which is why this app fetches through the
  worker instead.
- Subscriptions live in your own Layerbase database (capped at 150), keyed by your profile key — no account,
  no third-party service beyond the DB you created yourself.

Refreshing is on demand (pull-to-refresh / the refresh button): 1 request per channel, so a 20-channel
check costs 20 of your 100k daily worker requests. There is no background polling to burn quota.

---

## ShortsFire — your second site, inside Shorts

`https://yt.sanjeettiwari205.workers.dev/` (ShortsFire) is a separate app. The Shorts page has a two-way toggle:

**⚡ StreamVoid** — our own Shorts feed and player (YouTube data, proxied streams).
**🔥 ShortsFire** — the whole ShortsFire site embedded in an iframe, in place of the feed.

The embedded view gets its own status bar: `Reload` (remounts the frame), `Open ↗` (new tab) and back to
StreamVoid. Switching tabs pauses the hidden Shorts, and the global Shorts shortcuts (↑ ↓ / j k / m) are disabled
while the frame owns the keyboard.

The URL is a setting, not a constant: **Settings → 🔥 ShortsFire → Save URL** (stored in your cloud profile like
every other setting), default `https://yt.sanjeettiwari205.workers.dev/`.

**Honest limit:** if that site ever sends `X-Frame-Options` / a CSP `frame-ancestors` rule, browsers will refuse
to render it inside the page — the frame stays blank and `Open ↗` is the way in. Nothing on our side can override
that, and the toggle is built so it degrades to a plain link rather than looking broken.

---

## Recommendations

The Up-next list is built on the client, from four signals — no recommendation service, no tracking:

| Signal | Source | Weight |
| --- | --- | --- |
| What YouTube itself pairs with this video | `/api/related` (`next` endpoint) | highest base |
| Channels you actually watch | local watch history → top 6 authors → `/api/rss` | high, +8 per past view |
| Subscriptions (any source) | subscription list | +10 flat |
| More from the current channel | the same RSS call (current `authorId` included) | high |
| Freshness & popularity | `published` (feed) + `viewCount` | recency decays over a day, log-scaled views |

Items are merged, deduped, scored and sorted (top 20) — then each card says *why* it is there:
*Because you watch X*, *More from X*, *From a channel you follow*, *Related to this video*, *Trending now*.
Cold start (no history, no subs) falls back to related + trending, so the rail is never empty.
Results are cached for 5 minutes per video, so replaying the rail costs nothing.

Home gets a **Recommended for you** rail built the same way once you have any history or subscriptions
(`recommendHome()`), with subscriptions and frequent channels weighted first.

Shorts are filtered out of the watch-page rail (long-form context), and the video you are already
watching is always excluded.

---

## Shorts

Shorts are just normal videos, so playback needs nothing new: `/api/shorts` gives the list, `/api/player`
gives the stream, `/api/media` proxies it. The worker parses **both** shapes YouTube uses:

- `shortsLockupViewModel` (current): `entityId: "shorts-shelf-item-<id>"`, `overlayMetadata` (title + views),
  `thumbnailViewModel.image.sources` — the biggest source wins, and the id is validated before it is kept
- `reelItemRenderer` (older): `videoId`, `headline`, `viewCountText`, `thumbnail.thumbnails`

The feed ladder, in order:

1. `browse` → `FEshorts` (the real Shorts tab)
2. `search` → `#shorts`, then keep only items shorter than 90s (this is also how a normal search result
   becomes a Short)
3. `trending` → filter to ≤90s

Every step is isolated, `attempts` records what each one found, and the fallback steps deliberately ignore
the circuit breakers (`ignoreCooling`) so two dead sources don't kill the third. If you see a Short in a
normal list, `lengthSeconds ≤ 60` marks it (`isShort`) and the thumbnail gets a **Shorts** pill.

In the app:

- **Shorts** in the sidebar → full-height cards, one at a time, scroll-snap (wheel/trackpad) plus
  `↑`/`↓` / `j`/`k` to move, `m` to mute. Only the visible card (and the next one) resolves a stream, so
  opening Shorts costs 1–2 `/api/player` calls, not one per card.
- Autoplay starts **muted** (browsers block unmuted autoplay); tap the speaker or press `m` for sound.
- Subscribe / like / share / "open watch page" sit on the card — the channel id comes from the resolved
  player response when the lockup doesn't carry one.
- Home gets a **Shorts shelf** (horizontal rail) above the grid, and any short video in a normal grid shows
  the Shorts pill.

---

## Stays alive without you touching it

| Breaks over time | How the worker handles it |
| --- | --- |
| **Breakers tripped by one endpoint** | The first attempt honours a cooldown; the self-heal round **ignores** cooldowns (and re-discovers versions), so a warm breaker from another route can't blank search/trending/RSS. |
| **Client versions go stale** (the #1 cause of breakage) | `discoverVersions()` fetches `youtube.com`'s HTML for the current `INNERTUBE_CLIENT_VERSION` and yt-dlp's `_base.py` for the mobile/TV versions — cached 6h (Cache API, falls back to a plain fetch). Every client is tried **twice**: discovered version, then the baked-in fallback. |
| **Signature / `n` algorithm changes** | `buildDecipher()` extracts the functions from the *current* `base.js` at runtime — nothing hardcoded. |
| **Renderer JSON reshuffles** | `collect()` walks the tree recursively instead of relying on fixed paths. |
| **Everything fails at once** | `/api/health` reports the versions it's using, `/api/debug` shows the full ladder + cookie state, and the player surfaces the per-client reasons (e.g. `android_vr@1.62.27: LOGIN_REQUIRED`). |

Optional hard override (no redeploy needed for version bumps):

```bash
npx wrangler secret put CLIENT_VERSIONS
# {"ANDROID":"19.50.1","IOS":"20.10.4"}
```

### Four-pass playback (self-healing)

| Pass | What | When |
| --- | --- | --- |
| 1 | anonymous client ladder (9 clients × 2 versions, breaker-aware, 25s budget) | always |
| 2 | **self-heal**: force re-discovery of versions + `visitorData`, ignore breakers, retry | pass 1 failed |
| 3 | authenticated retry (`android`, `web`, `ios`, `tv_embedded`, `web_embedded` + `SAPISIDHASH`) | pass 2 failed **and** `SV_KEY` matched |
| 4 | emergency mirrors (`EMERGENCY_MIRRORS`, Invidious `local=true` only) | everything else failed |

Extra guards:

- **Circuit breaker** per `client@version` — a combination YouTube just rejected is skipped for 40s → 5min,
  so one broken client can't slow every request.
- **`visitorData`** is scraped from `youtube.com` and sent with each request (helps against soft bot checks).
- **`PO_TOKEN`** secret, if you have one, is attached as `serviceIntegrityDimensions`.
- **Retries with jittered backoff** on 429/5xx/network (`fetchRetry`).
- **Media proxy self-repair**: if a signed URL expires mid-playback (403/410), the worker re-runs the
  player pipeline, swaps in a fresh URL and retries the range request; the response carries
  `x-sv-refreshed: 1`. The app also re-requests `/api/player` automatically on a media error.
- **`/api/selftest?id=…`** runs the whole pipeline and reports timing, which pass succeeded, and breaker state.

Emergency mirrors are **off unless you set them** (you asked for no Piped/Invidious by default):

```bash
npx wrangler secret put EMERGENCY_MIRRORS   # https://inv.example.com
```

### Optional: cookies for age-restricted / members-only videos

Cookies are **worker-side secrets only** — never in the browser, never in Settings:

```bash
npx wrangler secret put YT_COOKIES   # "SID=...; HSID=...; SSID=...; SAPISID=..." (or Netscape cookies.txt)
npx wrangler secret put SV_KEY       # any random string; required to unlock cookie use
```

Then paste the same `SV_KEY` value into the app under **Settings → Access key**.

Behaviour:

1. Pass 1 always tries every client **without** cookies (public videos, zero account risk).
2. Only if that fails, pass 2 retries `android`, `web`, `ios`, `tv_embedded` **with** cookies
   (`web` also gets a computed `SAPISIDHASH`).
3. Cookies are ignored entirely unless the request carries the correct `SV_KEY`, so a public worker
   URL can't be used to ride your Google account.

Notes: use a **throwaway Google account** (YouTube ToS discourages this), cookies expire after
~1–2 years or on password/2FA change, and "confirm you're not a bot" issues are usually PoToken,
which cookies do not fully solve.

---

## The player (hand-built, YouTube-accurate)

Chrome is modelled on the real YouTube player:

- **48px controls** (52px in fullscreen, 42px on phones), 18px scrub bar that thickens to 6px on hover,
  red played bar, buffered bar, drag-to-seek, hover time tooltip.
- **Skip** — dedicated `↺10` / `10↻` buttons in the row, **double-tap the left/right third of the video**
  for ±10s with YouTube's ripple + "10 seconds" overlay, `j`/`l` for ±10s, `←`/`→` for ±5s.
  Double-tap the middle = fullscreen.
- **Settings** — a nested panel exactly like YouTube's: *Playback speed* (0.25×–3×, 10 steps),
  *Quality* (Auto + every muxed stream with its itag), *Zoom* (Fit to screen / Fill width / 125% / 150% / 200%),
  and *Preserve pitch*. Rows show the current value on the right, submenus have a back arrow, checks mark the
  active choice.
- **Pitch** — *Preserve pitch* (default, voices stay natural at any speed) or *Varispeed* (`preservesPitch`,
  `mozPreservesPitch`, `webkitPreservesPitch`).
- **Zoom** — Fit to screen (contain), Fill width (cover), or 125/150/200% zoom; the `z` key cycles, the zoom
  button in the row cycles too, and a badge shows the active mode next to the speed badge.
- Top gradient carries the title plus **Save to Watch later / Share / Open on YouTube**; the bottom row has
  play, skip, next, volume (hover slider), time, then settings / zoom / theater / fullscreen.
- Keyboard: `space`/`k` play-pause · `j`/`l` ±10s · `←`/`→` ±5s · `↑`/`↓` volume · `<`/`>` speed step ·
  `z` zoom · `m` mute · `f` fullscreen · `t` theater · `n` next · `0`–`9` jump to % · `esc` closes the menu.
- Quality switching keeps your position; autoplay pushes the next recommendation on end; specific errors with
  Retry / "Open on YouTube".

Everything persists (`sv_cfg`): volume, mute, speed, zoom, pitch. Settings also has default speed/zoom chips,
a pitch toggle and the full shortcut grid.

## Local preview (no worker needed)

```bash
node dev-server.mjs        # http://localhost:3000
```

This serves the real app, but answers `/api/*` with mock data and Google's public sample MP4s, so you can
click through the whole UI and player. It is a preview tool only — production uses your worker.

---

## Known limits

- Worker returns **muxed** formats only (usually 360p/720p). Higher resolutions come as separate video/audio
  DASH tracks and would need MSE muxing in the browser.
- Live streams and some age-restricted / members-only / region-locked videos return no muxed stream; the
  player then offers "Open on YouTube".
- YouTube's bot checks (`PoToken`) can reject a client on some networks; the ladder + cookies cover most cases,
  and the worker always reports what it tried. If all fail, `Retry` after a moment or from another network.
- Version discovery + 4-pass fallback make breakage rare and recoverable, but **"never breaks" is not a thing**:
  YouTube can change the cipher/player flow in a way that needs a code patch. What this setup does give you is
  graceful degradation (a dead client is skipped, playback self-heals, mirrors are the last resort) instead of
  a blank screen.
- Subscriptions: YouTube killed `feeds/videos.xml` in Oct 2026. The worker now falls back to the channel's
  Videos tab (InnerTube), which gives relative dates ("2 hours ago") — day grouping uses an approximation.
- Comments: `/api/comments` InnerTube `next` ke continuation par depend karta hai. YouTube shape badle to section
  khud "Comments load nahi ho paye" bolta hai (watch page safe rehta hai); `?token=` se paging hoti hai.
- Shorts: `/api/shorts` returns one page (up to 40). There is no endless scroll yet — hit Refresh for more,
  and YouTube's `FEshorts` tab is region/algorithm dependent, which is why the two fallbacks exist.
- Cloudflare free tier: 100k requests/day. Media proxying costs bandwidth — fine for personal use.
- Cloud store: the profile key lives in a cookie, so clearing cookies on every device loses the pointer to your
  data (the rows stay in Layerbase). Export a JSON backup if that matters. Browser "block all cookies" means a
  fresh profile every visit.
- Layerbase free tier sleeps after 15 min idle (first request after that takes ~1–5s) and is archived after 14
  idle days; the worker serves the last edge snapshot in the meantime and the dashboard Restore takes seconds.

## Files

```
index.html       entire app (React 18 UMD + Babel in-browser, no build step)
worker.js        Cloudflare Worker: InnerTube API + sig decipher + media proxy + RSS + Layerbase store
dev-server.mjs   local preview with mock API + sample MP4s
tests/           regression suites (worker: node tests/smoke.mjs etc; UI: see below)
```

### Tests

```bash
node tests/smoke.mjs      # worker core: decipher, list calls, breakers, media, routes
node tests/rsstest.mjs    # feeds: parsing, merge/dedupe/sort, resolveChannel, /api/rss + /api/channel
node tests/mptest.mjs     # /mp4 endpoint: Range/206, HEAD, content-type, ?itag, ?dl
node tests/clienttest.mjs # 31 checks: visitor-id header, watch referer, consent cookies (on/off),
                          # playbackContext, visionOS/Studio in the right pass, cookies kept in pass 3,
                          # scoreboard, /api/debug
node tests/keeptest.mjs   # 33 checks: expired/403/410/5xx/network self-heal, Range survival,
                          # mirror refresh fallback, /api/stream, /mp4, health guarantees
node tests/synctest.mjs   # 75 checks: Layerbase libSQL pipeline against a real SQLite, every cap, trim,
                          # edge-snapshot fallback, import/export, profile isolation, cron heartbeat,
                          # /api/sync/probe (connected? latency? rows? 5 setup steps when not)
node tests/brahmatest.mjs # 41 checks: failure classification, bot-check escalation, cookies pass,
                          # PoToken (secret + provider + cache), mirrors, canary, diagnosis output
node tests/budgettest.mjs # 24 checks: bot-checks never trip a breaker, network failures do, mirror order,
                          # subrequest budget (ladder stops, reserve kept, mirrors still run), honest canary
node tests/shortstest.mjs # Shorts: both renderer shapes, dedupe, view parsing, 3-step ladder, route

npm i jsdom react react-dom @babel/core @babel/preset-react
node tests/ui.test.cjs    # compiles the JSX out of index.html and drives it in jsdom
```

All worker suites import `worker.js` directly and stub `fetch`/`caches` — no npm install needed.
`synctest.mjs` runs the real SQL on Node's built-in `node:sqlite`, so **Node 22.5+** is required for it.
The UI suite is the only one that needs the npm packages above.
