---
# pkm-mbcc
title: Pending assistant confirm survives a dead client for minutes
status: todo
type: bug
priority: normal
created_at: 2026-07-30T20:02:45Z
updated_at: 2026-07-30T20:02:45Z
---

When the browser's SSE connection dies while a write confirmation is pending,
the conversation stays `busy` and the harness subprocess stays blocked in
`can_use_tool` until the disconnect is finally noticed -- observed at over ten
minutes on 2026-07-30.

## Observed incident (2026-07-30)

Conversation `5b72cf28aadf0861`: `POST .../messages` started 20:40:46, the model
issued a `batch` at 20:42:33, and `can_use_tool` parked awaiting the decision.
The client's TCP connection was already gone (no ESTABLISHED socket from the
client IP, no WebSocket), so the confirm card could not be answered. The request
finally completed at **20:51:09 with a duration of 623174ms**, at which point the
`finished == false` branch in `claude_engine.py:159-183` ran: `interrupt()` plus
every pending future resolved to `False` (declined). No writes were applied.

Cleanup is therefore correct but arbitrarily slow. While parked:

- `entry.busy` stays `True`, and `_reap_idle` (`service.py:114`) skips busy
  entries, so idle reaping cannot collect it
- the harness subprocess and its MCP child stay alive, CPU-idle
- from the user's side the panel just looks hung, with no signal anywhere

## Notes for whoever picks this up

- The delay is the disconnect detection, not the cleanup: the generator is parked
  on `await self._queue.get()` and writes nothing, so nothing forces the dead
  socket to surface an error.
- A pending-confirm timeout, or a keepalive/heartbeat write on the SSE stream
  that would fail fast against a dead peer, would both bound this. A heartbeat
  has the side benefit of keeping intermediaries from idling the stream out.
- Whatever the mechanism, a declined-by-timeout confirm must reach the UI as a
  clear message rather than a silent deny.

## Plan

- [ ] Decide the mechanism (SSE heartbeat vs pending-confirm timeout vs both)
- [ ] Bound the time a pending confirm can survive a dead client
- [ ] Surface a timed-out confirm to the panel as an explicit message
- [ ] Test that a dropped consumer with a confirm pending releases `busy`
      promptly and closes the harness
