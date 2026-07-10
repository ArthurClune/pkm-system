---
# pkm-lhzd
title: Move WAL/DDL setup out of per-request open_db() to fix database-lock 500s
status: in-progress
type: bug
priority: high
created_at: 2026-07-10T10:56:28Z
updated_at: 2026-07-10T11:19:41Z
parent: pkm-m309
---

Review finding 1 (Important) — the only issue observed as a live server exception. open_db() (server/src/pkm/server/db.py:14-36) runs PRAGMA journal_mode=WAL and executescript(SIDEBAR_ENTRIES_DDL) on every request-created connection. WAL is persistent DB config and the DDL script takes locks, so concurrent requests intermittently fail with 'sqlite3.OperationalError: database is locked' before the route runs. Reproduced in both pnpm e2e runs (server logs show the exception at db.py:18) even though Playwright reported 2/2 passed — the E2E harness does not fail on unobserved server 500s.

## Checklist
- [x] Apply schema migrations and journal_mode=WAL once at explicit DB init/app startup, before serving requests
- [x] Keep only connection-local config (foreign_keys=ON) in open_db()
- [x] Set and document an appropriate busy_timeout for genuine writer contention
- [x] Replace ad hoc SIDEBAR_ENTRIES_DDL-on-open with an explicit idempotent migration/startup step
- [x] Regression: backend concurrency test opening read connections while an ops transaction commits
- [x] Regression: make the Playwright harness fail on unexpected server exceptions / HTTP 5xx even when visible assertions pass
