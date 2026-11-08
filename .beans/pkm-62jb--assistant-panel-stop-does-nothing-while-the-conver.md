---
# pkm-62jb
title: 'Assistant panel: Stop does nothing while the conversation is being created (make the turn an explicit machine)'
status: in-progress
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:46Z
updated_at: 2026-11-08T14:25:48Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding webui F1. Verdict: HOLDS.

## Symptom
New chat, send, press Stop while `createConversation` is in flight (one POST
round trip), or during the 404 re-create retry: nothing is aborted and the
turn runs to completion. Writes still need an Allow on a card.

## Cause
`assistant/useAssistant.ts` `runTurn` creates the AbortController only after
`await createConversation(model)`; `stop()` aborts `abortController.current`
(null, or the dead attempt's controller on the 404 path, because the
recursive `runTurn` runs before the outer `finally`). Nothing reads
`stopRequested` before streaming starts.

## Also closes (were won't-fix rows in the epic)
- webui F9: a stray error line after Stop when the confirm POST fails.
- webui F10: the server's default model lands after the first create, and
  the picker stays locked after a 404 re-create.

## Fix
Replace the loose refs in `assistant/useAssistant.ts` with one explicit
per-conversation machine, a pure reducer in its own Functional Core file.
The refs are `runStatus`, `abortController`, `stopRequested`, `turnGen`,
`activeTurn`, `conversationId`, `modelLocked` and `modelTouched`.
- Conversation: `none` / `creating` / `open(id, model)`. The picker is
  locked exactly when the conversation is `creating` or `open`, and it
  shows the model that conversation uses.
- Turn: `idle` / `creating` / `streaming(controller)` / `stopping` /
  `failed(message)`. `stop` is a transition from every busy phase:
  - in `creating` it marks the turn as stopping, and the create's result
    is discarded (or the new conversation is kept, but no stream starts);
  - in `streaming` it aborts.
  Confirm-POST failures that arrive in `stopping` or `idle` are dropped.
- The 404 re-create is a transition (`open` → `creating`), not a recursive
  `runTurn`, so a single turn record holds the controller across the
  retry.
- The models-list fetch is an event, and it changes the selection only
  while the conversation is `none` and the user has not touched the
  picker.

- [x] Red tests for both Stop windows (during create, during the 404 re-create), F9 and F10
- [x] Reducer plus shell; the hook only dispatches events and runs effects
- [ ] frontend.md (assistant section): the machine and why stop is valid in every busy phase

## Property testing (required)

This bean introduces or changes a state machine, so it gets full property
testing, not only unit tests (Arthur, 2026-11-07). Per
docs/architecture/checks.md § Property gate:

- Write the model from the docs (sync-and-offline.md, backend.md,
  assistant.md, frontend-editor.md as relevant), never from the code under test.
- The generator draws the whole event alphabet below, freely interleaved, and
  must reach the interleaving that found this bug.
- Show it reaches: label each named path with `event()` (server) or the
  suite tally (web) and read the rates from a real run.
- Show it has teeth: reintroduce this bug as a mutant (or a teeth route) and
  confirm the named invariant fails; a clean run passes.
- Run `proptest/check.sh` before merge; a red-first unit test for the
  original sequence goes beside the code as usual.

Sketch (fast-check, a new suite `web/src/props/assistant`, reducer-level):
- Model from assistant.md: a conversation has at most one turn in flight. A
  Stop the user presses before the turn ends prevents any further stream
  output from being shown and any new write card from appearing. The picker
  shows the model that the conversation runs.
- Alphabet, freely interleaved:
  - `send(text)`, `stop`, `createResolves(id)`, `createFails(404|5xx|net)`;
  - `streamEvent(kind)` (text, tool, confirm-request, result), `streamEnds`,
    `streamErrors`;
  - `confirmPostFails`, `modelsLoaded(default)`, `pickModel(m)`, `newChat`.
- Must reach:
  - send → stop → createResolves;
  - send → createFails(404) → stop → createResolves;
  - stop → confirmPostFails;
  - send → modelsLoaded → createResolves.
- Invariants:
  - after `stop` in a turn, no later event of that turn adds an item or a
    card, or sets an error;
  - at most one turn is busy;
  - the picker's model equals the open conversation's model;
  - `modelsLoaded` never changes the model of a conversation that is
    `creating` or `open`.
- Teeth: drop the stop transition from `creating` (today's behaviour) and
  confirm the first invariant fails.
