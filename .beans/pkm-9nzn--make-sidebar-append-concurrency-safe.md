---
# pkm-9nzn
title: Make sidebar append concurrency-safe
status: completed
type: bug
priority: low
created_at: 2026-08-01T19:23:16Z
updated_at: 2026-08-01T20:09:06Z
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

## Final Review Hardening

Replaced the 250 ms helper timeout with a deterministic `get_db` dependency override around real `open_db()` connections. The gate rendezvous occurs after the sidebar snapshot is captured or when the competing fixed-code request attempts `BEGIN IMMEDIATE`, asserts arrival, restores the override, and closes both connections. Removing `BEGIN IMMEDIATE` deterministically produced duplicate append indexes.
