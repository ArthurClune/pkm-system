# Contract: the embedded assistant

What a conversation's turn phase does, case by case.
`server/tests/props/test_assistant_turn_props.py` is written from this file,
and `web/src/props/assistant/model.ts` from this file and
[contracts/frontend.md](frontend.md), never from the code. So a change in
behaviour edits the row here and the model together. Each section's
principle, and why it holds, is in [assistant.md](../assistant.md) under the
same section name; a reason that belongs to one row sits in that row.

## The turn phase

The phases and moves are the diagram in
[assistant.md § The turn phase](../assistant.md#the-turn-phase). Any move
the `next_phase` table lacks is `dead`, and `close()` moves `lost` from any
phase.

| `lost` is |
|---|
| a query that fails or is cancelled |
| an interrupt that times out (`INTERRUPT_TIMEOUT_S`), raises or is cancelled |
| a drain that times out (`DRAIN_TIMEOUT_S`) |
| a stream that raises or ends before its result |

| Case | Rule | Reason |
|---|---|---|
| The drain | The pump keeps reading after the ack until the aborted turn's result, bounded by `DRAIN_TIMEOUT_S`. The drained messages still update the tool maps and `_running_writes`, but their events reach no consumer | |
| One interrupt | A turn sends one interrupt at most: `_stop_turn` acts only in `streaming` | A second ack would find the phase `draining`, and the table makes that `dead` |
| A cancelled query | `send()` moves `query` before it awaits `query()`. A cancellation there makes the phase `dead` | The prompt may already have reached the harness, and a turn nobody reads would be read by the next one as its own |
| The turn a stop reaches | A stop reaches the turn the service has reserved, started or not, and never a later one: `send()` mints each turn's stop request when called. A turn stopped before its first step sends no prompt and yields only `TurnStopped` | The stop POST can be handled before the response body starts |
| Finished as the Stop landed | A turn that finished as the Stop landed ends on its own `TurnDone` | An idle CLI acknowledges an interrupt with no result, so a drain would wait out its bound |
| The user's Stop | The user's Stop (`POST …/stop`, `stop_turn()`) answers at once. The stream then ends with `TurnStopped` (`turn_stopped`) once the drain has read the aborted result, or the harness is lost. A stall's interrupt that came first ends it with the stall's `error` instead | Once the pump hears the stop this takes at most `INTERRUPT_TIMEOUT_S` + `DRAIN_TIMEOUT_S`. A stop heard while the prompt is still being written waits on `query()`, which has no bound; there only the web's fallback ([contracts/frontend.md § The chat machine](frontend.md#the-chat-machine)) bounds the panel |
| A write during a stop | A write that reaches `can_use_tool` while its turn is being stopped, or after its consumer has gone, is declined without a card. `send()` declines any confirm still parked before it clears the queue | A parked card would hold the harness where it cannot acknowledge the interrupt. A dropped `ConfirmRequest` would leave its future parked, which also suspends the stall watchdog |
| A `dead` phase | A `dead` phase retires the conversation: `AssistantService._stream()` checks `healthy` when the turn ends, and `send()` refuses a `dead` harness without querying it | The subprocess may still be running the turn, or is gone. The next `send()` for that id raises `UnknownConversationError`, a 404 the panel answers by re-creating the conversation ([contracts/frontend.md § The chat machine](frontend.md#the-chat-machine)). A stream that ended gets an in-band `error`, or the consumer would wait forever |
