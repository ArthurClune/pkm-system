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
