---
# pkm-xnnh
title: 'Offline sync: service worker app shell + asset runtime cache + manifest'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-13T20:46:54Z
parent: pkm-y8p0
blocked_by:
    - pkm-wptk
---

Spec step 7 (section 5): vite-plugin-pwa precached app shell (cold start offline), web manifest, runtime Cache-API caching of viewed assets with LRU cap (few hundred MB), navigator.storage.persist(), placeholders for uncached assets offline. Full 2GB asset sync and offline asset upload stay deferred (spec Deferred section).

## Summary of Changes

- **vite-plugin-pwa** (autoUpdate, clientsClaim/skipWaiting): precaches the built shell incl. the sqlite wasm binary (78 entries ~5MB); web manifest + generated icons (public/icon.svg, icon-192/512.png). navigateFallback /index.html with denylist /api, /assets, /login. Runtime CacheFirst for same-origin /assets/ with `expiration {maxEntries: 400, purgeOnQuotaError: true}`. /api is never cached.
- **main.tsx**: registerSW({immediate}) + navigator.storage.persist() (coverage-excluded glue).
- **Server**: SPA fallback now serves real dist-root files (sw.js, manifest.webmanifest, icons) with no-cache instead of shadowing them with index.html — a SW script served as HTML breaks registration (test_spa.py::test_root_level_dist_files_served_not_shadowed).
- **Cold-start readiness**: replicaSync.start() is single-flight and SyncProvider starts it at mount, so a hydrated replica reaches ready with no socket; when it turns ready while disconnected, resyncSeq bumps so views refetch through the shim.
- **AssetImage**: failed loads render a labelled 'image unavailable offline' placeholder; recovers on src change.
- **e2e** offline-shell.spec.ts: upload+embed image, SW controls page, hard reload fully offline → shell boots from SW, replica serves journal, cached image renders (naturalWidth>0), never-viewed asset shows placeholder. Full suite (6 specs) 5/5 consecutive green.

Deferred (unchanged): full 2GB asset sync, offline asset upload.
