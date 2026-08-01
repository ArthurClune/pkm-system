---
# pkm-lk7t
title: Throttle expensive unauthenticated password checks
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 13).

## Context

**References:** `server/src/pkm/server/auth.py:45-56`; `server/src/pkm/server/auth_core.py:8-15`

Every login failure runs scrypt with no rate limit, concurrency bound, or backoff. Any host able to reach the configured bind address can consume substantial CPU and memory with concurrent attempts.

**Direction:** Add global/per-source throttling and bound concurrent checks while keeping failure responses uniform.

## Tasks

- [ ] Add rate-limit and concurrent-attempt tests
- [ ] Bound unauthenticated scrypt work
