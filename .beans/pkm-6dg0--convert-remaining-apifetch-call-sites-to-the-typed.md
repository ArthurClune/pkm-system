---
# pkm-6dg0
title: Convert remaining apiFetch call sites to the typed client
status: completed
type: task
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-02T17:43:50Z
parent: pkm-6phf
---

Follow-up to pkm-60bf. 32 apiFetch call sites remain on the untyped client; the full list and a reproducing grep live in pkm-60bf's Summary of Changes and .superpowers report. Cautions recorded there: sync/assets.ts stays on apiFetch (multipart), replicaSync.ts is an injection seam, GET conversions change mocked-fetch expectations ({method:"GET"} init, + for spaces in query strings). The null-query guard (b29882e) already landed.

- [x] Convert the enumerated call sites lane by lane, keeping tests honest
- [x] Decide whether raw apiFetch should then be lint-restricted outside api/

## Summary of Changes

Converted the 29 concrete JSON apiFetch calls remaining at current HEAD to generated path/method-aware helpers. Preserved multipart upload and the replicaSync transport-injection seam, added an enforced restricted-import rule with fixture coverage, updated intentional GET/query transport expectations, tightened op batches to require batch_id, and documented the API invariant.
