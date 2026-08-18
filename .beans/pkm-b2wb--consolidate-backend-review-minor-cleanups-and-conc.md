---
# pkm-b2wb
title: Consolidate backend review minor cleanups and concurrency documentation
status: completed
type: task
priority: low
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-18T19:32:55Z
parent: pkm-wvvu
---

## Review findings

Backend minor duplication, B4 marginal, and the describe-service comment imbalance not absorbed by the larger children.

## Acceptance criteria

- [x] Share the describe enqueue eligibility/active/add/queue ritual between single enqueue and scan
- [x] Document describe shutdown semantics: idempotent close and caller cancellation must not abort worker teardown
- [x] Explain that `assistant.policy.all_tool_names()` is a contract-tripwire test subject if it intentionally remains production-unused
- [x] Reassess the duplicated `_BLOCK_COLS` constant and leave it duplicated only with its deliberate-coupling rationale intact
- [x] Remove any remaining tiny duplicate or dead helper identified by the review only where the replacement is clearer
- [x] Add focused tests for behavior-changing cleanup and run backend lint/type/coverage gates

## Summary of Changes

- **Enqueue ritual shared**: `describe/service.py` -- extracted `_enqueue_if_eligible(sha256, mime, size) -> bool` (eligibility check, `_active` guard, add, `put_nowait`) and rewired both `maybe_enqueue` and `scan` to call it, removing the copy-pasted triplet the review flagged.
- **Shutdown semantics**: already documented by the sibling epic child pkm-f3mo (commit 4398500, merged to main before this bean started) -- `close()`'s docstring and `_shutdown()`'s inline comments state idempotency, the single shared shutdown task, and that a caller's cancellation is delayed rather than allowed to abort the owned transport close. Verified the text against the review's exact ask; no gap found, no change needed here.
- **`all_tool_names()` tripwire**: added a docstring to `assistant/policy.py::all_tool_names()` stating it has no production caller (`claude_engine` uses `read_tool_names()` for `allowed_tools` and gates writes via `classify_tool` at confirm-time, not an allowlist), and that it exists solely so `test_tool_names_namespaced`'s 11-count assertion has a subject -- explicitly telling the next reader not to delete it as dead code.
- **`_BLOCK_COLS`**: reassessed both copies (`routes_pages.py`, `routes_export.py`). `routes_export.py` already carries the deliberate-coupling rationale ("kept as its own copy rather than a cross-module import since it's a plain SQL literal, not shared behaviour"). Left both copies as-is -- the rationale is intact and a shared constant would be the kind of cross-module coupling the comment explicitly rejects.
- **Remaining tiny dup/dead helper**: checked every other item the 2026-08-17 backend review's "Minor duplication" and "B4. Marginal" sections listed (`_walk` in cli/build.py+render.py, `classify_export_asset_transfer`, the decline-all-pending loops in claude_engine.py, the A4 group-by-page triplet). All were already resolved by other now-completed pkm-wvvu children (pkm-2771, pkm-6g0l, pkm-f3mo, pkm-byig) before this bean started -- nothing left to remove in this bean's scope.
- Did not touch refs.py or rename.py (another agent's concurrent work), per instructions.

### Verification
- `cd server && uv run pytest -q` -- 1546 passed, coverage 97.32% (>= 95% required)
- `cd server && uv run pyrefly check` -- 0 errors
- `cd server && uv run ruff check` -- all checks passed
