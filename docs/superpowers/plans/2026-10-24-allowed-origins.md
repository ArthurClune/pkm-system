# Allowed Origins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser page on any origin other than PKM's own can neither
open `/api/ws` nor send a cookie-carrying write; clients that send no
`Origin` header (CLI, `pkm-mcp`, Shortcuts, curl) work as before.

**Architecture:** One pure-ASGI middleware, `OriginGuardMiddleware`,
sits inside `SecurityHeadersMiddleware` and `RequestLogMiddleware`. It
checks the `Origin` header of every WebSocket handshake and of every
HTTP request whose method is not GET, HEAD or OPTIONS. No header passes;
a header passes only when it is exactly one value in the allowed set,
which `create_app` builds once from the new `serve_origins` config key,
each `bind_hosts` listener on the server's port, and loopback on that
port. A refused HTTP request gets `403 {"detail": "origin not allowed"}`
before routing, auth or body parsing; a refused handshake is closed with
4403 before accept (uvicorn sends that as HTTP 403). The policy lives in
a Functional Core module; the middleware only reads headers and answers.

**Tech Stack:** Python 3, FastAPI/Starlette ASGI, pytest; Vite 6 dev
proxy (http-proxy), vitest.

**Spec:** row pkm-u1jk in
`docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`
(binding); the finding "Medium: any host in the tailnet is same-site,
and the WebSocket streams note text to any Origin" in
`docs/security-review-2026-10-23.md`; bean
`.beans/pkm-u1jk--check-origin-on-websocket-upgrades-and-cookie-carr.md`.
Probes (main checkout only, gitignored, read-only):
`/Users/arthur/code/llm/pkm/docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-cross/probe_ws_origin.py`
and `probe_csrf.py` in the same folder.

## Global Constraints

- From the spec, verbatim: "`/api/ws` and the cookie-carrying
  simple-request routes accept only PKM's own origins: the Tailscale
  Serve hostname (a new config key), each `bind_hosts` listener with its
  port, and localhost for e2e and scratch servers. A request with no
  `Origin` header still works (CLI, `pkm-mcp`, Shortcuts, curl). No
  cross-origin browser caller exists (no bookmarklet, extension, clipper
  or other tailnet app)."
- New config key: `serve_origins`, a JSON list of full origins
  (`"https://biber.bobtail-dorian.ts.net"`), default `[]`. A list of
  origins rather than one hostname, so a Serve on a non-443 port
  (`https://host:8443`) is expressible. Absent or empty: loopback and
  `bind_hosts` listeners are still allowed; the Serve hostname is not.
- Loopback origins are exactly `http://127.0.0.1:<port>`,
  `http://localhost:<port>` and `http://[::1]:<port>`, where `<port>` is
  the port this process serves on. Another loopback port is refused: a
  different local web app on `127.0.0.1` is same-site with PKM.
- `Origin: null`, an empty `Origin`, and more than one `Origin` header
  are refused. Reason: a sibling page can make its own requests carry
  `null` (a sandboxed iframe, a `data:` URL), so allowing `null` would
  reopen the hole. PKM itself never sends `null`: the app sets no
  `Referrer-Policy`, and under the browser default a same-origin POST
  carries its real origin.
- One middleware over all unsafe methods, not a per-route list. Reason:
  the five routes the review found are only today's set; a new route
  taking a form, a file or no body would be exposed again silently,
  and the middleware also refuses before the multipart parser reads an
  upload. JSON routes keep FastAPI's 415/422 as a second layer.
- Safe methods (GET, HEAD, OPTIONS) are not checked. A cross-origin GET
  cannot read the response (there is no CORS), and its only side effect
  is creating today's empty daily page, which the review accepted.
- The policy is an exact string match. Browsers serialise `Origin`
  lowercase with the default port omitted; `serve_origins` entries are
  normalised the same way at load.
- FCIS: `origin_core.py` is `# pattern: Functional Core`;
  `origin_guard.py` is `# pattern: Imperative Shell`.
- Comments carry no bean ids, line numbers or plan pointers; comment
  lines at most 80 columns, other lines at most 120 (AGENTS.md § FCIS).
  Never write "load-bearing".
- No route, query param, response model or route docstring changes, so
  `web/src/api/openapi.json` is not regenerated; `test_openapi_sync.py`
  confirms that.
- Do not edit `docs/SECURITY.md`: its wording goes to pkm-e95y (see
  Hand-offs below).
- Stage by explicit path; never `git add -A` (`web/node_modules` shows
  untracked). Run `git status -sb` before each commit. Commit messages
  end with the `Co-Authored-By` line only, never a `Claude-Session` line
  or session URL (AGENTS.md § Git; `.githooks/commit-msg` enforces it).

## Review Focus

1. Prod deployed before `serve_origins` is set, or set with a typo: every
   write from the Serve hostname answers 403 and the socket never opens.
   Edits must queue, not be discarded. Already pinned: 403 is in
   `RETRY_LATER_STATUSES` (`web/src/sync/rejection.ts`,
   `rejection.test.ts`). Task 1 adds the troubleshooting row and makes
   a malformed entry fail at load rather than silently allow nothing
   (`test_serve_origins_refuses_*`).
2. Near-miss origins: an uppercase host, an explicit default port
   (`https://h:443`), a trailing slash, two `Origin` headers. Exact
   match refuses all of them (`test_origin_allowed` table, Task 1).
3. `run.py --host` overrides `bind_hosts`: the allowed set must follow
   the hosts actually bound, not the config file
   (`test_main_hands_create_app_the_hosts_it_binds`, Task 1).
4. A future route that takes a form, a file or no body: the walk over
   every unsafe route with a foreign origin catches it
   (`test_every_unsafe_route_refuses_a_foreign_origin`, Task 1).
5. Test and scratch servers on non-default ports (e2e 8975, perf 8977,
   simpad 8979): `tests/e2e_serve.py` must pass its port to
   `create_app`, or every Playwright POST answers 403. Pinned by the
   Playwright suite in `pnpm verify` (Task 1, Step 9) and by
   `perf/check.sh frontend` before merge.

---

### Task 1: Origin guard on the server

**Model:** opus (the security property, its edge cases and the walk).

**Files:**
- Create: `server/src/pkm/server/origin_core.py`
- Create: `server/src/pkm/server/origin_guard.py`
- Create: `server/tests/test_origin_guard.py`
- Modify: `server/src/pkm/server/config.py` (`Config.serve_origins`,
  `load_config`)
- Modify: `server/src/pkm/server/app.py` (`create_app`: add the
  middleware)
- Modify: `server/src/pkm/server/run.py` (`main`: hand `create_app` the
  bound hosts)
- Modify: `server/tests/e2e_serve.py` (`main`: `api_port=PORT`)
- Modify: `server/tests/test_hostile_requests.py` (`_is_refusal`,
  `_non_json_answers`, the content-type walk test)
- Modify: `server/tests/test_config.py`, `server/tests/test_run.py`
- Modify: `docs/architecture/backend.md` (Module map, § Auth,
  § Configuration and entrypoints)
- Modify: `docs/troubleshooting.md` (two rows)
- Modify: `deploy/README.md` (First install step 4), `deploy/install.sh`
  (the printed config lines)

**Interfaces:**
- Produces, in `pkm.server.origin_core`:
  - `SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})`
  - `canonical_origin(value: str) -> str`: raises `ValueError` unless
    `value` is `http` or `https`, has a host, and has no userinfo,
    query, fragment or path other than `""` or `"/"`; an invalid port
    (`urlsplit(...).port` raising) is a `ValueError` too. Returns
    `scheme://host[:port]`, lowercased, IPv6 hosts in brackets, the
    port dropped when it is the scheme's default (80, 443).
  - `allowed_origins(serve_origins: Iterable[str], bind_hosts: Iterable[str], port: int) -> frozenset[str]`:
    `serve_origins` as given (already canonical), plus
    `http://<host>:<port>` for each bind host (brackets when the host
    holds `:`), plus the three loopback origins on `port`.
  - `checks_origin(scope_type: str, method: str | None) -> bool`: True
    for `"websocket"`; for `"http"`, True when `method` is not in
    `SAFE_METHODS`; False otherwise.
  - `origin_allowed(origins: Sequence[str], allowed: frozenset[str]) -> bool`:
    True when `origins` is empty, or holds exactly one value that is in
    `allowed`.
- Produces, in `pkm.server.origin_guard`:
  - `ORIGIN_REFUSED_DETAIL = "origin not allowed"`,
    `ORIGIN_REFUSED_WS_CODE = 4403`
  - `class OriginGuardMiddleware` with
    `__init__(self, app: ASGIApp, allowed: frozenset[str]) -> None` and
    the ASGI `__call__`. Header values are read from `scope["headers"]`
    (every `b"origin"` entry, decoded latin-1, so duplicates are seen).
    HTTP refusal: `JSONResponse({"detail": ORIGIN_REFUSED_DETAIL},
    status_code=403)`. Handshake refusal:
    `starlette.websockets.WebSocketClose(code=ORIGIN_REFUSED_WS_CODE)`.
    Lifespan and allowed requests pass through untouched.
- Produces: `Config.serve_origins: tuple[str, ...] = ()`, each entry
  canonical.
- Consumes: `create_app(config, *, api_port=8974, ...)` already exists;
  `api_port` becomes the port the allowed set is built for as well as
  the assistant harness's base URL. Its comment says so.

- [ ] **Step 1: Write the red tests from the probes**

In `server/tests/test_origin_guard.py`. Fixture `guarded_app`: a
`create_app(dataclasses.replace(seeded_config,
serve_origins=("https://pkm.tailnet-a.ts.net",),
bind_hosts=("127.0.0.1", "100.64.0.7")), api_port=8974,
assistant_engine=FakeEngine())` (`from fake_engine import FakeEngine`).
Fixture `guarded_client`: a logged-in `TestClient` on it. Constants:
`OWN = "https://pkm.tailnet-a.ts.net"`,
`SIBLING = "https://other-host.tailnet-a.ts.net"`,
`OTHER_TAILNET = "https://evil.tailnet-b.ts.net"`. Until Step 3 the
`serve_origins` field does not exist, so these fail at fixture setup;
that is the red.

From `probe_ws_origin.py`:
- `test_ws_refuses_a_foreign_origin[SIBLING | OTHER_TAILNET | "null"]`:
  `websocket_connect("/api/ws", headers={"Origin": o})` raises
  `WebSocketDisconnect` with `code == 4403`, and
  `app.state.hub._conns == set()` afterwards.
- `test_ws_refuses_a_foreign_origin_before_the_cookie_check`: an
  anonymous client with `Origin: SIBLING` gets 4403, not 4401.
- `test_ws_accepts_its_own_origins[OWN | "http://100.64.0.7:8974" |
  "http://127.0.0.1:8974" | "http://localhost:8974" |
  "http://[::1]:8974" | None]`: the socket opens; a `POST /api/ops`
  creating a block with text `"SECRET-NOTE-TEXT"` (the probe's op)
  arrives as an ops frame on it. `None` sends no `Origin` header.
- `test_ws_anonymous_with_its_own_origin_is_still_4401`.

From `probe_csrf.py`, the five simple requests, each with
`Origin: SIBLING`:
`POST /api/journal/cleanup` (`content-type: text/plain`, empty body);
`POST /api/assets/scan?force=true` (text/plain, empty);
`POST /api/assistant/conversations/{id}` (text/plain, empty; `id` from
a conversation created first with `json={}` and no Origin);
`POST /api/assets` (multipart, the probe's 72-byte PNG);
`POST /api/assets/export.zip` (urlencoded, `sha256=["0"*64]`).
- `test_simple_requests_refuse_a_foreign_origin[<each>]`: status 403,
  `r.json() == {"detail": "origin not allowed"}`, the DB digest
  (`_digest` from `test_hostile_requests`) is unchanged, and for the
  upload the assets dir lists the same files as before.
- `test_simple_requests_pass_their_own_origin[<each>]`: with
  `Origin: OWN`, status is not 403.
- `test_simple_requests_pass_with_no_origin[<each>]`: with no `Origin`,
  status is not 403.

Policy-wide:
- `test_every_unsafe_route_refuses_a_foreign_origin`: for every route
  from `_api_routes(app.routes)` (from `test_routes_models`) and each of
  its methods not in `SAFE_METHODS`, a request to
  `fill_path(route.path)` with `content=b"{}"`,
  `content-type: text/plain;charset=UTF-8` and `Origin: SIBLING`
  answers 403; the walk visits more than 20 route-methods; the DB
  digest is unchanged.
- `test_safe_methods_ignore_origin`: `GET /api/sidebar` with
  `Origin: SIBLING` answers 200.
- `test_a_refusal_carries_the_security_headers`: a refused POST has
  `X-DNS-Prefetch-Control: off` (the guard is inside
  `SecurityHeadersMiddleware`).

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && uv run pytest -q --no-cov tests/test_origin_guard.py`
Expected: every test errors at fixture setup with `TypeError ...
unexpected keyword argument 'serve_origins'`. To see the probe's own
red, temporarily drop the `serve_origins=` argument from the fixture
and re-run: the WS-refusal and simple-request tests then fail because
the socket opens and the routes answer 200/404/422, as the probes
printed. Restore the argument.

- [ ] **Step 3: Write the core and config tests, then implement
  `origin_core.py` and `Config.serve_origins`**

Core tests, in `test_origin_guard.py`:
- `test_canonical_origin_normalises`:
  `"HTTPS://PKM.Tailnet-A.ts.net/"` → `"https://pkm.tailnet-a.ts.net"`;
  `"https://h.example:443"` → `"https://h.example"`;
  `"http://h.example:80"` → `"http://h.example"`;
  `"https://h.example:8443"` → `"https://h.example:8443"`.
- `test_canonical_origin_refuses` (each raises `ValueError`):
  `"pkm.tailnet-a.ts.net"`, `"ftp://h.example"`,
  `"https://h.example/app"`, `"https://u@h.example"`,
  `"https://h.example?q=1"`, `"https://h.example#f"`, `"https://"`,
  `"https://h.example:99999"`, `"null"`, `""`.
- `test_allowed_origins_composes`:
  `allowed_origins(("https://biber.bobtail-dorian.ts.net",),
  ("127.0.0.1", "100.122.144.66"), 8974)` equals
  `{"https://biber.bobtail-dorian.ts.net", "http://127.0.0.1:8974",
  "http://100.122.144.66:8974", "http://localhost:8974",
  "http://[::1]:8974"}`.
- `test_allowed_origins_without_serve_origins`: `allowed_origins((),
  ("127.0.0.1",), 8975)` equals the three loopback origins on 8975.
- `test_checks_origin`: `("websocket", None)` True; `("http", "POST")`,
  `"PUT"`, `"PATCH"`, `"DELETE"` True; `"GET"`, `"HEAD"`, `"OPTIONS"`
  False; `("lifespan", None)` False.
- `test_origin_allowed` with `allowed = allowed_origins((OWN,),
  ("127.0.0.1",), 8974)`: `[]` True; `[OWN]` True;
  `["http://127.0.0.1:8974"]` True; `[SIBLING]` False; `["null"]`
  False; `[""]` False; `[OWN, OWN]` False; `[OWN + ":443"]` False;
  `[OWN.upper()]` False; `[OWN + "/"]` False;
  `["http://127.0.0.1:8000"]` False.

Config tests, in `test_config.py` (use its `write_config`):
- `test_serve_origins_default_empty`: `serve_origins == ()`.
- `test_serve_origins_normalised`:
  `["HTTPS://Biber.bobtail-dorian.ts.net/"]` loads as
  `("https://biber.bobtail-dorian.ts.net",)`.
- `test_serve_origins_refuses_a_bare_hostname`:
  `["biber.bobtail-dorian.ts.net"]` raises `ValueError` whose message
  names `serve_origins` and the value.
- `test_serve_origins_refuses_a_string`: `"https://h.example"` (not a
  list) raises `ValueError` naming `serve_origins`.

Implement `origin_core.py` per Interfaces, using
`urllib.parse.urlsplit`. In `config.py`, add the field with a short
comment (what it holds; the absent case), and in `load_config` read
`raw.get("serve_origins", [])`, refuse a non-list, and wrap each
`canonical_origin` failure in a `ValueError` naming the key and value.

Run: `cd server && uv run pytest -q --no-cov tests/test_origin_guard.py
tests/test_config.py -k "canonical or allowed or checks or
origin_allowed or serve_origins"`
Expected: PASS.

- [ ] **Step 4: Implement `OriginGuardMiddleware` and wire it**

`origin_guard.py` per Interfaces; module docstring states why (tailnet
hosts are same-site, so `SameSite=Lax` does not stop a sibling page)
and that an absent header passes because only non-browser clients omit
it. In `create_app`, compute
`allowed_origins(config.serve_origins, config.bind_hosts, api_port)`
and call `app.add_middleware(OriginGuardMiddleware, allowed=...)`
immediately before the existing `SecurityHeadersMiddleware` line, so
the guard is innermost of the three and its 403 is logged and carries
the headers. In `run.py` `main`, after choosing `hosts`, pass
`dataclasses.replace(config, bind_hosts=tuple(hosts))` to
`create_app`. In `tests/e2e_serve.py`, call
`create_app(config, assistant_engine=FakeEngine(), api_port=PORT)`.

Add to `test_run.py`:
`test_main_hands_create_app_the_hosts_it_binds`: monkeypatch
`pkm.server.run.bind_sockets` (return `[]`), `pkm.server.run.uvicorn`'s
`Server` (a fake whose `run` returns), and `pkm.server.run.create_app`
(capture `config` and `api_port`); call `main(["--data-dir", <tmp with
a config.json from test_config's shape>, "--port", "8975", "--host",
"127.0.0.1", "--host", "100.64.0.9"])`; assert the captured
`config.bind_hosts == ("127.0.0.1", "100.64.0.9")` and
`api_port == 8975`.

Run: `cd server && uv run pytest -q --no-cov tests/test_origin_guard.py
tests/test_run.py tests/test_config.py`
Expected: PASS.

- [ ] **Step 5: Widen the content-type walk's refusal predicate**

In `test_hostile_requests.py`: `_is_refusal` also counts 403 (the
origin guard's refusal), with its docstring saying so;
`_non_json_answers(app, client, origin: str | None = None)` adds an
`Origin` header when `origin` is given; parametrize
`test_every_json_body_route_refuses_a_non_json_content_type` over
`origin` in `[None, "https://other-host.tailnet-a.ts.net"]`. The walk,
its `len(answers) > 20` check and the digest check stay. Leave
`test_the_content_type_walk_names_a_route_that_parses_any_body`
unchanged: with no Origin it still finds the lenient route, which
proves the widened predicate did not make the walk vacuous.

Run: `cd server && uv run pytest -q --no-cov tests/test_hostile_requests.py
-k content_type`
Expected: PASS (3 tests).

- [ ] **Step 6: Docs** (invoke the `architecture-docs` skill first)

- `backend.md` Module map: one `server/` line for `origin_core.py,
  origin_guard.py` (Core / Shell: allowed origins; the guard
  middleware).
- `backend.md` § Auth: replace the closing sentence about `/api/ws` with
  the guard's rule: what is checked (every handshake; HTTP methods
  outside `SAFE_METHODS`), what passes (no header; one header in the
  set), the set's three sources and that the port is the one `run.py`
  serves on, the answers (403 `origin not allowed`; 4403, which uvicorn
  sends as HTTP 403; it runs before the cookie check, so an anonymous
  handshake from a foreign origin sees 4403). Then the rules nothing
  enforces, each with its reason: `Origin: null` is refused because a
  sibling page can produce it; a `Referrer-Policy: no-referrer` header
  or meta on the app would make the browser send `null` on every
  same-origin POST and lock the app out; the web keeps 403 a
  retry-later status (`rejection.ts`) so a wrong `serve_origins` queues
  edits instead of discarding them; a new hostname or Serve port needs
  its origin in `serve_origins`.
- `backend.md` § Configuration and entrypoints: a `serve_origins` row
  (default `[]`; "Origins browsers use to reach the server through
  Tailscale Serve, e.g. `["https://<machine>.<tailnet>.ts.net"]`;
  loopback and `bind_hosts` listeners are always allowed"), and in the
  `run.py` paragraph that `--host` replaces `bind_hosts` for the allowed
  set too.
- `troubleshooting.md` under `### Writes, conflicts and races`: Symptom
  "A page on another tailnet host opened `/api/ws` with the session
  cookie and received every op's text, or sent `POST
  /api/journal/cleanup`, `/api/assets/scan?force=true`, an upload, the
  assistant close beacon or `/api/assets/export.zip` as a simple
  request"; Cause "`ts.net` is a public suffix, so every tailnet host is
  same-site and the `Lax` cookie travels; nothing checked `Origin`.
  `OriginGuardMiddleware` now refuses a foreign origin"; Where
  `backend.md § Auth`; Ref `pkm-u1jk, test_origin_guard.py`.
- `troubleshooting.md` under `## Deployment and host`: Symptom "On the
  Serve hostname the live-update banner never connects and edits stay
  queued; `access.log` shows `403` on `POST /api/ops`"; Cause "The
  browser's origin is not in `serve_origins` (unset, mistyped, or Serve
  moved off 443). Add it and `launchctl kickstart -k` the server"; Where
  `backend.md § Configuration and entrypoints`; Ref `pkm-u1jk`.
- `deploy/README.md` First install step 4: the hand-added lines become
  `bind_hosts` and `serve_origins`, with the example
  `"serve_origins": ["https://<machine>.<tailnet>.ts.net"],` and one
  sentence on what breaks without it.
- `deploy/install.sh`: after `TS_IP`, compute the Serve name with
  `"$TAILSCALE" status --json | python3 -c 'import json, sys;
  print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'` and print
  a `"serve_origins": ["https://<name>"],` line beside the
  `bind_hosts` one. Check with `bash -n deploy/install.sh`.

- [ ] **Step 7: Server gates**

Run, from `server/`: `uv run pytest -q`, `uv run pyrefly check`,
`uv run ruff check`. Expected: all pass, coverage gate included;
`test_openapi_sync.py` passes without a regen.

- [ ] **Step 8: Commit**

```bash
git status -sb
git add server/src/pkm/server/origin_core.py server/src/pkm/server/origin_guard.py \
  server/src/pkm/server/config.py server/src/pkm/server/app.py server/src/pkm/server/run.py \
  server/tests/test_origin_guard.py server/tests/test_config.py server/tests/test_run.py \
  server/tests/test_hostile_requests.py server/tests/e2e_serve.py \
  docs/architecture/backend.md docs/troubleshooting.md deploy/README.md deploy/install.sh
git commit -m "security: refuse foreign Origin on /api/ws and unsafe requests"
```

- [ ] **Step 9: Web verification (e2e proves the loopback port)**

Run: `cd web && set -o pipefail && pnpm verify`
Expected: exit 0. Every spec's POSTs carry
`Origin: http://127.0.0.1:8975`; a 403 anywhere means `e2e_serve.py`
is not passing `api_port`. If another session holds 8975, set
`E2E_PORT` to a free port for this run.

---

### Task 2: Vite dev proxy forwards its own origin as the backend's

**Model:** opus (the proxy must not turn a foreign page's origin into an
allowed one).

`pnpm dev` serves the SPA on its own port and proxies `/api` to the
backend, so the browser's `Origin` is the dev server's
(`http://localhost:5173`), which the guard refuses. The proxy rewrites
`Origin` to the backend's own origin only when the request is
same-origin with the dev server; any other `Origin` is forwarded as is
and refused upstream. Rewriting unconditionally would let any other
page on `localhost` write to the backend through the proxy, and the
default backend is production's 8974.

**Files:**
- Create: `web/tooling/devProxyOrigin.ts` (`// pattern: Functional Core`)
- Create: `web/tooling/devProxyOrigin.test.ts`
- Modify: `web/vite.config.ts` (the `"/api"` proxy entry)
- Modify: `docs/architecture/frontend.md` (§ Build notes, the dev-proxy
  bullet)

**Interfaces:**
- Consumes: Task 1's rule that loopback on the server's port is allowed.
- Produces: `devProxyOrigin(origin: string | undefined, host: string |
  undefined, target: string): string | undefined`: returns `target`
  when `origin` and `host` are both defined and
  `origin === "http://" + host`; otherwise `undefined` (leave the
  header alone).

- [ ] **Step 1: Write the failing test**

`devProxyOrigin.test.ts`, with `target = "http://127.0.0.1:8975"`:
- same origin: `("http://localhost:5173", "localhost:5173", target)` →
  `target`; `("http://127.0.0.1:5199", "127.0.0.1:5199", target)` →
  `target`.
- other origins left alone (→ `undefined`): `("http://localhost:3000",
  "localhost:5173", target)`; `("null", "localhost:5173", target)`;
  `("https://localhost:5173", "localhost:5173", target)`;
  `(undefined, "localhost:5173", target)`;
  `("http://localhost:5173", undefined, target)`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && pnpm vitest run tooling/devProxyOrigin.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `devProxyOrigin` and wire it**

In `vite.config.ts`, give the `"/api"` entry a `configure(proxy)` that
registers one handler on both `proxyReq` and `proxyReqWs`; the handler
calls `devProxyOrigin(req.headers.origin, req.headers.host, apiTarget)`
and, when it returns a value, `proxyReq.setHeader("origin", value)`.
(Vite 6's http-proxy emits both events before the upstream request is
sent.) Add `tooling/devProxyOrigin.ts` to
`tooling/tsconfig.typecheck.json` if that file lists its inputs
explicitly.

- [ ] **Step 4: Run the test and a live check**

Run: `cd web && pnpm vitest run tooling/devProxyOrigin.test.ts`
Expected: PASS.

Live check, all ports scratch, servers stopped by PID afterwards:
start `cd server && E2E_PORT=8975 uv run python tests/e2e_serve.py`
in the background and note its PID; start
`cd web && PKM_API_PORT=8975 pnpm dev --port 5199 --strictPort` in the
background and note its PID; then
`curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: http://localhost:5199' http://localhost:5199/api/journal/cleanup`
prints `401` (origin translated, refused only for want of a cookie) and
the same with `-H 'Origin: http://localhost:3000'` prints `403`. Kill
both PIDs.

- [ ] **Step 5: Docs**

`frontend.md` § Build notes, the dev-proxy bullet: add that the proxy
rewrites a same-origin `Origin` to the backend's (`devProxyOrigin`),
because the server refuses any origin but its own, and forwards any
other origin unchanged.

- [ ] **Step 6: Gates and commit**

Run: `cd web && set -o pipefail && pnpm verify`
Expected: exit 0.

```bash
git status -sb
git add web/tooling/devProxyOrigin.ts web/tooling/devProxyOrigin.test.ts web/vite.config.ts \
  docs/architecture/frontend.md
# plus web/tooling/tsconfig.typecheck.json if Step 3 changed it
git commit -m "web: dev proxy forwards its own origin as the backend's"
```

---

## Before merge (whole branch)

- `perf/check.sh backend`, then `perf/check.sh frontend` (the frontend
  run drives Chromium against `e2e_serve.py` on 8977, so it also proves
  the port hand-off). Handle results per AGENTS.md § Testing.
- `proptest/check.sh web --file sync`: the sync harness talks to a real
  uvicorn through every write route with Node's `fetch`; a pass shows it
  sends no `Origin` the guard refuses. The server side needs no run (no
  sync, ops or planning code changed).
- Re-run the two probes against the branch from `server/`
  (`uv run python <probes>/sec-cross/probe_ws_origin.py <probes>/sec-cross`
  and `probe_csrf.py` likewise). They send no `Origin` except the WS
  probe's three foreign ones, so expect the WS probe to stop at its
  first handshake with `WebSocketDisconnect` 4403, and the CSRF probe's
  numbers unchanged (no `Origin`).

## Hand-offs (not tasks in this branch)

**pkm-e95y (SECURITY.md wording).** The orchestrator notes on pkm-e95y:
- § Authentication, "There is no CORS…" paragraph: CSRF protection is now
  `SameSite=Lax` plus the origin guard (`/api/ws` and every non-GET
  request with an `Origin` must carry one of PKM's own origins:
  `serve_origins`, the `bind_hosts` listeners, loopback); requests with
  no `Origin` are non-browser clients and still need the cookie.
- Known limitations: drop the "No `Origin` checks on writes or WebSocket
  upgrades" half of that row.
- Hardening priorities: item 4 is done; item 5 must say that
  `Referrer-Policy: no-referrer` is excluded, because it makes
  same-origin POSTs send `Origin: null`, which the guard refuses.

**Deploy (orchestrator).** Order:
1. Back up `~/.config/pkm/data/config.json`, then add
   `"serve_origins": ["https://biber.bobtail-dorian.ts.net"]`. The
   running code ignores unknown keys, so this is safe before the deploy.
2. Merge with `--no-ff`, run `CI=true ~/.config/pkm/app/deploy/update.sh`.

**Post-deploy verification (orchestrator).**
1. `launchctl list | grep pkm` shows the server loaded, and
   `lsof -nP -iTCP:8974 -sTCP:LISTEN` shows it owning 8974.
2. The new code is live (this branch changes no served bundle, so check
   the server):
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://other-host.bobtail-dorian.ts.net' http://127.0.0.1:8974/api/journal/cleanup`
   prints `403`; the same with
   `-H 'Origin: https://biber.bobtail-dorian.ts.net'` prints `401`, and
   with no `Origin` prints `401`.
3. In a real browser on `https://biber.bobtail-dorian.ts.net`: log in;
   edit a block and reload to see it kept.
4. WebSocket: open the same page in two tabs, edit in one, and see the
   edit appear in the other without a reload; no live-update banner.
5. Upload: drop a small image onto a page; it uploads and renders.
6. `grep ' 403 ' ~/.config/pkm/logs/access.log` since the restart holds
   only step 2's curl.
7. On any failure: `git revert -m 1 <merge>` on main, redeploy, verify
   the revert, report (the spec's rule).

Steps 3 to 5 write to production. Use one scratch page made for the
check and delete it afterwards; the uploaded image stays in the
content-addressed store.
