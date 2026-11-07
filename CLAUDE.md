# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MM0 一起看 (repo `focalors215/mm0-video`) is a watch-together site. Users join a room via `/r/<id>`, and play/pause/seek/rate stay in sync across everyone in the room. It also has chat and video sources: direct links, HLS, or local uploads. UI text and README are in Chinese, so keep new user-facing strings in Chinese.

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

Config comes from env vars or `.env`: `PORT` (3000), `MAX_UPLOAD_GB` (10), `UPLOAD_DIR` (`data/uploads`, bind-mounted as a volume).

## Architecture

The backend is a single file, `server.js` (Express + Socket.IO). The frontend is vanilla JS in `public/` with no build step. `hls.js` is served from `node_modules` at `/vendor/hls.js`.

**Room sync model.** Room state lives in memory only (`rooms` Map). It is lost on restart, and an empty room is deleted after 10 minutes. The server is authoritative: state is `{src, playing, time, rate, updatedAt}`. `currentTime(r)` extrapolates the position while playing, and every snapshot includes `serverNow`.
- Clients estimate a clock offset via `ping_t` and compute the target time as `time + (now + offset - serverNow) * rate`.
- `control` events are broadcast to *other* clients only. `setSource` goes to everyone and resets the room to paused at 0.
- Each client polls `getState` every 5s and corrects drift above 1.5s.

**Echo suppression (room.js).** Applying remote state triggers native `play`/`pause`/`seeked` events. `suppressUntil` (800ms) stops those events from being re-broadcast. Any new code that changes the `<video>` element programmatically must go through `applyState` or set this window.

**Playback failure diagnosis.** On a video `error`, an HLS fatal error, or a 20s load timeout, the client calls `GET /api/probe?url=`. The server follows redirects manually, sends a 1KB Range request, and returns status, content-type, range support and a body snippet. `diagnose()` in room.js turns that into a Chinese explanation shown in `#errorBox`.

**Stream proxy (`/api/stream`).** Some netdisk CDNs (e.g. 123pan behind Alist-style `/d/` links) return `application/octet-stream` plus `Content-Disposition: attachment`, and Safari, iOS and in-app browsers refuse to play them.
- The proxy forwards `Range`, rewrites the type to `video/*` (guessed from the extension or the `filename` query param), and strips the disposition header.
- Proxying is per-client. The room's `src` stays the original URL, and only the affected browser switches, automatically for Safari/in-app, via a button otherwise.
- It only serves URLs that are currently some room's `src`, so it can't be used as an open proxy. Keep that check.

**SSRF guard.** `assertPublic()` resolves DNS and runs on *every redirect hop* in both probe and stream. IPv6 `fc00::/7` and `198.18.0.0/15` are intentionally **not** blocked. The deploy host uses a fake-IP proxy DNS that resolves public domains into those ranges, and blocking them broke all links.

## Deployment notes

- The container runs as root, so the bind-mounted `./data/uploads` stays writable without chown juggling.
- Only one deployment can run per host, because `container_name: mm0-video` is fixed.
- Behind Nginx, WebSocket upgrade headers must be forwarded and `client_max_body_size` raised.
