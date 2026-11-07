---
# pkm-74vc
title: 'Assistant: after Stop or a stall the conversation answers one turn behind for its whole life'
status: completed
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T22:00:20Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Covers review findings serverlib F1, F2, F4, F7. Verdict: HOLDS
(verified against the installed claude_agent_sdk reader and the bundled CLI
2.1.301, not only the test double).

## Symptom
Press Stop (or let the stall watchdog fire), then send another message. The
next turn ends at once (an `error_during_execution` error or an empty
TurnDone), and every later reply is shown under the following message.
Knock-ons:
- the stale TurnDone clears `_running_writes`, so later cards lose their
  `writes_in_flight` stamp;
- an out-of-step write reaches `can_use_tool` while no `send()` consumes;
  the next `send()` drains `_queue` and drops that ConfirmRequest while its
  future stays in `_pending`; `_pump` skips the stall deadline while
  `_pending` is non-empty, so the turn hangs on "thinking..." until Stop,
  which then declines a card the user never saw (serverlib F2);
- a harness whose process died (`ProcessError`, CLIConnectionError) is never
  marked unhealthy, so every later turn errors in-band until New chat; a
  clean EOF with no ResultMessage makes `send()` wait forever (F4).

## Cause
`assistant/claude_engine.py` `ClaudeConversation`: `_abandon_turn` and
`_stall` interrupt and stop reading. The SDK buffers every message; the CLI
acknowledges the interrupt and then writes the aborted turn's ResultMessage
(`terminal_reason` aborted_*). The next `receive_response()` yields it. The
state "the server has finished the turn but the harness has not" has no
name and no owner. `tests/fake_sdk_client.py` `interrupt()` never emits the
aborted result, so every Stop test passes.

## Fix
Add a small explicit phase on `ClaudeConversation`: idle / streaming /
draining / dead (replacing the loose `healthy` flag). Not the five-state
enum first proposed: abandoning and retired are already handled.
- [x] Fake SDK client emits the aborted ResultMessage after the interrupt ack (and variants: before ack, never)
- [x] Red tests for Stop→send, stall→send, process death, clean EOF
- [x] After an acknowledged interrupt, drain to the ResultMessage under a bound (feeding results through the shared TurnMapper); drain timeout → dead
- [x] `send()` never drops a ConfirmRequest whose future is pending: decline it explicitly
- [x] `_pump` marks the phase dead on transport/process errors and on StopAsyncIteration before a result; the service retires dead handles
- [x] Live-smoke Stop→send against the real harness: Claude routing done (sonnet, `ANTHROPIC_BASE_URL` unset in the CLI env; fixed code answers the new message, pre-fix code answers one behind). GLM smoke NOT done (Arthur declined key access on 2026-11-07): moved to pkm-eynb. GLM routing of Stop→send is covered by unit test (`test_stop_then_send_answers_the_new_message[glm]`)

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

Sketch (Hypothesis `RuleBasedStateMachine`, `proptest` marker, one loop):
- Model: a scripted fake CLI with a FIFO of queried prompts. Each turn emits
  stream events, optionally a write tool_use that calls `can_use_tool`, and a
  ResultMessage tagged with its prompt id. An interrupt ends the active turn
  with an aborted result tagged the same way.
- Alphabet: `send(p)` consuming 0..k events or to the end; `stop` (aclose
  mid-turn); `stall` (STALL_TIMEOUT_S patched small plus a clock step);
  `interrupt_ack_order` (result before ack / after ack / never);
  `answer_confirm(allow)`; `process_dies`; `stream_eof`. The interleaving that
  found the bug: send → stop with result-after-ack → send.
- Invariants: every finished `send(p)` ends on the result tagged p; at every
  quiescent step each future in `_pending` has its ConfirmRequest in the live
  consumer's stream or is declined; a dead process, unacknowledged interrupt
  or drain timeout is never reused; `_running_writes` ⊇ allowed writes whose
  result has not been emitted.

## Summary of Changes

- Verified the cause live against CLI 2.1.301: the CLI acknowledges the
  interrupt, then writes assistant/user messages and the aborted
  `ResultMessage` (`terminal_reason=aborted_streaming`) ~6 ms later; an
  interrupt to an idle CLI is acknowledged with no result.
- `pkm.assistant.turn_phase`: pure `next_phase` table over idle / streaming /
  draining / dead; any move outside the table is dead.
- `ClaudeConversation`: `healthy` is now a property (phase not dead). After an
  acknowledged interrupt (Stop or stall) the pump keeps reading to the aborted
  result, bounded by `DRAIN_TIMEOUT_S`; a Stop that finds the phase idle sends
  no interrupt; stream errors and EOF before a result mark it dead and end the
  turn with an in-band error; `send()` refuses a dead harness, turns a failed
  query into an error, and declines any parked confirm; a confirm with no
  consumer is declined without a card. Timeouts read the loop clock.
- Tests: `FakeSDKClient` interrupt orders, death and EOF;
  `test_assistant_turn_phase.py`, `test_turn_phase.py`; property
  `tests/props/test_assistant_turn_props.py` on `props/virtual_loop.py`.
- Docs: assistant.md § The turn phase, checks.md property-gate row, two
  troubleshooting rows.
