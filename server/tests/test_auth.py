import re
import threading
import time

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from test_routes_models import _api_routes

from pkm.server.app import create_app

from pkm.server.auth import MAX_CONCURRENT_SCRYPT, LoginThrottle
from pkm.server.auth_core import (hash_password, sign_session,
                                  verify_password, verify_session)

SECRET = b"s" * 32
SALT = b"\x01" * 16


def test_password_roundtrip():
    h = hash_password("hunter2", SALT)
    assert verify_password("hunter2", SALT, h)
    assert not verify_password("hunter3", SALT, h)


def test_session_roundtrip_and_tamper():
    token = sign_session(SECRET, 1700000000000)
    now = 1700000000000 + 1000
    assert token.startswith("v1.1700000000000.")
    assert verify_session(SECRET, token, now_ms=now)
    assert not verify_session(SECRET, token[:-1] + ("0" if token[-1] != "0" else "1"), now_ms=now)
    assert not verify_session(b"other" * 8, token, now_ms=now)
    assert not verify_session(SECRET, "garbage", now_ms=now)
    assert not verify_session(SECRET, "v1.123", now_ms=now)


def test_login_flow_and_gate(anon_client):
    # unauthenticated API access is rejected
    assert anon_client.get("/api/page/Machine%20Learning").status_code == 401
    # wrong password rejected
    assert anon_client.post("/api/login", json={"password": "nope"}).status_code == 401
    # login page is reachable without auth
    assert anon_client.get("/login").status_code == 200
    # A correct-password login right after that failure is now throttled
    # (same source) -- see test_fresh_source_with_no_prior_failure_logs_in_
    # immediately and the `client` fixture for the successful-login path.


def test_docs_routes_disabled(anon_client):
    assert anon_client.get("/docs").status_code == 404
    assert anon_client.get("/redoc").status_code == 404


def test_openapi_json_requires_auth(anon_client):
    assert anon_client.get("/api/openapi.json").status_code == 401


def test_openapi_json_available_after_login(client):
    r = client.get("/api/openapi.json")
    assert r.status_code == 200
    assert "openapi" in r.json()


def test_repeated_login_attempt_from_same_source_is_throttled(anon_client):
    r1 = anon_client.post("/api/login", json={"password": "nope"})
    assert r1.status_code == 401
    # Same source, immediately after -- even the *correct* password is
    # rejected, because throttling must happen before the password is
    # checked at all (that's the whole point: no scrypt work for it).
    r2 = anon_client.post("/api/login", json={"password": "test-pw"})
    assert r2.status_code == 401
    assert r2.json() == r1.json()  # uniform failure body, throttled or not
    assert "pkm_session" not in anon_client.cookies


def test_fresh_source_with_no_prior_failure_logs_in_immediately(anon_client):
    r = anon_client.post("/api/login", json={"password": "test-pw"})
    assert r.status_code == 200
    assert "pkm_session" in anon_client.cookies


def test_login_fails_fast_instead_of_hanging_when_scrypt_slots_are_saturated(
        anon_client):
    # A short acquire timeout keeps this test itself fast; the point is
    # that the route returns *at all* within a bounded time when every
    # slot is busy, rather than queuing forever behind whoever holds them
    # (which would tie up the shared worker-thread pool every other sync
    # route also runs on).
    throttle = LoginThrottle(acquire_timeout_s=0.1)
    anon_client.app.state.login_throttle = throttle
    held = [throttle.scrypt_slots.acquire(blocking=False)
           for _ in range(MAX_CONCURRENT_SCRYPT)]
    assert all(held)  # sanity: we actually saturated every real slot

    start = time.monotonic()
    r = anon_client.post("/api/login", json={"password": "test-pw"})
    elapsed = time.monotonic() - start

    assert r.status_code == 401  # same uniform failure body, not a hang
    assert elapsed < 1.0  # bounded by acquire_timeout_s, not indefinite


class TestLoginThrottle:
    """Unit tests against the shell class directly: all state transitions
    take an explicit monotonic clock reading (`mono_ms`, never reads the
    wall clock itself), so no real waiting or timing races are involved."""

    def test_fresh_source_is_not_throttled(self):
        throttle = LoginThrottle()
        assert not throttle.is_throttled("1.2.3.4", mono_ms=0)

    def test_failure_throttles_the_source_until_backoff_elapses(self):
        throttle = LoginThrottle()
        throttle.record_failure("1.2.3.4", mono_ms=0)
        assert throttle.is_throttled("1.2.3.4", mono_ms=500)
        assert not throttle.is_throttled("1.2.3.4", mono_ms=1_000)

    def test_failures_are_tracked_per_source(self):
        throttle = LoginThrottle()
        throttle.record_failure("1.2.3.4", mono_ms=0)
        assert throttle.is_throttled("1.2.3.4", mono_ms=500)
        assert not throttle.is_throttled("5.6.7.8", mono_ms=500)

    def test_success_clears_the_source_history(self):
        throttle = LoginThrottle()
        throttle.record_failure("1.2.3.4", mono_ms=0)
        throttle.record_success("1.2.3.4")
        assert not throttle.is_throttled("1.2.3.4", mono_ms=0)

    def test_bounds_concurrent_scrypt_slots(self):
        throttle = LoginThrottle(max_concurrent=2)
        assert throttle.scrypt_slots.acquire(blocking=False)
        assert throttle.scrypt_slots.acquire(blocking=False)
        assert not throttle.scrypt_slots.acquire(blocking=False)

    def test_store_is_pruned_once_it_grows_past_the_tracked_source_cap(
            self, monkeypatch):
        monkeypatch.setattr("pkm.server.auth.MAX_TRACKED_SOURCES", 1)
        throttle = LoginThrottle()
        throttle.record_failure("lapsed", mono_ms=0)  # blocks until 1_000
        # now=2_000: "lapsed"'s backoff has already elapsed and the store
        # is over cap, so recording a new failure prunes "lapsed" out
        # first -- the store stays at size 1 instead of growing unbounded.
        throttle.record_failure("still-live", mono_ms=2_000)
        assert len(throttle._attempts) == 1
        assert "lapsed" not in throttle._attempts

    def test_store_has_a_hard_cap_even_when_nothing_has_lapsed(
            self, monkeypatch):
        monkeypatch.setattr("pkm.server.auth.MAX_TRACKED_SOURCES", 2)
        throttle = LoginThrottle()
        # All three failures land at the same instant, so none of the
        # three sources' backoffs have lapsed by the time the third is
        # recorded -- prune_expired alone would leave all three in the
        # store, exceeding the cap. The store must still stay at 2 by
        # evicting the least-recently-touched source ("a").
        throttle.record_failure("a", mono_ms=0)
        throttle.record_failure("b", mono_ms=0)
        throttle.record_failure("c", mono_ms=0)
        assert len(throttle._attempts) == 2
        assert "a" not in throttle._attempts
        assert "b" in throttle._attempts
        assert "c" in throttle._attempts

    def test_scrypt_slot_fails_fast_instead_of_blocking_when_saturated(self):
        """Real threads, not a single-threaded semaphore probe: a slot
        holder keeps its slot for up to 5s (simulating an in-flight
        scrypt call, or an attacker's connection just sitting there); a
        concurrent acquire attempt with a short timeout must return
        promptly instead of waiting for the holder -- proving the bound
        is a fast-fail, not an unbounded queue that can freeze the
        shared worker-thread pool every other route also runs on."""
        throttle = LoginThrottle(max_concurrent=1, acquire_timeout_s=0.2)
        holder_ready = threading.Event()
        release_holder = threading.Event()

        def holder():
            with throttle.scrypt_slot() as acquired:
                assert acquired
                holder_ready.set()
                release_holder.wait(timeout=5)

        holder_thread = threading.Thread(target=holder)
        holder_thread.start()
        assert holder_ready.wait(timeout=2)

        start = time.monotonic()
        with throttle.scrypt_slot() as acquired:
            elapsed = time.monotonic() - start
            assert acquired is False

        assert elapsed < 1.0  # bounded by our 0.2s timeout, not the 5s hold

        release_holder.set()
        holder_thread.join(timeout=2)
        assert not holder_thread.is_alive()


# The routes that answer without a session: `pkm.server.auth.router` (login
# page and login) and `create_app`'s healthz. Every other route sits behind
# `pkm.server.auth.require_auth`, so a route missing from this set that
# answers an anonymous request is a private route that forgot its guard.
PUBLIC_ROUTES = {
    ("GET", "/login"),
    ("POST", "/api/login"),
    ("GET", "/healthz"),
}


def _fill_path(path: str) -> str:
    return re.sub(r"\{[^}]*\}", "x", path)


def _anonymous_answers(app) -> dict[tuple[str, str], int]:
    anon = TestClient(app, raise_server_exceptions=False)
    answers = {}
    for route in _api_routes(app.routes):
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            r = anon.request(method, _fill_path(route.path))
            answers[(method, route.path)] = r.status_code
    return answers


def _unwalked_routes(routes) -> list[str]:
    """Route entries the walk cannot drive: anything that is not an
    APIRoute, a websocket route or an included router."""
    found = []
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            found.extend(_unwalked_routes(inner.routes))
        elif not isinstance(route, (APIRoute, APIWebSocketRoute)):
            found.append(f"{type(route).__name__} {getattr(route, 'path', '')}")
    return found


def test_the_route_walk_sees_every_kind_of_route_the_app_holds(
        seeded_config):
    assert _unwalked_routes(create_app(seeded_config).routes) == []


def test_the_walk_names_a_mounted_sub_app(seeded_config):
    from starlette.applications import Starlette
    from starlette.routing import Mount

    app = create_app(seeded_config)
    app.router.routes.append(Mount("/api/sub", app=Starlette()))
    assert _unwalked_routes(app.routes) == ["Mount /api/sub"]


def test_every_private_route_refuses_an_anonymous_request(seeded_config):
    answers = _anonymous_answers(create_app(seeded_config))
    assert len(answers) > 40  # the walk found the routes
    assert PUBLIC_ROUTES <= set(answers)
    leaked = {k: v for k, v in answers.items()
              if k not in PUBLIC_ROUTES and v != 401}
    assert leaked == {}


def test_public_routes_do_not_demand_a_session(seeded_config):
    answers = _anonymous_answers(create_app(seeded_config))
    assert {k: answers[k] for k in PUBLIC_ROUTES if answers[k] == 401} == {}


def test_the_route_walk_names_a_private_route_without_the_guard(
        seeded_config):
    app = create_app(seeded_config)

    @app.get("/api/forgot-auth")
    def forgot_auth() -> dict[str, bool]:
        return {"ok": True}

    leaked = [k for k, v in _anonymous_answers(app).items()
              if k not in PUBLIC_ROUTES and v != 401]
    assert leaked == [("GET", "/api/forgot-auth")]


def test_the_websocket_refuses_a_request_without_a_cookie(anon_client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as exc:
        with anon_client.websocket_connect("/api/ws") as ws:
            ws.receive_text()
    assert exc.value.code == 4401
