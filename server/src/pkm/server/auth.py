# pattern: Imperative Shell
"""Login routes and the auth gate every other router depends on."""
from __future__ import annotations

import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from pkm.server.auth_core import sign_session, verify_password, verify_session
from pkm.server.config import Config
from pkm.server.db import get_config
from pkm.server.throttle_core import (AttemptState, after_failure,
                                      is_throttled, prune_expired)

COOKIE_NAME = "pkm_session"
COOKIE_MAX_AGE = 365 * 24 * 3600

# Scrypt (n=2**14, r=8) costs real CPU/memory per call and FastAPI runs
# sync path functions in a worker-thread pool (default capacity far above
# this), so without a bound, concurrent unauthenticated login attempts
# could run dozens of scrypt computations at once. This caps it process-wide.
MAX_CONCURRENT_SCRYPT = 4
# Above this many tracked sources, opportunistically drop ones whose
# backoff has already lapsed -- bounds memory under sustained attempts
# from many distinct sources rather than growing the store forever.
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

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_SCRYPT) -> None:
        self._lock = threading.Lock()
        self._attempts: dict[str, AttemptState] = {}
        self.scrypt_slots = threading.Semaphore(max_concurrent)

    def is_throttled(self, source: str, now_ms: int) -> bool:
        with self._lock:
            return is_throttled(self._attempts.get(source, AttemptState()), now_ms)

    def record_failure(self, source: str, now_ms: int) -> None:
        with self._lock:
            if len(self._attempts) >= MAX_TRACKED_SOURCES:
                self._attempts = prune_expired(self._attempts, now_ms)
            state = self._attempts.get(source, AttemptState())
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
    with throttle.scrypt_slots:
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
