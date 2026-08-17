---
# pkm-9w4f
title: Expose a stable title-span API and simplify import title sanitization
status: todo
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-17T20:55:21Z
parent: pkm-wvvu
---

## Review findings

Backend A5 and the `sanitize_export_titles` complexity finding. Import title rewriting reaches through private refs APIs and compensates for rename attribute matching, while collision merging is embedded in a 100-line function.

## Acceptance criteria

- [ ] Define a public title-span or normalizer-aware rewrite boundary owned by `refs.py` or `rename.py`
- [ ] Remove importer and rename dependencies on refs private names where they cross module boundaries
- [ ] Make raw-versus-normalized attribute-prefix handling explicit in the owning abstraction
- [ ] Extract the collision-group, survivor-selection, and reorder phase from `sanitize_export_titles`
- [ ] Pin attributes, bracket refs, code spans, collisions, ordering, and whitespace behavior with focused tests
- [ ] Document the new module boundary if it changes the backend architecture
