---
# pkm-n8eq
title: Preserve the last good Markdown backup until replacement succeeds
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:59:03Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 16).

## Context

**References:** `server/src/pkm/export/writer.py:39-59`; `server/src/pkm/backup/__main__.py:79-84`

export_graph() deletes all current page/journal Markdown files before rendering replacements. Rendering, disk, permission, or asset-copy failure leaves a partial export and destroys the last known-good working tree.

**Direction:** Render and validate in staging, then atomically publish while preserving the export repository, or implement rollback-safe replacement.

## Tasks

- [x] Inject rendering and copy failures and assert the previous export is byte-identical
- [x] Publish exports atomically

## Summary of Changes

`export_graph()` (`server/src/pkm/export/writer.py`) no longer deletes the
live `pages/`/`journal/`/`assets/` trees before rendering. It now:

1. Reads the DB and renders every page/journal body into memory first
   (no disk writes yet), and computes the wanted asset `{sha256: filename}`
   map.
2. Stages everything into a scratch `.export-staging-*` directory created
   beside the live export (same filesystem, so subsequent renames are
   atomic): writes rendered `.md` bodies, and either hardlinks an asset
   already present in the export or copies it from the live asset store
   (only genuinely new assets are copied, preserving the existing
   incremental behaviour and `assets_copied`/`assets_pruned` counts).
3. Only once every render and copy above has succeeded does it publish:
   `_publish_dir()` atomically swaps each of `pages/`, `journal/`,
   `assets/` in turn via directory rename (moving the previous contents
   aside to a `<name>.stale` sibling first, since POSIX rename refuses to
   replace a non-empty directory directly, then removing the stale copy).

Any exception during rendering or asset copying is raised before any
publish step runs, so the previous export is left completely untouched --
verified by injecting both a render failure and an asset-copy failure and
asserting a full byte-for-byte snapshot of the export tree is unchanged.
A `<name>.stale` leftover from a crash mid-swap is self-healed by the next
run's `_publish_dir` call, also covered by a test. `.gitignore` gained a
`.export-staging-*/` entry so a leftover staging directory (if cleanup
itself failed) is never picked up by the nightly `git add -A` commit.

The `.git` directory and any other files in the export repo are untouched
by this change -- only the `pages/`, `journal/`, and `assets/` subtrees are
ever swapped.

Tests added to `server/tests/test_export_writer.py`:
`test_render_failure_preserves_previous_export`,
`test_asset_copy_failure_preserves_previous_export`,
`test_recovers_from_an_abandoned_stale_dir` (plus the existing
`.gitignore` content assertion updated for the new ignore line).

Also updated `docs/architecture/backend.md`'s "Markdown export" bullet to
describe the new stage-then-swap mechanism and the `.stale` self-heal
invariant.

Verification (from worktree `server/`):
- `uv run pytest -q` -- 1034 passed, coverage 96.27% (threshold 95%)
- `uv run pyrefly check` -- 0 errors
- `uv run ruff check` -- all checks passed

## Fix Round 1 (review findings)

Two Important findings from task review:

1. **The three-subtree publish isn't one transaction, and that gap was
   untested.** `export_graph` calls `_publish_dir` for `pages/`,
   `journal/`, `assets/` sequentially. If a later call fails after an
   earlier one already landed, the export is left in a genuine mixed
   old/new state -- not byte-identical to before -- and no test proved
   what happens in that case.
2. **The existing self-heal test didn't hit the risky branch.**
   `test_recovers_from_a_stale_dir_left_by_a_prior_crash` created
   `pages.stale` while `pages/` still existed, which only exercises the
   pre-cleanup branch for an *abandoned* stale dir after a completed
   swap -- never the `target` missing / `.stale` holds the real content
   branch (a crash between `_publish_dir`'s two renames), which is the
   case the design's safety claim actually rests on.

Resolution taken (per the reviewer's offered option: prove recoverability
+ document the residual window, rather than restructure the publish
layout -- a single-transaction three-subtree swap would require nesting
`pages/`/`journal/`/`assets/` under a wrapper directory, changing the
physical shape of the export repo and the `/api/export.zip` output,
which is out of scope for this finding):

- Renamed the existing test to
  `test_recovers_from_an_abandoned_stale_dir` (accurate name for what it
  actually covers) and added
  `test_recovers_from_a_crash_between_the_two_publish_renames`, which
  manufactures the real crash state directly (renames `export/pages` to
  `export/pages.stale`, so `pages/` is missing outright) and asserts the
  next run recovers fully.
- Added
  `test_cross_subtree_publish_failure_recovers_on_next_run`, which
  injects an `os.replace` failure specifically on journal's publish
  (after pages' already succeeded) via monkeypatching
  `pkm.export.writer.os.replace`, and asserts: pages/ already has the
  new content, journal/ is missing with the old content preserved under
  `journal.stale`, assets/ is untouched, the exception propagates, and a
  subsequent successful run converges to a fully consistent export
  (`journal.stale` gone, all counts correct).
- Corrected the module docstring and the `docs/architecture/backend.md`
  bullet, which previously overclaimed byte-identical preservation for
  *any* failure -- they now state precisely that byte-identical
  preservation holds for failures before publishing starts, while a
  failure partway through the three publish calls leaves a real mixed
  state that self-heals on the next successful run (nothing corrupted or
  lost either way, and the raised exception keeps the nightly job from
  ever git-committing a mixed state, since `git_commit_export` in
  `backup/__main__.py` is only reached after `export_graph` returns
  without raising).
- Added an inline comment at the three `_publish_dir` calls in
  `export_graph` pointing back to the module docstring's explanation.

Covering tests: `server/tests/test_export_writer.py` (10 tests, up from
8).

Verification (from worktree `server/`):
- `uv run pytest -q tests/test_export_writer.py --no-cov` -- 10 passed
- `uv run pytest -q` -- 1036 passed, coverage 96.27% (threshold 95%)
- `uv run pyrefly check` -- 0 errors
- `uv run ruff check` -- all checks passed
