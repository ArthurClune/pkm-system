---
# pkm-wy1v
title: Move the clean-edit conflict-landing shortcut into a pure ops_core predicate
status: completed
type: task
priority: normal
created_at: 2026-09-28T21:01:10Z
updated_at: 2026-09-28T21:51:48Z
---

Found in the pkm-3g4n reviews. ops_apply._context_for skips the daily-page/header context for a live block when no block_rewrites exist and text_hash(current_text) == base_text_hash. That duplicates check 4's hash comparison in the shell, a small FCIS leak. It also misses two clean cases that still create today's daily page and cost about 3 queries: (a) blocks with block_rewrites in the 30-day window, which after a rename means every block referencing the renamed page; (b) a stale hash with identical text (check 2). Fix: a pure ops_core predicate that runs replay_title_rewrites and reports whether check 5 would be reached; the shell calls it. Also drop the conflict_uid requirement from plan_op's check-5 preamble on clean applies, and stop minting a header uid when today's header already exists.

## Summary of Changes

- `server/src/pkm/server/ops_core.py`: added `TextEditOutcome` and
  `classify_text_edit(text, base_hash, current_text, rewrites)` -- the one
  pure predicate that runs `replay_title_rewrites` and classifies a hashed
  `update_text` on a live block as `identical` (check 2), `clean` (check 4)
  or `conflict` (check 5), returning the replayed text. `plan_op`'s
  `update_text` branch now calls it instead of inlining the replay + hash
  comparison. Added `_conflict_landing_ready(ctx)` so check 1 and check 5's
  "conflict context missing" guards require a fresh `conflict_uid` only when
  `conflict_header_uid` is `None`; `current_text`/`order_idx` are still
  required for check 2/4, `conflict_uid` no longer is.
- `server/src/pkm/server/ops_apply.py`: `_context_for` now calls
  `classify_text_edit` (same function `plan_op` uses) to decide whether a
  hashed live-block edit needs `_with_conflict_landing`, replacing the old
  inline `not rewrites and text_hash(...) == op.base_text_hash` check that
  duplicated check 4's logic in the shell and missed two clean cases: a
  block with `block_rewrites` whose replay is clean, and a stale hash with
  identical text. `_with_conflict_landing` now mints `conflict_uid` only
  when no header exists yet for today (`header is None`), never when a
  conflict lands under an already-recorded header.
- Tests (TDD, written before the corresponding fix landed):
  `server/tests/test_ops_core.py` -- `classify_text_edit` unit tests
  (identical/clean/conflict, each with and without a rewrite replay,
  including a rename replay that turns a stale hash clean and one that
  makes an edit identical); `plan_op` checks 2/4 with `conflict_uid=None`;
  a missing-block conflict with `conflict_uid=None` when today's header
  already exists. `server/tests/test_ops_apply.py` -- a clean edit on a
  block with `block_rewrites` does not create today's daily page; a
  stale-hash identical-text edit does not create it; a second conflict on
  the same block the same day reuses the existing header and consumes no
  extra (unused) uid.
- `docs/architecture/backend.md`: rewrote the conflicts paragraph describing
  the shortcut to name `ops_core.classify_text_edit` as the shared
  predicate and drop the stale "only a clean hashed edit with no
  block_rewrites skips the lookup" claim; noted a second same-day conflict
  reuses the header uid rather than minting an unused one.
- Verification: `cd server && uv run pytest -q` -- 1953 passed, coverage
  97.36% (was 1941 passed before this branch). `uv run pyrefly check` --
  0 errors. `uv run ruff check` -- all checks passed.
- Perf: `perf/check.sh backend` reported "no changes against the baseline".
  The harness's only `/api/ops` `update_text` scenario (`ops/edit-1`) sends
  no `base_text_hash`, so it exercises the legacy hashless branch, not the
  hashed live-block path this change touches -- the harness has no scenario
  that can see this optimization either way.
