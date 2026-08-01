---
# pkm-lk7t
title: Throttle expensive unauthenticated password checks
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:04:16Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 13).

## Context

**References:** `server/src/pkm/server/auth.py:45-56`; `server/src/pkm/server/auth_core.py:8-15`

Every login failure runs scrypt with no rate limit, concurrency bound, or backoff. Any host able to reach the configured bind address can consume substantial CPU and memory with concurrent attempts.

**Direction:** Add global/per-source throttling and bound concurrent checks while keeping failure responses uniform.

## Tasks

- [x] Add rate-limit and concurrent-attempt tests
- [x] Bound unauthenticated scrypt work

## Summary of Changes

Added `server/src/pkm/server/throttle_core.py` (Functional Core): pure
per-source login-attempt policy. `AttemptState(failures, blocked_until_ms)`
plus `backoff_ms`/`is_throttled`/`after_failure`/`after_success`/
`prune_expired` — exponential backoff (1s, 2s, 4s, ... capped at 30s),
a success clears history, and `prune_expired` bounds the store's size
under sustained attempts from many distinct sources.

Added `LoginThrottle` (Imperative Shell, `auth.py`): wraps the core
policy with a `threading.Lock`-guarded `dict[str, AttemptState]` (one
instance per app, on `app.state.login_throttle`, so tests never share
state) plus a `threading.Semaphore(4)` (`scrypt_slots`) bounding
concurrent scrypt work process-wide — sync FastAPI routes run in a
worker-thread pool with far more than 4 threads by default, so without
this, dozens of concurrent login attempts could run scrypt at once.

`POST /api/login` (`auth.py`) now: computes the source from
`request.client.host`, rejects a throttled source with the same 401 a
wrong password gets — before running scrypt at all, so a throttled
attempt costs nothing even if the password would have been correct —
acquires a `scrypt_slots` slot around the `verify_password` call,
records a failure/success against the throttle, and only then proceeds
to issue the session cookie.

Test coverage (TDD, RED then GREEN at each step):
- `tests/test_throttle_core.py` — 6 tests on the pure policy (backoff
  growth/cap, throttle window, per-source independence via
  `after_failure`/`is_throttled`, success clearing history,
  `prune_expired` behaviour). No wall-clock use; all `now_ms` explicit.
- `tests/test_auth.py` — added `TestLoginThrottle` (7 unit tests against
  the shell class with explicit `now_ms`, including the concurrency-slot
  bound and the store-pruning branch) plus 2 HTTP-level tests through
  `anon_client` (same-source throttling after a failure returns a
  uniform 401 body even for the correct password; a fresh source with no
  prior failure logs in immediately). Adjusted the pre-existing
  `test_login_flow_and_gate`, which chained a wrong-password attempt
  immediately followed by a correct-password attempt from the same
  client — that sequence is now exactly what throttling is meant to
  block, so the correct-login assertion was moved to the new dedicated
  tests (and the existing `client` fixture, which does a single login
  with no prior failure).

Docs: `docs/architecture/backend.md` — added `throttle_core.py` to the
module map and a paragraph under `## Auth` documenting the throttling
mechanism and the uniform-failure-response design decision. No HTTP
route, query param, or response field changed, so no OpenAPI/gen-types
regeneration was needed.

Verification (from the worktree's `server/`): `uv run pytest -q` — 1045
passed, coverage 96.31% (≥95% required); `uv run pyrefly check` — 0
errors; `uv run ruff check` — all checks passed.

Self-review: confirmed no other test in the suite chains a same-source
failure immediately before a same-source success (grepped all
`/api/login` call sites); confirmed the `MAX_TRACKED_SOURCES` prune
guard uses `>=` (an initial `>` off-by-one meant it never fired at a
cap of 1, caught by the dedicated pruning test going RED first).
