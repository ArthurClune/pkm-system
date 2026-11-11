---
# pkm-21bj
title: 'Assistant: generated SSE contract, validate once, confirm answer state'
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T05:49:24Z
parent: pkm-4gda
blocked_by:
    - pkm-60go
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W14. Child of the 2026-11-09 maintainability review epic.

## Close-out (2026-11-11)

- `TurnDone.usage` kept: the server turn property uses it as the witness that a turn's `TurnDone` came from its own result.
- The live smoke with a real model was not run. Stand-ins: `e2e/assistant.spec.ts` (fake engine, real `preview_write`) and the old-bundle pins in `sse.test.ts` and `chatMachine.test.ts`.
- The three new answer labels in the web assistant property have no reach floors yet; each is guarded by a teeth mutant or the exactly-once rule. Floors need the 30-run measurement.
