---
# pkm-4zq4
title: Make Claude harness startup transactional and cancellation-safe
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:44Z
updated_at: 2026-07-31T15:54:44Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 4.

**References:** server/src/pkm/assistant/claude_engine.py:245-280

Startup writes a 0600 config containing a long-lived session token, creates the SDK client, and connects it without cleanup around failure or cancellation. Factory/connect failures can leave the credential file and a partially started subprocess/client behind.

**Direction:** Wrap all work after config creation in cancellation-safe cleanup that disconnects any created client and always unlinks the config before re-raising.

- [x] Test factory failure, partial connect failure, and cancellation during connect
- [x] Assert credential unlink and client disconnect on every failed startup path

## Summary of Changes

`ClaudeEngine.create_conversation()` (`server/src/pkm/assistant/claude_engine.py`)
now wraps client construction and `connect()` in `try`/`except BaseException`.
On any exit other than success it calls `conversation.close()` — the same
method used for normal teardown — and re-raises. `close()` already tolerates
a client that never connected (or was never attached, in the factory-failure
case) and a `disconnect()` that itself raises, so no new cleanup logic was
needed; startup failure now shares one path with normal shutdown.

Confirmed via the config file's existing lifecycle
(`test_create_conversation_options_and_config_file`): it is written before
the client is constructed and lives for the conversation's whole lifetime,
unlinked only in `close()`. That is unchanged — this fix only adds `close()`
calls on the failure paths that previously skipped it entirely.

Three new regression tests in `server/tests/test_claude_engine.py` cover the
failure shapes named in the brief:
- `test_create_conversation_factory_failure_unlinks_config` — `client_factory`
  raises before any client exists; only the config file needs cleanup.
- `test_create_conversation_connect_failure_unlinks_and_disconnects` —
  `connect()` raises after the client was created; both disconnect and
  unlink must happen.
- `test_create_conversation_cancelled_during_connect_cleans_up` — mirrors
  `service.create()`'s real caller: `asyncio.wait_for(create_conversation(...),
  short_timeout)` against a client whose `connect()` hangs forever, so a
  `CancelledError` is delivered into the awaited `connect()`. Same cleanup
  assertions as the previous test, using the outer `wait_for`'s `TimeoutError`
  as the caller-visible signal.

All three failed (RED) against the pre-fix code — the factory-failure test
left the config file on disk; the other two showed
`disconnect_calls == 0`. After the fix all three pass and the full suite
(963 tests, 95.99% coverage), `pyrefly check`, and `ruff check` are clean.

`docs/architecture/backend.md`'s embedded-assistant section gained a
"Transactional startup" paragraph describing this behavior next to the
existing config-file/auth bullet.

No concerns. No behavior change on the success path (config file still lives
for the conversation's lifetime, unlinked only in `close()`).

## Fix round 1 (review findings)

Review found two Important issues in the round-1 implementation above:

**Finding 1 (fixed):** `ClaudeConversation.close()` awaited
`client.disconnect()` guarded only by `except Exception`, then unlinked the
config file as a separate, later statement. `CancelledError` is
`BaseException`, not `Exception` — a second cancellation delivered into that
`disconnect()` await (realistic: `wait_for(create_timeout)` cancels once,
then whatever cancels the enclosing request task, e.g. an aborted POST or
lifespan shutdown, cancels again) skipped the unlink, leaking the 0600
session-token file, and also replaced the original exception that `raise` at
the end of `create_conversation()`'s except block never got to run. Fixed by
moving the whole disconnect/unlink body of `close()` into `try`/`finally`
with the unlink in `finally`, so it runs regardless of what is raised above
it. New regression test
`test_close_cleanup_survives_a_second_cancellation_during_disconnect` (a
`HangingDisconnectClient` fake whose `connect()` and `disconnect()` both
hang until cancelled) reproduces the exact double-cancellation sequence and
went RED (file leaked) then GREEN.

**Finding 2 (documentation only, no code change per reviewer's own
instruction):** `asyncio.wait_for` does not return until the task it
cancelled finishes unwinding, so `create_conversation()`'s new
cancellation-triggered cleanup (added in round 1) now runs to completion
*under the admission lock*, before `service.create()`'s `except
TimeoutError` is reached. The true worst-case lock hold is therefore
`CREATE_TIMEOUT_S` plus that cleanup (~20s worst case, riding on the SDK
transport's own bounded close), not `CREATE_TIMEOUT_S` alone. Updated the
comments on `CREATE_TIMEOUT_S` and `_admission_lock` in
`server/src/pkm/assistant/service.py`, and the corresponding paragraph in
`docs/architecture/backend.md`, to state the true ~80s bound instead of the
previously-implied 60s. Also corrected `backend.md`'s "tolerates a
`disconnect()` that itself raises" line to include the finding-1 fix
(survives a second cancellation via `finally`, not just `except Exception`).

Full suite after both fixes: 964 tests passed, 96.01% coverage, `pyrefly
check` clean, `ruff check` clean.

## Final-review fix wave

Whole-branch review (both pkm-4zq4 and pkm-rovq) came back "ready to merge
WITH FIXES" — one Important finding, one layer up from the two fixed above.

**Finding:** `AssistantService.create()`'s outer `finally` in
`server/src/pkm/assistant/service.py` closes each queued `to_close` handle
(reaped/evicted conversations popped from `_entries` under the admission
lock) guarded only by `except Exception`. A `CancelledError` delivered
while parked in one handle's `close()` — realistic path: a cap-full reload
queues an evicted handle, then a client-aborted POST cancels the request
task during that handle's close window — aborted the loop entirely. Every
remaining `to_close` entry had already been popped from `_entries`, so
nothing would ever close it: its subprocess and 0600 session-token config
file leak until process exit. This is the exact credential-leak class
pkm-4zq4 closes, resurrected one layer up, and a narrow regression versus
the pre-pkm-rovq code (where a stale entry stayed registered and got
retried on the next reap).

**Fix:** the loop now catches `asyncio.CancelledError` per iteration
separately from `Exception`, logs it, remembers the first one, and
continues closing the rest of the queue; after the loop finishes it
re-raises that first cancellation. Each handle's `close()` is itself
SDK-bounded (~20s worst case), so a queued cancellation is delayed, not
lost — matching the reviewer's suggested fix exactly.

New regression test in `server/tests/test_assistant_service.py`:
`test_close_loop_continues_past_a_cancelled_handle_and_reraises` seeds two
already-idle `_Entry` rows directly (`_StubHandle(hang_close=True)` and a
normal `_StubHandle`), lets a single `create()` reap both into `to_close`,
cancels the task while it's parked in the hung handle's `close()`, and
asserts the *second*, normal handle still gets closed (`normal.closed is
True`) while the task itself raises `CancelledError` and the hung handle is
left `closed is False` (cancelled mid-await, as expected). This test went
RED against the pre-fix loop (`normal.closed` stayed `False` — the loop had
already aborted after the first handle's cancellation) and GREEN after the
fix.

`docs/architecture/backend.md`'s admission-lock paragraph gained a sentence
describing this cancellation-safe teardown-loop behavior.

Verification: `cd server && uv run pytest -q tests/test_assistant_service.py
--no-cov` → 18 passed (was 17); full suite `uv run pytest -q` → 965 passed,
95.98% coverage; `uv run pyrefly check` → 0 errors (same 3 pre-existing
suppressions); `uv run ruff check` → all checks passed.

No concerns. No behavior change for the non-cancellation case: ordinary
`Exception`s from a handle's `close()` are still logged and swallowed
(best-effort teardown), exactly as before — only a `CancelledError` now
gets special (keep-going-then-re-raise) handling.
