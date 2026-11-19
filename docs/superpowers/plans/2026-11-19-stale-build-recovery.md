# Stale Build Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app notices when the server serves a different build, offers a
banner with a clean reload, and the error screen's Reload does the same clean
reload.

**Architecture:** A Vite plugin stamps one id per build into the bundle and
`dist/build-id.json`; the server reads the file at startup and sets
`X-Pkm-Build` on every response; `apiFetch` feeds that header to a small store
whose skew rule is a Functional Core function; a banner and the error boundary
call one `cleanReload()` shell module.

**Tech Stack:** FastAPI/Starlette ASGI middleware, Vite plugin API, React 19
`useSyncExternalStore`, vitest, Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-11-19-stale-build-recovery-design.md`

Work in `/Users/arthur/code/llm/pkm/.worktrees/stale-build-recovery` on
branch `fix/stale-build-recovery`. Bean: `pkm-tybk` (check its items off as
tasks land; commit the bean file with the code).

## Global Constraints

- Header name `X-Pkm-Build`; file name `build-id.json` holding
  `{"build": "<id>"}`; the bundle's id under `vite serve` (dev and vitest) is
  `dev`, and `dev` never counts as skew.
- A build id is accepted by the server only if it matches
  `^[A-Za-z0-9-]{1,64}$`; anything else means no header.
- A clean reload never touches OPFS or IndexedDB, and never unregisters or
  deletes caches unless `GET /healthz` (with `cache: "no-store"`) answered OK.
- No automatic reload anywhere.
- Banner copy: "A newer version of pkm is available." and a button "Reload".
- Every new runtime file declares its FCIS pattern; comments follow the
  AGENTS.md comment rules (no bean ids, ≤ 80 columns).

## Review Focus

- The server is unreachable when Reload is pressed (offline phone): plain
  `location.reload()`, the service worker and caches untouched. Task 4.
- Unregistering or a cache delete rejects: the reload still navigates to
  `/`, it never strands the user on the error screen. Task 4.
- The app is offline and reads go to the replica shim, including the shim
  fallback after a failed `fetch`: no header, never compared, no banner.
  Task 3.
- The browser lacks `navigator.serviceWorker` (non-secure context, tests):
  the clean reload still deletes caches and navigates. Task 4.
- A logged-out stale PWA: its first responses are 401s from the auth gate;
  those carry the header too, so skew is noted before the login redirect,
  and `/healthz` is public so the clean reload still works. Tasks 1 and 3.

---

### Task 1: Server sends `X-Pkm-Build`

**Files:**
- Create: `server/src/pkm/server/build_stamp.py` (`# pattern: Imperative Shell`)
- Modify: `server/src/pkm/server/app.py` (where `add_middleware` calls sit in
  `create_app`)
- Test: `server/tests/test_build_stamp.py` (reuse `_dist`/`_config` shapes
  from `test_spa.py`; copy, don't import private helpers if lint objects)

**Interfaces:**
- Produces: `read_build_id(web_dist: Path) -> str | None`;
  `class BuildHeaderMiddleware` (ASGI, `__init__(self, app: ASGIApp, build: str)`),
  modelled on `SecurityHeadersMiddleware`.

- [ ] **Step 1: Write the failing tests**

```python
def test_header_on_spa_healthz_and_unauthenticated_api(tmp_path):
    dist = _dist(tmp_path)
    (dist / "build-id.json").write_text('{"build": "abc-123"}')
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    assert client.get("/").headers["x-pkm-build"] == "abc-123"
    assert client.get("/healthz").headers["x-pkm-build"] == "abc-123"
    r = client.get("/api/sidebar")
    assert r.status_code == 401 and r.headers["x-pkm-build"] == "abc-123"

@pytest.mark.parametrize("content", [
    None, "not json", '{"nope": 1}', '{"build": 7}', '{"build": ""}',
    '{"build": "a\\r\\nb"}', '{"build": "' + "x" * 65 + '"}'])
def test_no_header_without_a_valid_stamp(tmp_path, content): ...
    # content None = no file; assert "x-pkm-build" not in headers of GET /

def test_no_header_without_web_dist(tmp_path): ...  # /healthz
```

- [ ] **Step 2: Run** `cd server && uv run pytest -q tests/test_build_stamp.py`
  — expected FAIL (module missing / header absent).
- [ ] **Step 3: Implement** `read_build_id` (read and `json.loads` the file,
  return `None` with a logged warning on a missing file, OSError, bad JSON,
  a non-string or non-matching id) and `BuildHeaderMiddleware`; in
  `create_app`, when `config.web_dist` is set and `read_build_id` returns an
  id, `app.add_middleware(BuildHeaderMiddleware, build=build)`.
- [ ] **Step 4: Run** the test file, then `uv run pytest -q`,
  `uv run pyrefly check`, `uv run ruff check` — all pass.
- [ ] **Step 5: Commit** `feat(server): advertise the served web build in X-Pkm-Build (pkm-tybk)`

### Task 2: Build stamp in the bundle and `dist`

**Files:**
- Create: `web/tooling/buildStampPlugin.ts`, `web/tooling/buildStampPlugin.test.ts`
- Modify: `web/vite.config.ts` (add to `plugins`), `web/src/vite-env.d.ts`
  (`declare const __PKM_BUILD__: string;`)

**Interfaces:**
- Produces: `buildStampPlugin(makeId?: () => string): Plugin` (default
  `() => crypto.randomUUID()`); global `__PKM_BUILD__: string` in the bundle.

- [ ] **Step 1: Write the failing tests** — call the hooks directly:
  `config({}, { command: "build", mode: "production" })` returns
  `{ define: { __PKM_BUILD__: JSON.stringify("fixed") } }` with
  `makeId = () => "fixed"`; with `command: "serve"` the value is
  `JSON.stringify("dev")`; `generateBundle` invoked with a stub
  `this.emitFile` records
  `{ type: "asset", fileName: "build-id.json", source: '{"build":"fixed"}' }`;
  under `serve`, `generateBundle` emits nothing (`apply: "build"` or a guard).
- [ ] **Step 2: Run** `cd web && pnpm test:unit tooling/buildStampPlugin`
  — expected FAIL.
- [ ] **Step 3: Implement** the plugin; call `makeId` once per plugin
  instance so define and file share the value.
- [ ] **Step 4: Verify** `cd web && pnpm build && cat dist/build-id.json`
  shows an id, and `grep -l "$(jq -r .build dist/build-id.json)" dist/app-assets/index-*.js`
  finds it in the entry chunk. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web): stamp each build's id into the bundle and dist (pkm-tybk)`

### Task 3: Skew rule, store, and the fetch wrapper

**Files:**
- Create: `web/src/buildSkewCore.ts` (Functional Core) + `.test.ts`;
  `web/src/staleBuild.ts` (Imperative Shell store) + `.test.ts`
- Modify: `web/src/api/client.ts` (`apiFetch`, `apiDownload`); its tests in
  `web/src/api/client.test.ts`

**Interfaces:**
- Consumes: `__PKM_BUILD__` (Task 2).
- Produces: `isStaleBuild(own: string, served: string | null): boolean`;
  `noteServedBuild(served: string | null, own?: string): void` (default
  `own = __PKM_BUILD__`), `isBuildStale(): boolean`,
  `subscribeStaleBuild(cb: () => void): () => void`. Follow the store and
  test-reset pattern of `web/src/outline/droppedDrafts.ts`. Once stale, it
  stays stale.

- [ ] **Step 1: Write the failing tests**
  - core: `isStaleBuild("a","b")` true; `("a","a")` false; `("a",null)`
    false; `("dev","b")` false.
  - store: `noteServedBuild("b","a")` flips `isBuildStale()` and notifies a
    subscriber once; a later `noteServedBuild("a","a")` keeps it stale;
    `noteServedBuild(null,"a")` leaves it fresh.
  - client: a mocked `fetch` whose response carries `X-Pkm-Build: other`
    makes `isBuildStale()` true after `apiFetch` (also for a 401 response);
    with the gateway offline (`localFetch` path) and on the shim fallback
    after `fetch` rejects, `isBuildStale()` stays false.
- [ ] **Step 2: Run** `cd web && pnpm test:unit buildSkewCore staleBuild api/client`
  — expected FAIL.
- [ ] **Step 3: Implement**; in `apiFetch` call
  `noteServedBuild(res.headers.get("X-Pkm-Build"))` immediately after the
  `fetch` resolves (before the 401/`ok` checks); same in `apiDownload`.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web): note when the server serves another build (pkm-tybk)`

### Task 4: Clean reload, the banner, and the error screen

**Files:**
- Create: `web/src/cleanReload.ts` (Imperative Shell) + `.test.ts`;
  `web/src/components/StaleBuildNotice.tsx` + `.test.tsx`
- Modify: `web/src/components/ErrorBoundary.tsx` + `.test.tsx`;
  `web/src/App.tsx` (banner stack, after `<DroppedDraftNotice />`)

**Interfaces:**
- Consumes: `isBuildStale`, `subscribeStaleBuild` (Task 3).
- Produces: `cleanReload(): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (stub globals with `vi.stubGlobal`
  / spies on `navigator.serviceWorker`, `caches`, `location`):
  - healthz OK → every `getRegistrations()` entry's `unregister` called,
    every `caches.keys()` name deleted, then `location.assign("/")`.
  - healthz rejects, and healthz non-OK → `location.reload()` only; no
    unregister, no delete, no assign.
  - `unregister` rejects and `caches.delete` rejects → still
    `location.assign("/")`.
  - `navigator.serviceWorker` undefined → caches still deleted, assign called.
  - healthz fetched as `fetch("/healthz", { cache: "no-store" })`.
  - `StaleBuildNotice`: renders nothing while fresh; after
    `noteServedBuild("b","a")` shows "A newer version of pkm is available."
    in a `.ws-banner.stale-build` with `role="status"`; clicking "Reload"
    calls `cleanReload` (mock the module).
  - `ErrorBoundary`: the fallback has a "Reload" button that calls
    `cleanReload` (replace the old `href="/"` assertion).
- [ ] **Step 2: Run** `cd web && pnpm test:unit cleanReload StaleBuildNotice ErrorBoundary`
  — expected FAIL.
- [ ] **Step 3: Implement**; each step of the clean reload catches its own
  failure so navigation always happens. The banner uses the existing
  `ws-banner` class plus `stale-build`; add CSS only if the stack needs it.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(web): banner and error-screen clean reload for a stale build (pkm-tybk)`

### Task 5: End-to-end spec, docs, verification

**Files:**
- Create: `web/e2e/stale-build.spec.ts` (import `test` from `./ownPage`)
- Modify: `docs/architecture/backend.md`, `docs/architecture/frontend.md`
  (invoke the `architecture-docs` skill), bean `pkm-tybk`

- [ ] **Step 1: Write the spec**
  - "a matching build shows no banner": after login, a real `/api/sidebar`
    response has a non-empty `x-pkm-build` header, and `.stale-build` has
    count 0 (proves the stamp and the server file agree).
  - "a different build shows the banner, and Reload clears the shell but
    keeps the replica": wait for the SW to control the page (as
    `offline-shell.spec.ts` does); create `caches.open("e2e-marker")`;
    record `navigator.storage.getDirectory()` entry names; `page.route`
    `**/api/sidebar` to `route.fetch()` then `route.fulfill` with
    `x-pkm-build: "other"`; trigger a sidebar load (reload); expect the
    banner; unroute; click Reload; expect `caches.has("e2e-marker")` false,
    the OPFS entry names unchanged, and no banner.
- [ ] **Step 2: Run** `cd web && E2E_PORT=8975 pnpm e2e stale-build` — passes
  (it exercises shipped code from Tasks 1–4).
- [ ] **Step 3: Docs** — `backend.md`: state that every response carries
  `X-Pkm-Build` when `web_dist/build-id.json` holds a valid id (read once at
  startup, so deploy must rebuild before restart, which `update.sh` does).
  `frontend.md` § Build notes: the stamp, the banner, and the rule that a
  clean reload probes `/healthz` first and never touches OPFS/IndexedDB,
  with the reason (offline with no service worker boots nothing; the replica
  holds pending edits).
- [ ] **Step 4: Verify** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`;
  `cd web && set -o pipefail && pnpm verify`. All pass. `perf/check.sh` before
  merge (frontend touches `client.ts`).
- [ ] **Step 5: Commit** spec, docs and the bean (items checked, Summary of
  Changes naming the error text) —
  `test(web): e2e for stale-build recovery; docs (pkm-tybk)`
