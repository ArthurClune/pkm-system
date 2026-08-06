---
# pkm-d31f
title: Reference indicator
status: in-progress
type: feature
priority: normal
created_at: 2026-07-30T20:52:51Z
updated_at: 2026-08-06T10:09:14Z
---

Blocks with references (block level not page) should have an indicator in the right gutter that is number of references ('1', '2' etc on a small block). Clicking on that should show the places where it's referenced in a pop up

## Tasks (plan: docs/superpowers/plans/2026-08-06-pkm-d31f-block-ref-indicator.md)

- [x] Task 1: block_refs table in schema + regenerated client schema artifact
- [x] Task 2: server write-path maintenance
- [x] Task 3: one-time server backfill at startup
- [ ] Task 4: importer populates block_refs
- [ ] Task 5: block_ref_counts in page and journal payloads
- [ ] Task 6: GET /api/block/{uid}/backlinks
- [ ] Task 7: replica write paths, shim reads, parity fixture
- [ ] Task 8: badge in the outline
- [ ] Task 9: references popover
- [ ] Task 10: e2e spec
- [ ] Task 11: architecture docs, bean completion, full verification
