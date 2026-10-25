import asyncio
import sys
import threading
import time
from dataclasses import replace

import httpx
from conftest import TEST_PASSWORD
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
from test_routes_models import _api_routes, fill_path

from pkm.server.app import create_app

import pkm.server.auth as auth_module
from pkm.server.auth import MAX_CONCURRENT_SCRYPT, LoginThrottle
from pkm.server.auth_core import (hash_password, sign_session,
                                  verify_password, verify_session)
from pkm.server.throttle_core import BASE_BACKOFF_MS

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


ATTACKER = "100.64.0.10"
USER = "100.64.0.20"
WRONG = {"detail": "wrong password"}
BURST = 200


def _count_checks(monkeypatch) -> list[str]:
    """Each password the route checks, in order. The pause keeps a check in
    flight long enough for a concurrent burst to pile up behind it."""
    checks: list[str] = []
    real = auth_module.verify_password

    def counting(password: str, salt: bytes, stored: str) -> bool:
        checks.append(password)
        time.sleep(0.05)
        return real(password, salt, stored)

    monkeypatch.setattr(auth_module, "verify_password", counting)
    return checks


def _frozen_throttle(app, **kwargs) -> tuple[LoginThrottle, list[int]]:
    """A throttle whose clock moves only when the test moves `frozen[0]`,
    so "one check per backoff window" is exact, not a timing race."""
    frozen = [0]
    throttle = LoginThrottle(clock_ms=lambda: frozen[0], **kwargs)
    app.state.login_throttle = throttle
    return throttle, frozen


async def _logins(app, peer: str,
                  passwords: list[str]) -> list[httpx.Response]:
    """All `passwords` posted at once from one client address."""
    transport = httpx.ASGITransport(app=app, client=(peer, 50000))
    async with httpx.AsyncClient(transport=transport, timeout=60,
                                 base_url="http://testserver") as c:
        return list(await asyncio.gather(
            *[c.post("/api/login", json={"password": p}) for p in passwords]))


def test_a_concurrent_burst_runs_one_check_per_backoff_window(
        anon_client, monkeypatch):
    checks = _count_checks(monkeypatch)
    throttle, frozen = _frozen_throttle(anon_client.app)
    guesses = [f"guess-{i}" for i in range(BURST)]

    first = asyncio.run(_logins(anon_client.app, ATTACKER, guesses))
    assert len(checks) == 1
    assert {r.status_code for r in first} == {401}
    assert all(r.json() == WRONG for r in first)
    assert throttle._attempts[ATTACKER].failures == 1

    frozen[0] += BASE_BACKOFF_MS
    asyncio.run(_logins(anon_client.app, ATTACKER, guesses))
    assert len(checks) == 2
    assert throttle._attempts[ATTACKER].failures == 2
    assert throttle._turns == {}


def test_a_burst_from_one_source_does_not_lock_out_another(
        anon_client, monkeypatch):
    _count_checks(monkeypatch)
    _frozen_throttle(anon_client.app)

    async def both() -> list[httpx.Response]:
        burst, user = await asyncio.gather(
            _logins(anon_client.app, ATTACKER, ["guess"] * BURST),
            _logins(anon_client.app, USER, [TEST_PASSWORD]))
        return user

    [r] = asyncio.run(both())
    assert r.status_code == 200
    assert "pkm_session" in r.cookies


def test_two_concurrent_correct_logins_from_one_source_both_succeed(
        anon_client, monkeypatch):
    # A double-submit by the real user: the second waits for the first's
    # check, finds the source not in backoff, and gets its own check --
    # never a "wrong password" for the right one.
    checks = _count_checks(monkeypatch)
    throttle, _ = _frozen_throttle(anon_client.app)

    rs = asyncio.run(_logins(anon_client.app, USER,
                             [TEST_PASSWORD, TEST_PASSWORD]))
    assert [r.status_code for r in rs] == [200, 200]
    assert all("pkm_session" in r.cookies for r in rs)
    assert len(checks) == 2
    assert throttle._turns == {}


def test_a_wait_for_the_source_that_times_out_gets_the_throttle_refusal(
        anon_client, monkeypatch):
    checks = _count_checks(monkeypatch)
    throttle, _ = _frozen_throttle(anon_client.app, acquire_timeout_s=0.1)

    async def behind_a_stuck_check() -> httpx.Response:
        async with throttle.source_turn(USER) as ours:
            assert ours
            [r] = await _logins(anon_client.app, USER, [TEST_PASSWORD])
            return r

    r = asyncio.run(behind_a_stuck_check())
    assert (r.status_code, r.json()) == (401, WRONG)
    assert checks == []
    assert USER not in throttle._attempts
    assert throttle._turns == {}


def test_slot_timeout_releases_the_turn_and_records_nothing(anon_client):
    throttle = LoginThrottle(acquire_timeout_s=0.1)
    anon_client.app.state.login_throttle = throttle
    held = [throttle.scrypt_slots.acquire(blocking=False)
            for _ in range(MAX_CONCURRENT_SCRYPT)]
    assert all(held)

    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert (r.status_code, r.json()) == (401, WRONG)
    assert throttle._attempts == {}
    assert throttle._turns == {}

    for _ in held:
        throttle.scrypt_slots.release()
    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200


def test_an_exception_during_the_check_releases_the_turn(anon_client,
                                                         monkeypatch):
    real = auth_module.verify_password
    calls: list[str] = []

    def fails_once(password: str, salt: bytes, stored: str) -> bool:
        calls.append(password)
        if len(calls) == 1:
            raise RuntimeError("check blew up")
        return real(password, salt, stored)

    monkeypatch.setattr(auth_module, "verify_password", fails_once)
    throttle = anon_client.app.state.login_throttle
    anon = TestClient(anon_client.app, raise_server_exceptions=False)

    assert anon.post("/api/login",
                     json={"password": TEST_PASSWORD}).status_code == 500
    assert throttle._attempts == {}
    assert throttle._turns == {}
    assert anon.post("/api/login",
                     json={"password": TEST_PASSWORD}).status_code == 200


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

    def test_a_source_takes_one_turn_at_a_time(self):
        throttle = LoginThrottle(acquire_timeout_s=0.05)
        waited: list[bool] = []

        async def wait_for_a() -> None:
            async with throttle.source_turn("a") as ours:
                waited.append(ours)

        async def scenario() -> None:
            async with throttle.source_turn("a") as ours:
                assert ours
                async with throttle.source_turn("b") as other:
                    assert other  # another source is never held up
                await asyncio.create_task(wait_for_a())  # times out
                assert "a" in throttle._turns  # still ours
            await asyncio.create_task(wait_for_a())

        asyncio.run(scenario())
        assert waited == [False, True]
        assert throttle._turns == {}

    def test_a_waiter_gets_the_turn_when_the_holder_ends(self):
        throttle = LoginThrottle(acquire_timeout_s=5)
        order: list[str] = []

        async def take(name: str, hold_s: float) -> None:
            async with throttle.source_turn("a") as ours:
                assert ours
                order.append(f"{name} in")
                await asyncio.sleep(hold_s)
                order.append(f"{name} out")

        async def scenario() -> None:
            await asyncio.gather(take("first", 0.05), take("second", 0))

        asyncio.run(scenario())
        assert order == ["first in", "first out", "second in", "second out"]
        assert throttle._turns == {}

    def test_the_turn_is_released_when_the_body_raises(self):
        throttle = LoginThrottle(acquire_timeout_s=0.05)

        async def scenario() -> bool:
            try:
                async with throttle.source_turn("a"):
                    raise RuntimeError("boom")
            except RuntimeError:
                pass
            async with throttle.source_turn("a") as ours:
                return ours

        assert asyncio.run(scenario())
        assert throttle._turns == {}

    def test_now_ms_reads_the_injected_clock(self):
        assert LoginThrottle(clock_ms=lambda: 1_234).now_ms() == 1_234

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
# page and login), `create_app`'s healthz and the SPA catch-all, which serves
# the same shell to everyone. Every other route sits behind
# `pkm.server.auth.require_auth` (a websocket checks the cookie inline), so a
# route missing from this set that answers an anonymous request is a private
# route that forgot its guard.
PUBLIC_ROUTES = {
    ("GET", "/login"),
    ("POST", "/api/login"),
    ("GET", "/healthz"),
    ("GET", "/{full_path:wholepath}"),
}

WEBSOCKET = "WEBSOCKET"


def _walk_app(config, tmp_path):
    """The app as production builds it: with a built SPA, so the catch-all
    and the `/app-assets` mount are in the route table."""
    dist = tmp_path / "dist"
    (dist / "app-assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    return create_app(replace(config, web_dist=dist))


def _ws_routes(routes) -> list[APIWebSocketRoute]:
    found = []
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            found.extend(_ws_routes(inner.routes))
        elif isinstance(route, APIWebSocketRoute):
            found.append(route)
    return found


WEBSOCKET_CONNECT_SECONDS = 5


def _websocket_answer(anon: TestClient, path: str) -> int | str:
    """The close code an anonymous websocket gets, "accepted", or "hung".
    Leaving the context closes an accepted socket. A handler that neither
    accepts nor closes would block the connect forever, so it runs on a
    daemon thread and a miss of the deadline is an answer, not a stall."""
    out: list[int | str] = []

    def connect() -> None:
        try:
            with anon.websocket_connect(path):
                out.append("accepted")
        except WebSocketDisconnect as exc:
            out.append(exc.code)
        except Exception as exc:
            out.append(type(exc).__name__)

    thread = threading.Thread(target=connect, daemon=True)
    thread.start()
    thread.join(WEBSOCKET_CONNECT_SECONDS)
    return out[0] if out else "hung"


def _anonymous_answers(app) -> dict[tuple[str, str], int | str]:
    anon = TestClient(app, raise_server_exceptions=False)
    answers: dict[tuple[str, str], int | str] = {}
    for route in _api_routes(app.routes):
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            r = anon.request(method, fill_path(route.path))
            answers[(method, route.path)] = r.status_code
    for ws_route in _ws_routes(app.routes):
        answers[(WEBSOCKET, ws_route.path)] = _websocket_answer(
            anon, fill_path(ws_route.path))
    return answers


def _leaked(answers) -> list[tuple[str, str]]:
    """Non-public routes that did not refuse: 401, or close code 4401."""
    return [k for k, v in answers.items()
            if k not in PUBLIC_ROUTES
            and v != (4401 if k[0] == WEBSOCKET else 401)]


def _unwalked_routes(routes) -> list[str]:
    """Route entries the walk cannot drive: anything that is not an
    APIRoute, a websocket route or an included router. The `/app-assets`
    static mount is the one exception: it serves only the hashed bundle
    files, which carry no data."""
    found = []
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            found.extend(_unwalked_routes(inner.routes))
        elif isinstance(route, (APIRoute, APIWebSocketRoute)):
            continue
        elif (getattr(route, "name", None) == "app-assets"
                and isinstance(getattr(route, "app", None), StaticFiles)):
            continue
        else:
            found.append(f"{type(route).__name__} {getattr(route, 'path', '')}")
    return found


def test_the_route_walk_sees_every_kind_of_route_the_app_holds(
        seeded_config, tmp_path):
    app = _walk_app(seeded_config, tmp_path)
    assert _unwalked_routes(app.routes) == []
    assert (WEBSOCKET, "/api/ws") in _anonymous_answers(app)


def test_the_walk_names_a_mounted_sub_app(seeded_config, tmp_path):
    from starlette.applications import Starlette
    from starlette.routing import Mount

    app = _walk_app(seeded_config, tmp_path)
    app.router.routes.append(Mount("/api/sub", app=Starlette()))
    assert _unwalked_routes(app.routes) == ["Mount /api/sub"]


def test_every_private_route_refuses_an_anonymous_request(
        seeded_config, tmp_path):
    answers = _anonymous_answers(_walk_app(seeded_config, tmp_path))
    assert len(answers) > 40  # the walk found the routes
    assert PUBLIC_ROUTES <= set(answers)
    assert (WEBSOCKET, "/api/ws") in answers
    assert _leaked(answers) == []


def test_public_routes_do_not_demand_a_session(seeded_config, tmp_path):
    answers = _anonymous_answers(_walk_app(seeded_config, tmp_path))
    assert {k: answers[k] for k in PUBLIC_ROUTES if answers[k] == 401} == {}


def test_the_route_walk_names_a_private_route_without_the_guard(
        seeded_config, tmp_path):
    app = _walk_app(seeded_config, tmp_path)

    @app.get("/api/forgot-auth")
    def forgot_auth() -> dict[str, bool]:
        return {"ok": True}

    assert _leaked(_anonymous_answers(app)) == [("GET", "/api/forgot-auth")]


def test_the_route_walk_names_a_websocket_without_the_guard(
        seeded_config, tmp_path):
    app = _walk_app(seeded_config, tmp_path)

    @app.websocket("/api/ws-forgot")
    async def forgot_auth(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_text("secret")
        await websocket.receive_text()

    answers = _anonymous_answers(app)
    assert answers[(WEBSOCKET, "/api/ws-forgot")] == "accepted"
    assert _leaked(answers) == [(WEBSOCKET, "/api/ws-forgot")]


def test_the_route_walk_names_a_websocket_that_never_answers(
        seeded_config, tmp_path, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "WEBSOCKET_CONNECT_SECONDS", 1)
    app = _walk_app(seeded_config, tmp_path)

    @app.websocket("/api/ws-silent")
    async def silent(websocket: WebSocket) -> None:
        return None

    answers = _anonymous_answers(app)
    assert answers[(WEBSOCKET, "/api/ws-silent")] == "hung"
    assert (WEBSOCKET, "/api/ws-silent") in _leaked(answers)
