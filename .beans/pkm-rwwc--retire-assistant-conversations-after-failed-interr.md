---
# pkm-rwwc
title: Retire assistant conversations after failed interrupts
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:33:17Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 14).

## Context

**References:** `server/src/pkm/assistant/claude_engine.py:147-201`; `server/src/pkm/assistant/service.py:86-93`

If interrupt times out or raises, local cleanup continues and the service marks the conversation not busy even though the subprocess may still be running. The uncertain harness is then reusable for later turns, risking stale events, concurrent queries, or continued token use.

**Direction:** Treat unacknowledged interrupt as terminal: disconnect/kill the harness and remove or invalidate the conversation.

## Tasks

- [x] Add a second-send test after interrupt timeout/failure
- [x] Prevent reuse of uncertain harnesses

## Summary of Changes

Added a `healthy: bool` field to the `ConversationHandle` protocol
(`server/src/pkm/assistant/engine.py`), defaulting `True`. `ClaudeConversation`
(`server/src/pkm/assistant/claude_engine.py`) now flips it to `False` inside
`send()`'s existing cleanup path the moment an `interrupt()` times out or
raises -- the same spot that already declines pending confirms before
awaiting interrupt (pkm-mbcc ordering preserved, untouched). This does not
itself touch the client/subprocess; it only signals "this harness's state is
now uncertain."

`AssistantService._stream()` (`server/src/pkm/assistant/service.py`) checks
`entry.handle.healthy` in its own `finally`, after resetting `busy = False`.
If unhealthy, it pops the entry from `_entries` -- synchronously, with no
`await` between the busy-reset and the pop, so no concurrent `create()`
admission (reap/evict, which both skip busy entries) can race a reuse of
this cid in between -- and, only if that pop actually removed the entry
(i.e. nothing else, such as a concurrent explicit `delete()` via the
pagehide beacon, already claimed it first), awaits `handle.close()`: the
harness's existing full teardown (SDK disconnect + credential-config
unlink). That `removed` guard is the double-teardown-race guard the brief
calls for -- it composes with the pkm-rovq admission-lock/deferred-close
pattern (no teardown under the lock) in both directions: `delete()`'s own
`pop(..., None)` is already a no-op if retirement got there first, and now
retirement's close is skipped if `delete()` got there first. The next
`send()` for that conversation id raises `UnknownConversationError`, which
the route layer already maps to a 404 -- "a fresh conversation or a clear
error," per the brief.

TDD: added failing tests first for both layers (see
`test_wedged_interrupt_marks_conversation_unhealthy` /
`test_interrupt_that_raises_marks_conversation_unhealthy` /
`test_acknowledged_interrupt_leaves_conversation_healthy` in
`test_claude_engine.py`, and `test_second_send_after_failed_interrupt_gets_unknown_conversation`
/ `test_healthy_conversation_is_reused_after_a_dropped_turn` in
`test_assistant_service.py`), confirmed each failed against the pre-fix code,
then implemented until green. The service-level test's stub (`_StubHandle`)
blocks on an unset `asyncio.Event` and only flips `healthy = False` in its
own `finally` on cancellation, rather than returning early, so it actually
exercises the cancellation-triggered cleanup path (pkm-mbcc test-double
lesson) instead of faking the outcome.

Also added `healthy = True` to the two other `ConversationHandle` test
doubles the protocol change touched: `FakeConversation`
(`tests/fake_engine.py`, used by route/e2e tests) and `ExplodingConversation`
(`tests/test_assistant_routes.py`) -- both stay `True` since neither
simulates an interrupt path.

Full verification from the worktree's `server/`: `uv run pytest -q` (1055
passed, 96.33% coverage), `uv run pyrefly check` (0 errors, same 3
pre-existing suppressions as before this change), `uv run ruff check` (all
checks passed).
