# pattern: Imperative Shell
"""Login routes and the auth gate every other router depends on."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from pkm.server.auth_core import sign_session, verify_password, verify_session
from pkm.server.config import Config
from pkm.server.db import get_config

COOKIE_NAME = "pkm_session"
COOKIE_MAX_AGE = 365 * 24 * 3600

router = APIRouter()

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
def login(body: LoginBody, response: Response,
          config: Config = Depends(get_config)) -> dict:
    if not verify_password(body.password, bytes.fromhex(config.password_salt),
                           config.password_hash):
        raise HTTPException(status_code=401, detail="wrong password")
    token = sign_session(bytes.fromhex(config.session_secret),
                         int(time.time() * 1000))
    response.set_cookie(COOKIE_NAME, token, max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=config.cookie_secure,
                        samesite="lax", path="/")
    return {"ok": True}
