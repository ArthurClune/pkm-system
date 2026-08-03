---
# pkm-amq2
title: 'Export writer polish: repair telemetry, staging-dir sweep, warning docs'
status: completed
type: task
priority: low
created_at: 2026-08-01T12:52:43Z
updated_at: 2026-08-03T13:12:26Z
parent: pkm-ulae
---

Follow-up from the pkm-ulae medium sweep (exports-track final review, findings all Minor).

## Context

Three writer.py-local polish items from the ulae-medium-exports final review:

1. **`assets_repaired` telemetry**: `assets_copied` conflates fresh copies with corruption repairs. A distinct repair count in the nightly backup log line is a disk-health signal worth seeing separately (a nonzero value means bytes on disk failed SHA verification).
2. **Sweep abandoned staging dirs**: `export_graph`'s `finally` removes only the current run's `.export-staging-*` dir; a kill-9 leaves one behind forever (gitignored, mostly hardlinks, small but accumulating for a recurring crasher). Sweep `export_dir.glob(".export-staging-*")` at the top of each run. Also closes the vanishingly-unlikely case of a partially-removed staging dir being rglob'd into /api/export.zip.
3. **Docstring note**: after successful assets publication, corrupt-existing + missing-source residue drops from the tree and later runs take the silent missing-residue branch; a failure before assets publication can leave the corrupt prior tree active and repeat the warning.

## Tasks

- [x] Add disjoint assets_repaired telemetry to export_graph and backup output
- [x] Sweep abandoned staging entries before last-good mutation with no-follow handling
- [x] Document the successful-publication warning lifetime and repeat case

## Summary of Changes

- Added disjoint export telemetry: fresh transfers increment only `assets_copied`, successful corrupt replacements increment only `assets_repaired`, and missing-source repairs increment neither transfer counter.
- Sweeps abandoned `.export-staging-*` entries before last-good mutation, unlinking symlinks without following targets, recursively removing directories, accepting disappearance, and propagating other errors.
- Documented single-writer cleanup invariants and successful-publication versus pre-publication warning lifetime in writer and backend architecture docs.
- Verified 82 focused tests pass; pyrefly reports 0 errors; ruff is clean.
