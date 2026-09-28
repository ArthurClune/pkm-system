---
# pkm-tf15
title: Split sync-and-offline architecture doc into design and failure-modes/recovery docs
status: completed
type: task
created_at: 2026-09-28T19:12:42Z
updated_at: 2026-09-29T12:00:00Z
---

`docs/architecture/sync-and-offline.md` mixes two audiences: how sync is designed (replica, op queue, changes feed, nudges, snapshots) and the long tail of edge cases, guards and recovery paths that have accreted with each fix (fallback lane precedence, availability latch, window strikes, corruption reset and file replacement, pending-id guard, rollback error masking, poison repair ownership...). The design is hard to see through the guards.

Arthur's direction (2026-09-28): split it into two docs.

1. **Design** — the system as a newcomer needs it: components, data flow, the write path, the read/pull path, bootstrap, reconnect. Diagrams first.
2. **Failure modes and recovery** — every guard and recovery pattern, keyed by the failure it handles: what detects it, what the response is, which invariant must hold, and where the code lives. Tables over prose.

`docs/troubleshooting.md` stays the symptom-keyed index and links into doc 2.

## Todo
- [x] Inventory every section of sync-and-offline.md as design vs guard/recovery
- [x] Agree names and the split line with Arthur
- [x] Write the design doc (diagram-led) and the failure-modes doc (table-led), via the architecture-docs skill
- [x] Repoint inbound links: troubleshooting.md Where column, sibling docs, AGENTS.md doc list
- [x] Verify each claim against the code, not against the old prose
- [x] check-docs.mjs clean on both files

## Summary of Changes

- `docs/architecture/sync-and-offline.md` is now the design doc: model, key
  pieces, the online edit, the changes feed, nudges and hub fan-out, offline
  editing and the reconnect drain, conflicts at push time (new subsection),
  title activation, the replica (the cache-vs-intent rule as a consequence
  table linking into the recovery doc), ancillary details.
- New `docs/architecture/sync-recovery.md` ("Sync failure modes and
  recovery"): a failure-modes-at-a-glance table (failure / detected by /
  response / must hold / section), then local write failures and the fallback
  lane (with the lost-reply replay), replica open failures, the availability
  latch, UI banners, the pending-id guard, recovery-intent guards (table),
  rejected batches, a new "A pull that keeps failing" section (the stall
  classifier, previously undocumented), rebootstrap triggers, a `runRecovery`
  lifecycle flowchart plus options table, reset/rebase/file replacement, and
  missing-target convergence.
- Repointed troubleshooting.md Where links, design.md, frontend.md and
  frontend-editor.md; added the doc to overview.md and AGENTS.md.
- Corrected against the code: `strip_asset_tokens` lives in
  `pkm/assets_core.py`; manual reset's flush is `"skip"` when the user
  discards pending changes; a collapse of a missing block journals a
  tombstone rather than being silent; the worker latch is the `unavailable`
  variable, not the memoised `dbPromise`; the ops contract's path.
