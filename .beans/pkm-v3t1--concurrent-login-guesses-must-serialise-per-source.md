---
# pkm-v3t1
title: Concurrent login guesses must serialise per source
status: in-progress
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-25T03:15:18Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-u8uh. The throttle is checked before the password and a failure recorded after, so 200 concurrent guesses ran 40 scrypt checks. Opus designs: reserve the attempt (or hold a per-source lock) before the scrypt check. Mind the anyio threadpool, the scrypt semaphore and its 2 s timeout. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_throttle.py.

- [x] Red test: the probe's 200-concurrent burst expects one check per backoff window
- [x] Fix
- [x] troubleshooting.md row; SECURITY.md via pkm-e95y (handed over: its throttle-keying item carries the login-backoff row)

## Summary of Changes

- `login()` is now an async route. A request takes its source's turn (`LoginThrottle.take_turn`, a per-source `asyncio.Lock` waited on the event loop, up to `SCRYPT_ACQUIRE_TIMEOUT_S`), re-checks the backoff, then hands the turn to the check (`hand_turn_to`). The check records its verdict on the worker thread, and its done-callback ends the turn, so a cancelled request cannot release the turn mid-check.
- Concurrent requests wait rather than being refused, so a double-submit of the right password gets 200 twice. Every refusal stays the uniform 401 `wrong password`; a turn timeout answers it too. Worst case under contention: 2 s for the turn, 2 s for a scrypt slot, one check.
- The 200-request burst runs one check per backoff window (`test_a_concurrent_burst_runs_one_check_per_backoff_window`); cancellation, deadline, slot-timeout and exception paths are pinned in `server/tests/test_auth.py`. The done-callback reads and logs a failed check's exception, so a check that raises after its request was cancelled is not reported as "exception was never retrieved".
- Docs: backend.md § Login throttle; troubleshooting row.
