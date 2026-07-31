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
- The daily-page call sites are untouched: `title_for_date()` never produces a blank string, so they were never at risk and don't need the fallback wrapper. **CORRECTION (final-review fix wave):** the claim originally made here about the two ref-indexing call sites (`store.py`'s `rewrite_referencing_blocks`, `ops_apply.py`'s reindex loop) — that "refs.extract() drops empty refs before they reach get_or_create_page" — was false. `extract()`'s own blank-ref check reuses the narrow `normalize_title`, so it only drops a ref title that `normalize_title` collapses all the way to `""` (control whitespace); a spaces-only bracket ref like `[[   ]]` survives it as `Ref(title="   ")` and reaches `get_or_create_page` unguarded, where the new `BlankTitleError` check (added in round 1) raised uncaught — an HTTP 500 on the ops path and on rename, strictly worse than either the pre-branch silent behavior or the 422 pkm-hjhy explicitly banned from ops. See "Final-review fix wave" below for the fix.

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

## Fix round 2 (review findings)

Round 1's `.strip()` fix over-corrected: it stripped the title that gets **stored and looked up**, not just the one used to test for blankness. Verified against a copy of the production database, this silently changed canonicalization for every pre-existing padded title — production has real pages like `" EvilCorp"` (leading space, 11 blocks, 3 inbound refs) and one with a trailing space, both minted back when refs/ops never stripped. Post round-1, any ref or op naming one of those titles *exactly as stored* got stripped first, missed the padded row (`fetch_page` is an exact match), and minted a fresh empty duplicate page — stranding the real content and backlinks under the padded title, reachable only by a byte-exact URL. A silent data-reachability split, and strictly worse than the bug this bean set out to fix.

**Fix:** blankness and canonicalization are now separate checks in `get_or_create_page`. The title is normalized as before (`normalize_title`, no `.strip()` on the stored/looked-up value); `.strip()` is used *only* in the `if not title.strip():` blankness test. So `"   "` (nothing but padding) still raises `BlankTitleError` and falls back on the ops path — round-1 finding 2 stays fixed — while `" EvilCorp"` (padding plus real content) is not blank, and `fetch_page`/`INSERT` both use the un-stripped normalized title, so it matches itself exactly, the same as every path did before this bean existed.

**Recorded decision (do NOT implement here):** canonicalizing *existing* padded titles in the live database (merging `" EvilCorp"` into `"EvilCorp"`, etc.) is out of scope for this bean — it needs a data migration with explicit merge handling for any title collision, not a lookup-time behavior change, and carries its own risk (silently merging two pages a user may have kept separate on purpose). The controller is filing a separate bean for that; this bean deliberately leaves padded titles exactly as they are today.

Added tests (server/tests/test_blank_titles.py): `test_padded_title_is_preserved_and_reused_exactly` (store-level, RED before the narrow-strip fix: asserted a second call with the identical padded title reused the original page id, and that a stripped variant is a genuinely different page) and `test_create_page_op_reuses_a_pre_existing_padded_title` (ops-level end-to-end version of the same regression, inserting the padded row directly to simulate a pre-existing production page, then posting a `create_page` op with the exact padded title and asserting no duplicate/stray row was created). Both directly reproduce the review's verified regression before confirming the fix.

Also verified `CONTROL_ONLY` (`"\n\t"`) and `CONTROL_ONLY_2` (`" \n "`) from the round-1 idempotency test: both are single contiguous runs entirely within `normalize_title`'s whitespace-run class, so `normalize_title` collapses each to `""` outright (not merely to spaces needing a further strip) — the round-1 idempotency test's semantics are unaffected by narrowing the strip's scope.

**Verification (round 2 fix):** `uv run pytest -q` → 978 passed, 95.98% coverage. `uv run pyrefly check` → 0 errors. `uv run ruff check` → all checks passed.

## Final-review fix wave

The whole-branch final review found one Critical and one Important issue, both downstream of the `BlankTitleError` check landing in `get_or_create_page`.

**CRITICAL, fixed:** `refs.extract()`'s own "drop a blank ref" filter (`if norm := normalize_title(title)`) has the identical narrowness gap that motivated this whole bean — it only catches a title `normalize_title` collapses all the way to `""` (control whitespace), so a spaces-only bracket ref like `[[   ]]` is NOT dropped: `extract()` yields `Ref(title="   ")`. That `ref.title` reached `get_or_create_page` unguarded at the two ref-indexing call sites (`ops_apply.py`'s `ReindexRefs` handling and `store.py`'s `rewrite_referencing_blocks`, used by rename/merge) and raised `BlankTitleError` — which neither `routes_ops.py` (catches only `OpError`) nor the rename route (catches only `sqlite3.IntegrityError`) handles, surfacing as an uncaught HTTP 500. Reachable trivially: type `[[`, let autopair close it, type spaces, save. For the ops path this is strictly worse than either the pre-branch silent `"   "`-titled page or the 422 pkm-hjhy explicitly forbids there — an unrecoverable batch that permanently wedges an offline client's queue.

Fix: added `store.index_ref(db, src_uid, ref_title, ref_kind, now_ms)`, which calls `get_or_create_page` and catches `BlankTitleError` to **skip the ref** — no page created, no `refs` row, no `"Untitled"` fallback (deliberately different from the ops `page_title` fallback: an op needs *some* page to land its content on, but a ref with a blank-normalizing title is not a reference at all, so indexing it onto a fallback would fabricate a phantom backlink — per `extract()`'s own docstring). Both call sites now go through `index_ref` instead of calling `get_or_create_page` directly. Also added a pure predicate, `refs.is_blank_title(title)` (`not normalize_title(title).strip()`), reused by `get_or_create_page`'s own check and by the broadcast fix below, instead of duplicating "normalize then strip" inline in more than one place.

Also corrected the false claim in this file's round-1 Summary (see above, now struck through/annotated): the ref-indexing call sites were NOT "always already non-blank by construction" — that was wrong, and is exactly what this finding proved.

**IMPORTANT, fixed:** `_broadcast_op` relayed a blank-normalizing `page_title` to remote clients verbatim, even though the server had actually resolved it to `"Untitled"` server-side. A remote replica keys its refetch on the broadcast `page_title`, so it would look for (and mint its own local page under) the raw blank string instead of finding the real `"Untitled"` page — a silent divergence between replicas until the next resync. Fix: `_broadcast_op` now checks `is_blank_title(op.page_title)` for `CreateOp`/`CreatePageOp`/`MoveOp` (when `page_title is not None`) and overrides `d["page_title"]` to `UNTITLED_PAGE_TITLE`, mirroring the existing enrichment for the omitted-title cross-page move.

**Tests added/extended** (`server/tests/test_blank_titles.py`, 11 → 13): `test_create_op_with_spaces_only_ref_in_text_does_not_500` and `test_rename_page_with_referencing_spaces_only_ref_succeeds` reproduce the Critical finding directly (RED before the `index_ref` fix: both raised `BlankTitleError` uncaught, one via a 500 from the ops endpoint, one via the rename route). The three existing blank-title ops tests (`create`, `create_page`, cross-page `move`) were extended to open a `client.websocket_connect("/api/ws")` and assert the broadcast payload's `page_title` is `"Untitled"`, not the raw blank string (RED before the `_broadcast_op` fix: each asserted the raw blank title instead).

`docs/architecture/backend.md` gained a paragraph on `index_ref`'s skip-not-fallback behavior and the broadcast enrichment, alongside the existing blank-title section.

**Verification (final-review fix wave):** `uv run pytest -q` → 980 passed, 95.98% coverage. `uv run pyrefly check` → 0 errors. `uv run ruff check` → all checks passed.
