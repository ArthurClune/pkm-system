# pattern: Imperative Shell
"""Login routes and the auth gate every other router depends on."""
from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Generator

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from pkm.server.auth_core import sign_session, verify_password, verify_session
from pkm.server.config import Config
from pkm.server.db import get_config
from pkm.server.throttle_core import (AttemptState, after_failure,
                                      evict_oldest, is_throttled, prune_expired)

COOKIE_NAME = "pkm_session"
COOKIE_MAX_AGE = 365 * 24 * 3600

# Scrypt (n=2**14, r=8) costs real CPU/memory per call and FastAPI runs
# sync path functions in a worker-thread pool (default capacity far above
# this), so without a bound, concurrent unauthenticated login attempts
# could run dozens of scrypt computations at once. This caps it process-wide.
MAX_CONCURRENT_SCRYPT = 4
# How long a request will wait for a scrypt slot before giving up. This
# bound is load-bearing, not cosmetic: `login()` is a sync `def`, so
# FastAPI runs it in the shared worker-thread pool every other sync route
# also uses. Without a timeout, an attacker just needs to open enough
# concurrent connections to /api/login (zero scrypt cost -- they sit
# blocked in acquire()) to occupy every worker thread beyond the
# MAX_CONCURRENT_SCRYPT actually computing, freezing the whole app, not
# just login. Per-source backoff cannot prevent this on its own: it only
# engages after a failure is recorded, which requires having gotten a
# slot and finished a password check first.
SCRYPT_ACQUIRE_TIMEOUT_S = 2.0
# Hard cap on tracked sources: record_failure prunes lapsed entries first
# and, if that alone didn't free room, evicts the least-recently-touched
# source -- so the store never exceeds this size, even if every tracked
# source is still inside its backoff window.
MAX_TRACKED_SOURCES = 10_000

router = APIRouter()


class LoginThrottle:
    """Per-source login-failure backoff plus a process-wide bound on
    concurrent scrypt work (see throttle_core for the backoff policy).

    Lives on `app.state`, so every app -- including each test's -- gets
    its own isolated instance. All state transitions take an explicit
    `now_ms` rather than reading a clock themselves, matching
    `auth_core.verify_session`'s style and keeping this unit-testable
    without real waiting."""

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_SCRYPT,
                acquire_timeout_s: float = SCRYPT_ACQUIRE_TIMEOUT_S) -> None:
        self._lock = threading.Lock()
        self._attempts: dict[str, AttemptState] = {}
        self.scrypt_slots = threading.Semaphore(max_concurrent)
        self._acquire_timeout_s = acquire_timeout_s

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

    def is_throttled(self, source: str, now_ms: int) -> bool:
        with self._lock:
            return is_throttled(self._attempts.get(source, AttemptState()), now_ms)

    def record_failure(self, source: str, now_ms: int) -> None:
        with self._lock:
            # Pop first: this both fetches the source's prior state (to
            # keep its failure count growing) and, if present, removes it
            # from its old position so the re-insert below marks it as
            # most-recently-touched -- otherwise it would look like the
            # oldest entry and get evicted first despite being live.
            state = self._attempts.pop(source, AttemptState())
            if len(self._attempts) >= MAX_TRACKED_SOURCES:
                self._attempts = prune_expired(self._attempts, now_ms)
            if len(self._attempts) >= MAX_TRACKED_SOURCES:
                self._attempts = evict_oldest(self._attempts)
            self._attempts[source] = after_failure(state, now_ms)

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


class LoginBody(BaseModel):
    password: str


def require_auth(request: Request, config: Config = Depends(get_config)) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if not token or not verify_session(bytes.fromhex(config.session_secret),
                                       token, now_ms=int(time.time() * 1000)):
        raise HTTPException(status_code=401, detail="not authenticated")


@router.get("/login", response_class=HTMLResponse)
def login_page() -> str:
    return _LOGIN_HTML


@router.post("/api/login")
def login(body: LoginBody, request: Request, response: Response,
          config: Config = Depends(get_config)) -> dict:
    throttle: LoginThrottle = request.app.state.login_throttle
    source = request.client.host if request.client else "unknown"
    now_ms = int(time.monotonic() * 1000)
    # Throttled sources are rejected with the *same* 401 a wrong password
    # gets, before any scrypt work runs -- an attacker can't distinguish
    # "throttled" from "wrong password" except by the timing difference
    # (fast reject vs. a real scrypt computation), which this design accepts.
    if throttle.is_throttled(source, now_ms):
        raise HTTPException(status_code=401, detail="wrong password")
    with throttle.scrypt_slot() as acquired:
        # Every slot busy past the timeout also gets the uniform 401 --
        # a fast rejection, never an unbounded wait (see
        # SCRYPT_ACQUIRE_TIMEOUT_S above for why that bound matters).
        if not acquired:
            raise HTTPException(status_code=401, detail="wrong password")
        ok = verify_password(body.password, bytes.fromhex(config.password_salt),
                             config.password_hash)
    if not ok:
        throttle.record_failure(source, int(time.monotonic() * 1000))
        raise HTTPException(status_code=401, detail="wrong password")
    throttle.record_success(source)
    token = sign_session(bytes.fromhex(config.session_secret),
                         int(time.time() * 1000))
    response.set_cookie(COOKIE_NAME, token, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=config.cookie_secure,
                        samesite="lax", path="/")
    return {"ok": True}
