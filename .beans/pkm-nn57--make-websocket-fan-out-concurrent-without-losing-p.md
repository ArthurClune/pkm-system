---
# pkm-nn57
title: Make WebSocket fan-out concurrent without losing per-client ordering
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 11).

## Context

**References:** `server/src/pkm/server/ws.py:15-35`; `server/src/pkm/server/routes_ops.py:59-67`

Hub.broadcast() awaits each client sequentially with a one-second timeout. Writes await multiple broadcasts after commit, so stalled clients can add latency proportional to connection count.

**Direction:** Send concurrently with bounded concurrency and per-client timeout. Preserve per-client frame ordering via queues or locks and consider connection limits.

## Tasks

- [ ] Add multiple-stalled-client latency tests
- [ ] Implement bounded concurrent fan-out with ordered per-client delivery
