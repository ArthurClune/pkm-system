---
# pkm-6g0l
title: Centralize backend asset verification and split asset staging workflows
status: todo
type: task
priority: high
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:20Z
updated_at: 2026-08-17T20:55:20Z
parent: pkm-wvvu
---

## Review findings

Backend A1, B4 marginal, and the `importer/run.py::main` / `export/writer.py::export_graph` complexity findings.

`importer/run.py` and `export/writer.py` hand-roll the same stat, size-short-circuit, hash, and `asset_needs_repair` ritual. The two large workflow functions also bury coherent asset-copy/staging phases inside broader orchestration.

## Acceptance criteria

- [ ] Add a tested `assets_core.asset_on_disk_needs_repair(path, sha256, expected_size)` boundary covering missing files, size mismatch, hash mismatch, and valid files
- [ ] Route both importer and exporter verification through the shared boundary without weakening the size-before-hash behavior
- [ ] Extract the importer asset-copy phase and exporter asset-staging phase into named, independently testable helpers
- [ ] Merge the importer audit/apply database lifetime where safe so connection management is not duplicated around a database-free asset phase
- [ ] Remove or inline `classify_export_asset_transfer` if it remains a one-call bool-to-counter-key wrapper after extraction
- [ ] Preserve hardlink/copy counters, corruption repair, and failure behavior with regression tests
- [ ] Update backend or assistant-and-files architecture documentation if ownership changes
