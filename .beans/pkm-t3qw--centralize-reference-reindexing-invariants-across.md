---
# pkm-t3qw
title: Centralize reference reindexing invariants across server and replica
status: completed
type: task
priority: high
tags:
    - review
    - architecture
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-18T13:33:03Z
parent: pkm-wvvu
---

## Review findings

Backend A2 and frontend A5. The invariant that refs and block refs are rebuilt from block text is encoded as repeated delete, extract, and insert rituals in two Python paths and two replica paths.

## Acceptance criteria

- [x] Add a server `store.reindex_refs_for_text(db, uid, text, now_ms)` composition and use it from operation application and snapshot rewriting
- [x] Add a replica `reindexBlockRefs(db, uid, text)` composition and use it from both remote apply and local operation application
- [x] Preserve blank-ref handling, page creation/index semantics, timestamps, and transaction ownership
- [x] Add focused tests that would fail if either call site drifted from its shared implementation
- [x] Check server/TypeScript parity explicitly and update sync/backend architecture invariants

## Summary of Changes

**Server.** `store.reindex_refs_for_text(db, uid, text, now_ms)` now owns the
delete -> extract -> index_ref loop -> reindex_block_refs ritual. Both call
sites use it: `ops_apply._execute`'s `ReindexRefs` branch (which no longer
imports `extract`, `index_ref` or `reindex_block_refs`) and
`store.rewrite_snapshotted_blocks`, i.e. rename, merge and the title migration.
Blank refs are still dropped inside `index_ref`, `now_ms` still stamps only
pages a `[[link]]` creates, and the composition still never commits.

**Replica.** New `web/src/replica/blockRefs.ts` (Imperative Shell) exports
`reindexBlockRefs(db, uid, text)`, called by `apply.ts::upsertBlock` (remote
apply) and `localOps.ts::reindexRefs` (local ops). It returns the parse so
`localOps` reads the text once while also rebuilding `refs`; block_refs are now
written before refs there, which is unobservable (no FK between the two tables,
no triggers on either, one transaction).

**Parity checked, and deliberately asymmetric.** The server composition rebuilds
both `refs` and `block_refs` from text; the replica one rebuilds `block_refs`
only, because `refs` rows ship hydrated in the feed (their target is a page id
only the server mints) and `localOps` resolves titles to negative local page ids
for its own writes. Blank-ref filtering lives in the two parity-pinned
extractors, so neither composition needs its own check. Two other places that
call `extract().block_refs` are intentionally out of scope: `db.py::init_db`'s
one-time backfill (insert only, no delete) and `importer/rows.py` (bulk row
building for an empty database).

**Tests.** `server/tests/test_refs_reindex.py` (14) and
`web/src/replica/blockRefs.test.ts` (12) spy on each composition to pin
delegation from every call site, plus semantics (replace not append, blank refs,
dangling targets, page stamping, no commit) and an equivalence check that the
call sites index the same text identically. Each delegation test was confirmed
red against a temporarily re-inlined call site.

**Docs.** `backend.md` § The write path names the single server composition
(and corrects the blank-ref paragraph, which claimed two call sites resolve refs
independently); `sync-and-offline.md` § Offline editing and reconnect gains the
derived-index parity note and the changes-feed bullet now links to it;
`frontend.md`'s replica module map lists `blockRefs.ts`.
