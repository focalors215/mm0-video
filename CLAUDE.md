# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MM0 一起看 (repo `focalors215/mm0-video`) is a watch-together site. Users join a room via `/r/<id>`, and play/pause/seek/rate stay in sync across everyone in the room. It also has chat and video sources: direct links, HLS, or local uploads. UI text and README are in Chinese, so keep new user-facing strings in Chinese.

## Workflow

Every change must be committed and pushed to GitHub (`git push` to `origin main`) when it is done; don't leave work only local. SSH auth is already set up on this host via `~/.ssh/id_ed25519`. After code changes, also rebuild the running container (`docker compose up -d --build`).

## Commands

The host may not have Node installed. Docker is the primary runtime.

```bash
docker compose up -d --build     # build + run on :3000 (container name: mm0-video)
docker compose logs -f
bash deploy.sh                   # one-click deploy (installs Docker if missing, writes .env, health-checks /healthz)
bash update.sh                   # git pull --ff-only + rebuild; FORCE=1 to rebuild without new commits
```

To check syntax without a local Node install:
```bash
docker run --rm -v $PWD:/w node:20-alpine sh -c 'node --check /w/server.js && node --check /w/public/room.js'
```

There is no test suite or linter. Changes have been verified ad hoc in two ways:
- A `socket.io-client` script runs inside the container, or in `node:20-alpine`, to check sync.
- Headless Chromium runs in `node:20-alpine` (`apk add chromium` + `puppeteer-core`) and points at `http://172.17.0.1:3000` to check player behaviour. Alpine's Chromium plays H.264.

Config comes from env vars or `.env`: `PORT` (3000), `MAX_UPLOAD_GB` (10), `UPLOAD_DIR` (`data/uploads`, bind-mounted as a volume), `ICE_SERVERS` (JSON array for WebRTC voice).

When testing with headless Chromium, give each simulated user its own browser instance: background tabs defer media loading and stall rAF-based waits.

## Architecture

The backend is a single file, `server.js` (Express + Socket.IO). The frontend is vanilla JS in `public/` with no build step. Players are served from `node_modules`: `/vendor/hls.js` (always loaded), `/vendor/mpegts.js` (FLV) and `/vendor/dash.js` (DASH, pinned to dashjs 4.x) which room.js loads lazily.

**Room sync model.** Room state lives in memory only (`rooms` Map). It is lost on restart, and an empty room is deleted after 10 minutes. The server is authoritative: the playing item is `r.cur` (`{id, src, title, headers, subtitle}`) plus `{playing, time, rate, updatedAt}`. `currentTime(r)` extrapolates the position while playing. `snapshot()` (the `state` event) includes `itemId`, `subtitle`, `proxy` (item has custom headers → everyone must use the proxy) and `serverNow`; `roomInfo()` (the `room` event) carries settings, playlist and history.
- Clients estimate a clock offset via `ping_t` and compute the target time as `time + (now + offset - serverNow) * rate`.
- `control` events are broadcast to *other* clients only. Changing the item (`pl:add` with `play`, `pl:play`, `pl:next`) goes to everyone and resets to 0 (paused for manual picks, playing for auto-advance).
- Each client polls `getState` every 5s and corrects drift above 1.5s. A client in 自由模式 (free mode) neither applies nor sends control state, except item changes.
- Auto-advance: clients emit `ended {itemId}`; the server advances by `r.mode` (order/loop/one/shuffle). It ignores `ended` within 5s of the last item change, so several clients reporting it only advance once.

**Identity and permissions.** Each browser has a persistent `wt_uid` in localStorage, sent on `join`. The first uid to join a new room becomes owner (`r.ownerUid`), and `r.admins` holds admin uids. uids are never sent to other clients; members are addressed by socket id (`sid`). `controlMode: 'admins'` blocks members' `control`/playlist events, and the server answers a blocked `control` with the current `state` to revert the client. Room passwords are stored as a sha256 hash, owner/admins skip them. A kick bans the uid for 5 minutes. Create-time options (name/public/password) are passed from the home page through sessionStorage `wt_create_<id>` and only apply when the room doesn't exist yet.

**Echo suppression (room.js).** Applying remote state triggers native `play`/`pause`/`seeked` events. `suppressUntil` (800ms) stops those events from being re-broadcast; `applyState` sets it only when it actually changes the player (so a user's click right after a sync isn't swallowed). Any new code that changes the `<video>` element programmatically must go through `applyState` or set this window.

**Playback failure diagnosis.** On a video `error`, an HLS fatal error, or a 20s load timeout, the client calls `GET /api/probe?url=`. The server follows redirects manually, sends a 1KB Range request, and returns status, content-type, range support and a body snippet. `diagnose()` in room.js turns that into a Chinese explanation shown in `#errorBox`.

**Stream proxy (`/api/stream`).** Some netdisk CDNs (e.g. 123pan behind Alist-style `/d/` links) return `application/octet-stream` plus `Content-Disposition: attachment`, and Safari, iOS and in-app browsers refuse to play them.
- The proxy forwards `Range`, rewrites the type to `video/*` (guessed from the extension or the `filename` query param), and strips the disposition header.
- Proxying is per-client. The room's `src` stays the original URL, and only the affected browser switches, automatically for Safari/in-app, via a button otherwise.
- Items may carry custom headers (whitelist: Referer, Origin, User-Agent, Cookie, Authorization). They stay server-side, and Cookie/Authorization are dropped on cross-origin redirects.
- m3u8 responses are rewritten so segment/child-playlist/key URIs also go through the proxy, each signed with an HMAC of `(roomId, itemId, url)` using a per-process secret.
- It only serves a room's current `cur.src` or a URL with a valid signature for the room's current item, so it can't be used as an open proxy. Keep that check.

**Subtitles.** `POST /api/subtitle` converts SRT/ASS/SSA/VTT (UTF-8/UTF-16/GBK) to WebVTT under `uploads/subs/`; the `subtitle` socket event attaches it to the current item and everyone loads it as a `<track>`.

**Danmaku / fullscreen.** Chat messages fly over the video (`#danmaku` layer). The native fullscreen button is hidden (`controlslist="nofullscreen"`) and `#fsBtn` fullscreens the wrapper so danmaku and the in-video chat box stay visible; iOS falls back to `webkitEnterFullscreen`.

**Voice.** WebRTC mesh (max 8). The server only tracks `r.voice` and relays `voice:signal` between members who are both in voice. ICE servers come from `ICE_SERVERS` via `/api/config`. getUserMedia requires https.

**SSRF guard.** `assertPublic()` resolves DNS and runs on *every redirect hop* in both probe and stream. IPv6 `fc00::/7` and `198.18.0.0/15` are intentionally **not** blocked. The deploy host uses a fake-IP proxy DNS that resolves public domains into those ranges, and blocking them broke all links.

## Deployment notes

- The container runs as root, so the bind-mounted `./data/uploads` stays writable without chown juggling.
- Only one deployment can run per host, because `container_name: mm0-video` is fixed.
- Behind Nginx, WebSocket upgrade headers must be forwarded and `client_max_body_size` raised.
