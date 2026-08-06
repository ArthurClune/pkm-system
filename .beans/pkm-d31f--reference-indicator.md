---
# pkm-d31f
title: Reference indicator
status: completed
type: feature
priority: normal
created_at: 2026-07-30T20:52:51Z
updated_at: 2026-08-06T11:50:41Z
---

Blocks with references (block level not page) should have an indicator in the right gutter that is number of references ('1', '2' etc on a small block). Clicking on that should show the places where it's referenced in a pop up

## Tasks (plan: docs/superpowers/plans/2026-08-06-pkm-d31f-block-ref-indicator.md)

- [x] Task 1: block_refs table in schema + regenerated client schema artifact
- [x] Task 2: server write-path maintenance
- [x] Task 3: one-time server backfill at startup
- [x] Task 4: importer populates block_refs
- [x] Task 5: block_ref_counts in page and journal payloads
- [x] Task 6: GET /api/block/{uid}/backlinks
- [x] Task 7: replica write paths, shim reads, parity fixture
- [x] Task 8: badge in the outline
- [x] Task 9: references popover
- [x] Task 10: e2e spec
- [x] Task 11: architecture docs, bean completion, full verification

## Summary of Changes

- `block_refs(src_block_uid, target_block_uid)` added to the replicated BASE_DDL (PK collapses duplicate mentions; no FK on target — unresolved `((uid))` is legal), with `idx_block_refs_target` and regenerated `baseSchema.gen.ts`.
- Server write paths keep it current: `store.reindex_block_refs` called from the `ReindexRefs` op handler and the rename rewrite loop; deletes cascade.
- One-time `sync_meta`-guarded backfill in `db.py::init_db` indexes pre-existing text; the importer emits rows directly.
- `PagePayload`/`JournalPayload` gained `block_ref_counts` (distinct referencing blocks, count >= 1 only); new `GET /api/block/{uid}/backlinks` returns backlink-style groups, unpaginated (422 malformed uid, 404 unknown block).
- Replica derives `block_refs` locally (localOps create/update_text, apply upsert, snapshot wipe) — rows never ship over sync; shim serves counts and block backlinks byte-identically (parity fixture regenerated with a block_backlinks case).
- UI: sparse per-row count badge in the gutter (`RefCountBadge`, `.block-ref-badge`, not hidden on phones), popover (`BlockRefBacklinksPopover`) fetching live at open, rendering through the extracted shared `BacklinkGroupList`; entries navigate to `pagePath(title)#uid`.
- E2E spec `web/e2e/block-ref-indicator.spec.ts`; architecture docs updated (backend API table + ER diagram + derived-indexes note, frontend module map + badge/popover prose, sync derived-locally note, styling badge/popover invariants, overview derived-tables line, e2e count).
- All gates green: server 1443 passed / 96.96% coverage / pyrefly / ruff; web `pnpm verify` incl. 52 e2e.

Out of scope by design: sidebar-panel badges, CLI/MCP reads, `_block_is_referenced` LIKE-scan swap (possible follow-up bean).
