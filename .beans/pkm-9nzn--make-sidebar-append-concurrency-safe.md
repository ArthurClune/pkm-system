---
# pkm-9nzn
title: Make sidebar append concurrency-safe
status: todo
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:23:16Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 27: concurrent sidebar additions read/check/allocate before entering a write transaction, allowing duplicate order indexes and leaking same-title uniqueness races as 500.

## Checklist

- [ ] Add concurrent same-title and different-title regression tests
- [ ] Serialize title checking and index allocation in one SQLite write transaction
- [ ] Map same-title uniqueness races to stable HTTP 409
- [ ] Run focused tests, pyrefly, and ruff
- [ ] Commit implementation and bean summary
