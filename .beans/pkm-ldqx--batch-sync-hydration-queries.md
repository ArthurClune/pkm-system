---
# pkm-ldqx
title: Batch sync hydration queries
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:41:24Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 12).

## Context

**References:** `server/src/pkm/server/routes_sync.py:36-71,93-104,124-135`

Changed blocks are hydrated with one block query and one refs query per UID; pages/sidebar entries are also fetched individually. A legal 5,000-entity window can execute over 10,000 SQL statements, and snapshots have no block limit while holding a read transaction.

**Direction:** Fetch blocks, refs, pages, and sidebar rows in chunked set queries under SQLite's parameter limit and group them in memory.

## Tasks

- [x] Add distinct-UID query-count or benchmark coverage
- [x] Replace N+1 hydration with bounded set queries

## Summary of Changes

Replaced the per-UID hydration loops in `server/src/pkm/server/routes_sync.py`
(`_block_payloads`, `_page_payloads`, and the changes feed's inline sidebar
loop) with chunked `WHERE x IN (...)` set queries:

- `_blocks_by_uid` / `_refs_by_block` / `_page_payloads` / `_sidebar_payloads`
  each batch their id list into `chunk_ids()`-sized groups (≤500 params per
  statement, comfortably under SQLite's historic 999-parameter cap and the
  modern 32766 cap) and build an id-keyed dict from the results.
- `hydrate_in_order()` (new, Functional Core) puts each dict back into the
  caller's original id order, dropping ids nothing was found for — this is
  what reproduces the old per-uid loop's ordering (blocks in window order,
  pages sorted, sidebar in window order) and its "missing row -> tombstone"
  semantics, without doing a query per id.
- `refs` is a `WITHOUT ROWID` table keyed on
  `(src_block_uid, target_page_id, kind)`; the batched refs query orders
  explicitly by those columns so each block's ref list comes back in the
  same order the old single-uid query produced (that query had no
  `ORDER BY` either, but a WITHOUT ROWID scan is already a PK-order btree
  walk).
- `chunk_ids()` and `hydrate_in_order()` live in `sync_core.py` (Functional
  Core, pure); the `db.execute` calls and dict-building stay in
  `routes_sync.py` (Imperative Shell).
- Response shapes are unchanged (`ChangesPayload`/`SnapshotPayload` fields
  and ordering are identical to before) — no OpenAPI regen needed.

**Tests** (TDD, RED before implementation):
- `tests/test_sync_core.py`: unit tests for `chunk_ids` (splits at
  `CHUNK_SIZE`, empty input, under-one-chunk) and `hydrate_in_order`
  (preserves order, skips missing, empty order).
- `tests/test_sync_query_batching.py` (new): seeds 1,200 blocks + refs
  (spanning 3 chunk boundaries at `CHUNK_SIZE=500`) and asserts, via
  `sqlite3.Connection.set_trace_callback`, that `sync_changes` and
  `sync_snapshot` each execute a chunk-bounded number of statements
  (`< 4 * ceil(n/CHUNK_SIZE) + 10`) rather than one that scales with n —
  proving the old ~2 statements/uid pattern (2,400+ for this seed) is gone.
- `tests/test_sync_endpoints.py::test_feed_hydrates_sidebar_entries` (new):
  the refactored sidebar hydration path had no existing test exercising it
  with a real entry (only journal-row tests existed); added one so
  `_sidebar_payloads` isn't just covered by the batching test's empty case.

**Verification:** `cd server && uv run pytest -q` — 1055 passed, 96.27%
coverage (`routes_sync.py` and `sync_core.py` both 100%). `uv run pyrefly
check` — 0 errors. `uv run ruff check` — all checks passed.
