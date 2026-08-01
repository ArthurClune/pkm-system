# pkm-ulae Low-Priority Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete pkm-ulae findings 27–29 by making sidebar append transactional, closing the owned image describer at shutdown, and rendering HTTP statuses exactly once.

**Architecture:** Three file-disjoint child beans execute concurrently in isolated worktrees. Each worker adds failing tests before its minimal production change, verifies and commits only its assigned subsystem, and returns the commit hash; the coordinator reviews and merges every branch with `--no-ff`, updates architecture documentation and the parent epic, then runs the full server verification suite.

**Tech Stack:** Python 3.12, FastAPI/Starlette TestClient, sqlite3 WAL transactions, asyncio, httpx2, pytest, pyrefly, ruff, beans, git worktrees.

## Global Constraints

- Scope is only pkm-ulae findings 27, 28, and 29; unrelated follow-up beans are excluded.
- Every runtime file keeps its existing FCIS declaration; no new runtime module or schema migration is introduced.
- Every behavior change follows red-green-refactor TDD.
- Each worker edits only its listed production/tests/child-bean files; `docs/architecture/backend.md` and parent bean `pkm-ulae` are coordinator-owned.
- Child branches start from the plan commit on `ulae-low-sweep` and are merged with `git merge --no-ff`.
- The final sweep branch is merged to `main` with `git merge --no-ff`; do not push.

---

## File Map

### Track A — pkm-9nzn

- `server/src/pkm/server/routes_sidebar.py`: acquire the SQLite writer reservation before sidebar read/check/allocation and translate duplicate conflicts.
- `server/tests/test_sidebar_endpoint.py`: deterministic concurrent route regressions using two request threads.
- `.beans/pkm-9nzn--make-sidebar-append-concurrency-safe.md`: checklist, status, and implementation summary.

### Track B — pkm-wztk

- `server/src/pkm/describe/service.py`: lifecycle protocol and idempotent service-owned cleanup.
- `server/src/pkm/server/app.py`: failure-safe application teardown ordering.
- `server/tests/fake_describer.py`: close-aware describer doubles.
- `server/tests/test_describe_service.py`: service ownership, ordering, idempotence, and disabled behavior.
- `server/tests/test_describe_openai.py`: HTTP-client close delegation.
- `server/tests/test_assistant_routes.py`: lifespan still closes assistant conversations when describe shutdown raises.
- `.beans/pkm-wztk--close-owned-image-describer-on-shutdown.md`: checklist, status, and implementation summary.

### Track C — pkm-qvus

- `server/src/pkm/client/core.py`: status-neutral friendly detail shaping; `ApiError` remains the only status renderer.
- `server/tests/test_client_core.py`: exact pure formatting strings.
- `server/tests/test_client_api.py`: exact HTTP-originated `ApiError` fields/string and 401 regression.
- `server/tests/test_cli_main_read.py`: exact CLI stderr.
- `server/tests/test_mcp_server.py`: exact MCP-facing exception string.
- `.beans/pkm-qvus--remove-duplicate-http-status-prefixes.md`: checklist, status, and implementation summary.

### Coordinator-owned integration

- `docs/architecture/backend.md`: sidebar allocation transaction and describer ownership/shutdown invariants.
- `.beans/pkm-ulae--server-hardening-from-recent-change-review.md`: mark the historical completed findings, all three low findings, verification, and sweep summary.

---

### Task 1: Prepare and Dispatch Three Isolated Tracks

**Files:**
- Existing: `.beans/pkm-9nzn--make-sidebar-append-concurrency-safe.md`
- Existing: `.beans/pkm-wztk--close-owned-image-describer-on-shutdown.md`
- Existing: `.beans/pkm-qvus--remove-duplicate-http-status-prefixes.md`

**Interfaces:**
- Consumes: clean `ulae-low-sweep` plan commit.
- Produces: branches/worktrees `ulae-low-sidebar`, `ulae-low-describer`, and `ulae-low-errors`, each with its bean in `in-progress`.

- [ ] **Step 1: Verify the sweep baseline before code changes**

Run:

```bash
cd /Users/arthur/code/llm/pkm/.worktrees/ulae-low-sweep/server
uv run pytest -q
uv run pyrefly check
uv run ruff check
```

Expected: all tests pass, pyrefly reports 0 errors, and ruff reports no violations. Stop and report any baseline failure rather than attributing it to a child track.

- [ ] **Step 2: Create child branches and worktrees from the sweep branch**

Run from `/Users/arthur/code/llm/pkm/.worktrees/ulae-low-sweep`:

```bash
git worktree add ../ulae-low-sidebar -b ulae-low-sidebar HEAD
git worktree add ../ulae-low-describer -b ulae-low-describer HEAD
git worktree add ../ulae-low-errors -b ulae-low-errors HEAD
```

Expected: each worktree starts at the same plan commit and `git status --short` is empty.

- [ ] **Step 3: Mark each child bean in progress in its own worktree**

Run the matching command in each worktree:

```bash
beans update pkm-9nzn --status in-progress
beans update pkm-wztk --status in-progress
beans update pkm-qvus --status in-progress
```

Do not update `pkm-ulae` from child worktrees.

- [ ] **Step 4: Dispatch Tasks 2–4 concurrently**

Send one implementation subagent per worktree in one parallel dispatch. Each prompt must include its exact task below, require TDD, require the listed focused verification, forbid architecture/parent-bean edits, and require a final commit hash plus concise red/green evidence.

---

### Task 2: pkm-9nzn — Serialize Sidebar Append

**Files:**
- Modify: `server/src/pkm/server/routes_sidebar.py:26-46`
- Modify: `server/tests/test_sidebar_endpoint.py`
- Modify: `.beans/pkm-9nzn--make-sidebar-append-concurrency-safe.md`

**Interfaces:**
- Consumes: `next_order_idx(list[int]) -> int`, `notify.commit_and_nudge_threadpool(request, db) -> None`, SQLite `BEGIN IMMEDIATE`.
- Produces: unchanged `POST /api/sidebar` success shape; duplicate title always returns HTTP 409 with `{"detail": "entry already exists"}`; concurrent distinct titles receive unique append indexes.

- [ ] **Step 1: Add a deterministic concurrent-request helper and failing regressions**

In `server/tests/test_sidebar_endpoint.py`, import `threading`, `ThreadPoolExecutor`, and `pkm.server.routes_sidebar`. Add a helper that monkeypatches the route's imported `next_order_idx` with a two-caller rendezvous: the first call waits briefly for the second; the second releases it. This forces both requests past the old pre-transaction read while allowing the fixed implementation's first writer to time out, commit, and release the second writer.

Use this shape, retaining the real allocator for the returned value:

```python
def _post_concurrently(client, monkeypatch, titles):
    real_next = routes_sidebar.next_order_idx
    second_arrived = threading.Event()
    call_lock = threading.Lock()
    calls = 0

    def rendezvous(values):
        nonlocal calls
        with call_lock:
            calls += 1
            call = calls
        if call == 1:
            second_arrived.wait(timeout=0.25)
        else:
            second_arrived.set()
        return real_next(values)

    monkeypatch.setattr(routes_sidebar, "next_order_idx", rendezvous)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, "/api/sidebar",
                               json={"title": title})
                   for title in titles]
    return [future.result() for future in futures]
```

Add these assertions:

```python
def test_concurrent_different_titles_get_distinct_append_indexes(
        client, seeded_config, monkeypatch):
    _seed_entries(seeded_config.db_path, [("AWS", 0)])
    responses = _post_concurrently(
        client, monkeypatch, ["Crypto", "Databases"])
    assert [r.status_code for r in responses] == [200, 200]

    con = sqlite3.connect(seeded_config.db_path)
    rows = con.execute(
        "SELECT title, order_idx FROM sidebar_entries"
        " WHERE title IN ('Crypto', 'Databases') ORDER BY order_idx"
    ).fetchall()
    con.close()
    assert [row[1] for row in rows] == [1, 2]
    assert {row[0] for row in rows} == {"Crypto", "Databases"}


def test_concurrent_same_title_returns_one_conflict(
        client, seeded_config, monkeypatch):
    responses = _post_concurrently(
        client, monkeypatch, ["Crypto", "Crypto"])
    assert sorted(r.status_code for r in responses) == [200, 409]
    conflict = next(r for r in responses if r.status_code == 409)
    assert conflict.json() == {"detail": "entry already exists"}

    con = sqlite3.connect(seeded_config.db_path)
    count = con.execute(
        "SELECT count(*) FROM sidebar_entries WHERE title = 'Crypto'"
    ).fetchone()[0]
    con.close()
    assert count == 1
```

If shared TestClient concurrency proves unsupported, create two TestClient instances over the same `create_app(seeded_config)` and authenticate both before submitting; preserve the rendezvous and database assertions.

- [ ] **Step 2: Run the new tests and confirm the old implementation fails**

Run:

```bash
cd server
uv run pytest -q \
  tests/test_sidebar_endpoint.py::test_concurrent_different_titles_get_distinct_append_indexes \
  tests/test_sidebar_endpoint.py::test_concurrent_same_title_returns_one_conflict
```

Expected before implementation: the distinct-title test observes duplicate index `1`, and/or the same-title test observes a 500/uncaught `IntegrityError` instead of `[200, 409]`.

- [ ] **Step 3: Acquire the writer reservation before reading and map conflicts**

In `add_sidebar_entry()`, keep blank-title validation before transaction acquisition. Then implement this transaction shape:

```python
    db.execute("BEGIN IMMEDIATE")
    existing = db.execute(
        "SELECT title, order_idx FROM sidebar_entries").fetchall()
    if any(r["title"] == title for r in existing):
        db.rollback()
        raise HTTPException(status_code=409, detail="entry already exists")
    order_idx = next_order_idx([r["order_idx"] for r in existing])
    try:
        cur = db.execute(
            "INSERT INTO sidebar_entries(title, order_idx) VALUES (?, ?)",
            (title, order_idx))
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="entry already exists") from None
```

Leave `notify.commit_and_nudge_threadpool(request, db)` as the only successful commit and nudge. Do not add an `order_idx` uniqueness constraint or a Python process-local lock.

- [ ] **Step 4: Run focused green tests repeatedly**

Run:

```bash
cd server
uv run pytest -q tests/test_sidebar_endpoint.py tests/test_journal_advancing_contract.py
for i in 1 2 3 4 5; do
  uv run pytest -q \
    tests/test_sidebar_endpoint.py::test_concurrent_different_titles_get_distinct_append_indexes \
    tests/test_sidebar_endpoint.py::test_concurrent_same_title_returns_one_conflict
done
uv run pyrefly check
uv run ruff check src/pkm/server/routes_sidebar.py tests/test_sidebar_endpoint.py
```

Expected: every run passes; no duplicate indexes, 500s, type errors, or lint errors.

- [ ] **Step 5: Complete and summarize pkm-9nzn**

Check every bean checklist item and append:

```markdown
## Summary of Changes

Serialized sidebar title checking and append-index allocation with `BEGIN IMMEDIATE`, translated defensive title uniqueness races to HTTP 409, and added repeated concurrent route regressions for same and different titles.
```

Set the bean to `completed` only after its focused verification passes.

- [ ] **Step 6: Commit the track**

```bash
git add server/src/pkm/server/routes_sidebar.py \
  server/tests/test_sidebar_endpoint.py \
  .beans/pkm-9nzn--make-sidebar-append-concurrency-safe.md
git commit -m "fix(pkm-9nzn): serialize sidebar append allocation"
```

Return the commit hash and the exact failing-before/passing-after evidence.

---

### Task 3: pkm-wztk — Close the Owned Image Describer

**Files:**
- Modify: `server/src/pkm/describe/service.py:27-56`
- Modify: `server/src/pkm/server/app.py:61-67`
- Modify: `server/tests/fake_describer.py`
- Modify: `server/tests/test_describe_service.py`
- Modify: `server/tests/test_describe_openai.py`
- Modify: `server/tests/test_assistant_routes.py`
- Modify: `.beans/pkm-wztk--close-owned-image-describer-on-shutdown.md`

**Interfaces:**
- Consumes: `ImageDescriber.describe(image_bytes: bytes, mime: str) -> Awaitable[str]`, `AssistantService.close_all() -> Awaitable[None]`.
- Produces: `ImageDescriber.close() -> Awaitable[None]`; `DescribeService.close()` stops its worker before closing its owned describer, closes at most once, and remains harmless when disabled.

- [ ] **Step 1: Make test describers lifecycle-aware and add failing service tests**

In `server/tests/fake_describer.py`, add `close_calls = 0`, `events: list[str] = []`, and an async close method to both `FakeDescriber` and `BlockingDescriber`:

```python
    async def close(self) -> None:
        self.close_calls += 1
        self.events.append("closed")
```

For `BlockingDescriber.describe()`, append `"describe-finished"` in a `finally` around its blocking await so cancellation ordering is observable.

In `server/tests/test_describe_service.py`, add:

```python
def test_close_closes_owned_describer_once(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)

    async def run():
        service.start()
        await service.close()
        await service.close()

    asyncio.run(run())
    assert fake.close_calls == 1


def test_close_cancels_worker_before_closing_describer(seeded_config):
    fake = BlockingDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)

    async def run():
        service.start()
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))
        await asyncio.to_thread(fake.started.wait, 5)
        await service.close()

    asyncio.run(run())
    assert fake.events == ["describe-finished", "closed"]
    assert fake.close_calls == 1


def test_close_disabled_service_is_idempotent(seeded_config):
    service = DescribeService(
        seeded_config, None, "OPENAI_API_KEY is not set")
    asyncio.run(service.close())
    asyncio.run(service.close())


def test_start_rejects_reuse_after_close(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(), None)
    asyncio.run(service.close())
    with pytest.raises(RuntimeError, match="describe service is closed"):
        service.start()
```

Add `close()` to the nested `ExplodingDescriber` in the existing worker-survival test so it satisfies the expanded protocol.

- [ ] **Step 2: Add failing HTTP-client delegation and app teardown tests**

In `server/tests/test_describe_openai.py`, add a dedicated test that constructs an injected `httpx2.AsyncClient`, awaits `OpenAIDescriber.close()`, and asserts `http.is_closed is True`. Refactor `_describe()` to close its injected client in `finally` so existing tests do not leak transports.

In `server/tests/test_assistant_routes.py`, add a close-failing describer (or use `FakeDescriber` with a test-only `close_error`) and a lifespan test with a real `FakeEngine` conversation:

```python
def test_app_shutdown_closes_assistant_when_describer_close_fails(
        seeded_config):
    engine = FakeEngine()
    describer = CloseFailingDescriber()
    service = DescribeService(seeded_config, describer, None)
    app = create_app(
        seeded_config, assistant_engine=engine, describe_service=service)

    with pytest.raises(RuntimeError, match="describe close failed"):
        with TestClient(app) as client:
            client.post("/api/login", json={"password": "test-pw"})
            client.post("/api/assistant/conversations", json={})

    assert engine.conversations[0].closed is True
```

The close-failing describer must implement both protocol methods and raise only from `close()`.

- [ ] **Step 3: Run the new tests and confirm they fail for lifecycle reasons**

Run:

```bash
cd server
uv run pytest -q \
  tests/test_describe_service.py::test_close_closes_owned_describer_once \
  tests/test_describe_service.py::test_close_cancels_worker_before_closing_describer \
  tests/test_describe_service.py::test_close_disabled_service_is_idempotent \
  tests/test_describe_service.py::test_start_rejects_reuse_after_close \
  tests/test_describe_openai.py \
  tests/test_assistant_routes.py::test_app_shutdown_closes_assistant_when_describer_close_fails
```

Expected before implementation: fake `close_calls` remains zero and the application skips assistant cleanup when describe close raises.

- [ ] **Step 4: Define ownership and implement idempotent service shutdown**

In `ImageDescriber`, add:

```python
    async def close(self) -> None:
        """Release resources owned by this describer."""
        ...
```

In `DescribeService.__init__`, add `self._closed = False`. Make `start()` reject reuse after shutdown:

```python
        if self._closed:
            raise RuntimeError("describe service is closed")
```

Implement close with the state transition before its first await so concurrent callers cannot both close the transport:

```python
    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._task is not None:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
                self._task = None
        finally:
            if self._describer is not None:
                await self._describer.close()
```

This ordering ensures the worker cannot use the transport after closure. Do not special-case `OpenAIDescriber` in `app.py`.

- [ ] **Step 5: Make application teardown attempt both owned services**

In `_lifespan()` preserve startup/yield and replace sequential teardown with:

```python
    try:
        await app.state.describe.close()
    finally:
        await app.state.assistant.close_all()
```

This preserves describe failures when assistant cleanup succeeds while guaranteeing the assistant cleanup attempt.

- [ ] **Step 6: Run lifecycle-focused green verification**

Run:

```bash
cd server
uv run pytest -q \
  tests/test_describe_service.py \
  tests/test_describe_openai.py \
  tests/test_describe_routes.py \
  tests/test_assistant_routes.py
uv run pyrefly check
uv run ruff check \
  src/pkm/describe/service.py src/pkm/server/app.py \
  tests/fake_describer.py tests/test_describe_service.py \
  tests/test_describe_openai.py tests/test_assistant_routes.py
```

Expected: all lifecycle and existing worker/route/assistant tests pass, pyrefly reports 0 errors, and ruff is clean.

- [ ] **Step 7: Complete and summarize pkm-wztk**

Check every bean checklist item and append:

```markdown
## Summary of Changes

Made `DescribeService` the explicit owner of its `ImageDescriber`, added idempotent worker-first shutdown and HTTP-client closure, and made app teardown attempt assistant cleanup even when describe cleanup fails. Added service, transport, and lifespan regressions.
```

Set the bean to `completed` only after focused verification passes.

- [ ] **Step 8: Commit the track**

```bash
git add server/src/pkm/describe/service.py server/src/pkm/server/app.py \
  server/tests/fake_describer.py server/tests/test_describe_service.py \
  server/tests/test_describe_openai.py server/tests/test_assistant_routes.py \
  .beans/pkm-wztk--close-owned-image-describer-on-shutdown.md
git commit -m "fix(pkm-wztk): close owned image describer"
```

Return the commit hash and the exact failing-before/passing-after evidence.

---

### Task 4: pkm-qvus — Render HTTP Status Once

**Files:**
- Modify: `server/src/pkm/client/core.py:43-57`
- Modify: `server/tests/test_client_core.py`
- Modify: `server/tests/test_client_api.py`
- Modify: `server/tests/test_cli_main_read.py`
- Modify: `server/tests/test_mcp_server.py`
- Modify: `.beans/pkm-qvus--remove-duplicate-http-status-prefixes.md`

**Interfaces:**
- Consumes: `ApiError(status: int, message: str)` and `friendly_error(status: int, detail: object) -> str`.
- Produces: status-neutral `friendly_error` detail; `str(ApiError(404, "page not found")) == "404: page not found"` for client, CLI, and MCP callers.

- [ ] **Step 1: Tighten pure formatting tests to exact failing strings**

Replace substring assertions in `server/tests/test_client_core.py` with:

```python
def test_friendly_error_401_suggests_login():
    assert friendly_error(401, "unauthorized") == (
        "session expired or missing — run `pkm login`")


def test_friendly_error_renders_ops_detail_dict():
    assert friendly_error(
        400, {"index": 2, "reason": "block not found: x"}
    ) == "op 2: block not found: x"


def test_friendly_error_plain_detail():
    assert friendly_error(404, "page not found") == "page not found"


def test_api_error_carries_status_message_and_single_prefix():
    e = ApiError(409, "conflict")
    assert (e.status, e.message) == (409, "conflict")
    assert str(e) == "409: conflict"
```

- [ ] **Step 2: Add exact client, CLI, and MCP regressions**

In `server/tests/test_client_api.py`, strengthen the missing-page test:

```python
    assert e.value.status == 404
    assert e.value.message == "page not found"
    assert str(e.value) == "404: page not found"
```

Strengthen the unauthorized test to assert:

```python
    assert str(exc.value) == (
        "401: session expired or missing — run `pkm login`")
```

In `server/tests/test_cli_main_read.py`, replace the missing-page substring assertion with:

```python
    assert err == "404: page not found\n"
```

In `server/tests/test_mcp_server.py`, add:

```python
def test_missing_page_error_has_one_status_prefix(tools):
    with pytest.raises(ApiError) as exc:
        tools.get_page("No Such Page")
    assert str(exc.value) == "404: page not found"
```

Add this status-zero ownership assertion to `test_client_core.py`:

```python
def test_api_error_status_zero_has_one_prefix():
    assert str(ApiError(0, "network unavailable")) == "0: network unavailable"
```

This pins transport/schema-style status rendering without depending on a live transport failure.

- [ ] **Step 3: Run the exact-string tests and confirm current duplication fails**

Run:

```bash
cd server
uv run pytest -q \
  tests/test_client_core.py \
  tests/test_client_api.py::test_api_error_carries_friendly_message \
  tests/test_client_api.py::test_unauthenticated_client_gets_login_hint \
  tests/test_cli_main_read.py::test_get_missing_page_exits_1_with_stderr \
  tests/test_mcp_server.py::test_missing_page_error_has_one_status_prefix
```

Expected before implementation: plain/operation friendly details and downstream 404 strings contain the unwanted numeric prefix.

- [ ] **Step 4: Make friendly detail shaping status-neutral**

In `friendly_error()`, retain the `status` argument for the 401 branch but remove numeric formatting from every returned detail:

```python
def friendly_error(status: int, detail: object) -> str:
    if status == 401:
        return "session expired or missing — run `pkm login`"
    if isinstance(detail, dict) and "reason" in detail:
        index = detail.get("index")
        prefix = f"op {index}: " if index is not None else ""
        return f"{prefix}{detail['reason']}"
    return str(detail)
```

Do not change `ApiError`, `PkmClient._request()`, `login()`, CLI handlers, or MCP handlers. Their existing construction/rendering becomes correct once detail shaping is status-neutral.

- [ ] **Step 5: Run focused green verification**

Run:

```bash
cd server
uv run pytest -q \
  tests/test_client_core.py tests/test_client_api.py \
  tests/test_cli_main_read.py tests/test_mcp_server.py \
  tests/test_client_contracts.py
uv run pyrefly check
uv run ruff check \
  src/pkm/client/core.py tests/test_client_core.py \
  tests/test_client_api.py tests/test_cli_main_read.py tests/test_mcp_server.py
```

Expected: all exact strings contain one status prefix, existing 401/operation/schema behavior remains green, pyrefly reports 0 errors, and ruff is clean.

- [ ] **Step 6: Complete and summarize pkm-qvus**

Check every bean checklist item and append:

```markdown
## Summary of Changes

Made `friendly_error()` shape status-neutral details and retained `ApiError` as the sole numeric status renderer. Added exact core, client, CLI, MCP, 401, operation-detail, and status-zero regression coverage.
```

Set the bean to `completed` only after focused verification passes.

- [ ] **Step 7: Commit the track**

```bash
git add server/src/pkm/client/core.py server/tests/test_client_core.py \
  server/tests/test_client_api.py server/tests/test_cli_main_read.py \
  server/tests/test_mcp_server.py \
  .beans/pkm-qvus--remove-duplicate-http-status-prefixes.md
git commit -m "fix(pkm-qvus): render HTTP status once"
```

Return the commit hash and the exact failing-before/passing-after evidence.

---

### Task 5: Review and Merge the Three Child Branches

**Files:**
- Review every file listed in Tasks 2–4.

**Interfaces:**
- Consumes: one completed commit from each child branch.
- Produces: three reviewed `--no-ff` merges on `ulae-low-sweep` with no child worktree changes left uncommitted.

- [ ] **Step 1: Review actual child diffs and bean states**

Run the exact review commands:

```bash
git diff --check ulae-low-sweep...ulae-low-sidebar
git diff --stat ulae-low-sweep...ulae-low-sidebar
git diff ulae-low-sweep...ulae-low-sidebar -- \
  server/src/pkm/server/routes_sidebar.py \
  server/tests/test_sidebar_endpoint.py \
  .beans/pkm-9nzn--make-sidebar-append-concurrency-safe.md
beans show --json pkm-9nzn

git diff --check ulae-low-sweep...ulae-low-describer
git diff --stat ulae-low-sweep...ulae-low-describer
git diff ulae-low-sweep...ulae-low-describer -- \
  server/src/pkm/describe/service.py server/src/pkm/server/app.py \
  server/tests/fake_describer.py server/tests/test_describe_service.py \
  server/tests/test_describe_openai.py server/tests/test_assistant_routes.py \
  .beans/pkm-wztk--close-owned-image-describer-on-shutdown.md
beans show --json pkm-wztk

git diff --check ulae-low-sweep...ulae-low-errors
git diff --stat ulae-low-sweep...ulae-low-errors
git diff ulae-low-sweep...ulae-low-errors -- \
  server/src/pkm/client/core.py server/tests/test_client_core.py \
  server/tests/test_client_api.py server/tests/test_cli_main_read.py \
  server/tests/test_mcp_server.py \
  .beans/pkm-qvus--remove-duplicate-http-status-prefixes.md
beans show --json pkm-qvus
```

Also inspect each full `git diff --name-only` and reject edits outside the assigned files, unchecked bean items, missing summaries, broad refactors, status/schema changes, or tests that cannot fail against the pre-fix code.

- [ ] **Step 2: Run focused verification independently in each child worktree**

Re-run the exact focused test/type/lint commands from Tasks 2–4. Do not rely only on the worker's summary.

- [ ] **Step 3: Merge each approved branch preserving history**

From `ulae-low-sweep`:

```bash
git merge --no-ff ulae-low-sidebar -m "Merge pkm-9nzn sidebar concurrency fix"
git merge --no-ff ulae-low-describer -m "Merge pkm-wztk describer lifecycle fix"
git merge --no-ff ulae-low-errors -m "Merge pkm-qvus error formatting fix"
```

Expected: no production-file conflicts. Resolve only mechanical bean-file metadata conflicts after comparing both versions; never discard a completed checklist or summary.

- [ ] **Step 4: Run all directly affected tests on the merged sweep**

```bash
cd server
uv run pytest -q \
  tests/test_sidebar_endpoint.py tests/test_journal_advancing_contract.py \
  tests/test_describe_service.py tests/test_describe_openai.py \
  tests/test_describe_routes.py tests/test_assistant_routes.py \
  tests/test_client_core.py tests/test_client_api.py \
  tests/test_client_contracts.py tests/test_cli_main_read.py \
  tests/test_mcp_server.py
```

Expected: all pass together.

---

### Task 6: Update Architecture and Finish pkm-ulae

**Files:**
- Modify: `docs/architecture/backend.md`
- Modify: `.beans/pkm-ulae--server-hardening-from-recent-change-review.md`

**Interfaces:**
- Consumes: merged, reviewed behavior from Tasks 2–4.
- Produces: current architecture invariants and a completed parent epic with verification evidence.

- [ ] **Step 1: Document the sidebar transaction invariant**

In the API/sidebar section of `docs/architecture/backend.md`, state that POST append acquires SQLite's write reservation before checking title uniqueness and calculating `max(order_idx) + 1`; same-title races return 409 and distinct concurrent appends cannot share an index. Do not claim `order_idx` has a schema uniqueness constraint.

Also correct the stale API-table phrase that calls `POST /api/ops` the only write path: describe it as the transactional block-operation write path, because page, sidebar, asset, and other route writes are already enumerated below it.

- [ ] **Step 2: Document describer ownership and shutdown ordering**

In the image-description section, add that `DescribeService` owns its injected `ImageDescriber`, stops the worker before closing the provider transport, and closes it once during app-lifespan shutdown. Note that application teardown still attempts assistant conversation cleanup when describer cleanup fails.

- [ ] **Step 3: Run architecture count/invariant checks**

Search for stale statements:

```bash
rg -n "only write path|sidebar|ImageDescriber|DescribeService|shutdown|httpx2" \
  docs/architecture docs/superpowers/specs
```

Expected: no contradictory current-state claim remains. Historical specs may describe their original state and need not be rewritten.

- [ ] **Step 4: Run the full server verification suite**

From `/Users/arthur/code/llm/pkm/.worktrees/ulae-low-sweep`:

```bash
cd server
uv run pytest -q
uv run pyrefly check
uv run ruff check
```

Capture exact test count, coverage, type-check result, and lint result. Any failure reopens the responsible child bean before fixing it in that child branch and re-merging with `--no-ff`.

- [ ] **Step 5: Update and complete pkm-ulae**

Use exact beans body replacements to mark findings 27–29 and verification/documentation checklist entries complete. Historical high/medium checklist items are already evidenced by the epic's two completed sweep summaries; mark those historical items complete so the epic contains no unchecked work. Append:

```markdown
## Low-priority sweep — completed 2026-08-01

All three lower-priority findings (27–29) were fixed via child beans and isolated branches, developed test-first, independently reviewed, and merged with `--no-ff`.

- Finding 27 → pkm-9nzn (completed): SQLite writer reservation serializes sidebar append allocation; duplicate races return 409.
- Finding 28 → pkm-wztk (completed): DescribeService owns and closes its describer after worker shutdown; app teardown remains failure-safe.
- Finding 29 → pkm-qvus (completed): friendly details are status-neutral and ApiError renders one numeric prefix.

Architecture documentation records the sidebar and describer lifecycle invariants.
```

Immediately after that paragraph, add a `Full server verification:` sentence containing the exact pytest test count and coverage copied from Step 4, followed by `pyrefly 0 errors; ruff clean.` Never write an estimated count. Add a `## Summary of Changes` section explaining that all 29 review findings were completed across the three priority sweeps. Set `pkm-ulae` to `completed` only after `beans show --json pkm-ulae` has no unchecked checklist item.

- [ ] **Step 6: Commit integration documentation and epic completion**

```bash
git add docs/architecture/backend.md \
  .beans/pkm-ulae--server-hardening-from-recent-change-review.md
git commit -m "docs(pkm-ulae): complete server hardening sweep"
```

- [ ] **Step 7: Verify the sweep branch is clean and internally consistent**

```bash
git status --short
git diff --check main...HEAD
beans show --json pkm-9nzn pkm-wztk pkm-qvus pkm-ulae
git log --graph --decorate --oneline main..HEAD
```

Expected: clean status, no whitespace errors, four completed beans, and three visible child merge commits.

---

### Task 7: Merge the Verified Sweep to Main

**Files:**
- No new source changes expected.

**Interfaces:**
- Consumes: clean, fully verified `ulae-low-sweep` branch.
- Produces: local `main` containing the complete sweep through one `--no-ff` merge.

- [ ] **Step 1: Confirm main has not diverged unexpectedly**

From `/Users/arthur/code/llm/pkm`:

```bash
git status --short
git log -1 --oneline main
git merge-base --is-ancestor main ulae-low-sweep
```

Expected: main is clean and remains an ancestor of the sweep. If main advanced, merge main into the sweep with `--no-ff`, resolve, and rerun Task 6 Step 4 before continuing.

- [ ] **Step 2: Merge the sweep preserving branch history**

```bash
git merge --no-ff ulae-low-sweep -m "Merge pkm-ulae low-priority hardening sweep"
```

Do not push.

- [ ] **Step 3: Prove the merged tree is the verified sweep tree**

```bash
test "$(git rev-parse main^{tree})" = "$(git rev-parse ulae-low-sweep^{tree})"
git status --short
git log --graph --decorate --oneline -12
```

Expected: identical tree hashes, clean main, the sweep merge visible, and all three child branch merges retained beneath it.

- [ ] **Step 4: Report completion evidence**

Summarize production behavior, tests added, docs updated, child bean IDs, branch/merge structure, exact full verification output, and the local main merge commit. Explicitly state that no remote push was performed.
