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

## Fix round 1 (review findings)

Task review found the admission lock now spanned two unbounded awaits:
(a) `engine.create_conversation()` → `client.connect()` (spawns the Claude
CLI subprocess) had no timeout, and (b) `_reap_idle()`/`_evict_oldest_idle()`
closed the evicted/reaped conversation's harness (`pump_task`/`disconnect()`)
*inside* the lock. Either one hanging (a wedged harness) would hold
`_admission_lock` forever and wedge every future `POST
/api/assistant/conversations` process-wide.

Fix: (a) `engine.create_conversation()` is now awaited via
`asyncio.wait_for(..., self._create_timeout)` (new constructor param
`create_timeout`, default `CREATE_TIMEOUT_S = 60.0`); a timeout logs a
warning and re-raises, and the lock is still released via `async with`'s
own try/finally. (b) `_reap_idle()`/`_evict_oldest_idle()` are now
synchronous methods that only pop entries from `_entries` (atomic under
the lock) and return the handles to close; `create()` collects them in
`to_close` and closes them in an outer `finally` that runs *after* the
`async with self._admission_lock:` block has already exited — so a hung
teardown only ever delays the request that triggered the eviction, never
blocks other concurrent admissions.

Two new tests in `server/tests/test_assistant_service.py`:
- `test_hung_engine_connect_times_out_and_releases_the_lock` — a harness
  that never connects times out (`create_timeout=0.05`) and a subsequent
  `create()` still succeeds promptly.
- `test_hung_teardown_of_an_evicted_conversation_does_not_block_the_next_admission`
  — an evicted conversation whose `close()` hangs forever; a concurrent
  `create()` that evicts a *different*, normal conversation still completes
  promptly while the first request is still stuck closing the hung one.

RED (against the pre-fix code, verified by temporarily restoring the
just-committed version and running only the two new tests): both failed —
the connect-timeout test with `TypeError: unexpected keyword argument
'create_timeout'` (constructor didn't accept it yet), the teardown test
with `TimeoutError` from the test's own `asyncio.wait_for(..., timeout=1.0)`
around the third `create()` call, proving it was blocked behind the
lock-held-during-hung-close bug. GREEN after the fix: `uv run pytest -q
tests/test_assistant_service.py` → 17 passed (run 5x with no flakiness).

Also updated `docs/architecture/backend.md`'s `service.py` row area with a
new paragraph describing the admission lock's scope, the `create_timeout`
bound, and why teardown happens after the lock is released (Finding 2).

Full verification re-run: `uv run pytest -q` → 960 passed, coverage 95.97%;
`uv run pyrefly check` → 0 errors; `uv run ruff check` → clean.
