---
# pkm-ynze
title: Page delete wins over stale offline edits
status: completed
type: feature
priority: normal
created_at: 2026-10-14T09:07:45Z
updated_at: 2026-10-14T11:07:46Z
---

Spec: docs/superpowers/specs/2026-10-14-page-delete-wins-design.md

A stale offline batch (built before its device saw a page delete) must not re-create the deleted page: top-level creates/moves/create_page on it are parked in the daily note, and every link to it in the batch's text becomes plain text. Server records user page deletes (title + sync seq); OpBatch carries the client's seen sync seq.

## Todo

- [x] Plan (docs/superpowers/plans/2026-10-14-page-delete-wins.md)
- [x] Server: page-deletion record (user deletes only; not dailies, cleanup_journal, merges), pruned with block_rewrites
- [x] Contract: optional seen-seq on OpBatch; regen openapi + types
- [x] Web: replica worker records the cursor at enqueue
- [x] Server: stale top-level create/move/create_page parked or no-op; new skip handled by the client
- [x] Server: unlink stale titles in all create/update_text text of a stale batch
- [x] Docs: backend.md, sync-and-offline.md, troubleshooting row
- [x] Gates: server, web verify, perf, proptest

## Summary of Changes

- Server records user page deletes in `page_deletions` (title, journal seq, deleted_at); daily titles, cleanup_journal, merges and the title migration are not recorded; pruned only on the delete path.
- `OpBatch.seen_seq` (optional, not hashed). `store.stale_titles` decides staleness; no query for a batch without it.
- In a stale batch: links to stale titles become plain text in every create/update_text (with `unlink` block_rewrites rows so chained edits apply clean); stale create_page dropped; stale top-level create parked in today's daily note (skip `stale_page`, ack reason `page_deleted`); stale top-level move stays put with a note.
- Web: `pending_seen` replica table filled at enqueue (only once bootstrapped); sent by the durable queue path and recovery flushes; `ensureClientTables` memoised per handle.
- Docs: backend.md (Stale batches), sync-and-offline.md, sync-recovery.md, frontend.md, troubleshooting row.
- Gates: server pytest/pyrefly/ruff, web verify, perf (no changes), proptest (all) pass.
- Follow-ups: pkm-4g1a, pkm-wj3x.
