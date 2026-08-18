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
- [ ] Update backend or assistant-and-files architecture documentation if ownership changes

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
