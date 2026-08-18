---
# pkm-6g0l
title: Centralize backend asset verification and split asset staging workflows
status: in-progress
type: task
priority: high
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:20Z
updated_at: 2026-08-18T12:13:42Z
parent: pkm-wvvu
---

## Review findings

Backend A1, B4 marginal, and the `importer/run.py::main` / `export/writer.py::export_graph` complexity findings.

`importer/run.py` and `export/writer.py` hand-roll the same stat, size-short-circuit, hash, and `asset_needs_repair` ritual. The two large workflow functions also bury coherent asset-copy/staging phases inside broader orchestration.

## Acceptance criteria

- [x] Add a tested `assets_core.asset_on_disk_needs_repair(path, sha256, expected_size)` boundary covering missing files, size mismatch, hash mismatch, and valid files
- [x] Route both importer and exporter verification through the shared boundary without weakening the size-before-hash behavior
- [x] Extract the importer asset-copy phase and exporter asset-staging phase into named, independently testable helpers
- [x] Merge the importer audit/apply database lifetime where safe so connection management is not duplicated around a database-free asset phase
- [x] Remove or inline `classify_export_asset_transfer` if it remains a one-call bool-to-counter-key wrapper after extraction
- [x] Preserve hardlink/copy counters, corruption repair, and failure behavior with regression tests
- [x] Update backend or assistant-and-files architecture documentation if ownership changes

## Placement note

The boundary landed in a new `pkm/assets_disk.py` (`# pattern: Imperative
Shell`), not in `assets_core.py`: it stats and reads files, and
`assets_core.py` declares `# pattern: Functional Core`, so hosting it there
would have made that header false and forced the module to
`Mixed`. `assets_core.asset_needs_repair` still owns the pure decision the
new shell function feeds, and its docstring points at the wrapper. The
naming follows the repo's existing `auth_core.py`/`auth.py` and
`ops_core.py`/`ops_apply.py` pairing; `assets_disk` rather than `assets`
because `importer/assets.py` and `routes_assets.py` already exist.

## Summary of Changes

- **New `server/src/pkm/assets_disk.py`** (Imperative Shell):
  `asset_on_disk_needs_repair(path, sha256, expected_size)`. It absorbs the
  callers' `is_file()` check too, so "missing" and "present but wrong" become
  one branch, and it keeps the stat-before-read order that saves a full read
  of a file whose size alone condemns it.
- **`importer/run.py`**: the asset loop is now `_copy_assets(assets_dir,
  sources, assets)`, routed through the boundary. Because that phase touches
  no database, it moved inside the row-writing connection's lifetime, so the
  two identical `connect/try/finally/close` blocks around it collapsed into
  one. The `con.commit()` before it is what keeps a copy failure's leftover
  `pkm.sqlite3.tmp` complete; title activation still runs after the copies.
- **`export/writer.py`**: the staging loop is now `_stage_assets(wanted, *,
  assets_dir, stage_assets, live_assets_dir)`, returning its own
  `assets_copied` / `assets_repaired` / `assets_missing_source_on_repair`
  counts for `export_graph` to merge.
- **`assets_core.classify_export_asset_transfer` deleted** — after the
  extraction it wrapped nothing; two explicit counter bumps replace it. Its
  test and the now-unused `typing.Literal` import went with it.
- **Tests**: new `tests/test_assets_disk.py` (missing / not-a-regular-file /
  size mismatch / same-size hash mismatch / valid, plus a spy proving the
  short circuit). New importer tests: boundary routing and short circuit via
  a spy on the shared hasher, a fully-populated-tmp-DB guard for the merged
  connection, and a standalone `_copy_assets` unit test. New exporter tests:
  the same spy-based routing/short-circuit proof and a standalone
  `_stage_assets` test covering both the fresh-copy and hardlink paths.
- **`docs/architecture/backend.md`**: `assets_disk.py` added to the module
  map; the Markdown-export and importer prose now name the shared boundary
  and the pure decision it feeds; the importer bullet gains the
  commit-before-the-asset-phase invariant.

Verification (from `server/`): `uv run pytest -q` → 1470 passed, coverage
96.98% (gate 95%); `uv run pyrefly check` → 0 errors; `uv run ruff check` →
clean.
