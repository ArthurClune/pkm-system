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

Docs (`docs/architecture/backend.md`, CLI help text, `.claude/skills/pkm`)
already describe "## Heading" as resolving to "a heading with that exact
text" -- none claimed level-blind matching, so no doc changes were
needed; the fix aligns implementation with already-documented intent.

Out of scope (noted for a follow-up, not filed as a bean): `select_section`
in `server/src/pkm/cli/render.py:132-141` (used by `pkm get --section`)
has the same text-only matching bug but is a different function, not
referenced by this bean.

Tests added to `server/tests/test_cli_build.py`:
- `test_resolve_parent_ignores_plain_block_with_matching_text`
- `test_resolve_parent_requires_matching_level`
- `test_resolve_parent_duplicate_headings_picks_first_in_document_order`

Verification: `uv run pytest -q` (971 passed, 96.13% coverage),
`uv run pyrefly check` (0 errors), `uv run ruff check` (all checks passed).
