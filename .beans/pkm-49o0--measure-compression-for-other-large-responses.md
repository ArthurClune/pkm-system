---
# pkm-49o0
title: Measure compression for other large responses
status: scrapped
type: task
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

W11 gzips only /api/sync/snapshot and /api/sync/changes (about 8.6x on the perf fixture snapshot). Measure the SPA bundle and the large page reads over a slow link before deciding whether a wider scheme (middleware, precompressed static assets, brotli) is worth it. Check what Tailscale Serve does with Content-Encoding first.


## Reasons for Scrapping

Little to gain: the app reads from its local replica, and the service worker caches the bundle, so it downloads only after a deploy. (Arthur, 2026-11-11.)
