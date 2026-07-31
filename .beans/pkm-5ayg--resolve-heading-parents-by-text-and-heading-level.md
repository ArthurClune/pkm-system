---
# pkm-5ayg
title: Resolve heading parents by text and heading level
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:55Z
updated_at: 2026-07-31T16:40:00Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 7.

**References:** server/src/pkm/cli/build.py:55-82,164-175,197-202

resolve_parent("## Notes") compares only block text and ignores heading. It can choose a plain Notes block or a level-3 heading instead of a level-2 heading, while same-batch heading memoization is level-aware.

**Direction:** Require the requested heading level when resolving heading specifications and define duplicate-heading selection semantics.

- [x] Add plain-text collision, wrong-level collision, and duplicate-heading tests
- [x] Align fetched-page and in-batch heading resolution

## Summary of Changes

`resolve_parent` (`server/src/pkm/cli/build.py`) matched a "## Heading"
spec against `n["text"]` alone, so a plain (non-heading) block or a
heading at the wrong level with the same text could be selected as the
parent -- while `_Planner._headings`'s in-batch memoization already keys
on `(page, level, text)`, so the two resolution paths disagreed.

Fixed by adding `n["heading"] == level` to the match condition. `_walk`
already yields blocks in document (pre-order) order and the loop returns
on first match, so duplicate same-level-same-text headings already
resolved deterministically to the first one in document order; this is
now the same rule the in-batch memoization applies (first `setdefault`
wins), so a page fetched before vs. after a batch-created heading exists
resolves to the same parent. Expanded `resolve_parent`'s docstring to
state this explicitly. No other call site needed a change: `move`
(build.py:410) and `_Planner.creates`'s missing-heading handling
(build.py:164-178) both go through `resolve_parent`/the same memoization
and inherit the fix.

Out of scope: `select_section` in `server/src/pkm/cli/render.py:132-141`
(used by `pkm get --section`) has the same text-only matching bug but is
a different function, not referenced by this bean -- filed as follow-up
[[pkm-dzgw]].

Tests added to `server/tests/test_cli_build.py`:
- `test_resolve_parent_ignores_plain_block_with_matching_text`
- `test_resolve_parent_requires_matching_level`
- `test_resolve_parent_duplicate_headings_picks_first_in_document_order`

Verification: `uv run pytest -q` (971 passed, 96.13% coverage),
`uv run pyrefly check` (0 errors), `uv run ruff check` (all checks passed).

## Fix round 1 (task review)

Review verdict: code change correct/minimal/complete, but user-facing
help text still described the pre-fix, level-blind rule -- a user
following `main.py`'s `save --help`/`batch --help` would hit `move
target heading does not exist` with no explanation, since the docs said
"a heading with that exact text" (no level) and the batch epilog
explicitly documented the old asymmetry ("a repeat ... at a different
level ... makes its own heading" as if only in-batch reuse cared about
level). That correction supersedes what this report said above about
"no doc changes needed" -- the private docstring was accurate, the
public help text was not.

Fixed:
- `_SAVE_EPILOG`, the `create` command entry in `_BATCH_EPILOG`, and the
  `"## Heading"` parent-forms entry in `_BATCH_EPILOG` (all in
  `server/src/pkm/cli/main.py`) now state the level-and-text match rule
  and the first-in-document-order tie-break, and no longer describe the
  old level-blind reuse asymmetry.
- `docs/architecture/backend.md` (~394-399): added a sentence stating
  the same rule and that the in-batch memo follows it too.
- `server/tests/test_cli_build.py`: added
  `test_plan_batch_move_rejects_wrong_level_heading` (a level-3 "Notes"
  heading must not satisfy a `move` to "## Notes"/level 2 -- confirmed
  RED without the level check: "DID NOT RAISE BuildError", GREEN with
  it).
- Strengthened `test_resolve_parent_duplicate_headings_picks_first_in_document_order`
  to nest the first matching heading as a child of an earlier top-level
  block and put the second match at page top level after that block --
  pinning pre-order (depth-first) document order as the tie-break rather
  than merely top-level list order (this test passes with or without the
  level fix, since it exercises traversal order, not level-matching, and
  is a genuine spec of already-existing `_walk` behavior).

Verification (re-run from `/Users/arthur/code/llm/pkm-worktrees/cli/server`):
`uv run pytest -q` -- 972 passed, 96.17% coverage;
`uv run pyrefly check` -- 0 errors;
`uv run ruff check` -- all checks passed.
