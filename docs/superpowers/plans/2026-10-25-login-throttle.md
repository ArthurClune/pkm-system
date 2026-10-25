# Login Throttle: Explicit Proxy Trust and One Check per Source

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The login backoff key is the connecting tailnet address on both
listeners, fixed in `run.py` rather than inherited from uvicorn defaults and
the environment (pkm-lamg); and a source has at most one password check in
flight, so a concurrent burst gets one scrypt check per backoff window, not
forty (pkm-v3t1).

**Architecture:** `run.py` builds its `uvicorn.Config` in one function that
passes `proxy_headers=True` and `forwarded_allow_ips="127.0.0.1"` explicitly,
so `request.client.host` is the peer on the Tailscale-IP listener and the
`X-Forwarded-For` that Tailscale Serve sets on the loopback listener.
`LoginThrottle` gains a per-source reservation: `begin_attempt` admits a
source only when it is neither in backoff nor already checking, under the
throttle's lock; `end_attempt` records the outcome and clears the reservation
in the same critical section. Refused attempts return at once with the
uniform 401; nothing waits on a per-source lock.

**Tech Stack:** Python 3.12, FastAPI/Starlette, uvicorn 0.49
(`ProxyHeadersMiddleware`), anyio threadpool, httpx `ASGITransport`, pytest.

**Spec:** `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`
§ Left to the builders (both beans are engineering decisions); the beans
`.beans/pkm-lamg--login-throttle-key-set-proxy-headers-forwarded-all.md` and
`.beans/pkm-v3t1--concurrent-login-guesses-must-serialise-per-source.md`;
the finding in `docs/security-review-2026-10-23.md` § Low: login backoff,
pre-auth bodies and cookie parsing (first two bullets).

## Global Constraints

- Port 8974 is production: never bind it, never stop the service. Scratch
  servers use 8975; e2e runs take their own `E2E_PORT`.
- Tailscale Serve on 443 belongs to production. Any observation Serve goes on
  8443 and is turned off afterwards (`tailscale serve --https=8443 off`).
- The uniform failure stays: a throttled, already-in-flight or slot-timed-out
  attempt gets the same `401 {"detail": "wrong password"}` as a wrong
  password.
- No route, query param, response model or route docstring changes, so
  `web/src/api/openapi.json` is untouched. If a task finds it must change
  one, regenerate per backend.md § Generated artifacts.
- AGENTS.md comment rules: no bean ids or line numbers in code, test or
  architecture-doc comments; comment lines at most 80 columns. Run
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all` before each
  commit. `# pattern:` headers stay as they are (`auth.py` and `run.py` are
  Imperative Shell, `throttle_core.py` is Functional Core).
- `SECURITY.md` is not edited on this branch; its wording goes to pkm-e95y.
- Commit with explicit paths, never `git add -A`. No session URLs in commit
  messages.

## Observation: what Tailscale Serve sends (2026-10-25)

Scratch echo server (raw ASGI, uvicorn 0.49) on `127.0.0.1:8975` and
`100.122.144.66:8975`, exposed with `tailscale serve --bg --https=8443`
(Tailscale 1.102.2), requested with curl from biber itself. Another tailnet
device was not reachable to run from (no ssh on biber-rex); Serve sets
`X-Forwarded-For` to the connecting node's tailnet address, and the
from-biber value below is biber's own tailnet IP, which is consistent.

| Request | Raw `client` (proxy_headers off) | Headers arriving | `client` with proxy_headers on, trust 127.0.0.1 |
|---|---|---|---|
| Serve, plain | `127.0.0.1` | `X-Forwarded-For: 100.122.144.66`, `X-Forwarded-Proto: https`, `X-Forwarded-Host: biber…:8443`, `Tailscale-User-Login/Name/Profile-Pic`, `Tailscale-Headers-Info` | `100.122.144.66`, scheme `https` |
| Serve, client sent `X-Forwarded-For: 6.6.6.6` | `127.0.0.1` | `X-Forwarded-For: 100.122.144.66` only (client's value dropped) | `100.122.144.66` |
| Serve, client sent two XFF lines, `X-Forwarded-Proto: http`, `Forwarded`, `X-Real-IP` | `127.0.0.1` | XFF and XFP replaced; `Forwarded` dropped; **`X-Real-IP: 5.5.5.5` passed through unchanged** | `100.122.144.66` |
| Serve, client sent `Tailscale-User-Login: evil@…` | `127.0.0.1` | client's `Tailscale-User-*` dropped, Serve's own injected | — |
| Direct `100.122.144.66:8975`, client sent `X-Forwarded-For: 6.6.6.6` | `100.122.144.66` | header passes through (no proxy) | `100.122.144.66` (peer not trusted, header ignored) |
| Direct loopback `127.0.0.1:8975`, client sent XFF `6.6.6.6`, then `10.0.0.1..3` | `127.0.0.1` | header passes through | `6.6.6.6`, `10.0.0.1`, `10.0.0.2`, `10.0.0.3` (a local process chooses its key) |

Serve reused one upstream keep-alive connection for every request (same
source port), so nothing connection-level identifies a client. Serve's
upstream is `http://127.0.0.1:$PORT` (`deploy/install.sh`); it never connects
from `::1`. A peer on the Tailscale-IP listener is never loopback, even when
the client is biber itself.

The probe (`probe_throttle.py`, run against this branch's base) agrees:
spoofed XFF ignored on the direct listener; right-most non-loopback XFF
entry on loopback; 200 concurrent wrong passwords from one source ran 40
password checks in 0.32 s against 1 sequentially.

## Decisions (the executor does not revisit these)

| Question | Decision | Why |
|---|---|---|
| `proxy_headers` | `True`, passed explicitly | Off, every Serve client keys as `127.0.0.1`: one bucket for the whole tailnet, so a guessing device puts the real user's devices in backoff too. On, each device keys by its own tailnet address. |
| `forwarded_allow_ips` | `"127.0.0.1"`, passed explicitly (a constant `FORWARDED_ALLOW_IPS` in `run.py`) | It is exactly Serve's upstream source. Passing it explicitly means a `FORWARDED_ALLOW_IPS` in the launchd environment cannot widen trust (with `*`, uvicorn takes the left-most entry, which a client can choose). Not a config field: it must follow `install.sh`'s Serve line, not a user setting. |
| Key per listener | Tailscale-IP listener: the TCP peer (XFF ignored, peer never trusted). Loopback listener: the right-most non-loopback `X-Forwarded-For` entry, which through Serve is the only entry and is Serve's; no XFF gives `127.0.0.1`. | Follows from trusting the peer, not the listener: a loopback peer arrives only on the loopback listener. A device's key is the same through Serve and direct (its tailnet IPv4). |
| Headers never read for the key | `X-Real-IP`, `Forwarded`, `Tailscale-User-*` | Serve passes `X-Real-IP` through from the client. `Tailscale-User-*` is unforgeable through Serve but forgeable on both direct listeners, and absent for tagged nodes. |
| Local processes on loopback | Accepted: they can pick their key with XFF | A local process can read `config.json` (hash, salt, session secret); the throttle does not defend against it. |
| Concurrency (v3t1) | One check in flight per source, by waiting, not refusing: `LoginThrottle.take_turn` waits on a per-source `asyncio.Lock` on the event loop, up to `SCRYPT_ACQUIRE_TIMEOUT_S`; the holder re-checks the backoff before its check. A turn timeout gets the uniform 401. | Refusing an in-flight source would tell a double-submit of the right password it was wrong. Waiting on the event loop holds no worker thread, so a burst cannot starve the pool. |
| Turn release | The turn belongs to the check: `hand_turn_to` ends it in the check task's done-callback; `_check_password` records the verdict on the worker thread | A cancelled or disconnected request stops waiting, but its worker thread runs on; ending the turn with the request would let the next request check before the verdict is recorded. |
| Outcomes | Right password clears history; wrong is `after_failure` (count + 1); a slot timeout or an exception records nothing. Every refusal is the uniform 401 `wrong password` (no 429) | An abandoned attempt made no guess. The uniform refusal hides throttling from a guesser. |
| Order | backoff check, `take_turn`, backoff re-check, then on the worker `scrypt_slot()` (unchanged, 4 slots, 2 s timeout) and verify | A burst from one source never queues on the semaphore. Worst case under contention: 2 s for the turn, 2 s for a slot, one scrypt check; a right password that times out in the queue gets the 401. |
| Clock | `LoginThrottle(clock_ms=...)`, default monotonic ms; the route reads `throttle.now_ms()` | Lets the burst test freeze time, so "one check per backoff window" is exact rather than timing-dependent. |
| Where turns live | `LoginThrottle._turns: dict[str, _SourceTurn]`, separate from `_attempts`, dropped with its last holder or waiter | `_attempts` is pruned and evicted at `MAX_TRACKED_SOURCES`; a held turn must never be dropped. The map's size is bounded by sources with a request in flight. |
| Test harness servers (`tests/e2e_serve.py`, perf fixture) | Unchanged | They are not production and bind loopback only. |

As shipped: the original refuse-in-flight reservation (`begin_attempt` / `end_attempt`) was overruled during execution so a concurrent correct login is never answered "wrong password"; the rows above for concurrency, release, outcomes, order and storage describe the shipped wait-for-the-turn design.

## Review Focus

- A slot timeout or an exception inside the check must release the
  reservation, or the source is locked out until restart (Task 2 tests
  `test_slot_timeout_releases_the_reservation_and_records_nothing`,
  `test_an_exception_during_the_check_releases_the_reservation`).
- Two concurrent correct-password logins from one source: the second now
  gets 401. Harnesses that log in from loopback (Playwright `workers: 1`,
  `web/src/props/sync/serverControl.ts`, `web/tooling/perf/seed.mjs`,
  `server/tooling/perfcheck/backend.py`) log in sequentially today; Task 3's
  full-suite runs confirm it.
- A burst from an attacking source while the real user logs in from
  another source: the user gets 200 (Task 2 test
  `test_a_burst_from_one_source_does_not_lock_out_another`).
- `FORWARDED_ALLOW_IPS=*` in the environment must not change the key
  (Task 1 test).
- A spoofed `X-Forwarded-For` on the Tailscale-IP listener, and `X-Real-IP`
  on loopback, must not choose the key (Task 1 table test).

---

### Task 1: Pin proxy trust in `run.py` (pkm-lamg) (model: opus)

**Files:**
- Modify: `server/src/pkm/server/run.py` (extract the `uvicorn.Config`
  construction in `main`)
- Modify: `server/src/pkm/server/auth.py` (comment above the `source =`
  line in `login`: what the key is on each listener and that it depends on
  `run.py`'s trust setting)
- Create: `server/tests/test_run_proxy_trust.py`

**Interfaces:**
- Produces: `run.FORWARDED_ALLOW_IPS: str = "127.0.0.1"` and
  `run.uvicorn_config(app: ASGIApp, port: int, log_config: dict | None) -> uvicorn.Config`,
  which passes `proxy_headers=True`, `forwarded_allow_ips=FORWARDED_ALLOW_IPS`
  and `access_log=False`. `main` calls it.

- [ ] **Step 1: Write the failing tests** in `test_run_proxy_trust.py`.
  Build the app with `create_app(seeded_config)`, then
  `cfg = run.uvicorn_config(app, port=0, log_config=None); cfg.load()`, and
  drive `cfg.loaded_app` with `httpx.AsyncClient(transport=httpx.ASGITransport(app=cfg.loaded_app, client=(peer, 50000)))`
  posting a wrong password; read the new key from
  `app.state.login_throttle._attempts`. Use `asyncio.run` inside sync tests.
  - `test_config_trusts_forwarding_only_from_loopback(monkeypatch)`:
    `monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")`; assert
    `cfg.proxy_headers is True` and `cfg.forwarded_allow_ips == "127.0.0.1"`.
  - `test_throttle_key_per_listener(...)`, parametrised, with the env set to
    `*` in every case:

    | peer | headers | key |
    |---|---|---|
    | `100.64.0.5` | `X-Forwarded-For: 1.2.3.4` | `100.64.0.5` |
    | `127.0.0.1` | `X-Forwarded-For: 100.64.0.7` | `100.64.0.7` |
    | `127.0.0.1` | `X-Forwarded-For: 6.6.6.6, 100.64.0.7` | `100.64.0.7` |
    | `127.0.0.1` | none | `127.0.0.1` |
    | `127.0.0.1` | `X-Real-IP: 8.8.4.4`, `Forwarded: for=8.8.8.8` | `127.0.0.1` |

- [ ] **Step 2: Run to verify red**
  `cd server && uv run pytest -q tests/test_run_proxy_trust.py`
  Expected: FAIL (`uvicorn_config` does not exist). After a temporary stub
  that omits `forwarded_allow_ips`, the third row would key `6.6.6.6` under
  `*`; that is the regression the explicit value pins.
- [ ] **Step 3: Implement** `FORWARDED_ALLOW_IPS` and `uvicorn_config` in
  `run.py`; `main` uses it. The constant's comment says it must name Serve's
  upstream source (`install.sh`'s `serve` line) and why it is explicit
  (the environment variable would otherwise set it).
- [ ] **Step 4: Run** `cd server && uv run pytest -q tests/test_run_proxy_trust.py tests/test_auth.py`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add server/src/pkm/server/run.py server/src/pkm/server/auth.py server/tests/test_run_proxy_trust.py`
  `git commit -m "server: pin uvicorn proxy trust to loopback for the login throttle key"`

### Task 2: One password check in flight per source (pkm-v3t1) (model: opus)

**Files:**
- Modify: `server/src/pkm/server/auth.py` (`LoginThrottle`, `login`; the
  `SCRYPT_ACQUIRE_TIMEOUT_S` comment's "Per-source backoff cannot prevent
  this…" sentence, which the reservation makes partly untrue: rewrite it to
  say the reservation bounds each source to one waiting thread and the
  timeout bounds what many sources can hold)
- Modify: `server/src/pkm/server/throttle_core.py` (module docstring: the
  caller reserves before the check, not just consults `is_throttled`)
- Modify: `server/tests/test_auth.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, on `LoginThrottle`:
  - `__init__(self, max_concurrent=MAX_CONCURRENT_SCRYPT, acquire_timeout_s=SCRYPT_ACQUIRE_TIMEOUT_S, clock_ms: Callable[[], int] = <monotonic ms>)`
  - `now_ms(self) -> int`
  - `begin_attempt(self, source: str, mono_ms: int) -> bool`: True and
    reserved when the source is not throttled and not in flight; else False.
  - `end_attempt(self, source: str, outcome: Literal["success", "failure", "abandoned"], mono_ms: int) -> None`:
    one lock acquisition that applies the outcome and discards the
    reservation.
  - `is_throttled`, `record_failure`, `record_success` stay (existing unit
    tests use them); the latter two delegate to lock-free private helpers
    that `end_attempt` also calls (`threading.Lock` is not re-entrant).

- [ ] **Step 1: Write the failing route-level tests** in `test_auth.py`.
  Shared helper: replace `pkm.server.auth.verify_password` (monkeypatch)
  with a wrapper that appends to a list and sleeps 0.05 s before calling the
  real one; install `LoginThrottle(clock_ms=lambda: frozen[0])` on
  `anon_client.app.state.login_throttle`; fire requests with
  `asyncio.gather` over an `httpx.AsyncClient` on
  `httpx.ASGITransport(app=anon_client.app, client=(peer, 50000))`.
  - `test_a_concurrent_burst_runs_one_check_per_backoff_window`: 200
    concurrent wrong passwords from `100.64.0.10` -> checks == 1, every
    status 401, every body `{"detail": "wrong password"}`,
    `_attempts["100.64.0.10"].failures == 1`. Advance `frozen[0]` by
    `BASE_BACKOFF_MS`, burst 200 again -> checks == 2, failures == 2.
  - `test_a_burst_from_one_source_does_not_lock_out_another`: start the 200
    burst from `100.64.0.10` and, in the same `gather`, one correct-password
    login from `100.64.0.20` -> that one is 200 and sets `pkm_session`.
- [ ] **Step 2: Run to verify red**
  `cd server && uv run pytest -q tests/test_auth.py -k "burst"`
  Expected: the first FAILS with about 40 checks (the anyio thread limit);
  the second may pass already (it guards the fix, not the bug).
- [ ] **Step 3: Write the unit tests** in `TestLoginThrottle`:
  - `test_a_source_in_flight_is_not_admitted_again`: `begin_attempt("a", 0)`
    True, again False, `begin_attempt("b", 0)` True.
  - `test_end_failure_clears_the_reservation_and_starts_backoff`:
    after `end_attempt("a", "failure", 0)`, `begin_attempt("a", 999)` False,
    `begin_attempt("a", 1_000)` True.
  - `test_end_abandoned_records_nothing`: `begin` then
    `end_attempt("a", "abandoned", 0)` -> `begin_attempt("a", 0)` True and
    `"a" not in _attempts`.
  - `test_end_success_clears_history`.
  - `test_reservations_survive_eviction`: with `MAX_TRACKED_SOURCES`
    monkeypatched to 2, reserve `"x"`, record failures for three other
    sources -> `begin_attempt("x", 0)` still False.
- [ ] **Step 4: Write the release tests** (route level):
  - `test_slot_timeout_releases_the_reservation_and_records_nothing`:
    `LoginThrottle(acquire_timeout_s=0.1)` with every slot held (as in the
    existing saturated-slots test) -> 401; release the slots; the correct
    password from the same client -> 200.
  - `test_an_exception_during_the_check_releases_the_reservation`: the
    wrapped `verify_password` raises `RuntimeError` once; use
    `TestClient(app, raise_server_exceptions=False)` -> 500; then the
    correct password -> 200.
- [ ] **Step 5: Implement.** `login` becomes: read `source` and
  `throttle.now_ms()`; if `not begin_attempt` raise the uniform 401; else
  `outcome = "abandoned"`, and in `try`: the unchanged `scrypt_slot()` block
  (slot timeout raises the uniform 401 leaving `outcome` abandoned), then
  `outcome = "success" if ok else "failure"`; `finally`:
  `end_attempt(source, outcome, throttle.now_ms())`. Then raise the 401 on
  failure or set the cookie on success, as today. The comment above the
  reservation says why it refuses rather than waits and why the release is
  one critical section.
- [ ] **Step 6: Run** `cd server && uv run pytest -q tests/test_auth.py`
  Expected: PASS, including the pre-existing throttle tests.
- [ ] **Step 7: Commit**
  `git add server/src/pkm/server/auth.py server/src/pkm/server/throttle_core.py server/tests/test_auth.py`
  `git commit -m "server: reserve a login attempt per source before the scrypt check"`

### Task 3: Docs, beans and the merge gates (model: opus)

**Files:**
- Modify: `docs/architecture/backend.md` § Auth. Use the `architecture-docs`
  skill. Replace "Under `tailscale serve` every client shares the proxy
  address, so the backoff is effectively global." with: a small table of
  listener -> key (from the Decisions table), the rule that
  `FORWARDED_ALLOW_IPS` in `run.py` must name Serve's upstream and why it is
  explicit, the headers never read for the key, and the reservation rule
  (one check in flight per source; refused, not queued, and why; release
  and record in one critical section).
- Modify: `deploy/README.md`: one sentence where Serve is configured (first
  install, step 1's Serve line, or the Layout section): Serve must proxy to
  `http://127.0.0.1:<port>`; pointing it at another address (the Tailscale
  IP, `localhost` resolving to `::1`) makes every Serve client share one
  login-backoff bucket unless `run.FORWARDED_ALLOW_IPS` changes with it.
- Modify: `docs/troubleshooting.md` § Backend › Writes, conflicts and races,
  two rows:
  - Symptom: 200 concurrent wrong passwords from one source ran 40 scrypt
    checks in 0.3 s (one per backoff window expected). Cause: `login`
    checked the backoff before the password and recorded the failure after,
    with nothing reserving the attempt (`LoginThrottle.begin_attempt`).
    Where: backend.md § Auth. Ref: pkm-v3t1.
  - Symptom: the login backoff key depended on uvicorn defaults; a
    `FORWARDED_ALLOW_IPS=*` in the server's environment would let any client
    choose its key with `X-Forwarded-For`. Cause: `run.py` left
    `proxy_headers`/`forwarded_allow_ips` unset (`run.uvicorn_config`).
    Where: backend.md § Auth. Ref: pkm-lamg.
- Modify: both beans: tick each item, add `## Summary of Changes`, set
  `status: completed`. The SECURITY.md item on pkm-v3t1 is ticked as handed
  to pkm-e95y, whose throttle-keying item already exists.

- [ ] **Step 1:** Update the docs. Verify every claim against the code as
  shipped, not this plan.
- [ ] **Step 2:** `PYTHONPATH=server/tooling python3 -m commentlint.run --all`
  comes back clean.
- [ ] **Step 3:** Merge gates, each with `set -o pipefail`:
  - `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  - `cd web && E2E_PORT=<free port, not 8974> pnpm verify` (the full
    Playwright suite logs in from loopback; it must stay green with the
    reservation)
  - `perf/check.sh backend` on a quiet machine (the login route and the
    harness's login changed). Read any regression per AGENTS.md; put the
    table in the review package.
  - No property gate: no sync, ops, planning, outline or undo code changed.
- [ ] **Step 4: Commit**
  `git add docs/architecture/backend.md deploy/README.md docs/troubleshooting.md .beans/pkm-lamg--login-throttle-key-set-proxy-headers-forwarded-all.md .beans/pkm-v3t1--concurrent-login-guesses-must-serialise-per-source.md`
  `git commit -m "docs: login throttle key per listener and one check per source; complete pkm-lamg, pkm-v3t1"`
