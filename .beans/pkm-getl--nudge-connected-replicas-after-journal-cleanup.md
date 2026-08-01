---
# pkm-getl
title: Nudge connected replicas after journal cleanup
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:03:57Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 10).

## Context

**References:** `server/src/pkm/server/routes_pages.py:423-448`; `server/src/pkm/server/notify.py:1-38`; change triggers in `server/src/pkm/schema.py:129-150`

Journal cleanup commits page/block deletions and advances changes.seq but sends no sequence nudge. Connected replicas can retain deleted pages until another mutation or reconnect. This overlaps the previously scrapped pkm-ie73, but the current invariant remains broken.

**Direction:** Send a post-commit nudge when cleanup deletes rows, and centralize the commit-then-nudge protocol to prevent route omissions.

## Tasks

- [x] Add WebSocket coverage for journal cleanup
- [x] Add a mutation-route contract test for every journal-advancing endpoint
- [x] Centralize or enforce post-commit notification

## Summary of Changes

- `server/src/pkm/server/routes_pages.py` `cleanup_journal`: takes `request`
  now and sends a WS seq nudge (`notify.nudge_threadpool`) after a commit
  that actually deleted a page. Guarded on `deleted` being non-empty (unlike
  most routes' unconditional nudge) because this route runs on every
  journal-page load and a no-op run — the common case — never advances
  `changes.seq`.
- `server/src/pkm/server/notify.py`: added `commit_and_nudge` (async) and
  `commit_and_nudge_threadpool` (sync-def) helpers that pair `db.commit()`
  with the matching nudge in one call, so a route has one line to remember
  instead of two. Refactored every existing call site where commit and
  nudge were already adjacent to use them (`routes_pages.py`'s page
  create/delete/rename/autocreate/journal-autocreate paths,
  `routes_sidebar.py`'s add/delete/reorder). Left the three sites where
  commit and nudge can't be adjacent as separate calls: `delete_asset`
  (commits before best-effort unlink), `upload_asset` (writes only to
  `assets`, which isn't journal-triggered, so it never nudges), and
  `POST /api/ops` (broadcasts the applied-op echo between commit and nudge).
- `server/tests/test_journal_advancing_contract.py` (new): enumerates all 11
  journal-advancing routes/scenarios (writes to
  `blocks`/`pages`/`sidebar_entries`) and asserts each emits a seq nudge
  over a real WebSocket connection. This is the enforcement mechanism per
  the brief: a route that starts writing to a journaled table without a
  corresponding case here is an uncovered contract gap, the same shape
  that let cleanup ship without a nudge. Includes `delete_asset` exercised
  with a referencing block (its `blocks`-writing branch), added in the
  review-fix round below after the initial version wrongly excluded it.

### Review-fix round 1

The task review found the contract test's route list was incomplete and
its stated rationale factually wrong: `delete_asset` conditionally writes
to `blocks` (stripping/deleting any block that references the deleted
asset) whenever the asset has referencing blocks, which is exactly the
"journal-advancing" shape this task defines — the nudge there is
load-bearing, not incidental surplus, contrary to what the test's
docstring and the architecture doc both claimed. Fixed:

- Added a `delete_asset`-with-referencing-block case to
  `JOURNAL_ADVANCING_ROUTES`, asserting `refs_removed == 1` so the run
  provably takes the `blocks`-writing branch rather than degrading into a
  duplicate of the orphan-delete case.
- While adding it, found the test harness itself had a latent flaw: four
  existing entries (`delete_page`, `rename_page`, `delete_sidebar_entry`,
  `reorder_sidebar`) ran their setup mutations *after* the WebSocket was
  already open, so the setup's own nudge (not the action's) could be what
  satisfied the frame-scan loop — the same "passes without proving
  anything" trap the reviewed finding was about, just relocated. Restructured
  every entry into separate `setup`/`action` callables threaded through a
  per-test `ctx` dict: `setup` runs before the WS connects, `action` (the
  route actually under test) runs after, so the checked nudge is
  unambiguously the action's own.
- Corrected `docs/architecture/sync-and-offline.md`'s "Post-commit
  nudges" section: `delete_asset`'s nudge is load-bearing in the
  referencing-block branch and mere unchanged-seq surplus only in the
  orphan-delete branch — not a blanket "harmless" exception like
  `upload_asset`.

Covering tests: `uv run pytest -q tests/test_journal_advancing_contract.py
tests/test_asset_delete.py --no-cov -v` → 20 passed. Full suite:
`uv run pytest -q` → 1044 passed, 96.24% coverage. `uv run pyrefly check`
→ 0 errors. `uv run ruff check` → All checks passed.
- `server/tests/test_journal_cleanup.py`: added
  `test_cleanup_deletion_emits_seq_nudge` (RED before the fix — hung
  forever waiting for a nudge frame that never arrived, confirming the
  missing call) and `test_cleanup_noop_emits_no_seq_nudge` (guards the
  conditional-nudge decision against regressing to "always nudge").
- `docs/architecture/sync-and-offline.md`: new "Post-commit nudges" section
  documenting the commit-then-nudge invariant, the new helpers, the three
  adjacency exceptions, cleanup's conditional guard, and the contract
  test's role as the enforcement mechanism.

No HTTP route, query param, or response field changed (cleanup_journal
gained a `request: Request` dependency-injected parameter, not a client-
visible one; its request/response shape is unchanged), so no OpenAPI/type
regen was needed.
