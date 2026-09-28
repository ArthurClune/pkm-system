---
# pkm-x8e3
title: Stale page_title hint on an orphan conflict re-creates a renamed-away page
status: completed
type: bug
created_at: 2026-09-28T21:01:06Z
updated_at: 2026-09-28T21:01:06Z
---

Found in the pkm-3g4n final review. When an update_text targets a block the server no longer has, the daily-note conflict header links [[<page_title hint>]]. If that page was renamed after the client last saw it, the hint is the old title, so the header's ref re-creates an empty page under the old name. That is the effect replay_title_rewrites exists to prevent for live blocks. Options: resolve the hint through page-rename history before labelling; label an unknown title as plain text instead of a link; or fall back to (page unknown) when no page with that title exists. No data loss, only a stray empty page.

## Summary of Changes

Implemented the decided rule: the header links the hint only when a page
with that title currently exists; otherwise it names the title without
minting a page for it.

- `server/src/pkm/server/ops_core.py`: `conflict_label(page_title,
  hint_page_exists)` gained a second parameter. Usable hint + page exists ->
  `[[Title]]` (unchanged). Usable hint + no such page -> `` `Title` (page not
  found) `` (inline code, which the ref extractor never scans, so no page is
  created). Usable hint + no such page + the title itself holds a backtick
  -> `(page unknown)` (a code span can't safely wrap it). Missing/blank/
  syntactically invalid hint -> `(page unknown)` (unchanged). Comment states
  why `block_rewrites` can't serve as a rename lookup here: it's keyed by
  referencing block and only has rows when some other block referenced the
  renamed page, so it holds no history of a page's own former titles.
  `orphan_header_text` and `OpContext` (new `hint_page_exists: bool = False`
  field) thread the fact through; the decision stays pure.
- `server/src/pkm/server/ops_apply.py`: new `_hint_page_exists()` looks the
  hint up via `canonicalize_title` + `fetch_page` (same canonicalization
  `get_or_create_page` uses), called only in `_context_for`'s check-1 branch
  (hashed `update_text` on a missing block) — no extra query on any other
  path.
- Tests (TDD, written first and confirmed failing before the fix):
  `server/tests/test_ops_core.py` gained a parametrized `conflict_label`
  table test plus `plan_op`-level tests for the renamed-away and
  backtick-in-title cases; the existing hinted-page test now sets
  `hint_page_exists=True` explicitly.
  `server/tests/test_ops_endpoint.py` gained
  `test_orphan_conflict_hint_naming_a_renamed_away_page_does_not_recreate_it`,
  which renames "Machine Learning" away, posts an orphan edit hinting the old
  title, asserts the header reads `` `Machine Learning` (page not found) ``
  and asserts directly against the `pages` table that no row named "Machine
  Learning" was recreated.
- Docs: `docs/architecture/backend.md` § The write path and
  `docs/architecture/sync-and-offline.md`'s conflict table updated to the
  four header forms (was three); `docs/troubleshooting.md` gained one row
  under Backend.
- Verified: `cd server && uv run pytest -q` (1969 passed, coverage 97.37%),
  `uv run pyrefly check` (0 errors), `uv run ruff check` (clean). No route
  docstring changed, so no openapi regen was needed.
