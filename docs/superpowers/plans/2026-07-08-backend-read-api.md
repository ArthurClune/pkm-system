# Backend Read API + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FastAPI server over the imported SQLite database: login + session auth, page trees with backlinks and block-ref resolution, unlinked references, full-text search, Roam-query evaluation, daily-notes journal, and asset serving — everything needed to *read* the graph.

**Architecture:** Thin imperative-shell routes over pure functional-core modules (tree assembly, backlink grouping, query parsing/planning, FTS escaping, daily-title mapping, session signing). Per-request SQLite connections with `PRAGMA foreign_keys=ON` + WAL. Single static password → signed long-lived session cookie gating every route except `/healthz` and login. Spec: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` Section 3. **This is plan 2 of 6** (import ✅ → read API → write path/sync → frontend read → frontend edit → deployment).

**Tech Stack:** Python ≥3.12, FastAPI, uvicorn, sqlite3 (stdlib), stdlib crypto (`hashlib.scrypt`, `hmac`). Dev: pytest, httpx (TestClient).

## Global Constraints

- Python ≥ 3.12 via `uv`; all commands from `server/` via `uv run …`.
- Every runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top.
- All API routes and asset serving require the session cookie; only `/healthz`, `GET /login`, `POST /api/login` are open. Password comparison and token verification are constant-time (`hmac.compare_digest`).
- Cookie: name `pkm_session`, `HttpOnly`, `SameSite=Lax`, `max_age` 1 year, `Secure` controlled by config (`cookie_secure`, default true; tests/dev set false).
- Every DB connection sets `PRAGMA foreign_keys=ON` (cascades are inert without it) and WAL.
- Server binds `127.0.0.1` only (Tailscale Serve terminates HTTPS in front).
- Page titles may contain `/` (namespace pages) — page routes use `{title:path}`.
- Daily titles use Roam's ordinal format (`July 8th, 2026`).
- The UI never renders unbounded lists → backlinks, unlinked refs, and query results are paginated server-side.
- `((block-ref))` rendering is v1 scope (1,344 in the real graph): the page endpoint returns a `block_ref_texts` resolution map.
- Never commit `data/` or `sample-data/` (gitignored). `data/config.json` holds the password hash + session secret — it must never enter git.
- Commit after each green test cycle; push after committing. End commit messages with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QBTordkbweEi22RdkLTQrR
```

## File Structure

```
server/src/pkm/server/
  __init__.py
  config.py        # IS: Config dataclass + load_config(path)
  db.py            # IS: open_db (pragmas), FastAPI dependencies
  app.py           # IS: create_app(config), healthz, router wiring
  run.py           # IS: CLI entry — load config, uvicorn.run on 127.0.0.1
  setup.py         # IS: CLI — write data/config.json (scrypt hash, secret)
  auth_core.py     # FC: hash/verify password, sign/verify session token
  auth.py          # IS: /login page, /api/login, require_auth dependency
  daily.py         # FC: date ↔ "July 8th, 2026"
  tree.py          # FC: flat block rows → nested dicts; block-ref uid collection
  backlinks.py     # FC: group backlink rows by page, assemble breadcrumbs
  fts.py           # FC: escape user text into an FTS5 MATCH expression
  query.py         # FC: parse Roam query expr → QueryNode → SQL plan
  routes_pages.py  # IS: GET /api/page/{title}, GET /api/unlinked, GET /api/journal
  routes_search.py # IS: GET /api/search, GET /api/query
  routes_assets.py # IS: GET /assets/{sha256}/{filename}
server/tests/
  conftest.py      # seeded db + logged-in TestClient fixtures
  test_server_scaffold.py  test_auth.py  test_daily.py  test_tree.py
  test_page_endpoint.py  test_backlinks.py  test_unlinked.py
  test_search_endpoint.py  test_query.py  test_journal_assets.py
```

---

### Task 1: Server scaffolding (deps, config, db helper, app factory, run entry)

**Files:**
- Modify: `server/pyproject.toml` (add deps)
- Create: `server/src/pkm/server/__init__.py` (empty), `server/src/pkm/server/config.py`, `server/src/pkm/server/db.py`, `server/src/pkm/server/app.py`, `server/src/pkm/server/run.py`
- Test: `server/tests/test_server_scaffold.py`

**Interfaces:**
- Produces:
  - `Config(db_path: Path, assets_dir: Path, password_salt: str, password_hash: str, session_secret: str, cookie_secure: bool)` (frozen dataclass; salt/hash/secret are hex strings)
  - `load_config(path: Path) -> Config` — reads JSON; `db_file`/`assets_dir` keys resolve relative to the config file's directory
  - `open_db(path: Path) -> sqlite3.Connection` — Row factory, `foreign_keys=ON`, WAL, `check_same_thread=False`
  - `create_app(config: Config) -> FastAPI` — has `GET /healthz` (no auth), stores config on `app.state.config`
  - FastAPI dependencies in `db.py`: `get_config(request) -> Config`, `get_db(...)` (per-request connection, closed after)
  - `python -m pkm.server.run --data-dir DIR [--port 8974]` starts uvicorn on `127.0.0.1`

- [ ] **Step 1: Add dependencies**

In `server/pyproject.toml` set:
```toml
dependencies = ["fastapi>=0.115", "uvicorn>=0.30"]

[dependency-groups]
dev = ["pytest>=8", "httpx>=0.27"]
```
Run: `cd server && uv sync`

- [ ] **Step 2: Write the failing test**

`server/tests/test_server_scaffold.py`:
```python
import json
import sqlite3

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.config import Config, load_config
from pkm.server.db import open_db


def _config(tmp_path, **over):
    defaults = dict(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    defaults.update(over)
    return Config(**defaults)


def test_healthz_needs_no_auth(tmp_path):
    client = TestClient(create_app(_config(tmp_path)))
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_load_config_resolves_paths_relative_to_file(tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "00" * 16, "password_hash": "ab" * 32,
        "session_secret": "cd" * 32, "cookie_secure": False,
    }))
    cfg = load_config(cfg_file)
    assert cfg.db_path == tmp_path / "pkm.sqlite3"
    assert cfg.assets_dir == tmp_path / "assets"
    assert cfg.cookie_secure is False


def test_open_db_sets_pragmas(tmp_path):
    con = open_db(tmp_path / "t.sqlite3")
    assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.execute("CREATE TABLE t(a)")
    con.execute("INSERT INTO t VALUES (1)")
    assert con.execute("SELECT a FROM t").fetchone()["a"] == 1  # Row factory
    con.close()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_server_scaffold.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server'`

- [ ] **Step 4: Implement**

`server/src/pkm/server/config.py`:
```python
# pattern: Imperative Shell
"""Server configuration loaded from data/config.json (never in git)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    db_path: Path
    assets_dir: Path
    password_salt: str   # hex
    password_hash: str   # hex (scrypt)
    session_secret: str  # hex
    cookie_secure: bool = True


def load_config(path: Path) -> Config:
    raw = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    return Config(
        db_path=base / raw["db_file"],
        assets_dir=base / raw["assets_dir"],
        password_salt=raw["password_salt"],
        password_hash=raw["password_hash"],
        session_secret=raw["session_secret"],
        cookie_secure=raw.get("cookie_secure", True),
    )
```

`server/src/pkm/server/db.py`:
```python
# pattern: Imperative Shell
"""SQLite connection helper and FastAPI dependencies."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import Request

from pkm.server.config import Config


def open_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_db(request: Request):
    con = open_db(request.app.state.config.db_path)
    try:
        yield con
    finally:
        con.close()
```

`server/src/pkm/server/app.py`:
```python
# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI

from pkm.server.config import Config


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="pkm", openapi_url="/api/openapi.json")
    app.state.config = config

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
```

`server/src/pkm/server/run.py`:
```python
# pattern: Imperative Shell
"""Run the PKM server: python -m pkm.server.run --data-dir ../data"""
from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from pkm.server.app import create_app
from pkm.server.config import load_config


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PKM server.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--port", type=int, default=8974)
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_server_scaffold.py -v`
Expected: 3 tests PASS. Then full suite: `uv run pytest -q` → all pass.

- [ ] **Step 6: Commit and push**

```bash
git add server/ && git commit -m "feat: server scaffolding with config, db helper, app factory" && git push
```

---

### Task 2: Auth (password hash, session cookie, login, gate) + shared test fixtures

**Files:**
- Create: `server/src/pkm/server/auth_core.py`, `server/src/pkm/server/auth.py`, `server/src/pkm/server/setup.py`, `server/tests/conftest.py`
- Test: `server/tests/test_auth.py`

**Interfaces:**
- Consumes: `Config`, `create_app`, `get_config` (Task 1); `pkm.schema.DDL`.
- Produces:
  - `auth_core.hash_password(password: str, salt: bytes) -> str` (scrypt hex, n=2**14, r=8, p=1)
  - `auth_core.verify_password(password: str, salt: bytes, expected_hex: str) -> bool` (constant-time)
  - `auth_core.sign_session(secret: bytes, issued_at_ms: int) -> str` (format `v1.<ms>.<hmac-sha256-hex>`)
  - `auth_core.verify_session(secret: bytes, token: str) -> bool` (constant-time)
  - `auth.require_auth` — FastAPI dependency raising 401 without a valid `pkm_session` cookie. **Every later router is declared with `dependencies=[Depends(require_auth)]`.**
  - `auth.router` — `GET /login` (HTML form), `POST /api/login` (JSON `{"password": …}` → sets cookie)
  - `python -m pkm.server.setup --data-dir DIR --password PW [--insecure-cookie]` writes `config.json` (mode 0600)
  - conftest fixtures used by ALL later tasks: `seeded_db_path` (tmp SQLite with schema + seed data below) and `client` (TestClient with app over that db, already logged in)
  - Seed data (exact — later tasks' tests depend on it):
    - pages: 1 "Machine Learning" (created 1000, updated 2000), 2 "AI", 3 "July 7th, 2026", 4 "Paper", 5 "Attention Is All You Need"
    - blocks `(uid, page_id, parent_uid, order_idx, text, heading, collapsed)`:
      `b1`=(1,NULL,0,"Tags:: #AI",NULL,0), `b2`=(1,NULL,1,"Papers",2,0), `b3`=(1,b2,0,"[[Attention Is All You Need]] is a [[Paper]]",NULL,0), `b4`=(3,NULL,0,"Studying [[Machine Learning]] today",NULL,0), `b5`=(3,NULL,1,"See ((b3)) for details",NULL,0), `b6`=(2,NULL,0,"AI overview mentions Machine Learning in plain text",NULL,0)
    - refs: (b1,2,tag), (b3,5,link), (b3,4,link), (b4,1,link)
    - test password: `test-pw`

- [ ] **Step 1: Write the failing tests**

`server/tests/conftest.py`:
```python
import pytest
from fastapi.testclient import TestClient

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import open_db

TEST_PASSWORD = "test-pw"
TEST_SALT = bytes.fromhex("00" * 16)

SEED_PAGES = [
    (1, "Machine Learning", 1000, 2000),
    (2, "AI", None, None),
    (3, "July 7th, 2026", None, None),
    (4, "Paper", None, None),
    (5, "Attention Is All You Need", None, None),
]
SEED_BLOCKS = [
    ("b1", 1, None, 0, "Tags:: #AI", None, 0, None, None),
    ("b2", 1, None, 1, "Papers", 2, 0, None, None),
    ("b3", 1, "b2", 0, "[[Attention Is All You Need]] is a [[Paper]]",
     None, 0, None, None),
    ("b4", 3, None, 0, "Studying [[Machine Learning]] today", None, 0, None, None),
    ("b5", 3, None, 1, "See ((b3)) for details", None, 0, None, None),
    ("b6", 2, None, 0, "AI overview mentions Machine Learning in plain text",
     None, 0, None, None),
]
SEED_REFS = [
    ("b1", 2, "tag"),
    ("b3", 5, "link"),
    ("b3", 4, "link"),
    ("b4", 1, "link"),
]


@pytest.fixture()
def seeded_config(tmp_path) -> Config:
    db_path = tmp_path / "pkm.sqlite3"
    con = open_db(db_path)
    con.executescript(DDL)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", SEED_PAGES)
    con.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)", SEED_BLOCKS)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", SEED_REFS)
    con.commit()
    con.close()
    (tmp_path / "assets").mkdir()
    return Config(
        db_path=db_path,
        assets_dir=tmp_path / "assets",
        password_salt=TEST_SALT.hex(),
        password_hash=hash_password(TEST_PASSWORD, TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
    )


@pytest.fixture()
def anon_client(seeded_config) -> TestClient:
    return TestClient(create_app(seeded_config))


@pytest.fixture()
def client(anon_client) -> TestClient:
    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return anon_client
```

`server/tests/test_auth.py`:
```python
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
    assert token.startswith("v1.1700000000000.")
    assert verify_session(SECRET, token)
    assert not verify_session(SECRET, token[:-1] + ("0" if token[-1] != "0" else "1"))
    assert not verify_session(b"other" * 8, token)
    assert not verify_session(SECRET, "garbage")
    assert not verify_session(SECRET, "v1.123")


def test_login_flow_and_gate(anon_client):
    # unauthenticated API access is rejected
    assert anon_client.get("/api/page/Machine%20Learning").status_code == 401
    # wrong password rejected
    assert anon_client.post("/api/login", json={"password": "nope"}).status_code == 401
    # login page is reachable without auth
    assert anon_client.get("/login").status_code == 200
    # correct password sets the session cookie
    r = anon_client.post("/api/login", json={"password": "test-pw"})
    assert r.status_code == 200
    assert "pkm_session" in anon_client.cookies
```

Note: `test_login_flow_and_gate` asserts a 401 (not 404) for `/api/page/...` before that route exists — FastAPI returns 404 for unknown paths, so for THIS task add a placeholder authed router (see Step 3) that Task 4 will replace with the real page route.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.auth_core'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/auth_core.py`:
```python
# pattern: Functional Core
"""Password hashing and session-token signing. All comparisons constant-time."""
from __future__ import annotations

import hashlib
import hmac


def hash_password(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt,
                          n=2**14, r=8, p=1).hex()


def verify_password(password: str, salt: bytes, expected_hex: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt), expected_hex)


def sign_session(secret: bytes, issued_at_ms: int) -> str:
    payload = f"v1.{issued_at_ms}"
    sig = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_session(secret: bytes, token: str) -> bool:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return False
    payload = f"{parts[0]}.{parts[1]}"
    expected = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts[2])
```

`server/src/pkm/server/auth.py`:
```python
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
    if not token or not verify_session(bytes.fromhex(config.session_secret), token):
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
```

`server/src/pkm/server/setup.py`:
```python
# pattern: Imperative Shell
"""Write data/config.json: python -m pkm.server.setup --data-dir ../data --password PW"""
from __future__ import annotations

import argparse
import getpass
import json
import secrets
from pathlib import Path

from pkm.server.auth_core import hash_password


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Initialise PKM server config.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--password", help="omit to be prompted")
    ap.add_argument("--insecure-cookie", action="store_true",
                    help="allow the session cookie over plain http (dev only)")
    args = ap.parse_args(argv)
    password = args.password or getpass.getpass("password: ")
    salt = secrets.token_bytes(16)
    cfg = {
        "db_file": "pkm.sqlite3",
        "assets_dir": "assets",
        "password_salt": salt.hex(),
        "password_hash": hash_password(password, salt),
        "session_secret": secrets.token_bytes(32).hex(),
        "cookie_secure": not args.insecure_cookie,
    }
    out = Path(args.data_dir) / "config.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    out.chmod(0o600)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Modify `server/src/pkm/server/app.py` — wire the auth router and a placeholder authed API router (replaced by the real page router in Task 4):
```python
# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI

from pkm.server.auth import require_auth, router as auth_router
from pkm.server.config import Config


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="pkm", openapi_url="/api/openapi.json")
    app.state.config = config
    app.include_router(auth_router)

    api = APIRouter(dependencies=[Depends(require_auth)])

    @api.get("/api/page/{title:path}")
    def page_placeholder(title: str) -> dict:  # replaced in Task 4
        return {"title": title}

    app.include_router(api)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_auth.py -v`
Expected: 3 tests PASS. Full suite: `uv run pytest -q` → all pass.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: static-password auth with signed session cookie" && git push
```

---

### Task 3: Daily-title mapping

**Files:**
- Create: `server/src/pkm/server/daily.py`
- Test: `server/tests/test_daily.py`

**Interfaces:**
- Produces (Tasks 4 and 9 consume):
  - `title_for_date(d: datetime.date) -> str` — `"July 8th, 2026"`
  - `date_for_title(title: str) -> datetime.date | None` — None if not a daily title

- [ ] **Step 1: Write the failing test**

`server/tests/test_daily.py`:
```python
from datetime import date

import pytest

from pkm.server.daily import date_for_title, title_for_date

CASES = [
    (date(2026, 7, 1), "July 1st, 2026"),
    (date(2026, 7, 2), "July 2nd, 2026"),
    (date(2026, 7, 3), "July 3rd, 2026"),
    (date(2026, 7, 4), "July 4th, 2026"),
    (date(2026, 7, 11), "July 11th, 2026"),
    (date(2026, 7, 12), "July 12th, 2026"),
    (date(2026, 7, 13), "July 13th, 2026"),
    (date(2026, 7, 21), "July 21st, 2026"),
    (date(2026, 7, 22), "July 22nd, 2026"),
    (date(2026, 7, 23), "July 23rd, 2026"),
    (date(2026, 1, 31), "January 31st, 2026"),
]


@pytest.mark.parametrize("d,title", CASES)
def test_roundtrip(d, title):
    assert title_for_date(d) == title
    assert date_for_title(title) == d


@pytest.mark.parametrize("bad", [
    "Machine Learning", "July 2026", "July 32nd, 2026",
    "Smarch 1st, 2026", "July 1st 2026", "AWS/SCP",
])
def test_non_daily_titles(bad):
    assert date_for_title(bad) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_daily.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.daily'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/daily.py`:
```python
# pattern: Functional Core
"""Roam's ordinal daily-page titles: date <-> 'July 8th, 2026'."""
from __future__ import annotations

import re
from datetime import date

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_TITLE_RE = re.compile(
    rf"^({'|'.join(_MONTHS)}) (\d{{1,2}})(st|nd|rd|th), (\d{{4}})$")


def _suffix(day: int) -> str:
    if 10 <= day % 100 <= 20:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")


def title_for_date(d: date) -> str:
    return f"{_MONTHS[d.month - 1]} {d.day}{_suffix(d.day)}, {d.year}"


def date_for_title(title: str) -> date | None:
    m = _TITLE_RE.match(title)
    if not m:
        return None
    month = _MONTHS.index(m.group(1)) + 1
    try:
        return date(int(m.group(4)), month, int(m.group(2)))
    except ValueError:
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_daily.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: daily-title date mapping" && git push
```

---

### Task 4: Block tree + page endpoint (with daily auto-create and block-ref resolution)

**Files:**
- Create: `server/src/pkm/server/tree.py`, `server/src/pkm/server/routes_pages.py`
- Modify: `server/src/pkm/server/app.py` (replace placeholder router with `routes_pages.router`)
- Test: `server/tests/test_tree.py`, `server/tests/test_page_endpoint.py`

**Interfaces:**
- Consumes: conftest fixtures (Task 2); `daily.date_for_title`, `daily.title_for_date` (Task 3); `pkm.refs.extract` (plan 1).
- Produces:
  - `tree.build_tree(rows) -> list[dict]` — rows are mappings with `uid,parent_uid,order_idx,text,heading,collapsed,created_at,updated_at`; returns nested `{"uid","text","heading","collapsed","children":[…]}` sorted by `order_idx`; orphaned parents (parent not in set) are treated as roots
  - `tree.collect_block_ref_uids(texts: Iterable[str]) -> list[str]` — ordered unique `((uid))` targets
  - `GET /api/page/{title:path}` → `{"page": {"id","title","created_at","updated_at"}, "blocks": [tree…], "block_ref_texts": {uid: {"text","page_title"}}}` (backlinks added by Task 5); 404 for missing non-daily; missing daily titles are auto-created
  - `routes_pages.router` — the authed APIRouter later tasks attach to (Tasks 6 and 9 add routes to this file)

- [ ] **Step 1: Write the failing tests**

`server/tests/test_tree.py`:
```python
from pkm.server.tree import build_tree, collect_block_ref_uids

ROWS = [
    dict(uid="r2", parent_uid=None, order_idx=1, text="second", heading=2,
         collapsed=1, created_at=None, updated_at=None),
    dict(uid="r1", parent_uid=None, order_idx=0, text="first", heading=None,
         collapsed=0, created_at=None, updated_at=None),
    dict(uid="c1", parent_uid="r2", order_idx=0, text="child", heading=None,
         collapsed=0, created_at=None, updated_at=None),
    dict(uid="ghost", parent_uid="missing", order_idx=0, text="orphan",
         heading=None, collapsed=0, created_at=None, updated_at=None),
]


def test_build_tree_nests_and_sorts():
    tree = build_tree(ROWS)
    assert [n["text"] for n in tree] == ["first", "second", "orphan"]
    assert tree[1]["heading"] == 2 and tree[1]["collapsed"] == 1
    assert [c["text"] for c in tree[1]["children"]] == ["child"]


def test_collect_block_ref_uids():
    texts = ["see ((abc123XYZ)) and ((abc123XYZ))", "plain", "((zz99_-foo))"]
    assert collect_block_ref_uids(texts) == ["abc123XYZ", "zz99_-foo"]
```

`server/tests/test_page_endpoint.py`:
```python
from datetime import date

from pkm.server.daily import title_for_date


def test_page_tree_shape(client):
    r = client.get("/api/page/Machine Learning")
    assert r.status_code == 200
    body = r.json()
    assert body["page"]["title"] == "Machine Learning"
    assert body["page"]["created_at"] == 1000
    texts = [b["text"] for b in body["blocks"]]
    assert texts == ["Tags:: #AI", "Papers"]
    papers = body["blocks"][1]
    assert papers["heading"] == 2
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]"]


def test_block_ref_resolution(client):
    r = client.get("/api/page/July 7th, 2026")
    assert r.status_code == 200
    body = r.json()
    assert body["block_ref_texts"] == {
        "b3": {"text": "[[Attention Is All You Need]] is a [[Paper]]",
               "page_title": "Machine Learning"},
    }


def test_missing_page_404(client):
    assert client.get("/api/page/No Such Page").status_code == 404


def test_missing_daily_page_auto_creates(client):
    title = title_for_date(date(2031, 3, 3))
    r = client.get(f"/api/page/{title}")
    assert r.status_code == 200
    assert r.json()["page"]["title"] == title
    assert r.json()["blocks"] == []
    # created persistently, not per-request
    assert client.get(f"/api/page/{title}").status_code == 200


def test_namespace_title_with_slash(client, seeded_config):
    import sqlite3
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id,title) VALUES (99,'AWS/SCP')")
    con.commit(); con.close()
    assert client.get("/api/page/AWS/SCP").status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_tree.py tests/test_page_endpoint.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.tree'`, and page tests fail against the placeholder route.

- [ ] **Step 3: Implement**

`server/src/pkm/server/tree.py`:
```python
# pattern: Functional Core
"""Assemble flat block rows into a nested tree; collect ((block-ref)) uids."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from pkm.refs import extract


def build_tree(rows: Sequence[Mapping]) -> list[dict]:
    known = {r["uid"] for r in rows}
    by_parent: dict[str | None, list[Mapping]] = {}
    for r in rows:
        parent = r["parent_uid"] if r["parent_uid"] in known else None
        by_parent.setdefault(parent, []).append(r)

    def nodes(parent: str | None) -> list[dict]:
        children = sorted(by_parent.get(parent, []), key=lambda r: r["order_idx"])
        return [{
            "uid": r["uid"],
            "text": r["text"],
            "heading": r["heading"],
            "collapsed": bool(r["collapsed"]),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "children": nodes(r["uid"]),
        } for r in children]

    return nodes(None)


def collect_block_ref_uids(texts: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for text in texts:
        for uid in extract(text).block_refs:
            if uid not in seen:
                seen.add(uid)
                out.append(uid)
    return out
```

`server/src/pkm/server/routes_pages.py`:
```python
# pattern: Imperative Shell
"""Page read routes: page tree, block-ref resolution (backlinks: Task 5)."""
from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.daily import date_for_title
from pkm.server.db import get_db
from pkm.server.tree import build_tree, collect_block_ref_uids

router = APIRouter(dependencies=[Depends(require_auth)])

_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
               " created_at, updated_at")


def _fetch_page(db: sqlite3.Connection, title: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
        (title,)).fetchone()


def _block_ref_texts(db: sqlite3.Connection, texts: list[str]) -> dict:
    uids = collect_block_ref_uids(texts)
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    rows = db.execute(
        f"SELECT b.uid, b.text, p.title AS page_title FROM blocks b"
        f" JOIN pages p ON p.id = b.page_id WHERE b.uid IN ({marks})",
        uids).fetchall()
    return {r["uid"]: {"text": r["text"], "page_title": r["page_title"]}
            for r in rows}


@router.get("/api/page/{title:path}")
def get_page(title: str, db: sqlite3.Connection = Depends(get_db)) -> dict:
    page = _fetch_page(db, title)
    if page is None:
        if date_for_title(title) is None:
            raise HTTPException(status_code=404, detail="page not found")
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
            (title, now, now))
        db.commit()
        page = _fetch_page(db, title)
    blocks = db.execute(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["id"],)).fetchall()
    return {
        "page": dict(page),
        "blocks": build_tree(blocks),
        "block_ref_texts": _block_ref_texts(db, [r["text"] for r in blocks]),
    }
```

Modify `server/src/pkm/server/app.py` — drop the placeholder router:
```python
# pattern: Imperative Shell
"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI

from pkm.server.auth import router as auth_router
from pkm.server.config import Config
from pkm.server.routes_pages import router as pages_router


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="pkm", openapi_url="/api/openapi.json")
    app.state.config = config
    app.include_router(auth_router)
    app.include_router(pages_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_tree.py tests/test_page_endpoint.py tests/test_auth.py -v`
Expected: all PASS (auth's gate test still passes against the real route). Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: page endpoint with block tree and block-ref resolution" && git push
```

---

### Task 5: Backlinks with breadcrumbs and pagination

**Files:**
- Create: `server/src/pkm/server/backlinks.py`
- Modify: `server/src/pkm/server/routes_pages.py` (add backlinks to the page response)
- Test: `server/tests/test_backlinks.py`

**Interfaces:**
- Consumes: page endpoint (Task 4), conftest seeds (Task 2).
- Produces:
  - `backlinks.group_backlinks(rows: Sequence[Mapping], ancestors: Mapping[str, list[str]]) -> list[dict]` — rows have `uid,text,src_page_id,src_page_title`; returns `[{"page_id","page_title","items":[{"uid","text","breadcrumbs":[…]}]}]` grouped in input order
  - Page response gains `"backlinks": {"groups": […], "total_pages": int, "offset": int, "limit": int}`; query params `bl_offset` (default 0), `bl_limit` (default 20, max 100) paginate by SOURCE PAGE
  - Backlink texts are included in the `block_ref_texts` resolution input

- [ ] **Step 1: Write the failing test**

`server/tests/test_backlinks.py`:
```python
from pkm.server.backlinks import group_backlinks


def test_group_backlinks_pure():
    rows = [
        dict(uid="x1", text="t1", src_page_id=7, src_page_title="P1"),
        dict(uid="x2", text="t2", src_page_id=7, src_page_title="P1"),
        dict(uid="y1", text="t3", src_page_id=9, src_page_title="P2"),
    ]
    groups = group_backlinks(rows, {"x2": ["root text"]})
    assert [g["page_title"] for g in groups] == ["P1", "P2"]
    assert groups[0]["items"][0] == {"uid": "x1", "text": "t1", "breadcrumbs": []}
    assert groups[0]["items"][1]["breadcrumbs"] == ["root text"]


def test_page_endpoint_includes_backlinks(client):
    body = client.get("/api/page/Machine Learning").json()
    bl = body["backlinks"]
    assert bl["total_pages"] == 1
    [group] = bl["groups"]
    assert group["page_title"] == "July 7th, 2026"
    assert [i["text"] for i in group["items"]] == \
        ["Studying [[Machine Learning]] today"]


def test_backlink_breadcrumbs(client):
    # b3 is nested under b2 ("Papers") — backlinks of "Paper" show the chain
    body = client.get("/api/page/Paper").json()
    [group] = body["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"
    [item] = group["items"]
    assert item["uid"] == "b3"
    assert item["breadcrumbs"] == ["Papers"]


def test_backlink_pagination_params(client):
    body = client.get("/api/page/Machine Learning",
                      params={"bl_limit": 1, "bl_offset": 1}).json()
    assert body["backlinks"]["groups"] == []
    assert body["backlinks"]["total_pages"] == 1
    assert body["backlinks"]["offset"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_backlinks.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.backlinks'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/backlinks.py`:
```python
# pattern: Functional Core
"""Group backlink rows by source page and attach breadcrumb trails."""
from __future__ import annotations

from collections.abc import Mapping, Sequence


def group_backlinks(rows: Sequence[Mapping],
                    ancestors: Mapping[str, list[str]]) -> list[dict]:
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["src_page_id"])
        if group is None:
            group = {"page_id": r["src_page_id"],
                     "page_title": r["src_page_title"], "items": []}
            index[r["src_page_id"]] = group
            groups.append(group)
        group["items"].append({
            "uid": r["uid"],
            "text": r["text"],
            "breadcrumbs": list(ancestors.get(r["uid"], [])),
        })
    return groups
```

In `server/src/pkm/server/routes_pages.py`, add below `_block_ref_texts`:
```python
def _fetch_ancestors(db: sqlite3.Connection, uids: list[str]) -> dict[str, list[str]]:
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    rows = db.execute(
        f"""WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth) AS (
              SELECT uid, uid, parent_uid, text, 0 FROM blocks
               WHERE uid IN ({marks})
              UNION ALL
              SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1
                FROM anc a JOIN blocks b ON b.uid = a.parent_uid
            )
            SELECT start_uid, text, depth FROM anc WHERE depth > 0
             ORDER BY start_uid, depth DESC""", uids).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:  # depth DESC = root first
        out.setdefault(r["start_uid"], []).append(r["text"])
    return out


def _backlinks(db: sqlite3.Connection, page_id: int,
               offset: int, limit: int) -> tuple[list[dict], int, list[str]]:
    total = db.execute(
        """SELECT count(DISTINCT b.page_id) FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
           WHERE r.target_page_id = ?""", (page_id,)).fetchone()[0]
    page_ids = [r[0] for r in db.execute(
        """SELECT DISTINCT b.page_id FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
            JOIN pages p ON p.id = b.page_id
           WHERE r.target_page_id = ?
           ORDER BY p.updated_at DESC NULLS LAST, p.title
           LIMIT ? OFFSET ?""", (page_id, limit, offset)).fetchall()]
    if not page_ids:
        return [], total, []
    marks = ",".join("?" * len(page_ids))
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
              FROM refs r
              JOIN blocks b ON b.uid = r.src_block_uid
              JOIN pages p ON p.id = b.page_id
             WHERE r.target_page_id = ? AND b.page_id IN ({marks})
             ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid""",
        [page_id, *page_ids]).fetchall()
    ancestors = _fetch_ancestors(db, [r["uid"] for r in rows])
    return (group_backlinks(rows, ancestors), total,
            [r["text"] for r in rows])
```
Add the imports (`from pkm.server.backlinks import group_backlinks`) and change `get_page` to:
```python
@router.get("/api/page/{title:path}")
def get_page(title: str, bl_offset: int = 0, bl_limit: int = 20,
             db: sqlite3.Connection = Depends(get_db)) -> dict:
    bl_limit = max(1, min(bl_limit, 100))
    page = _fetch_page(db, title)
    if page is None:
        if date_for_title(title) is None:
            raise HTTPException(status_code=404, detail="page not found")
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
            (title, now, now))
        db.commit()
        page = _fetch_page(db, title)
    blocks = db.execute(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["id"],)).fetchall()
    groups, total, bl_texts = _backlinks(db, page["id"], bl_offset, bl_limit)
    return {
        "page": dict(page),
        "blocks": build_tree(blocks),
        "backlinks": {"groups": groups, "total_pages": total,
                      "offset": bl_offset, "limit": bl_limit},
        "block_ref_texts": _block_ref_texts(
            db, [r["text"] for r in blocks] + bl_texts),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_backlinks.py tests/test_page_endpoint.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: backlinks with breadcrumbs and source-page pagination" && git push
```

---

### Task 6: FTS escaping + unlinked references endpoint

**Files:**
- Create: `server/src/pkm/server/fts.py`
- Modify: `server/src/pkm/server/routes_pages.py` (add `GET /api/unlinked`)
- Test: `server/tests/test_unlinked.py`

**Interfaces:**
- Consumes: conftest seeds; `backlinks.group_backlinks` is NOT reused here (items have no breadcrumbs) — grouping is inline.
- Produces:
  - `fts.escape_fts_query(q: str) -> str` — splits on whitespace, doubles embedded `"`, wraps each term in quotes, appends `*` to the last term (prefix search). Empty/whitespace input → `'""'`.
  - `fts.phrase_query(q: str) -> str` — the whole string as one quoted phrase (no prefix star), for unlinked-reference title matching
  - `GET /api/unlinked?title=…&limit=20&offset=0` → `{"groups": [{"page_id","page_title","items":[{"uid","text"}]}], "total": int}` — blocks whose text contains the title as a phrase, excluding blocks that already ref the page and blocks on the page itself; 404 if the page doesn't exist

- [ ] **Step 1: Write the failing test**

`server/tests/test_unlinked.py`:
```python
from pkm.server.fts import escape_fts_query, phrase_query


def test_escape_fts_query():
    assert escape_fts_query("machine learn") == '"machine" "learn"*'
    assert escape_fts_query('say "hi"') == '"say" "\"\"hi\"\""*'
    assert escape_fts_query("  ") == '""'


def test_phrase_query():
    assert phrase_query("Machine Learning") == '"Machine Learning"'


def test_unlinked_endpoint(client):
    r = client.get("/api/unlinked", params={"title": "Machine Learning"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    [group] = body["groups"]
    assert group["page_title"] == "AI"
    assert [i["uid"] for i in group["items"]] == ["b6"]
    # b4 links [[Machine Learning]] so it is NOT unlinked


def test_unlinked_missing_page_404(client):
    assert client.get("/api/unlinked",
                      params={"title": "No Such Page"}).status_code == 404
```

Note on the escape test's expected string: Python source `'"say" "\"\"hi\"\""*'` renders the FTS text `"say" ""hi""*` wrapped in quotes — embedded quotes doubled per FTS5 rules.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_unlinked.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.fts'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/fts.py`:
```python
# pattern: Functional Core
"""Escape untrusted text into FTS5 MATCH expressions."""
from __future__ import annotations

import re


def _quote(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def escape_fts_query(q: str) -> str:
    terms = [t for t in re.split(r"\s+", q.strip()) if t]
    if not terms:
        return '""'
    quoted = [_quote(t) for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


def phrase_query(q: str) -> str:
    return _quote(q.strip())
```

Add to `server/src/pkm/server/routes_pages.py` (import `phrase_query` from `pkm.server.fts`):
```python
@router.get("/api/unlinked")
def get_unlinked(title: str, limit: int = 20, offset: int = 0,
                 db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    page = _fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    where = """FROM blocks_fts f
               JOIN blocks b ON b.rowid = f.rowid
               JOIN pages p ON p.id = b.page_id
              WHERE blocks_fts MATCH ? AND b.page_id != ?
                AND NOT EXISTS (SELECT 1 FROM refs r
                                 WHERE r.src_block_uid = b.uid
                                   AND r.target_page_id = ?)"""
    params = (phrase_query(title), page["id"], page["id"])
    total = db.execute(f"SELECT count(*) {where}", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
            {where} ORDER BY p.title, b.uid LIMIT ? OFFSET ?""",
        (*params, limit, offset)).fetchall()
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["page_id"])
        if group is None:
            group = {"page_id": r["page_id"], "page_title": r["page_title"],
                     "items": []}
            index[r["page_id"]] = group
            groups.append(group)
        group["items"].append({"uid": r["uid"], "text": r["text"]})
    return {"groups": groups, "total": total}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_unlinked.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: unlinked references endpoint with fts escaping" && git push
```

---

### Task 7: Search endpoint

**Files:**
- Create: `server/src/pkm/server/routes_search.py`
- Modify: `server/src/pkm/server/app.py` (include `routes_search.router`)
- Test: `server/tests/test_search_endpoint.py`

**Interfaces:**
- Consumes: `fts.escape_fts_query` (Task 6), conftest seeds.
- Produces:
  - `routes_search.router` — authed APIRouter (Task 8 adds `/api/query` to this file)
  - `GET /api/search?q=…&limit=20` → `{"pages": [{"id","title"}], "blocks": [{"uid","page_title","snippet"}]}` — pages ranked first-class by `pages_fts`, blocks with `snippet(...)` context marked `<mark>…</mark>`; empty `q` → empty result; FTS syntax errors cannot occur (input is escaped)

- [ ] **Step 1: Write the failing test**

`server/tests/test_search_endpoint.py`:
```python
def test_search_finds_pages_and_blocks(client):
    r = client.get("/api/search", params={"q": "machine"})
    assert r.status_code == 200
    body = r.json()
    assert [p["title"] for p in body["pages"]] == ["Machine Learning"]
    uids = {b["uid"] for b in body["blocks"]}
    assert uids == {"b4", "b6"}
    hit = next(b for b in body["blocks"] if b["uid"] == "b6")
    assert "<mark>Machine</mark>" in hit["snippet"]
    assert hit["page_title"] == "AI"


def test_search_prefix_match(client):
    body = client.get("/api/search", params={"q": "attent"}).json()
    assert [p["title"] for p in body["pages"]] == ["Attention Is All You Need"]
    assert {b["uid"] for b in body["blocks"]} == {"b3"}


def test_search_empty_query(client):
    body = client.get("/api/search", params={"q": "  "}).json()
    assert body == {"pages": [], "blocks": []}


def test_search_quote_injection_is_safe(client):
    r = client.get("/api/search", params={"q": 'NEAR( "x" OR'})
    assert r.status_code == 200  # escaped, not parsed as FTS syntax
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_search_endpoint.py -v`
Expected: FAIL — 404s (`routes_search` not included / module missing).

- [ ] **Step 3: Implement**

`server/src/pkm/server/routes_search.py`:
```python
# pattern: Imperative Shell
"""Full-text search (query evaluation joins in Task 8)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.fts import escape_fts_query

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/search")
def search(q: str = "", limit: int = 20,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    if not q.strip():
        return {"pages": [], "blocks": []}
    match = escape_fts_query(q)
    pages = [dict(r) for r in db.execute(
        """SELECT p.id, p.title FROM pages_fts f
            JOIN pages p ON p.id = f.rowid
           WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit)).fetchall()]
    blocks = [dict(r) for r in db.execute(
        """SELECT b.uid, p.title AS page_title,
                  snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16)
                    AS snippet
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN pages p ON p.id = b.page_id
            WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit)).fetchall()]
    return {"pages": pages, "blocks": blocks}
```

In `server/src/pkm/server/app.py`, add:
```python
from pkm.server.routes_search import router as search_router
```
and `app.include_router(search_router)` next to the other routers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_search_endpoint.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: full-text search endpoint" && git push
```

---

### Task 8: Roam query parser + evaluation endpoint

**Files:**
- Create: `server/src/pkm/server/query.py`
- Modify: `server/src/pkm/server/routes_search.py` (add `GET /api/query`)
- Test: `server/tests/test_query.py`

**Interfaces:**
- Consumes: conftest seeds; `routes_search.router` (Task 7).
- Produces:
  - `QueryNode(kind: str, title: str | None, children: tuple[QueryNode, ...])` — kind ∈ `and|or|not|page`
  - `QueryParseError(ValueError)`
  - `parse_query(expr: str) -> QueryNode` — parses `{and: [[A]] [[B]] {or: …} {not: [[C]]}}`; nested `[[A [[B]]]]` titles kept whole; unknown clause (e.g. `between`) → `QueryParseError("unsupported clause: between")`; `not` outside `and` → `QueryParseError`
  - `plan_sql(node: QueryNode) -> tuple[str, list[str]]` — SQL selecting matching block uids as column `uid` (INTERSECT/UNION/EXCEPT over the refs table)
  - `GET /api/query?expr=…&limit=100&offset=0` → `{"groups": [{"page_id","page_title","items":[{"uid","text"}]}], "total": int}`; parse errors → 400 with the parser message

- [ ] **Step 1: Write the failing test**

`server/tests/test_query.py`:
```python
import pytest

from pkm.server.query import (QueryNode, QueryParseError, parse_query,
                              plan_sql)


def test_parse_simple_and():
    node = parse_query("{and: [[Paper]] [[Attention Is All You Need]]}")
    assert node.kind == "and"
    assert [c.title for c in node.children] == \
        ["Paper", "Attention Is All You Need"]


def test_parse_nested_or_and_not():
    node = parse_query("{and: [[A]] {or: [[B]] [[C]]} {not: [[D]]}}")
    kinds = [c.kind for c in node.children]
    assert kinds == ["page", "or", "not"]
    assert [c.title for c in node.children[1].children] == ["B", "C"]
    assert node.children[2].children[0].title == "D"


def test_parse_nested_bracket_title():
    node = parse_query("{and: [[A [[B]] c]]}")
    assert node.children[0].title == "A [[B]] c"


@pytest.mark.parametrize("bad,msg", [
    ("{between: [[A]] [[B]]}", "unsupported clause: between"),
    ("{not: [[A]]}", "not"),
    ("{and: }", "empty"),
    ("[[A]] [[B]]", "expected"),
])
def test_parse_errors(bad, msg):
    with pytest.raises(QueryParseError, match=msg):
        parse_query(bad)


def test_query_endpoint_and(client):
    r = client.get("/api/query",
                   params={"expr": "{and: [[Paper]] [[Attention Is All You Need]]}"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    [group] = body["groups"]
    assert group["page_title"] == "Machine Learning"
    assert [i["uid"] for i in group["items"]] == ["b3"]


def test_query_endpoint_or_and_not(client):
    body = client.get("/api/query",
                      params={"expr": "{or: [[Paper]] [[Machine Learning]]}"}).json()
    assert {i["uid"] for g in body["groups"] for i in g["items"]} == {"b3", "b4"}
    body = client.get(
        "/api/query",
        params={"expr": "{and: [[Paper]] {not: [[Attention Is All You Need]]}}"},
    ).json()
    assert body["total"] == 0


def test_query_endpoint_bad_expr_400(client):
    r = client.get("/api/query", params={"expr": "{between: [[A]] [[B]]}"})
    assert r.status_code == 400
    assert "unsupported clause" in r.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_query.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.query'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/query.py`:
```python
# pattern: Functional Core
"""Parse Roam's {{[[query]]}} expression syntax and plan it as SQL set ops.

Supported: {and: ...} {or: ...} {not: ...} over [[Page Title]] operands,
arbitrarily nested. `not` is only valid inside `and` (matching Roam).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_OP_RE = re.compile(r"\{\s*([a-zA-Z-]+)\s*:")


class QueryParseError(ValueError):
    pass


@dataclass(frozen=True)
class QueryNode:
    kind: str  # 'and' | 'or' | 'not' | 'page'
    title: str | None = None
    children: tuple["QueryNode", ...] = ()


def parse_query(expr: str) -> QueryNode:
    node, pos = _parse_node(expr, _skip_ws(expr, 0))
    if _skip_ws(expr, pos) != len(expr):
        raise QueryParseError(f"trailing input at offset {pos}")
    if node.kind == "not":
        raise QueryParseError("a top-level not is unsupported")
    if node.kind == "page":
        raise QueryParseError("expected a {and: ...} or {or: ...} clause")
    return node


def _skip_ws(s: str, pos: int) -> int:
    while pos < len(s) and s[pos].isspace():
        pos += 1
    return pos


def _parse_node(s: str, pos: int) -> tuple[QueryNode, int]:
    if s.startswith("[[", pos):
        title, pos = _parse_title(s, pos)
        return QueryNode("page", title), pos
    m = _OP_RE.match(s, pos)
    if not m:
        raise QueryParseError(f"expected '[[' or '{{' at offset {pos}")
    op = m.group(1).lower()
    if op not in ("and", "or", "not"):
        raise QueryParseError(f"unsupported clause: {op}")
    pos = m.end()
    children: list[QueryNode] = []
    while True:
        pos = _skip_ws(s, pos)
        if pos >= len(s):
            raise QueryParseError("unterminated clause")
        if s[pos] == "}":
            pos += 1
            break
        child, pos = _parse_node(s, pos)
        children.append(child)
    if not children:
        raise QueryParseError(f"empty {op} clause")
    if op == "not" and len(children) != 1:
        raise QueryParseError("not takes exactly one operand")
    if op != "and" and any(c.kind == "not" for c in children):
        raise QueryParseError("not is only valid inside and")
    return QueryNode(op, None, tuple(children)), pos


def _parse_title(s: str, pos: int) -> tuple[str, int]:
    depth, j = 1, pos + 2
    while j < len(s) - 1 and depth:
        pair = s[j:j + 2]
        if pair == "[[":
            depth, j = depth + 1, j + 2
        elif pair == "]]":
            depth, j = depth - 1, j + 2
        else:
            j += 1
    if depth:
        raise QueryParseError("unterminated [[title]]")
    return s[pos + 2:j - 2], j


_PAGE_SQL = ("SELECT r.src_block_uid AS uid FROM refs r"
             " JOIN pages p ON p.id = r.target_page_id WHERE p.title = ?")


def plan_sql(node: QueryNode) -> tuple[str, list[str]]:
    if node.kind == "page":
        return _PAGE_SQL, [node.title]
    if node.kind == "not":  # only reachable nested inside and
        return plan_sql(node.children[0])
    wrap = "SELECT uid FROM ({})"
    if node.kind == "or":
        parts, params = [], []
        for c in node.children:
            sql, p = plan_sql(c)
            parts.append(wrap.format(sql))
            params.extend(p)
        return " UNION ".join(parts), params
    # and: INTERSECT positives, then EXCEPT each not-operand
    positives = [c for c in node.children if c.kind != "not"]
    negatives = [c.children[0] for c in node.children if c.kind == "not"]
    if not positives:
        raise QueryParseError("and needs at least one non-negated operand")
    parts, params = [], []
    for c in positives:
        sql, p = plan_sql(c)
        parts.append(wrap.format(sql))
        params.extend(p)
    sql = " INTERSECT ".join(parts)
    for c in negatives:
        nsql, p = plan_sql(c)
        sql += " EXCEPT " + wrap.format(nsql)
        params.extend(p)
    return sql, params
```

Add to `server/src/pkm/server/routes_search.py` (import `HTTPException`, and `parse_query, plan_sql, QueryParseError` from `pkm.server.query`):
```python
@router.get("/api/query")
def run_query(expr: str, limit: int = 100, offset: int = 0,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 500))
    try:
        sql, params = plan_sql(parse_query(expr))
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    total = db.execute(
        f"SELECT count(*) FROM ({sql})", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
              FROM ({sql}) m JOIN blocks b ON b.uid = m.uid
              JOIN pages p ON p.id = b.page_id
             ORDER BY p.title, b.uid LIMIT ? OFFSET ?""",
        [*params, limit, offset]).fetchall()
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["page_id"])
        if group is None:
            group = {"page_id": r["page_id"], "page_title": r["page_title"],
                     "items": []}
            index[r["page_id"]] = group
            groups.append(group)
        group["items"].append({"uid": r["uid"], "text": r["text"]})
    return {"groups": groups, "total": total}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_query.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: roam query parser and evaluation endpoint" && git push
```

---

### Task 9: Journal endpoint + asset serving

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py` (add `GET /api/journal`)
- Create: `server/src/pkm/server/routes_assets.py`
- Modify: `server/src/pkm/server/app.py` (include `routes_assets.router`)
- Test: `server/tests/test_journal_assets.py`

**Interfaces:**
- Consumes: `daily.title_for_date` (Task 3), `tree.build_tree` (Task 4), conftest seeds.
- Produces:
  - `GET /api/journal?before=YYYY-MM-DD&days=7` → `{"days": [{"date","title","exists",...}]}`, newest first, starting the day before `before` (default: `before` = tomorrow, so today is first). Each existing day carries `"blocks": [tree…]`; missing days carry `"blocks": []` and `"exists": false`. **Today is auto-created** when it falls in range; other missing days are placeholders only. `days` capped at 31.
  - `GET /assets/{sha256}/{filename}` → the stored file with the DB-recorded mime type and `Cache-Control: private, max-age=31536000, immutable`; 404 for unknown sha or missing file; auth-gated like the API

- [ ] **Step 1: Write the failing test**

`server/tests/test_journal_assets.py`:
```python
import hashlib
from datetime import date, timedelta

import sqlite3

from pkm.server.daily import title_for_date


def test_journal_includes_seeded_daily(client):
    # seeded daily page: July 7th, 2026
    r = client.get("/api/journal",
                   params={"before": "2026-07-08", "days": 2})
    assert r.status_code == 200
    days = r.json()["days"]
    assert [d["date"] for d in days] == ["2026-07-07", "2026-07-06"]
    assert days[0]["title"] == "July 7th, 2026"
    assert days[0]["exists"] is True
    assert [b["text"] for b in days[0]["blocks"]] == \
        ["Studying [[Machine Learning]] today", "See ((b3)) for details"]
    assert days[1]["exists"] is False and days[1]["blocks"] == []


def test_journal_auto_creates_today_only(client, seeded_config):
    today = date.today()
    r = client.get("/api/journal", params={"days": 3})
    days = r.json()["days"]
    assert days[0]["date"] == today.isoformat()
    con = sqlite3.connect(seeded_config.db_path)
    titles = {r[0] for r in con.execute("SELECT title FROM pages")}
    con.close()
    assert title_for_date(today) in titles
    assert title_for_date(today - timedelta(days=1)) not in titles


def test_asset_serving(client, seeded_config):
    data = b"PNGDATA"
    sha = hashlib.sha256(data).hexdigest()
    dest = seeded_config.assets_dir / sha[:2] / sha
    dest.parent.mkdir(parents=True)
    dest.write_bytes(data)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO assets VALUES (?,?,?,?,NULL)",
                (sha, "fig.png", "image/png", len(data)))
    con.commit(); con.close()
    r = client.get(f"/assets/{sha}/fig.png")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-type"] == "image/png"
    assert "immutable" in r.headers["cache-control"]


def test_asset_unknown_sha_404(client):
    assert client.get(f"/assets/{'0' * 64}/x.png").status_code == 404


def test_asset_requires_auth(anon_client):
    assert anon_client.get(f"/assets/{'0' * 64}/x.png").status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_journal_assets.py -v`
Expected: FAIL — journal route 404, `pkm.server.routes_assets` missing.

- [ ] **Step 3: Implement**

Add to `server/src/pkm/server/routes_pages.py` (import `date, timedelta` from `datetime` and `title_for_date` from `pkm.server.daily`):
```python
@router.get("/api/journal")
def get_journal(before: str | None = None, days: int = 7,
                db: sqlite3.Connection = Depends(get_db)) -> dict:
    days = max(1, min(days, 31))
    start = (date.fromisoformat(before) if before
             else date.today() + timedelta(days=1))
    out = []
    for i in range(1, days + 1):
        d = start - timedelta(days=i)
        title = title_for_date(d)
        page = _fetch_page(db, title)
        if page is None and d == date.today():
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
                (title, now, now))
            db.commit()
            page = _fetch_page(db, title)
        if page is None:
            out.append({"date": d.isoformat(), "title": title,
                        "exists": False, "blocks": []})
        else:
            blocks = db.execute(
                f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
                (page["id"],)).fetchall()
            out.append({"date": d.isoformat(), "title": title,
                        "exists": True, "blocks": build_tree(blocks)})
    return {"days": out}
```

`server/src/pkm/server/routes_assets.py`:
```python
# pattern: Imperative Shell
"""Serve content-addressed assets (upload arrives in plan 3)."""
from __future__ import annotations

import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db

router = APIRouter(dependencies=[Depends(require_auth)])

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


@router.get("/assets/{sha256}/{filename}")
def get_asset(sha256: str, filename: str,
              db: sqlite3.Connection = Depends(get_db),
              config: Config = Depends(get_config)) -> FileResponse:
    if not _SHA_RE.match(sha256):
        raise HTTPException(status_code=404, detail="asset not found")
    row = db.execute("SELECT mime FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    path = config.assets_dir / sha256[:2] / sha256
    if row is None or not path.is_file():
        raise HTTPException(status_code=404, detail="asset not found")
    return FileResponse(
        path, media_type=row["mime"],
        headers={"Cache-Control": "private, max-age=31536000, immutable"})
```

In `server/src/pkm/server/app.py`, add:
```python
from pkm.server.routes_assets import router as assets_router
```
and `app.include_router(assets_router)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_journal_assets.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: journal endpoint and asset serving" && git push
```

---

### Task 10: Real-data smoke test (verification)

**Requires:** the imported database at `data/pkm.sqlite3` (exists from plan 1's Task 10).

- [ ] **Step 1: Initialise config and start the server**

```bash
cd server
uv run python -m pkm.server.setup --data-dir ../data --password smoke-test-pw --insecure-cookie
uv run python -m pkm.server.run --data-dir ../data --port 8974 &
sleep 2
```

- [ ] **Step 2: Exercise the API against the real graph**

```bash
curl -s http://127.0.0.1:8974/healthz
# login and keep the cookie
curl -s -c /tmp/pkm-cookies -H 'Content-Type: application/json' \
  -d '{"password":"smoke-test-pw"}' http://127.0.0.1:8974/api/login
# gate works: no cookie -> 401
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8974/api/search?q=x'
# real page with backlinks + block refs
curl -s -b /tmp/pkm-cookies 'http://127.0.0.1:8974/api/page/Generative%20Models' | head -c 2000
# namespace page
curl -s -b /tmp/pkm-cookies 'http://127.0.0.1:8974/api/page/AWS/SCP' | head -c 500
# search
curl -s -b /tmp/pkm-cookies 'http://127.0.0.1:8974/api/search?q=datascript'
# a real query from the graph
curl -s -b /tmp/pkm-cookies \
  'http://127.0.0.1:8974/api/query?expr=%7Band%3A%20%5B%5BGenerative%20Models%5D%5D%20%5B%5BLink%5D%5D%7D' | head -c 1500
# unlinked references for a hub page
curl -s -b /tmp/pkm-cookies 'http://127.0.0.1:8974/api/unlinked?title=Machine%20Learning' | head -c 1000
# journal
curl -s -b /tmp/pkm-cookies 'http://127.0.0.1:8974/api/journal?days=3' | head -c 1500
# an asset: pick one sha from the db and fetch it
sqlite3 ../data/pkm.sqlite3 "SELECT sha256, filename FROM assets LIMIT 1"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -b /tmp/pkm-cookies \
  "http://127.0.0.1:8974/assets/<sha-from-above>/<filename-from-above>"
```

Verify: every authed call returns real data; the 401 check returns 401; response times feel instant (<100ms for pages with hundreds of backlinks — spot-check a heavily-linked page like `Paper` with `time curl …`).

- [ ] **Step 3: Stop the server, record findings**

Kill the background uvicorn. Note any slow queries, encoding issues with unusual titles, or surprises in `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` under the findings section. Reset the smoke password: delete `data/config.json` (the user sets their real password at deployment).

```bash
git add docs/ && git commit -m "docs: record read-api smoke findings" && git push
```

---

## Self-review notes (completed)

- **Spec coverage (plan-2 scope):** page endpoint w/ backlinks grouped by source page + breadcrumbs ✓ (T4/T5), unlinked references on demand ✓ (T6), FTS search w/ snippets + title ranking ✓ (T7), query eval incl. nested and/or/not ✓ (T8), assets served by hash ✓ (T9), daily auto-create + journal ✓ (T4/T9), auth per spec (static password, signed cookie, constant-time, all routes + assets gated) ✓ (T2), pagination on every list ✓ (T5/T6/T8), `((block-ref))` resolution map ✓ (T4), namespace titles via `{title:path}` ✓ (T4), `foreign_keys=ON` per connection ✓ (T1). Deferred to plan 3 by design: ops write path, asset upload, WebSocket. OpenAPI→TS type generation lands with the frontend plan.
- **Type consistency:** `Config` fields (T1) used by T2/T9; `require_auth`/`get_db`/`get_config` names consistent across routers; conftest seed rows match plan-1 schema column order; `escape_fts_query`/`phrase_query` (T6) used in T6/T7; `build_tree` dict shape identical in T4 page and T9 journal.
- **Placeholder scan:** clean — every code step contains complete code; the one intentional placeholder (T2's `page_placeholder`) is explicitly replaced in T4.
