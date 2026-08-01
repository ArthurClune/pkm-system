# pattern: Functional Core
"""Pure policy for throttling repeated login attempts from one source.

Each consecutive failure from a source doubles the wait before that
source's next attempt is allowed (capped), so an attacker gets
exponentially fewer scrypt computations over time while a user who
mistypes once waits at most a second. A success clears the source's
history. The caller must consult `is_throttled` *before* running the
password check -- a throttled attempt is rejected at zero cost,
including one that would have had the right password, because the
whole point is to avoid spending scrypt work on it.
"""
from __future__ import annotations

from dataclasses import dataclass

BASE_BACKOFF_MS = 1_000
MAX_BACKOFF_MS = 30_000
# Failure counts beyond this no longer increase the backoff (already at
# MAX_BACKOFF_MS), so there is no reason to let the exponent keep growing.
MAX_TRACKED_FAILURES = 6


@dataclass(frozen=True)
class AttemptState:
    """One source's login-failure history. A source with no entry in the
    store is equivalent to `AttemptState()` -- never throttled."""
    failures: int = 0
    blocked_until_ms: int = 0


def backoff_ms(failures: int) -> int:
    """Wait imposed after `failures` consecutive failures (0 before any)."""
    if failures <= 0:
        return 0
    capped = min(failures, MAX_TRACKED_FAILURES)
    return min(BASE_BACKOFF_MS * (2 ** (capped - 1)), MAX_BACKOFF_MS)


def is_throttled(state: AttemptState, now_ms: int) -> bool:
    return now_ms < state.blocked_until_ms


def after_failure(state: AttemptState, now_ms: int) -> AttemptState:
    failures = state.failures + 1
    return AttemptState(failures=failures,
                        blocked_until_ms=now_ms + backoff_ms(failures))


def after_success() -> AttemptState:
    return AttemptState()


def prune_expired(attempts: dict[str, AttemptState],
                  now_ms: int) -> dict[str, AttemptState]:
    """Drop sources whose backoff has already lapsed, bounding the store's
    size under sustained attempts from many distinct sources. A source
    still inside its backoff window is kept regardless of failure count."""
    return {src: st for src, st in attempts.items() if st.blocked_until_ms > now_ms}
