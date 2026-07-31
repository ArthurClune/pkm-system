---
# pkm-1rb5
title: Reject normalized-empty page titles at the shared creation boundary
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:38Z
updated_at: 2026-07-31T15:54:38Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 2.

**References:** server/src/pkm/server/store.py:18-38; server/src/pkm/server/ops_apply.py:61-79; server/src/pkm/server/routes_pages.py:197-204

get_or_create_page() normalizes control whitespace but does not reject a title that becomes "". The normal page route checks this, but create/create_page/cross-page move operations call the store directly and can commit an unreachable blank-titled page.

**Direction:** Make the shared creation boundary define normalized-empty behavior. Prefer rejecting the operation before mutation with a stable operation error; if offline replay needs a different recovery policy, specify it explicitly. NOTE: pkm-hjhy established titles must never 422 on the ops path (wedges offline queues) — reconcile with that invariant.

- [x] Add whitespace-only title tests for create, create_page, and move operations
- [x] Enforce the invariant in the shared creation path

## Summary of Changes

`get_or_create_page()` (server/src/pkm/server/store.py) is now the single place that defines "blank": after normalizing, if the title collapsed to `""` it raises a new `BlankTitleError` instead of silently inserting a blank-titled, unreachable page. Every caller now picks an explicit recovery policy:

- `POST /api/pages` (routes_pages.py `create_page`) catches `BlankTitleError` and returns 422 — unchanged observable behavior for interactive clients, but the blank check is no longer duplicated ahead of the call; the store is the sole authority.
- `ops_apply.py` adds `_resolve_page()`, a thin wrapper around `get_or_create_page()` used for every op-supplied `page_title` (`CreatePageOp`, `CreateOp`, and cross-page `MoveOp`). It catches `BlankTitleError` and falls back to a fixed constant, `UNTITLED_PAGE_TITLE = "Untitled"`, so a whitespace-only `page_title` (which passes pydantic's `min_length=1` untouched, e.g. `"\n\t"`) still lands the batch with 200 rather than 400/422ing and wedging an offline client's replay queue (the pkm-hjhy invariant). Repeated blank titles land on the same fallback page (ordinary get_or_create semantics), not one blank page each.
- The two ref-indexing call sites (`store.py`'s `rewrite_referencing_blocks`, `ops_apply.py`'s reindex loop) and the daily-page call sites are untouched: their titles are always already non-blank by construction (refs.extract() drops empty refs before they reach get_or_create_page; title_for_date() never produces a blank string), so they were never at risk and don't need the fallback wrapper.

docs/architecture/backend.md's "Normalise, never 422" section gained a paragraph explaining this one exception and pointing at `BlankTitleError`/`_resolve_page()`/`"Untitled"`.

**Tests** (server/tests/test_blank_titles.py, new file): unit test that `get_or_create_page` raises `BlankTitleError` for a whitespace-only title without touching the DB; ops-path tests for `create`, `create_page`, and cross-page `move` with a whitespace-only `page_title`, each asserting 200 (not 400/422), no blank-titled row ever appears, and the block/page lands on `"Untitled"`; an idempotency test that two separate blank-title `create_page` ops land on the *same* fallback page; and a regression test confirming `POST /api/pages` still 422s on a whitespace-only title.

**Verification:** `uv run pytest -q` → 973 passed, 95.98% coverage (threshold 95%). `uv run pyrefly check` → 0 errors. `uv run ruff check` → all checks passed.
