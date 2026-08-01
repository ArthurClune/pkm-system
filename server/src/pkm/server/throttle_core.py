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
    """Drop sources whose backoff has already lapsed. This alone is only a
    best-effort trim -- it does nothing if every tracked source is still
    inside its backoff window -- so the caller must pair it with
    `evict_oldest` for an actual hard cap on the store's size."""
    return {src: st for src, st in attempts.items() if st.blocked_until_ms > now_ms}


def evict_oldest(attempts: dict[str, AttemptState]) -> dict[str, AttemptState]:
    """Drop the least-recently-touched source (first in dict insertion/
    update order). Unlike `prune_expired`, this always frees one slot
    regardless of whether any source has lapsed, so a caller that falls
    back to this when `prune_expired` didn't make room gets a real,
    unconditional ceiling on the store's size."""
    if not attempts:
        return attempts
    oldest = next(iter(attempts))
    return {src: st for src, st in attempts.items() if src != oldest}
