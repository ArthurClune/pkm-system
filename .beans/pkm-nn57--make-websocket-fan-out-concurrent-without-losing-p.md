---
# pkm-nn57
title: Make WebSocket fan-out concurrent without losing per-client ordering
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:25:10Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 11).

## Context

**References:** `server/src/pkm/server/ws.py:15-35`; `server/src/pkm/server/routes_ops.py:59-67`

Hub.broadcast() awaits each client sequentially with a one-second timeout. Writes await multiple broadcasts after commit, so stalled clients can add latency proportional to connection count.

**Direction:** Send concurrently with bounded concurrency and per-client timeout. Preserve per-client frame ordering via queues or locks and consider connection limits.

## Tasks

- [x] Add multiple-stalled-client latency tests
- [x] Implement bounded concurrent fan-out with ordered per-client delivery

## Summary of Changes

`Hub.broadcast()` (`server/src/pkm/server/ws.py`) no longer awaits each
client sequentially with a one-second timeout. Each connection now gets a
small bounded `asyncio.Queue` (`QUEUE_SIZE = 8`) and a dedicated "drain"
task that is the sole consumer of that queue, sending one frame at a time
with a `SEND_TIMEOUT`-bounded `send_json`. `broadcast()` just enqueues to
every connected client's queue and returns — it never waits on a client's
network send, so however many clients are stalled, the write path that
calls it (routes_ops.py, notify.py) pays none of their latency. Ordering
per client is guaranteed structurally: `put_nowait` is synchronous (no
`await`), so two overlapping `broadcast()` calls always enqueue in call
order, and a single-consumer FIFO queue can't reorder its own items —
this is deliberately stronger than a per-client lock, since a test
(`test_broadcast_preserves_per_client_order_when_first_send_is_slow`)
demonstrated the *old* code, when driven by two overlapping broadcasts,
actually delivered frames out of order (`[{'seq': 2}, {'seq': 1}]`)
because a slow first send let the second race ahead of it. A client
whose queue overflows (not draining fast enough) or whose send exceeds
`SEND_TIMEOUT` is disconnected outright, same policy as before, just
applied per-client instead of blocking the whole broadcast.

No hard cap on total connection count was added — deliberate, since this
is a single-user server with a handful of replicas; the per-client queue
bound and send timeout already bound the cost of any one client or any
one broadcast, documented in `docs/architecture/sync-and-offline.md`
(new "Hub fan-out" subsection).

Tests (`server/tests/test_ws.py`): rewrote the existing low-level Hub
test to use `hub.connect()` (fakes now implement `accept()`) and wait for
background delivery; added
`test_broadcast_does_not_block_on_stalled_clients` (RED against the old
code: 10 stalled clients took 2.02s against a 0.2s bound),
`test_broadcast_preserves_per_client_order_when_first_send_is_slow` (RED
against the old code: genuinely reordered under concurrent broadcasts),
and `test_broadcast_disconnects_client_whose_queue_overflows`. Full
server suite (1047 tests), `test_journal_advancing_contract.py`,
`pyrefly check`, and `ruff check` all pass; no route/API surface changed
so no OpenAPI/gen-types regen needed.
