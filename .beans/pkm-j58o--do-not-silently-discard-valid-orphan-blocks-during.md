---
# pkm-j58o
title: Do not silently discard valid orphan blocks during import
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:58Z
updated_at: 2026-07-31T15:54:58Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 8.

**References:** server/src/pkm/importer/parse_export.py:116-135; server/src/pkm/importer/run.py:78-126

The importer records only the count of valid UID/string blocks unreachable from pages; it does not retain them. The replacement database is published before the warning report is written, so user content can be omitted and report failure can hide the warning.

**Direction:** Preserve orphan subtrees on a deterministic recovery page, or refuse publication unless an explicit lossy-import option is supplied. Complete preflight/reporting before swapping databases.

- [x] Assert every orphan UID/text remains recoverable or import is refused
- [x] Verify the existing database remains untouched on refusal/report failure
- [x] Make lossy behavior explicit rather than warning after publication

## Summary of Changes

`parse_export.py`: `Export` gains `orphan_blocks: tuple[Block, ...]` — the
root `Block` of every subtree unreachable from a page, with its own
uid/text/children intact (not just the flat count `orphan_block_count`
already tracked). Roots are computed as unreached block entities that no
other entity (reached or not) points to via `:block/children`; each root's
full subtree is then rebuilt via the existing `build()` helper.

`rows.py`: `to_rows` attaches `export.orphan_blocks` under a new
deterministic page, `RECOVERY_PAGE_TITLE = "Import recovery: unreachable
blocks"` (suffixed `" (2)"`, `" (3)"`, ... on the rare chance a page
already has that exact title), preserving each orphan's internal
parent/child structure and running its text through the same ref
extraction as every other block. `Rows` gains `recovery_page_title: str |
None`, `None` when there were no orphans.

`report.py`: `ImportReport` gains `recovery_page_title: str | None = None`;
`render()` now says "recovered to '<page>'" instead of "not imported" when
orphans were preserved.

`run.py`: reordered so all fallible preflight work — building rows,
populating the tmp sqlite db, copying assets, and now rendering and
writing `import-report.txt.tmp` — completes before either atomic
`os.replace` (db first, then report). Wrapped that block in try/except so
a failure at any point unlinks both `.tmp` files and re-raises, leaving
`pkm.sqlite3` and `import-report.txt` untouched.

`docs/architecture/backend.md`: updated the importer diagram (report
render/write now precedes the swap) and added a prose paragraph on the
orphan-recovery-page mechanism and the preflight-before-publish guarantee.

**Tests added** (TDD, RED confirmed before each GREEN):
- `test_parse_export.py`: single-leaf orphan recoverable; a chain of two
  unreachable blocks preserves parent/child nesting as one root, not two
  flattened orphans; no orphans yields `orphan_blocks == ()`.
- `test_rows.py`: orphan subtree lands on the recovery page with structure
  and refs intact; no recovery page when there are no orphans; title
  collision with an existing page falls back to `" (2)"`.
- `test_report.py`: render() names the recovery page and drops "not
  imported" wording when orphans were preserved.
- `test_importer_e2e.py`: updated the existing end-to-end assertions for
  the now-preserved fixture orphan block (blocks 7→8, new page in the
  title set); added a dedicated orphan-preservation test and a test that
  monkeypatches `render()` to raise and asserts the existing db/report
  files and no stray `.tmp` files remain.

**Bug caught during implementation:** the first attempt at building orphan
root subtrees called `build(eid, frozenset({eid}))`, seeding the fresh
root's own eid into its `trail` — `build`'s cycle guard
(`if eid in trail: return None`) then treated every root as a self-cycle
and silently returned `None` for all of them (`orphan_block_count` was
correct, `orphan_blocks` was empty). Fixed by starting orphan roots with an
empty trail (`build(eid, frozenset())`), matching how `_children` already
grows the trail via `trail | {eid}` only when descending into a block's
own children.

**Verification:** `uv run pytest -q` (963 passed, coverage 95.98% ≥ 95%
threshold), `uv run pyrefly check` (0 errors), `uv run ruff check` (all
checks passed).
