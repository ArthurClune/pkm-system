---
# pkm-v5x5
title: 'opQueue: a kick during a blocked drain is dropped (reconnect latency)'
status: todo
type: bug
priority: low
created_at: 2026-07-31T20:18:43Z
updated_at: 2026-07-31T20:18:43Z
---

Pre-existing behavior surfaced during pkm-49eh (affects durable rows and the new fallback lane identically).

missedKick is only recorded for a "drained" outcome, so a kick that arrives while a drain is in flight and about to return blocked (e.g. setOnline(true) racing a drain that is concluding offline) schedules no redrain; delivery waits for the next kick (next mutation, reconnect event, etc.). Observed as the reason several pkm-49eh tests must settle the offline drain before reconnecting.

- [ ] Decide the intended semantics (record missedKick for blocked outcomes, or re-kick on connectivity transitions)
- [ ] Add a reconnect-during-blocked-drain test
