---
# pkm-3iwm
title: 'Recovery lease holds the worker gate across network I/O: measure, then document or restructure'
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T13:12:09Z
parent: pkm-4gda
blocked_by:
    - pkm-onr2
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W11. Child of the 2026-11-09 maintainability review epic.


## Plan

Task-level plan: docs/superpowers/plans/2026-11-11-w11-recovery-lease.md
(Arthur, 2026-11-11: option (c), the lease follows the download, plus
compression of the snapshot and changes responses).

- [x] T1 The sync routes gzip their bodies
- [x] T2 The worker renews a recovery lease
- [x] T3 A property over the worker lease
- [x] T4 apiFetch bounds a read by its silence
- [x] T5 runRecovery renews on progress and abandons a stalled download (after pkm-jowv)
- [x] T6 "Reset failed" shows the message, not the class
- [x] T7 The sync suite meets slow and stalled downloads
- [x] T8 Docs say what W11 made true
- [x] T9 The troubleshooting row (own final commit)
- [x] T10 Measure the fix (reduced by Arthur to two Chromium rows; WebKit proxy and other rows skipped)


## Summary of Changes

The worker's recovery lease now follows progress: each flush ack and each
snapshot chunk renews it through `renewRecovery` (at most every
`LEASE_RENEW_EVERY_MS`), a download silent for `SNAPSHOT_STALL_MS` is
abandoned by the client, and an expired lease is refused `LEASE_EXPIRED`.
A run granted a lease after a long wait at the gate renews at once.
`/api/sync/snapshot` and `/api/sync/changes` are gzipped (`http_encoding.py`),
rendered with pydantic's `dump_json` as FastAPI does: perf `bytes` is
unchanged at 15,143,025 and no timing flagged. "Reset failed" shows the
message. The sync property suite draws slow and stalled snapshots against a
`lease held` invariant. Docs: sync-recovery.md § The recovery lease,
backend.md, frontend.md, SECURITY.md (compression row), checks.md, one
troubleshooting row.

Measured (report-w11-t10.md): rebase at 1 Mbit/s commits after a 14.7 s
download (was refused at 121.6 s); Reset at 400 kbit/s succeeds after 35.8 s
(was "Reset failed" at 303 s). Neither row outlasts the lease, so they show
gzip end to end; renewal is covered by the unit, props and property tests.

Gates on the merged branch: pnpm verify, full server pytest, pyrefly, ruff,
regen (no diff), perf backend, proptest web --file sync. Skipped by
agreement: proptest server and other web suites, perf frontend.
Whole-branch review: report-w11-review.md (0 blockers); fixes in
report-w11-fix.md. Reports live in the gitignored handoffs directory
docs/superpowers/handoffs/2026-11-09-maintainability-review/.

Follow-ups: pkm-j0u0, pkm-9o9m, pkm-1pzy, pkm-49o0, pkm-qx59, pkm-ll64,
pkm-t3km, pkm-pmym.
