---
# pkm-9nzn
title: Make sidebar append concurrency-safe
status: completed
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T19:31:12Z
parent: pkm-ulae
---

## Context

pkm-ulae finding 27: concurrent sidebar additions read/check/allocate before entering a write transaction, allowing duplicate order indexes and leaking same-title uniqueness races as 500.

## Checklist

- [x] Add concurrent same-title and different-title regression tests
- [x] Serialize title checking and index allocation in one SQLite write transaction
- [x] Map same-title uniqueness races to stable HTTP 409
- [x] Run focused tests, pyrefly, and ruff
- [x] Commit implementation and bean summary

## Summary of Changes

Serialized sidebar title checking and append-index allocation with `BEGIN IMMEDIATE`, translated defensive title uniqueness races to HTTP 409, and added repeated concurrent route regressions for same and different titles.
