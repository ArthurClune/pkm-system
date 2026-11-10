---
# pkm-60go
title: 'Assistant turn: Stop as the stall fires retires the conversation; interrupt state has no phase'
status: completed
type: bug
priority: high
created_at: 2026-11-09T21:39:23Z
updated_at: 2026-11-10T08:30:23Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W3. Child of the 2026-11-09 maintainability review epic.

## Checklist

- [x] Phase table: `querying`, `interrupting`; tests for every row
- [x] Red engine tests: B1 both orders, B2 cancelled query
- [x] Engine: `_stop_turn` the only interrupt path; `send()` moves `query` first; `close()` moves `lost`
- [x] Property model: held Stop interrupt across a stall; cancel during `query()`; rates and teeth
- [x] Route `POST .../stop`, `TurnStopped`, OpenAPI and types regenerated
- [x] Web: `postStop` effect, `turn_stopped`, `STOP_ACK_TIMEOUT_MS` fallback; property model and mutants
- [x] Docs: assistant.md turn phase, frontend.md chat machine, backend.md API row, troubleshooting rows

## Summary of Changes

- `turn_phase.py`: `querying` and `interrupting` phases; the `("idle", "interrupt_acked")` row removed.
- `claude_engine.py`: the pump is the only interrupter (`_stop_turn`); Stop and disconnect are requests it hears (`_request_stop`); `_stalling`/`stalled` gone; `send()` moves `query` before `query()` and retires on a cancellation there; `close()` moves `lost`; `stop_turn()`; a write reaching a stopping turn is declined.
- `POST /api/assistant/conversations/{id}/stop`, `TurnStopped` (`turn_stopped`), OpenAPI and types regenerated.
- Web: `postStop` effect, `turn_stopped`/`error` end a stopping turn, `STOP_ACK_TIMEOUT_MS` fallback abort; New chat aborts a stopping turn's stream.
- Property suites: server draws user Stop, a held Stop across the stall deadline, a cut-short query; web model expects a posted stop, with three new mutants.
- No `acking` phase: the pump reads nothing while its interrupt is in flight, so a result is never read before the ack.
