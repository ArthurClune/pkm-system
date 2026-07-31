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

## Fix round 1 (review findings)

Review found the fix was incomplete: `refs.normalize_title()` is deliberately narrow — it only collapses whitespace when the title holds a *control* character ([\t\n\r\f\v]); a title of plain spaces alone (`"   "`) passes through byte for byte. Two consequences, both fixed:

- **Finding 1 (test falsely passing):** the idempotency test posted `"\n\t"` then `"   "` and asserted both converged on `"Untitled"` — but `"   "` never reached the fallback under the round-1 code (see finding 2), so the test wasn't exercising convergence at all, just the trivial fact that exactly one blank title happened to become `"Untitled"`. Fixed by using two *different* control-whitespace-only strings (`"\n\t"` and `" \n "`, both genuinely normalize to `""`) and asserting total page count, not just the fallback's count.
- **Finding 2 (real bug):** because `normalize_title("   ")` returns `"   "` unchanged, `get_or_create_page(db, "   ", ...)` did not raise `BlankTitleError` — it created a real page literally titled `"   "`, reachable by nothing. Fixed by stripping in `get_or_create_page` itself, after `normalize_title`, before the emptiness check (`title = normalize_title(title).strip()`). This makes the ops path symmetric with the HTTP route, which already strips (`body.title.strip()`) before calling in.

Also folded in: `raise HTTPException(...) from None` in the `create_page` route's `except BlankTitleError` (routes_pages.py); doc wording fix in backend.md (the "collapses to nothing" claim now correctly attributes the strip to `get_or_create_page`, not `normalize_title` alone); and a new sentence documenting the accepted `"Untitled"` collision trade-off (a genuine user page named "Untitled" absorbs blank-title ops rather than a dedicated sentinel).

Added tests: `test_get_or_create_page_raises_on_spaces_only_title` (store-level, RED before the strip fix), `test_create_page_op_with_spaces_only_title_does_not_wedge` (ops-level, RED before the fix), `test_post_pages_route_rejects_spaces_only_title_too` (route symmetry regression), plus the corrected idempotency test. Checked specifically for any test relying on preserving leading/trailing plain spaces in a title created via ops or `get_or_create_page` directly (not via a route, which already strips) — found none; the only existing test asserting byte-for-byte preservation of `" Padded "` is against `normalize_title()` itself (test_refs.py), which was not touched.

**Verification (round 1 fix):** `uv run pytest -q` → 976 passed, 95.98% coverage. `uv run pyrefly check` → 0 errors. `uv run ruff check` → all checks passed.
