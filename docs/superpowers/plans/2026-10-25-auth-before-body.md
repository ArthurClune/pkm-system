# Auth Before Body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An anonymous request is refused before the server reads one byte of its body, and the one public route that reads a body (`POST /api/login`) reads at most a few KiB.

**Architecture:** A pure-ASGI `AuthGateMiddleware`, innermost of the user middlewares (inside `OriginGuardMiddleware`), refuses every anonymous request outside the public surface with the existing 401 / WS 4401, before routing and therefore before FastAPI parses the body. Which requests are public is a pure function of scope type, method and route path (`auth_gate_core.is_public`); the session check is one shell helper shared by the gate, `require_auth` and `/api/ws`. For the public request that carries a body, the gate reads it itself up to `PUBLIC_BODY_MAX_BYTES` and replays it, answering 413 past the cap.

**Tech Stack:** Python 3.12, FastAPI 49 / Starlette 3.4 (pure ASGI middleware), pytest.

**Spec:** bean `pkm-zav2` (`.beans/pkm-zav2--reject-unauthenticated-requests-before-reading-the.md`) and the finding "Low: login backoff, pre-auth bodies and cookie parsing" → "Bodies are read before auth" in `docs/security-review-2026-10-23.md`. The probe is `docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_preauth.py` in the main checkout (gitignored; read-only); Task 1 turns it into tests.

## Design decision

**Chosen: auth as pure-ASGI middleware ahead of body parsing, plus a body cap on the public routes only.** Neither half alone closes the finding:

| Option | Private routes (`/api/ops`, `/api/assets`, …) | `POST /api/login` (public) | New route forgets its guard |
|---|---|---|---|
| Anonymous-request body cap only | Still read up to the cap before the 401, on every route | Capped | Still leaks; the walk test is the only net |
| Gate middleware only | 0 bytes read | A 64 MiB password is still read whole (the probe shows this against a prototype gate) | Refused (default deny) |
| **Gate + public-body cap** | 0 bytes read | At most `PUBLIC_BODY_MAX_BYTES` read | Refused |

Reasons for the specific shape:

- **Path predicate, not route matching.** FastAPI 49 routes through `_IncludedRouter`, low-priority and frontend-route groups, and `matches()` writes FastAPI's own scope keys. Re-running that in a middleware duplicates the routing semantics; a predicate is O(1) and easy to audit. The predicate: a websocket is never public; `POST /api/login` is public; a `GET`/`HEAD` whose first path segment is neither `api` nor `assets` is public (that covers `/login`, `/healthz`, `/app-assets/*`, `sw.js`, the manifest and every SPA route); everything else is private. It reads `starlette.routing.get_route_path(scope)`, the same string the router matches, so the two cannot disagree on decoding or `root_path`.
- **Its one gap is pinned, not ignored.** A future `GET` route outside `/api` and `/assets` passes the gate. The rewritten walk test asserts the set of routes the predicate admits equals `PUBLIC_ROUTES` exactly, so such a route fails `pytest` by name. That is why **`Depends(require_auth)` stays on every router and `/api/ws` keeps its inline check**: it is the route's own check, and the only one for a `GET` outside `/api` and `/assets` (the proptest sync server's `GET /__proptest/*` control routes are exactly that). No route has a body and is admitted, except login.
- **Session verified without duplicating logic.** Today `require_auth` and `ws_endpoint` each repeat "cookie, `bytes.fromhex(secret)`, `verify_session`, wall clock". A new `auth.session_is_valid(conn: HTTPConnection, config: Config) -> bool` holds it once; `HTTPConnection(scope)` gives the gate the same cookie parsing `request.cookies` uses, for HTTP and websocket scopes alike.
- **Config is read per request from `scope["app"].state.config`**, never captured at construction: `proptest/sync_server.main` and `test_title_routes_props.py` replace `app.state.config` after `create_app`.
- **Refusal shapes unchanged.** HTTP: 401 `{"detail": "not authenticated"}` (what `HTTPException` in `require_auth` renders today). WS: `WebSocketClose(code=4401)` before accept, as `OriginGuardMiddleware` sends its 4403; uvicorn answers both as HTTP 403.
- **Order: `RequestLog → SecurityHeaders → OriginGuard → AuthGate → router`.** `AuthGateMiddleware` is added before `OriginGuardMiddleware` in `create_app`, so it is innermost: its 401/413 is logged by `RequestLogMiddleware` and carries `X-DNS-Prefetch-Control`, and a foreign-origin anonymous handshake still sees 4403, not 4401, as `backend.md § Auth` states. Both refuse without reading the body.
- **The cap applies to public requests whose method is outside `origin_core.SAFE_METHODS`** (by construction only `POST /api/login`), whether or not a session cookie is present: one rule, "a public route reads at most `PUBLIC_BODY_MAX_BYTES`". A `Content-Length` over the cap is refused unread; otherwise the gate buffers messages until the body ends (replayed to the app as one message) or the running total passes the cap (413, no further `receive`). 8 KiB holds any real passphrase (a JSON body of over 8,000 ASCII characters, or about 2,000 four-byte emoji) while 1,000 concurrent anonymous logins hold 8 MiB, not 64 GiB.
- **Composes with `security/throttle`.** That branch makes `login` async with a per-source turn and pins proxy trust in `run.py`; it does not touch `require_auth`. The gate reads the body before `login` runs, so the turn and the throttle key (`request.client.host`) are untouched. The `auth.py` hunks here (`session_is_valid`, two constants, `require_auth`'s body) sit away from `login`.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.claude/worktrees/zav2` (branch `security/zav2`). `pwd` first; never touch `/Users/arthur/code/llm/pkm` itself.
- Task 1 Step 1 merges `main` once the orchestrator says `security/throttle` has landed: `git merge --no-ff main`. Do not start before that word.
- Public surface, exactly: `GET`/`HEAD` `/login`, `/healthz`, `/app-assets/*`, the SPA catch-all `/{full_path:wholepath}`; `POST /api/login`. No websocket is public.
- `PUBLIC_BODY_MAX_BYTES = 8192`. Over it: 413 `{"detail": "request body too large"}`.
- Anonymous refusal: HTTP 401 `{"detail": "not authenticated"}`; websocket close 4401 before accept. Both unchanged from today.
- Keep every `Depends(require_auth)` and the inline check in `ws.ws_endpoint`.
- FCIS: `auth_gate_core.py` is `# pattern: Functional Core`, `auth_gate.py` is `# pattern: Imperative Shell`.
- Comments: at most 80 columns, other lines 120; no bean ids, line numbers or plan pointers in code, test or `docs/architecture/` text; never write "load-bearing". `git config core.hooksPath .githooks` once if not set.
- No route, query param, response model or route docstring changes, so `web/src/api/openapi.json` needs no regen; `test_openapi_sync.py` must stay green to prove it. If anything there changes, regenerate per `backend.md § Generated artifacts and parity fixtures`.
- Server verification: `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`.
- Commits: explicit paths (never `git add -A`); message ends `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; no session URL. Check `git status -sb` before each commit.
- Leave the bean file alone; the orchestrator owns it.

## Review Focus

1. **`HEAD /healthz` from an uptime monitor** must answer as `GET` does (200), not 401. Pinned in Task 1 (core table and an app-level `HEAD`).
2. **A browser holding an expired or garbage `pkm_session` cookie** must still get `/login` and the SPA shell (200), or a user whose session lapsed cannot reach the login form. Pinned in Task 1.
3. **A login body split across several ASGI messages** (chunked upload, slow client) must reach `login` intact and log in. Pinned in Task 2.
4. **A client that disconnects while the gate is pre-reading the login body** must not raise, must not call the app, and must not send a response. Pinned in Task 2.
5. **A logged-in client posting `/api/login` again** (the cap applies regardless of cookie) must still log in with a normal body. Pinned in Task 2.

---

### Task 1: The gate refuses anonymous requests before the body

**Model:** opus (the security property itself; the teeth-test rewrite needs judgement).

**Files:**
- Create: `server/src/pkm/server/auth_gate_core.py`, `server/src/pkm/server/auth_gate.py`
- Modify: `server/src/pkm/server/auth.py` (`require_auth`, new helper and constants), `server/src/pkm/server/ws.py` (`ws_endpoint`), `server/src/pkm/server/app.py` (`create_app` middleware block)
- Test: create `server/tests/test_auth_gate.py`; modify `server/tests/test_auth.py`, `server/tests/test_spa.py`, `server/tests/test_security_headers.py`

**Interfaces:**
- Produces, `auth_gate_core.py`:
  - `PRIVATE_FIRST_SEGMENTS: frozenset[str] = frozenset({"api", "assets"})`
  - `PUBLIC_UNSAFE_ROUTES: frozenset[tuple[str, str]] = frozenset({("POST", "/api/login")})`
  - `def is_public(scope_type: str, method: str | None, route_path: str) -> bool`
- Produces, `auth.py`:
  - `NOT_AUTHENTICATED_DETAIL = "not authenticated"`
  - `NOT_AUTHENTICATED_WS_CODE = 4401`
  - `def session_is_valid(conn: HTTPConnection, config: Config) -> bool`
- Produces, `auth_gate.py`: `class AuthGateMiddleware` with `__init__(self, app: ASGIApp) -> None` and `async __call__(self, scope: Scope, receive: Receive, send: Send) -> None`; imports `is_public` by name (`from pkm.server.auth_gate_core import is_public`) so tests can monkeypatch `pkm.server.auth_gate.is_public`.

- [ ] **Step 1: Merge main (after the orchestrator's word that throttle landed)**

Run: `git merge --no-ff main`, then `cd server && uv run pytest -q`.
Expected: merge commit; suite green. `auth.py`'s `login` is now `async def`.

- [ ] **Step 2: Write the failing tests in `server/tests/test_auth_gate.py`**

A module helper drives the ASGI app directly, as the probe does, with a lazy body so 64 MiB is never materialised:

`async def _stream(app, method: str, path: str, content_type: str, total: int, *, chunk: int = 1 << 20, prefix: bytes = b"", suffix: bytes = b"", headers: Sequence[tuple[bytes, bytes]] = (), cookie: str | None = None) -> Sent`, where `Sent` is a small dataclass `status: int | None`, `consumed: int` (bytes handed out by `receive` before `http.response.start`), `body: bytes`, `headers: list[tuple[bytes, bytes]]`. Scope as in the probe (`client=("100.64.0.5", 1)`, `state={}`); `cookie` adds a `cookie: pkm_session=<value>` header. Wrap in `asyncio.run(asyncio.wait_for(..., 10))`. App: `create_app(seeded_config)`.

Tests and their assertions (`MiB64 = 64 << 20`):

```python
def test_an_anonymous_json_body_is_refused_unread(seeded_config):
    s = run(_stream(app, "POST", "/api/ops", "application/json", MiB64,
                    prefix=b'{"x":"', suffix=b'"}'))
    assert (s.status, s.consumed) == (401, 0)
    assert json.loads(s.body) == {"detail": "not authenticated"}

def test_an_anonymous_upload_is_refused_unread(seeded_config):
    # multipart to /api/assets, the probe's PNG part around 64 MiB
    assert (s.status, s.consumed) == (401, 0)
    assert list(seeded_config.assets_dir.glob(".upload-*")) == []

def test_an_anonymous_form_body_is_refused_unread(seeded_config):
    # application/x-www-form-urlencoded to /api/assets/export.zip, 8 MiB
    assert (s.status, s.consumed) == (401, 0)

def test_a_garbage_cookie_is_anonymous_and_refused_unread(seeded_config):
    # cookie "v1.123.é" encoded utf-8, POST /api/ops 1 MiB
    assert (s.status, s.consumed) == (401, 0)

def test_a_foreign_origin_is_refused_403_before_the_gate(seeded_config):
    # anonymous POST /api/ops with Origin: https://evil.example
    assert (s.status, s.consumed) == (403, 0)

def test_an_authenticated_body_reaches_the_route(seeded_config):
    # cookie = sign_session(bytes.fromhex(seeded_config.session_secret),
    #                       int(time.time() * 1000)); POST
    # /api/client/diagnostics with {"kind": "replica-corruption",
    # "error": "x" * 32768, "report": {}, "client": {}}
    assert s.status == 200

def test_the_gate_401_is_logged_and_carries_the_security_header(
        anon_client, caplog):
    r = anon_client.post("/api/ops", json={})
    assert r.status_code == 401
    assert r.headers["x-dns-prefetch-control"] == "off"
    # one pkm.access record for POST /api/ops with status 401

@pytest.mark.parametrize("scope_type,method,path,public", [
    ("http", "GET", "/", True), ("http", "HEAD", "/", True),
    ("http", "GET", "/login", True), ("http", "GET", "/healthz", True),
    ("http", "HEAD", "/healthz", True),
    ("http", "GET", "/app-assets/index-abc.js", True),
    ("http", "GET", "/sw.js", True), ("http", "GET", "/page/Foo", True),
    ("http", "POST", "/api/login", True),
    ("http", "GET", "/api/login", False), ("http", "POST", "/login", False),
    ("http", "POST", "/api/login/", False),
    ("http", "GET", "/api", False), ("http", "GET", "/api/", False),
    ("http", "GET", "/api/sidebar", False),
    ("http", "GET", "/assets", False), ("http", "GET", "/assets/x/y", False),
    ("http", "OPTIONS", "/", False), ("http", "PUT", "/page/Foo", False),
    ("http", "POST", "/", False),
    ("websocket", None, "/api/ws", False), ("websocket", None, "/x", False),
])
def test_is_public(scope_type, method, path, public):
    assert is_public(scope_type, method, path) is public

def test_head_healthz_answers_anonymously(anon_client):
    assert anon_client.head("/healthz").status_code == 200

def test_an_expired_cookie_still_reaches_the_login_page_and_shell(
        seeded_config, tmp_path):
    # app with a built SPA (test_auth._walk_app's dist); cookie signed
    # with issued_ms two years ago; GET /login and GET / both 200
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd server && uv run pytest -q tests/test_auth_gate.py`
Expected: collection error, `pkm.server.auth_gate_core` does not exist.

- [ ] **Step 4: Implement the core and see the body tests fail for the right reason**

`auth_gate_core.is_public`: rules as in the Design decision. The first segment is `route_path.split("/", 2)[1]` (`""` for `/`). A websocket is never public.

Run: `cd server && uv run pytest -q tests/test_auth_gate.py`
Expected: `test_is_public` passes; the `refused_unread` tests FAIL on `consumed`, 401 only after the whole body (about 64 MiB for `/api/ops`), as the probe reported. Put that figure in the commit message as the red evidence.

- [ ] **Step 5: Implement the shell**

- `auth.session_is_valid`: the cookie `COOKIE_NAME` from `conn.cookies`, `verify_session(bytes.fromhex(config.session_secret), token, now_ms=int(time.time() * 1000))`. `require_auth` becomes `if not session_is_valid(request, config): raise HTTPException(401, NOT_AUTHENTICATED_DETAIL)`; `ws_endpoint` calls it and closes with `NOT_AUTHENTICATED_WS_CODE`. Update the module docstring: login routes, the session check, and the route-level guard.
- `AuthGateMiddleware.__call__`: pass non-`http`/`websocket` scopes through. If `is_public(scope["type"], scope.get("method"), get_route_path(scope))`, pass through (Task 2 adds the cap here). Else if `session_is_valid(HTTPConnection(scope), scope["app"].state.config)`, pass through. Else send `WebSocketClose(code=NOT_AUTHENTICATED_WS_CODE)` or `JSONResponse({"detail": NOT_AUTHENTICATED_DETAIL}, status_code=401)` without calling `receive`. Module docstring: why it exists (FastAPI reads the body before dependencies), what it admits, that `require_auth` remains the route's own check.
- `create_app`: `app.add_middleware(AuthGateMiddleware)` immediately before the `OriginGuardMiddleware` line; rewrite the comment above them to say both are innermost so their refusals are logged and carry the headers, and the Origin guard runs first.

- [ ] **Step 6: Run the new tests**

Run: `cd server && uv run pytest -q tests/test_auth_gate.py`
Expected: PASS.

- [ ] **Step 7: Rewrite the route-walk teeth in `server/tests/test_auth.py`**

Rewrite the comment above `PUBLIC_ROUTES`: these are the routes `AuthGateMiddleware` admits anonymously (`auth_gate_core.is_public`); every other route is refused by the gate before its body is read, and still carries its own `require_auth` (a websocket checks inline). Keep `PUBLIC_ROUTES`' four entries, `test_every_private_route_refuses_an_anonymous_request`, `test_public_routes_do_not_demand_a_session`, `test_the_route_walk_sees_every_kind_of_route_the_app_holds` and `test_the_walk_names_a_mounted_sub_app` unchanged. Replace the three teeth tests:

```python
def test_the_gate_admits_exactly_the_public_routes(seeded_config, tmp_path):
    app = _walk_app(seeded_config, tmp_path)
    admitted = {(m, r.path) for r in _api_routes(app.routes)
                for m in r.methods or ()
                if m not in ("HEAD", "OPTIONS")
                and is_public("http", m, fill_path(r.path))}
    admitted |= {(WEBSOCKET, r.path) for r in _ws_routes(app.routes)
                 if is_public("websocket", None, fill_path(r.path))}
    assert admitted == PUBLIC_ROUTES
    assert is_public("http", "GET", "/app-assets/index-abc.js")

def test_a_private_route_that_forgot_its_guard_is_refused_by_the_gate(
        seeded_config, tmp_path):
    # @app.get("/api/forgot-auth") without require_auth
    answers = _anonymous_answers(app)
    assert answers[("GET", "/api/forgot-auth")] == 401
    assert _leaked(answers) == []

def test_the_route_walk_names_a_route_the_gate_admits_without_a_guard(
        seeded_config, tmp_path):
    # @app.get("/forgot-auth") without require_auth: outside /api, so the
    # gate admits it; both the walk and the admitted-set check name it
    assert _leaked(_anonymous_answers(app)) == [("GET", "/forgot-auth")]

def test_the_route_walk_names_a_websocket_without_the_guard(
        seeded_config, tmp_path, monkeypatch):
    # as today's /api/ws-forgot test, plus monkeypatch
    # "pkm.server.auth_gate.is_public" to admit that one path;
    # answers[...] == "accepted" and _leaked == [(WEBSOCKET, "/api/ws-forgot")]

def test_the_route_walk_names_a_websocket_that_never_answers(...):
    # as today's /api/ws-silent test, with the same monkeypatch; "hung"
```

Also add `test_a_websocket_that_forgot_its_guard_is_closed_4401_by_the_gate` (no monkeypatch; `/api/ws-forgot` answers 4401, `_leaked == []`).

- [ ] **Step 8: Update the two tests whose anonymous 404s are now 401s**

`test_spa.test_api_and_asset_routes_not_shadowed`: anonymously, `/api/nonexistent`, `/assets/not-a-sha`, `/api` and `/assets` now answer 401; assert that, then set a minted cookie (`sign_session(bytes.fromhex("cd" * 32), now_ms)`) and keep the original 404 assertions for those four paths, which is what the test is for (the catch-all does not shadow them). `test_security_headers.test_every_response_turns_dns_prefetch_off`: the "API 404" request carries the same minted cookie.

- [ ] **Step 9: Full server verification**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all green. Every failure seen before Step 8 was an anonymous request to `/api` or `/assets` expecting something other than 401; anything else is a regression to investigate, not to re-expect. (A prototype of this gate failed exactly the five tests Steps 7 and 8 rewrite.)

- [ ] **Step 10: Commit**

```bash
git add server/src/pkm/server/auth_gate_core.py server/src/pkm/server/auth_gate.py \
  server/src/pkm/server/auth.py server/src/pkm/server/ws.py server/src/pkm/server/app.py \
  server/tests/test_auth_gate.py server/tests/test_auth.py server/tests/test_spa.py \
  server/tests/test_security_headers.py
git commit -m "server: refuse anonymous requests before the body is read"
```

### Task 2: Public request bodies are capped

**Model:** opus (the buffering and replay are where a subtle ASGI mistake would let the body through or break login).

**Files:**
- Modify: `server/src/pkm/server/auth_gate_core.py`, `server/src/pkm/server/auth_gate.py`
- Test: `server/tests/test_auth_gate.py`

**Interfaces:**
- Consumes: Task 1's `is_public`, `AuthGateMiddleware`, `_stream`.
- Produces, `auth_gate_core.py`:
  - `PUBLIC_BODY_MAX_BYTES = 8192`
  - `def declared_over_cap(headers: Iterable[tuple[bytes, bytes]], cap: int) -> bool` — True when any `content-length` value parses as an int above `cap`; an absent or unparsable value is False (the counted read still bounds it).
- Produces, `auth_gate.py`: `BODY_TOO_LARGE_DETAIL = "request body too large"`.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_login_declaring_a_body_past_the_cap_is_refused_unread(...):
    # POST /api/login, content-length: 67108864, streamed 64 MiB
    assert (s.status, s.consumed) == (413, 0)
    assert json.loads(s.body) == {"detail": "request body too large"}

def test_a_streamed_login_body_past_the_cap_stops_at_the_cap(...):
    # no content-length, chunk=1024, total 64 MiB
    assert s.status == 413
    assert s.consumed <= PUBLIC_BODY_MAX_BYTES + 1024

def test_a_login_body_at_the_cap_reaches_the_route(...):
    # '{"password":"' + "x" * n + '"}' padded to exactly
    # PUBLIC_BODY_MAX_BYTES bytes, one message
    assert s.status == 401          # wrong password, not 413
    # the same body plus one byte of padding inside the string
    assert s.status == 413

def test_a_login_split_across_messages_logs_in(...):
    # the correct password's JSON body delivered in 3 messages
    assert s.status == 200
    assert any(k == b"set-cookie" and v.startswith(b"pkm_session=")
               for k, v in s.headers)

def test_a_logged_in_client_can_log_in_again(client):
    r = client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200

def test_a_disconnect_during_the_login_read_calls_nothing():
    # drive AuthGateMiddleware(inner) directly, where `inner` records
    # that it was called; POST /api/login scope (public, so no
    # scope["app"] is needed); receive yields one 1 KiB http.request
    # (more_body=True), then {"type": "http.disconnect"}
    # completes without raising; inner never called; nothing sent

@pytest.mark.parametrize("headers,over", [
    ([], False), ([(b"content-length", b"8192")], False),
    ([(b"content-length", b"8193")], True),
    ([(b"content-length", b"abc")], False),
    ([(b"content-length", b"1"), (b"content-length", b"99999")], True),
])
def test_declared_over_cap(headers, over):
    assert declared_over_cap(headers, 8192) is over
```

The split-login and at-cap tests use a source address with no prior failures (each test builds its own app, so its own `LoginThrottle`).

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && uv run pytest -q tests/test_auth_gate.py -k "login or cap or disconnect"`
Expected: FAIL on import of `PUBLIC_BODY_MAX_BYTES` / `declared_over_cap`; once those exist, the past-the-cap tests fail with 401 after consuming the whole body.

- [ ] **Step 3: Implement**

In `AuthGateMiddleware.__call__`, for a public `http` request whose method is not in `origin_core.SAFE_METHODS`: if `declared_over_cap(scope["headers"], PUBLIC_BODY_MAX_BYTES)`, answer 413 without `receive`. Otherwise call `receive` until a message has `more_body` false (join the bodies) or the running total passes the cap (answer 413 at once, no further `receive`). On `http.disconnect` during that read, return without calling the app or sending. Then call the app with a `receive` that returns the joined body as one `http.request` message (`more_body: False`) the first time and delegates to the original `receive` afterwards, so a later disconnect still reaches the route. A short comment says why the gate reads the body itself: it is the only public route that reads one, and FastAPI would otherwise read any size.

- [ ] **Step 4: Run the gate tests and the login tests**

Run: `cd server && uv run pytest -q tests/test_auth_gate.py tests/test_auth.py tests/test_hostile_requests.py tests/test_origin_guard.py`
Expected: PASS.

- [ ] **Step 5: Full server verification and commit**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` — green.

```bash
git add server/src/pkm/server/auth_gate_core.py server/src/pkm/server/auth_gate.py \
  server/tests/test_auth_gate.py
git commit -m "server: a public route reads at most PUBLIC_BODY_MAX_BYTES of body"
```

### Task 3: Gates and docs

**Model:** opus (the docs state a security boundary's authority and order; the perf and property reads need judgement).

**Files:**
- Modify: `docs/architecture/backend.md` (Module map, § Auth, § Hostile input table), `docs/troubleshooting.md` (§ Backend)
- Possibly: `perf/baseline-backend.json` (only if the check rewrites it)

- [ ] **Step 1: Perf**

Run: `perf/check.sh backend` on a quiet machine, alone (the gate runs on every request: one cookie parse and HMAC per request on top of `require_auth`'s). Expected: no regression; counts cannot move. Act on any verdict as AGENTS.md § Testing says. Keep the table for the final review package.

- [ ] **Step 2: Hostile-request suite**

Run: `cd server && uv run pytest -q tests/test_hostile_requests.py tests/test_origin_guard.py tests/test_ws.py`, then `proptest/check.sh server` (the no-500 request properties send generated input, long login bodies included, through every route; a 413 is a 4xx and passes).
Expected: green. A failure follows AGENTS.md's property-gate rules.

- [ ] **Step 3: Docs (invoke the `architecture-docs` skill first)**

Edit the text as it stands after the Task 1 merge (the throttle branch rewrote parts of § Auth).

- Module map: one line for `auth_gate_core.py, auth_gate.py` (Core / Shell): which requests are public; `AuthGateMiddleware`.
- § Auth: replace "Every feature router declares … closes with 4401 before accepting." with: the gate refuses an anonymous request outside the public surface before routing, so before FastAPI reads the body (which it does before any dependency); what `is_public` admits; `PUBLIC_BODY_MAX_BYTES` and the 413; that `require_auth` stays on every router as the route's own check and is the only check for a `GET` outside `/api` and `/assets`; the middleware order `RequestLog → SecurityHeaders → OriginGuard → AuthGate → router` as one line or small diagram, keeping the existing 4403-before-4401 sentence; the walk test that pins the admitted set (`test_the_gate_admits_exactly_the_public_routes`). Add to "Nothing enforces these rules": a public route that reads a body must stay small, since the gate caps every public body; and the gate reads config per request because `app.state.config` is replaced after `create_app` in the proptest server.
- § Hostile input table: one row — "An anonymous body of any size" | `AuthGateMiddleware` refuses before reading; a public body is capped at `PUBLIC_BODY_MAX_BYTES` | `test_auth_gate.py`.
- `docs/troubleshooting.md` § Backend, one row: Symptom "An anonymous 64 MiB `POST /api/ops` was held in memory, and a multipart `POST /api/assets` spooled to `$TMPDIR`, before the 401; a 64 MiB login password was read whole" | Cause "FastAPI reads and parses the body before resolving `Depends(require_auth)`; `AuthGateMiddleware` now refuses first and caps public bodies" | `[backend.md § Auth](architecture/backend.md#auth)` | `pkm-zav2, test_auth_gate.py`.
- `docs/SECURITY.md` is not edited here; its wording goes to pkm-e95y.

- [ ] **Step 4: Verify and commit**

Run: `cd server && uv run pytest -q` (the comment-lint sweep covers the docs), `git diff --no-ext-diff --stat`.

```bash
git add docs/architecture/backend.md docs/troubleshooting.md   # plus perf/baseline-backend.json if rewritten
git commit -m "docs: the auth gate refuses before the body; public bodies are capped"
```

The commit message says what was added (gate, cap, order) and what was corrected (`require_auth` is no longer described as the only guard).
