# pattern: Imperative Shell
"""Login routes and the auth gate every other router depends on."""
from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import AsyncGenerator, Callable, Generator
from dataclasses import dataclass, field

import anyio
import anyio.to_thread
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse

from pkm.contracts.responses import OkAck
from pkm.contracts.text import WellFormedModel
from pkm.server.auth_core import sign_session, verify_password, verify_session
from pkm.server.config import Config
from pkm.server.db import get_config
from pkm.server.throttle_core import (AttemptState, after_failure,
                                      evict_oldest, is_throttled, prune_expired)

COOKIE_NAME = "pkm_session"
COOKIE_MAX_AGE = 365 * 24 * 3600

# Scrypt (n=2**14, r=8) costs real CPU/memory per call and `login()` runs
# it on the worker-thread pool (default capacity far above this), so
# without a bound, concurrent unauthenticated login attempts could run
# dozens of scrypt computations at once. This caps it process-wide.
MAX_CONCURRENT_SCRYPT = 4
# How long a request waits for its source's turn, and then for a scrypt
# slot, before giving up. The slot wait blocks a thread of the shared
# worker pool every sync route uses, so without a timeout enough
# concurrent connections to /api/login (zero scrypt cost -- they sit
# blocked in acquire()) would occupy every worker thread beyond the
# MAX_CONCURRENT_SCRYPT actually computing, freezing the whole app, not
# just login. The per-source turn bounds each source to one such thread
# (its other requests wait on the event loop, holding none); this
# timeout bounds what many sources can hold.
SCRYPT_ACQUIRE_TIMEOUT_S = 2.0
# Hard cap on tracked sources: record_failure prunes lapsed entries first
# and, if that alone didn't free room, evicts the least-recently-touched
# source -- so the store never exceeds this size, even if every tracked
# source is still inside its backoff window.
MAX_TRACKED_SOURCES = 10_000

router = APIRouter()


def _monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


@dataclass
class _SourceTurn:
    """The lock that orders one source's password checks, and how many
    requests hold or wait for it, so the last one out can drop it."""
    lock: anyio.Lock = field(default_factory=anyio.Lock)
    users: int = 0


class LoginThrottle:
    """Per-source login-failure backoff, one password check at a time per
    source (`source_turn`), and a process-wide bound on concurrent scrypt
    work (see throttle_core for the backoff policy).

    Lives on `app.state`, so every app -- including each test's -- gets
    its own isolated instance. All state transitions take an explicit
    monotonic clock reading (`mono_ms`) rather than reading a clock
    themselves, matching `auth_core.verify_session`'s style (there with
    an epoch clock) and keeping this unit-testable without real waiting."""

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_SCRYPT,
                 acquire_timeout_s: float = SCRYPT_ACQUIRE_TIMEOUT_S,
                 clock_ms: Callable[[], int] = _monotonic_ms) -> None:
        self._clock_ms = clock_ms
        self._lock = threading.Lock()
        self._attempts: dict[str, AttemptState] = {}
        # Touched only from the event loop, so it needs no thread lock.
        # Separate from `_attempts`, which is pruned and evicted: a turn
        # someone holds must never be dropped. Its size is bounded by the
        # sources with a request in flight.
        self._turns: dict[str, _SourceTurn] = {}
        self.scrypt_slots = threading.Semaphore(max_concurrent)
        self._acquire_timeout_s = acquire_timeout_s

    def now_ms(self) -> int:
        """The monotonic reading the route passes as `mono_ms`."""
        return self._clock_ms()

    @contextlib.asynccontextmanager
    async def source_turn(self, source: str) -> AsyncGenerator[bool, None]:
        """Yields True once this request is the only one from `source`
        inside the block, False if that took longer than the configured
        timeout (the caller then refuses without a check). Waiting
        happens on the event loop and holds no worker thread. The entry
        is dropped when its last holder or waiter leaves, so the map
        holds only sources with a request in flight."""
        turn = self._turns.get(source)
        if turn is None:
            turn = self._turns[source] = _SourceTurn()
        turn.users += 1
        try:
            ours = False
            with anyio.move_on_after(self._acquire_timeout_s):
                await turn.lock.acquire()
                ours = True
            try:
                yield ours
            finally:
                if ours:
                    turn.lock.release()
        finally:
            turn.users -= 1
            if turn.users == 0:
                del self._turns[source]

    @contextlib.contextmanager
    def scrypt_slot(self) -> Generator[bool, None, None]:
        """Yields True if a slot was acquired within the configured
        timeout, False otherwise. Callers MUST treat False as an
        immediate rejection -- never retry or block further -- that's
        what makes the timeout an actual bound on worker-thread
        occupancy rather than just a longer wait."""
        acquired = self.scrypt_slots.acquire(timeout=self._acquire_timeout_s)
        try:
            yield acquired
        finally:
            if acquired:
                self.scrypt_slots.release()

    def is_throttled(self, source: str, mono_ms: int) -> bool:
        with self._lock:
            return is_throttled(self._attempts.get(source, AttemptState()), mono_ms)

    def record_failure(self, source: str, mono_ms: int) -> None:
        with self._lock:
            # Pop first: this both fetches the source's prior state (to
            # keep its failure count growing) and, if present, removes it
            # from its old position so the re-insert below marks it as
            # most-recently-touched -- otherwise it would look like the
            # oldest entry and get evicted first despite being live.
            state = self._attempts.pop(source, AttemptState())
            if len(self._attempts) >= MAX_TRACKED_SOURCES:
                self._attempts = prune_expired(self._attempts, mono_ms)
            if len(self._attempts) >= MAX_TRACKED_SOURCES:
                self._attempts = evict_oldest(self._attempts)
            self._attempts[source] = after_failure(state, mono_ms)

    def record_success(self, source: str) -> None:
        with self._lock:
            self._attempts.pop(source, None)


_LOGIN_HTML = """<!doctype html><title>pkm login</title>
<form onsubmit="event.preventDefault();
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({password:document.getElementById('pw').value})})
  .then(r=>r.ok?location.href='/':alert('wrong password'))">
<input id="pw" type="password" autofocus placeholder="password">
<button>log in</button></form>"""


class LoginBody(WellFormedModel):
    password: str


def require_auth(request: Request, config: Config = Depends(get_config)) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if not token or not verify_session(bytes.fromhex(config.session_secret),
                                       token, now_ms=int(time.time() * 1000)):
        raise HTTPException(status_code=401, detail="not authenticated")


@router.get("/login", response_class=HTMLResponse)
def login_page() -> str:
    return _LOGIN_HTML


def _wrong_password() -> HTTPException:
    """The one refusal for a wrong password, a throttled source, a turn
    or slot that timed out: the caller cannot tell them apart."""
    return HTTPException(status_code=401, detail="wrong password")


def _check_password(throttle: LoginThrottle, password: str,
                    config: Config) -> bool | None:
    """Runs on a worker thread. None when every scrypt slot stayed busy
    past the timeout -- no check ran, so nothing is recorded."""
    with throttle.scrypt_slot() as acquired:
        if not acquired:
            return None
        return verify_password(password, bytes.fromhex(config.password_salt),
                               config.password_hash)


@router.post("/api/login", response_model=OkAck)
async def login(body: LoginBody, request: Request, response: Response,
                config: Config = Depends(get_config)) -> OkAck:
    throttle: LoginThrottle = request.app.state.login_throttle
    # The source is the client's tailnet address on both listeners: the TCP
    # peer on the Tailscale-IP one, and the X-Forwarded-For that Tailscale
    # Serve sets on loopback. That holds only while run.py's
    # FORWARDED_ALLOW_IPS trusts the header from 127.0.0.1 alone.
    source = request.client.host if request.client else "unknown"
    # Throttled sources are rejected with the *same* 401 a wrong password
    # gets, before any scrypt work runs -- an attacker can't distinguish
    # "throttled" from "wrong password" except by the timing difference
    # (fast reject vs. a real scrypt computation), which this design accepts.
    if throttle.is_throttled(source, throttle.now_ms()):
        raise _wrong_password()
    # One check in flight per source. Checking the backoff and recording
    # the verdict are separate steps, so without the turn every request
    # of a concurrent burst passes the check above and runs scrypt. The
    # rest wait for the turn rather than being refused, so a double-submit
    # of the right password is never told it was wrong; holding the turn
    # until the verdict is recorded, then re-checking, is what makes a
    # failure put every waiter into the backoff without a check of its own.
    async with throttle.source_turn(source) as ours:
        if not ours or throttle.is_throttled(source, throttle.now_ms()):
            raise _wrong_password()
        ok = await anyio.to_thread.run_sync(_check_password, throttle,
                                            body.password, config)
        if ok is None:
            raise _wrong_password()
        if ok:
            throttle.record_success(source)
        else:
            throttle.record_failure(source, throttle.now_ms())
    if not ok:
        raise _wrong_password()
    token = sign_session(bytes.fromhex(config.session_secret),
                         int(time.time() * 1000))
    response.set_cookie(COOKIE_NAME, token, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=config.cookie_secure,
                        samesite="lax", path="/")
    return OkAck(ok=True)
