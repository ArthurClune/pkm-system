---
# pkm-6dg0
title: Convert remaining apiFetch call sites to the typed client
status: todo
type: task
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-01T18:05:52Z
parent: pkm-6phf
---

Follow-up to pkm-60bf. 32 apiFetch call sites remain on the untyped client; the full list and a reproducing grep live in pkm-60bf's Summary of Changes and .superpowers report. Cautions recorded there: sync/assets.ts stays on apiFetch (multipart), replicaSync.ts is an injection seam, GET conversions change mocked-fetch expectations ({method:"GET"} init, + for spaces in query strings). The null-query guard (b29882e) already landed.

- [ ] Convert the enumerated call sites lane by lane, keeping tests honest
- [ ] Decide whether raw apiFetch should then be lint-restricted outside api/
