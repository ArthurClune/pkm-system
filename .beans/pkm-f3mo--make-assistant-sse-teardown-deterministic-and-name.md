---
# pkm-f3mo
title: Make assistant SSE teardown deterministic and name lifecycle protocols
status: in-progress
type: bug
priority: high
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-18T12:14:31Z
parent: pkm-wvvu
---

## Review findings

Backend correctness-adjacent SSE teardown plus the `ClaudeConversation.send`, `create_conversation`, duplicated decline loop, and comment-density findings.

Disconnecting `_with_keepalive` cancels a pending `anext` but does not explicitly close the underlying async generator, leaving critical decline/interrupt cleanup to async-generator finalization.

## Acceptance criteria

- [x] Explicitly `aclose()` the underlying stream during keepalive/SSE teardown without masking the original disconnect
- [x] Add a disconnect regression test proving parked confirmations are declined, the bounded interrupt runs, and the conversation becomes unhealthy deterministically
- [x] Extract and reuse a named abandon-turn protocol for decline, interrupt, and health state
- [x] Extract pure model/environment resolution from conversation creation
- [x] Consolidate identical decline-all-pending loops
- [x] Keep one canonical explanation of the assistant admission-lock timeout story and cross-reference it elsewhere
- [x] Preserve timeout bounds, cancellation safety, and provider routing with focused tests and architecture updates

## Summary of Changes

**The bug.** `_with_keepalive` cancelled a pending `anext` on disconnect but
never closed the underlying generator, and `sse()` just stopped iterating, so
the engine's dropped-consumer cleanup ran on async-generator finalization.
One layer down it was outright wrong rather than merely late: on the close
path `AssistantService._stream`'s `finally` read `handle.healthy` *before* the
handle's own cleanup had set it, so an unacknowledged interrupt left the
conversation in the registry for a later turn to reuse -- the pkm-rwwc defect,
reachable again through a different door.

**The fix**, explicit closes end to end:

- `routes._sse_frames` (the response body, extracted from the inline `sse()`
  closure so it is drivable in a test) closes the keepalive wrapper via
  `contextlib.aclosing`.
- `routes._with_keepalive`'s `finally` calls the new `_abandon_stream`, which
  cancels **and awaits** the in-flight read before `aclose()` -- closing a
  generator with a live `__anext__` raises "asynchronous generator is already
  running" -- and logs failures (including a cancellation landing in
  teardown) instead of raising, so it never masks the disconnect.
- `AssistantService._stream` wraps the handle's turn generator in
  `contextlib.aclosing`, so the handle's cleanup completes before the
  `healthy` check.
- `ConversationHandle.send` is typed `AsyncGenerator`: the caller closes it,
  so closability is contract, not accident.

**Extractions** (behaviour-preserving): `ClaudeConversation._abandon_turn`
names the decline -> bounded-interrupt -> health protocol;
`_decline_pending` is the decline-all-pending loop `_abandon_turn` and
`close()` used to carry twice; `harness_env.py` (Functional Core) owns
`resolve_harness_env()`, the pure model/env decision `create_conversation`
used to make mid-function while mutating `model`. Routing still keys on
`policy.ZAI_MODELS`, not a `glm` literal.

**Comments.** The lock-hold arithmetic now lives once, on `CREATE_TIMEOUT_S`;
`_admission_lock` and `create()`'s `finally` keep their local facts and point
there. `describe/service.py`'s shutdown machinery (shielded wait, the
`cancelling()` probe) gained the explanation it had none of.

**A second defect, found by live-checking against real uvicorn.** With the
closes in place the interrupt fired but the conversation still was not
retired. Starlette runs the response body inside an anyio cancel scope, and
that scope re-cancels every task inside it on every loop cycle, so the bounded
interrupt wait was cancelled instead of timing out and `healthy` never got a
verdict (`except TimeoutError`/`except Exception` do not catch
`CancelledError`). Two changes: `routes._wait_out` runs each teardown step as
its own task, outside that scope, and waits with `asyncio.wait` (capped by
`TEARDOWN_TIMEOUT_S`, so a wedged cleanup cannot hold a response task and a
core forever); and `_abandon_turn` now treats a cancelled interrupt wait like
a timed-out one and re-raises. Live-verified after the fix: wedged interrupt ->
warning logged, conversation retired, 0600 credential file gone, registry
empty; acknowledged interrupt -> conversation kept, healthy, and it accepts a
second turn (200). The server answered an unrelated request in 0.02s while
teardown was still running.

**Tests.** `tests/test_assistant_teardown.py` (11 tests) drives the real chain
-- `ClaudeConversation` over a fake SDK client, the real `AssistantService`,
the real SSE frame generator -- and asserts the decline, the interrupt, the
unhealthy flag and the retirement with no `await` between the close and the
assertions, so nothing can be credited to the collector. Four of them fail
against the previous code, including one that reproduces the anyio storm by
re-cancelling the consumer on every loop cycle.
`tests/test_assistant_harness_env.py` (6 tests)
covers the pure resolver. SDK doubles moved to `tests/fake_sdk_client.py`.

**Docs.** `assistant-and-files.md` gains a "Teardown when the client
disappears" section (close-chain diagram plus the two orderings that matter),
which absorbs the two lifecycle bullets that were in the harness-confinement
list; `harness_env.py` is in the module table; the admission section points at
`CREATE_TIMEOUT_S` for the arithmetic.

Verification: `pytest -q` 1480 passed, coverage 97.06% (gate 95%);
`pyrefly check` 0 errors; `ruff check` clean.
