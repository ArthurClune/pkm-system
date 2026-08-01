---
# pkm-amq2
title: 'Export writer polish: repair telemetry, staging-dir sweep, warning docs'
status: todo
type: task
priority: low
created_at: 2026-08-01T12:52:43Z
updated_at: 2026-08-01T12:52:43Z
parent: pkm-ulae
---

Follow-up from the pkm-ulae medium sweep (exports-track final review, findings all Minor).

## Context

Three writer.py-local polish items from the ulae-medium-exports final review:

1. **`assets_repaired` telemetry**: `assets_copied` conflates fresh copies with corruption repairs. A distinct repair count in the nightly backup log line is a disk-health signal worth seeing separately (a nonzero value means bytes on disk failed SHA verification).
2. **Sweep abandoned staging dirs**: `export_graph`'s `finally` removes only the current run's `.export-staging-*` dir; a kill-9 leaves one behind forever (gitignored, mostly hardlinks, small but accumulating for a recurring crasher). Sweep `export_dir.glob(".export-staging-*")` at the top of each run. Also closes the vanishingly-unlikely case of a partially-removed staging dir being rglob'd into /api/export.zip.
3. **Docstring note**: the corrupt-existing + missing-source warning fires exactly once ever (the asset then drops out of the tree and later runs take the silent residue branch) — note the one-shot nature where the counter is documented.

## Tasks

- [ ] Add assets_repaired to export_graph's counts and the backup log line
- [ ] Sweep abandoned .export-staging-* dirs at run start, with a test
- [ ] Document the one-shot missing-source warning
