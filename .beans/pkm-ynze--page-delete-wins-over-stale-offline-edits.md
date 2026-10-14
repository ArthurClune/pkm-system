---
# pkm-ynze
title: Page delete wins over stale offline edits
status: todo
type: feature
priority: normal
created_at: 2026-10-14T09:07:45Z
updated_at: 2026-10-14T09:17:40Z
---

Spec: docs/superpowers/specs/2026-10-14-page-delete-wins-design.md

A stale offline batch (built before its device saw a page delete) must not re-create the deleted page: top-level creates/moves/create_page on it are parked in the daily note, and every link to it in the batch's text becomes plain text. Server records user page deletes (title + sync seq); OpBatch carries the client's seen sync seq.

## Todo

- [x] Plan (docs/superpowers/plans/2026-10-14-page-delete-wins.md)
- [ ] Server: page-deletion record (user deletes only; not dailies, cleanup_journal, merges), pruned with block_rewrites
- [ ] Contract: optional seen-seq on OpBatch; regen openapi + types
- [ ] Web: replica worker records the cursor at enqueue
- [ ] Server: stale top-level create/move/create_page parked or no-op; new skip handled by the client
- [ ] Server: unlink stale titles in all create/update_text text of a stale batch
- [ ] Docs: backend.md, sync-and-offline.md, troubleshooting row
- [ ] Gates: server, web verify, perf, proptest
