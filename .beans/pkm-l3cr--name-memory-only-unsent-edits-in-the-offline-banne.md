---
# pkm-l3cr
title: Name memory-only unsent edits in the offline banner, not only the replica-unavailable banner
status: completed
type: task
priority: normal
created_at: 2026-09-29T13:20:43Z
updated_at: 2026-09-29T15:31:18Z
parent: pkm-a4t2
---

Review F9 (documented gap; Fable C3, an accepted limitation under pkm-0htf).
A replica that opens and then fails every write keeps the user's edits in
the in-memory fallback lane. `availabilityOf` returns null for a plain
`ReplicaError`, the "exist only in memory" sentence renders only inside
`ReplicaUnavailableBanner`, and the unload guard is desktop-only, so the
state looks like healthy offline queueing.

Decision (Arthur, 2026-09-29): show the existing sentence whenever
`unsentInMemory > 0` and the socket is not connected, outside the unavailable
banner. This narrows pkm-0htf rather than reversing it: the degraded-write
banner it dropped needed a failure counter and a threshold; this is a display
rule over the count pkm-0htf built for the guard. Online, the lane drains
within a drain cycle, so a healthy session never shows it.

Design: spec § F9.

## Todo

- [x] Failing `OfflineIndicator` tests: renders offline with lane entries; not when connected; not offline with only durable rows pending
- [x] `OfflineIndicator` reads `unsentInMemory`; the offline `ConnectivityBanner` appends the sentence; the helper is shared with `ReplicaUnavailableBanner`
- [x] Docs: `sync-recovery.md` § What the UI shows and the F9 failure row, stating it narrows pkm-0htf
- [x] verify, merge

## Summary of Changes

- `web/src/components/OfflineIndicator.tsx`: extracted `memoryOnlySentence(unsentInMemory)`
  as a pure helper above `onlineOnlySafetyCopy`, which now delegates to it.
  `ConnectivityBanner` takes a new `unsentInMemory: number` prop and appends the
  sentence in both its `!canEdit` and default offline branches (never while
  `status === "connected"`). `OfflineIndicator()` reads `unsentInMemory` from
  `useSyncHealth()` and passes it through.
- `web/src/components/OfflineIndicator.test.tsx`: four new tests (45 total in
  the file, up from 41) — names memory-only edits in the offline connectivity
  banner; does not name them while connected; says nothing when only durable
  rows are pending; names them even while editing is paused (read-only branch).
- `docs/architecture/sync-recovery.md`: rewrote the "replica opens, then fails
  every write" failure-modes row and replaced the "Known gap" paragraph in
  § What the UI shows with the new display rule, stating it narrows pkm-0htf's
  degraded-write-banner decision rather than reversing it.
- `docs/troubleshooting.md`: added a row for this symptom in the "Sync and
  offline" table, after the `pkm-jyx1` row.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis`,
`pnpm test:coverage` (180 files, 2831 tests, all pass), `pnpm build` all green.
No server, route, docstring, or e2e surface touched by this fix.
