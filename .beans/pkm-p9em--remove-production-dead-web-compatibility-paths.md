---
# pkm-p9em
title: Remove production-dead web compatibility paths
status: completed
type: task
priority: low
created_at: 2026-08-01T19:19:43Z
updated_at: 2026-08-01T19:31:04Z
parent: pkm-6phf
---

Delete BlockTree and activeOutlines compatibility modules after migrating useful tests to active runtime implementations.

## Checklist

- [x] Add or migrate coverage to EditableBlockTree and outlineSessions APIs
- [x] Remove dead compatibility modules and obsolete tests
- [x] Update frontend architecture documentation
- [x] Run focused web checks and full verification

## Summary of Changes

Deleted BlockTree and activeOutlines, moved retained coverage to EditableBlockTree and outlineSessions, corrected frontend architecture documentation, and passed the focused unit, type, lint, and FCIS checks. Full verification is recorded on the integration branch.
