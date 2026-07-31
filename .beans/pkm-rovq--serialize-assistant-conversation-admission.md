---
# pkm-rovq
title: Serialize assistant conversation admission
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:41Z
updated_at: 2026-07-31T15:54:41Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 3.

**References:** server/src/pkm/assistant/service.py:54-69

The conversation-cap check occurs before awaiting engine.create_conversation(). Concurrent requests can both observe free capacity and start harnesses, bypassing the configured cap or over-evicting idle conversations.

**Direction:** Serialize admission with a lock or atomically reserve creation slots, releasing reservations on every failure/cancellation path.

- [x] Add barrier-controlled concurrent creation tests
- [x] Enforce the cap across active and in-progress creations

## Summary of Changes

Added `self._admission_lock: asyncio.Lock` to `AssistantService` and wrapped
the entire body of `create()` (reap idle, cap check, eviction, cap re-check,
`engine.create_conversation()`, registration) in `async with
self._admission_lock:`. This serializes the whole admission path so two
concurrent `create()` calls can no longer both observe free capacity before
either registers its new entry — the second call now blocks on the lock and
re-evaluates the cap against the first call's actual outcome (success,
failure, or cancellation) instead of stale state. `async with` releases the
lock via its own try/finally on every exit path, including exceptions raised
by the engine and task cancellation, so a failed or cancelled creation never
leaves admission stuck.

`send()`, `confirm()`, and `delete()` are untouched — only admission is
serialized, not turns on existing conversations.

Added a `BarrierEngine` test double in `server/tests/test_assistant_service.py`
whose `create_conversation()` can be held open on a controlled
`asyncio.Event` and which records call count / concurrency, plus four new
tests:

- `test_concurrent_creates_never_enter_engine_simultaneously` — two
  concurrent `create()` calls with headroom under the cap; proves the engine
  is entered by only one admission at a time (RED before the fix: both
  entered concurrently, `engine.calls == 2` when only 1 was expected at that
  point).
- `test_cap_never_exceeded_across_a_pending_creation` — cap of 1, two
  concurrent `create()` calls; proves the cap is enforced against the
  in-progress creation (the second call blocks until the first's admission
  fully lands, then evicts it) rather than being bypassed.
- `test_failed_creation_releases_the_admission_lock` — engine raises on the
  first call; a subsequent `create()` still succeeds under a timeout,
  proving the lock isn't leaked on failure.
- `test_cancelled_creation_releases_the_admission_lock` — the first task is
  cancelled while parked inside the engine call; a subsequent `create()`
  still succeeds under a timeout, proving the lock isn't leaked on
  cancellation.

Verification: `uv run pytest -q` (958 passed, coverage 95.97%), `uv run
pyrefly check` (0 errors), `uv run ruff check` (clean).
