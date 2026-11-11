# pattern: Imperative Shell
"""Login routes, the session check, and `require_auth`, the guard every
other router declares.

`session_is_valid` is the one session check: `AuthGateMiddleware` runs it
before routing (so before a body is read), `require_auth` runs it again as
each route's own guard, and the WebSocket endpoint runs it inline."""
from __future__ import annotations

import asyncio
import time

import anyio
import anyio.to_thread
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from starlette.requests import HTTPConnection

from pkm.contracts.responses import OkAck
from pkm.contracts.text import WellFormedModel
from pkm.server.auth_core import sign_session, verify_password, verify_session
from pkm.server.config import Config
from pkm.server.db import get_config
from pkm.server.throttle import LoginThrottle

COOKIE_NAME = "pkm_session"
COOKIE_MAX_AGE = 365 * 24 * 3600
NOT_AUTHENTICATED_DETAIL = "not authenticated"
# Sent before accept, so uvicorn answers the handshake with HTTP 403.
NOT_AUTHENTICATED_WS_CODE = 4401

router = APIRouter()


_LOGIN_HTML = """<!doctype html><title>pkm login</title>
<form onsubmit="event.preventDefault();
  fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({password:document.getElementById('pw').value})})
  .then(r=>r.ok?location.href='/':alert('wrong password'))">
<input id="pw" type="password" autofocus placeholder="password">
<button>log in</button></form>"""


class LoginBody(WellFormedModel):
    password: str


def session_is_valid(conn: HTTPConnection, config: Config) -> bool:
    token = conn.cookies.get(COOKIE_NAME)
    return token is not None and verify_session(
        bytes.fromhex(config.session_secret), token,
        now_ms=int(time.time() * 1000))


def require_auth(request: Request, config: Config = Depends(get_config)) -> None:
    if not session_is_valid(request, config):
        raise HTTPException(status_code=401, detail=NOT_AUTHENTICATED_DETAIL)


@router.get("/login", response_class=HTMLResponse)
def login_page() -> str:
    return _LOGIN_HTML


def _wrong_password() -> HTTPException:
    """The one refusal for a wrong password, a throttled source, a turn
    or slot that timed out: the caller cannot tell them apart."""
    return HTTPException(status_code=401, detail="wrong password")


def _check_password(throttle: LoginThrottle, source: str, password: str,
                    config: Config) -> bool | None:
    """Runs on a worker thread and records the verdict there, so a
    request cancelled while it runs cannot lose the failure. None when
    every scrypt slot stayed busy past the timeout -- no check ran, so
    nothing is recorded."""
    with throttle.scrypt_slot() as acquired:
        if not acquired:
            return None
        ok = verify_password(password, bytes.fromhex(config.password_salt),
                             config.password_hash)
    if ok:
        throttle.record_success(source)
    else:
        throttle.record_failure(source, throttle.now_ms())
    return ok


@router.post("/api/login", response_model=OkAck)
async def login(body: LoginBody, request: Request, response: Response,
                config: Config = Depends(get_config)) -> OkAck:
    throttle: LoginThrottle = request.app.state.login_throttle
    # The device's tailnet address for every tailnet client, which holds
    # only while run.FORWARDED_ALLOW_IPS trusts loopback alone; see
    # docs/architecture/backend.md#login-throttle for each listener's key.
    source = request.client.host if request.client else "unknown"
    # The wrong-password 401, before any scrypt work runs.
    if throttle.is_throttled(source, throttle.now_ms()):
        raise _wrong_password()
    # One check in flight per source, or a concurrent burst all passes the
    # check above before the first failure is recorded. The turn's holder
    # re-checks the backoff; docs/architecture/backend.md#login-throttle.
    if not await throttle.take_turn(source):
        raise _wrong_password()
    if throttle.is_throttled(source, throttle.now_ms()):
        throttle.end_turn(source)
        raise _wrong_password()
    check = asyncio.ensure_future(anyio.to_thread.run_sync(
        _check_password, throttle, source, body.password, config))
    throttle.hand_turn_to(source, check)
    # A cancellation of this request stops only the wait, not the check.
    ok = await asyncio.shield(check)
    if not ok:
        raise _wrong_password()
    token = sign_session(bytes.fromhex(config.session_secret),
                         int(time.time() * 1000))
    response.set_cookie(COOKIE_NAME, token, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=config.cookie_secure,
                        samesite="lax", path="/")
    return OkAck(ok=True)
