# Recovering from a stale cached build

Bean: pkm-tybk.

## Why

The home-screen PWA kept running a precached bundle weeks older than the
server, because its service worker's install of each new build never
completed. The old bundle crashed on a changed response shape
(`l.breadcrumbs.length`), and the error screen's Reload, a plain link to `/`,
reloaded the same cached bundle. Nothing in the app could tell it was out of
date, and nothing in it could get out. The only recovery was deleting the
home-screen app.

## Goals

- The app learns, from its first API response, that the server serves a
  different build from the one it is running.
- It then shows a banner, "A newer version is available", whose button does
  a clean reload.
- The error screen's Reload does the same clean reload.
- A clean reload unregisters the service worker and deletes Cache Storage,
  then navigates to `/`, so the page loads from the network.

## Non-goals and anti-goals

- No automatic reload: the user picks the moment (Arthur chose the banner
  over auto-reload, so typing is never interrupted).
- A clean reload never touches OPFS or IndexedDB: the replica holds pending
  edits.
- A clean reload never runs while the server is unreachable: with the
  service worker gone and no network, nothing would boot. It probes
  `/healthz` first and falls back to a plain reload.
- No fix for the old bundle already on a device: only builds that ship this
  code can show the banner.
- No diagnosis of why a given device's install fails.

## Approaches

1. **Chosen: the build id in a response header.** The web build stamps an id
   into the bundle and writes `dist/build-id.json`. The server reads it at
   startup and sets `X-Pkm-Build` on its responses. `apiFetch` compares the
   header with the bundle's own id. Costs no extra request, and catches skew
   on the first call after launch or a reconnect.
2. A `GET /api/build` endpoint polled at launch and on foreground: an extra
   request and an OpenAPI route, and it checks only at the moments chosen.
3. Watching the service worker's update events: with `autoUpdate` there is
   no waiting state, and a failing install looks like "no update", which is
   the case this exists for.

## Design

- **Stamp.** `vite.config.ts` makes one id per build (`crypto.randomUUID()`;
  `dev` under `vite serve`), `define`s it as the bundle's build id, and a
  small plugin emits `build-id.json` (`{"build": "<id>"}`) into `dist`. Both
  come from the same value, so a build always matches its own file.
- **Server.** `create_app` reads `web_dist/build-id.json` once when
  `web_dist` is set. A middleware sets `X-Pkm-Build` on every response when
  an id was read. With no `web_dist`, or no file, or an unreadable one, no
  header is sent. Deploy rebuilds before restarting the service, so reading
  once at startup is enough.
- **Compare.** A Functional Core function decides skew from the bundle's id
  and the header: `dev`, a missing header, or an equal id are not skew.
  `apiFetch` (and `apiDownload`) pass each real network response's header to
  a small store. Shim responses carry no header and are never compared.
- **Banner.** `StaleBuildNotice` in `App.tsx`'s banner stack, next to
  `DroppedDraftNotice`, subscribes to the store and shows the message and a
  Reload button once skew is seen. It stays until the reload.
- **Clean reload.** One shell module, usable without React context (the
  error boundary sits outside the providers): probe `/healthz` with
  `cache: "no-store"`. On success, unregister every service worker
  registration, delete every Cache Storage entry, then `location.assign("/")`.
  On failure, a plain `location.reload()`.

## Left to the builder

- The banner's styling follows the existing banner stack classes.
- Test layers: unit tests for the skew rule, the store, the header read, the
  clean reload's branches; a pytest for the header and its absence; a
  Playwright spec that rewrites `X-Pkm-Build` on an API response with
  `page.route` and asserts the banner.
- Docs: the header row in `backend.md`, the rule (a clean reload never runs
  offline, never touches OPFS) in `frontend.md` § Build notes, and the
  skew sentence in `assistant.md` stays true.
