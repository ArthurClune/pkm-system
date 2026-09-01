---
# pkm-d6i6
title: 'Connectivity policy: WS backoff, visibility gating, fetch timeout, server drop threshold'
status: todo
type: task
priority: normal
created_at: 2026-09-01T21:26:51Z
updated_at: 2026-09-01T21:27:09Z
parent: pkm-fgjg
---

Tier 1 — stop generating flaps and stop hammering a dead link.

## Findings
1. **WS reconnect is a fixed 2 s loop, no backoff, no ceiling, no gating.** `web/src/sync/socket.ts:61` (`RECONNECT_MS` at `:28`): a failed connect fires `onclose`, which unconditionally schedules the next attempt. Measured 30.0 constructions/min forever on a dead link (1.2% CPU — but 30 DNS/TCP attempts/min keeps the radio out of low power, which is the real battery cost and unmeasurable on a Mac). Nothing in `web/src/sync` reads `navigator.onLine`, `document.visibilityState`, or `online`/`offline`/`freeze`/`resume` events; a hidden tab does exactly the same work as a foreground one.
2. **`apiFetch` has no timeout** — `web/src/api/client.ts:112` is a bare `await fetch`. A slow-not-dead pull can hang for minutes holding the connection while `pulling` blocks further nudges (`replicaSync.ts:436-440`). The assistant stream already has a stall guard (`assistant/client.ts:57`); sync does not.
3. **Server drop policy is the flap generator.** `server/src/pkm/server/ws.py:38-39`: `SEND_TIMEOUT = 1.0` s, `QUEUE_SIZE = 8`. Tuned for LAN; on train wifi it drops clients constantly, and each drop costs a full reconnect cycle (see sibling bean).

## Ideas
- Exponential backoff 2 s → ~30 s cap, reset on success; pause the timer while `document.hidden`; reconnect immediately on `visibilitychange` (to visible) and `window 'online'`.
- `AbortSignal.timeout(~15 s)` on sync/read fetches; the existing backoff handles the abort as an ordinary failure.
- Raise `SEND_TIMEOUT` (e.g. 5 s) and/or `QUEUE_SIZE`; a slow client is far cheaper than a dropped one. Keep "disconnecting must also close the socket" (sync-and-offline.md Hub fan-out).
- Optional cheap input: `navigator.connection?.saveData` / `effectiveType`.

## Verify
`ws-probe.mjs` dead-link window: attempts/min falls from 30 to ≤ 4 after the first minute. Docs: `sync-and-offline.md` Ancillary details currently says "fixed 2 s reconnect interval, no backoff" — update.

## Checklist
- [ ] Reconnect backoff + visibility/online gating (unit-tested with fake timers)
- [ ] Fetch timeout on sync path
- [ ] Server SEND_TIMEOUT/QUEUE_SIZE revisited (decide with Arthur)
- [ ] Re-measure; docs updated
