from pkm.server.throttle_core import (
    AttemptState, after_failure, after_success, backoff_ms, is_throttled,
    prune_expired,
)


def test_backoff_grows_exponentially_and_caps():
    assert backoff_ms(0) == 0
    assert backoff_ms(1) == 1_000
    assert backoff_ms(2) == 2_000
    assert backoff_ms(3) == 4_000
    assert backoff_ms(4) == 8_000
    assert backoff_ms(5) == 16_000
    assert backoff_ms(6) == 30_000  # capped at MAX_BACKOFF_MS
    assert backoff_ms(50) == 30_000  # stays capped, no runaway growth


def test_fresh_state_is_never_throttled():
    assert not is_throttled(AttemptState(), now_ms=0)


def test_failure_throttles_until_backoff_elapses():
    state = after_failure(AttemptState(), now_ms=1_000)
    assert state.failures == 1
    assert is_throttled(state, now_ms=1_500)
    assert not is_throttled(state, now_ms=2_000)  # backoff has elapsed


def test_repeated_failures_increase_wait_from_last_failure():
    state = after_failure(AttemptState(), now_ms=0)      # failures=1, blocks to 1_000
    state = after_failure(state, now_ms=1_000)            # failures=2, blocks to 1_000+2_000
    assert state.failures == 2
    assert state.blocked_until_ms == 3_000
    assert is_throttled(state, now_ms=2_999)
    assert not is_throttled(state, now_ms=3_000)


def test_success_clears_history():
    assert after_success() == AttemptState()


def test_prune_expired_drops_only_lapsed_sources():
    attempts = {
        "lapsed": AttemptState(failures=1, blocked_until_ms=500),
        "still-blocked": AttemptState(failures=3, blocked_until_ms=5_000),
    }
    pruned = prune_expired(attempts, now_ms=1_000)
    assert pruned == {"still-blocked": attempts["still-blocked"]}
