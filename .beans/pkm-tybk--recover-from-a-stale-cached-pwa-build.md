---
# pkm-tybk
title: Recover from a stale cached PWA build
status: in-progress
type: bug
created_at: 2026-11-19T15:38:48Z
updated_at: 2026-11-19T15:38:48Z
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
- [ ] Verification
