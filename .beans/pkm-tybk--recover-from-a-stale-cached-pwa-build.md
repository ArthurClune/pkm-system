---
# pkm-tybk
title: Recover from a stale cached PWA build
status: completed
type: bug
priority: normal
created_at: 2026-11-19T15:38:48Z
updated_at: 2026-11-19T19:54:40Z
---

Symptom: the home-screen PWA showed "Something went wrong / TypeError: undefined is not an object (evaluating 'l.breadcrumbs.length')" after a brief cached render; Safari on the same phone worked.

Cause: the PWA kept running a weeks-old precached bundle because its service worker's install of the new build never completed, so the old bundle met a server whose backlink items carry ancestor_uids instead of breadcrumbs. Nothing told the app it was out of date, and the error screen's Reload (a plain link to /) reloaded the same cached bundle.

Fix: the server advertises the build it serves (X-Pkm-Build header from web/dist/build-id.json); the app compares it with its own stamped id and shows a banner offering a clean reload (unregister the service worker, delete Cache Storage, keep the OPFS replica). The error screen's Reload does the same clean reload. Both fall back to a plain reload when the server is unreachable.

- [x] Design doc
- [x] Plan
- [x] Build id stamped into bundle and dist
- [x] Server header
- [x] Client comparison + banner
- [x] Clean reload (error screen + banner)
- [x] Docs
- [x] Verification

## Summary of Changes

Symptom: the home-screen PWA showed "Something went wrong / TypeError:
undefined is not an object (evaluating 'l.breadcrumbs.length')", and its
Reload brought the same error back.

Cause: a precached bundle weeks older than the server (the service worker's
install of newer builds kept failing) read a backlink field the server no
longer sends. The app could not tell it was stale, and the error screen's
Reload was a plain link that booted the same precached bundle.

Fix: `buildStampPlugin` stamps one id per build into the bundle and
`dist/build-id.json`; the server sends it as `X-Pkm-Build`, re-reading the
file when it changes; `apiFetch` compares it, and `StaleBuildNotice` offers a
clean reload. The error screen's Reload is the same `cleanReload()`: probe
`/healthz` (with a timeout), then unregister the service worker and delete
Cache Storage, never touching OPFS or IndexedDB; unreachable, a plain reload.
The rules are in docs/architecture/frontend.md § Build notes and
docs/architecture/backend.md § HTTP API reference.
