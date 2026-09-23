# PKM implementation review handoff

**Date:** 2026-07-10  
**Reviewer:** Codex  
**Scope:** Whole repository: implementation quality, consistency, tests,
security, type usage, and alignment with `README.md` and the linked design and
implementation documents.  
**Status:** Review complete; no code fixes were made as part of this review.

## Executive assessment

The codebase is in good shape overall (see *Strengths to preserve* and
*Security review*), but it is **not production-ready until the four Important
findings below are fixed**. The highest-confidence one is a SQLite connection race that produced
HTTP 500s on both Playwright runs while the test process exited successfully.
The others affect cross-client consistency, paused writes during
disconnection, and backup availability.

No Critical security vulnerability was found within the documented deployment
model. The authentication layer is defense in depth behind Tailscale and does
not justify exposing the service publicly.

## Confirmed findings

### 1. Important: per-request WAL and DDL setup causes database-lock 500s

**Locations**

- `server/src/pkm/server/db.py:14-23`
- `server/src/pkm/server/db.py:31-36`
- The E2E server is started by `server/tests/e2e_serve.py:23-44`.

**What happens**

`open_db()` runs this on every request-created connection:

```python
con.execute("PRAGMA foreign_keys=ON")
con.execute("PRAGMA journal_mode=WAL")
con.executescript(SIDEBAR_ENTRIES_DDL)
```

`journal_mode=WAL` persists in the database file, so it does not need setting
per request. `executescript()` does schema work and can take locks. Under
normal concurrent browser activity, a request can fail before its route
function runs.

**Evidence**

`pnpm e2e` was run twice from `web/`. Both runs reported `2 passed`, and both
server logs contained this exception during ordinary editing:

```text
File "server/src/pkm/server/db.py", line 18, in open_db
    con.execute("PRAGMA journal_mode=WAL")
sqlite3.OperationalError: database is locked
```

The E2E harness does not fail when the server logs an unobserved 500.

**Impact**

- Multi-request or multi-client activity can intermittently return 500.
- A background autocomplete, refetch, or similar request can fail without
  failing the browser test or showing the user a durable error.
- It contradicts the design claim that WAL makes reads reliably concurrent
  with writes.

**Recommended fix**

1. Apply schema migrations and `PRAGMA journal_mode=WAL` once during database
   initialization/application startup, before serving requests.
2. Keep only connection-local configuration such as `foreign_keys=ON` in
   `open_db()`.
3. Set and document a `busy_timeout`/connection timeout for writer contention.
4. Replace the `SIDEBAR_ENTRIES_DDL`-on-open migration with an explicit,
   idempotent migration/startup step.

**Regression coverage**

- A backend concurrency test that opens read connections while an ops
  transaction is committing.
- Make the Playwright harness fail on unexpected server exceptions or HTTP 5xx
  responses, even when the visible assertions pass.

### 2. Important: focusing a block discards remote text updates without a local draft

**Locations**

- `web/src/outline/useOutline.ts:119-136`
- Codified by `web/src/views/EditablePage.test.tsx:77-86`.

**What happens**

Remote `update_text` operations are filtered only by whether their UID is the
focused block:

```ts
const ops = batch.ops.filter((op) =>
  !(op.op === "update_text" && op.uid === focusRef.current?.uid));
```

The comment says this lets a local draft win, but focus does not imply a
draft. A user can click into a block, type nothing, and receive a newer update
from another client. The server commits the remote update; the focused client
keeps the old text until an unrelated refetch or navigation. Blurring without
typing does not repair it, because there is no pending text operation to
flush.

**Impact**

- Two clients can visibly disagree while the WebSocket is connected.
- The client stops reflecting the server's last writer.
- A later edit from the stale client can overwrite the unseen remote change.

**Recommended fix**

Base conflict behavior on a pending draft. One approach: apply the remote text
to the block tree even while the textarea keeps its local component draft;
when a real local draft flushes, it becomes the next last writer. The UX can
vary, but the no-draft case must adopt the remote value.

**Regression coverage**

- Focused block, no local change: remote update is displayed/adopted.
- Focused block with a pending local draft: verify the chosen LWW behavior.
- Focus then blur without editing after a remote update: client and server
  stay consistent.

### 3. Important: writes are not paused when the WebSocket disconnects

**Locations**

- `web/src/sync/SyncProvider.tsx:52-89`
- `web/src/sync/opQueue.ts:22-72`
- Pending debounce and asynchronous upload paths in
  `web/src/outline/useOutline.ts:42-100` and `:180-203`.
- The promised invariant is documented in
  `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md:117-120`.

**What happens**

The UI becomes read-only when `status !== "connected"`, but the queue has no
connection state. `SyncProvider` always exposes:

```ts
enqueue: (ops) => queue.enqueue(ops)
```

and the queue sends HTTP immediately. Operations whose asynchronous work began
while connected can be posted after the WebSocket has gone down:

- A text debounce starts, the socket drops, and the 500 ms timer fires.
- An image upload starts, the socket drops, and the completion callback
  creates an `update_text` operation.
- A structural action already in flight crosses the status transition.

This breaks the design claim that disconnection pauses writes so divergence is
impossible.

**Impact**

- HTTP operations may commit while the client has no broadcast channel.
- If HTTP also fails, the optimistic mutation is followed by a one-shot resync;
  failed resyncs are swallowed and may leave stale state.
- The safety property is weaker than the documentation and UI imply.

**Recommended fix**

Give the queue connectivity state. When offline, hold pending operations or
drafts without sending them. On reconnect, apply the authoritative-state
policy first, then flush safe pending work or discard it with a user-visible
reconciliation. Do not silently drop `enqueue()` calls; that loses data.

**Regression coverage**

- Type text, disconnect before the debounce, advance the timer, and assert no
  HTTP POST occurs.
- Complete an upload after disconnection and assert no op is sent.
- Reconnect and verify the documented handling of held pending work.
- Exercise an in-flight POST whose socket drops before the response.

### 4. Important: an unbounded uploaded filename can disable nightly exports

**Locations**

- `server/src/pkm/server/routes_assets.py:79-88`
- `server/src/pkm/export/markdown.py:37-38`
- `server/src/pkm/export/writer.py:60-70`

**What happens**

The upload route strips directory components with `Path(...).name` but does
not bound the filename's encoded byte length. The exporter uses
`safe_filename(row["filename"])` as a filesystem component. That helper
replaces unsafe characters and does not truncate.

**Evidence**

An asset row with a 300-character `.png` filename and a valid
content-addressed file, passed through `export_graph()`, reproducibly failed
with:

```text
OSError [Errno 63] File name too long: .../export/assets/<sha>/aaaa....png
```

The HTTP API can create such a row even if a local file picker usually cannot,
and direct tailnet API clients are a supported use case.

**Impact**

- Every later nightly export fails until the row is fixed by hand.
- The dated SQLite snapshot is created before export, but the affected asset
  is not mirrored into the backup export directory.
- If launchd failures are not monitored, new assets can lack off-machine
  backup coverage without anyone noticing.

**Recommended fix**

- Normalize and byte-truncate filenames to a safe component limit during
  upload/import, keeping a usable extension.
- Apply the same truncation in the exporter, because existing rows may
  already be too long.
- Handle `.`/`..` and empty-after-sanitization names explicitly.

**Regression coverage**

- Upload an overlong ASCII filename, run export, and verify success.
- Repeat with multibyte Unicode where character count is under the limit but
  UTF-8 byte count is over it.
- Test dot names, collisions after truncation, and extension preservation.

## Type-safety and contract findings

### 5. Important design gap: generated API types do not cover read responses

**Locations**

- `web/src/api/payloads.ts:1-111`
- `web/src/api/client.ts:25-35`
- Bare-dictionary response routes including
  `server/src/pkm/server/routes_pages.py:88-175` and
  `server/src/pkm/server/routes_search.py:17-87`.
- The existing drift guard is `server/tests/test_openapi_sync.py`.

The design says Pydantic/OpenAPI-generated types keep the block model in sync
between Python and TypeScript. OpenAPI generation covers the operation request
models; the main read payloads are copied by hand into `payloads.ts`. Backend
routes return `dict`, so FastAPI has no response model to put in OpenAPI.
`apiFetch<T>()` then asserts the decoded JSON is `T` without validation.

A backend rename or shape change can therefore pass:

- the OpenAPI drift test,
- strict TypeScript compilation, and
- frontend tests whose fixtures use the same stale TS interfaces.

**Recommended fix**

Define Pydantic response models for page, journal, search, query, sidebar, and
asset responses; declare them as FastAPI `response_model`s; generate their
TypeScript definitions; and delete or reduce the handwritten interfaces.
Consider runtime validation only at trust boundaries where malformed responses
would be hard to diagnose.

### 6. Python annotations are not type-check clean

Pyright, run with `server/.venv` as its interpreter, reported **17 source
errors**:

- 15 in `server/src/pkm/importer/parse_export.py`, mostly because
  `parse_export(db: object)` accesses nested values without narrowing or
  validation.
- One `str | None` versus `str` in `server/src/pkm/server/query.py:94`.
- One `sqlite3.Row | None` versus `sqlite3.Row` in
  `server/src/pkm/server/store.py:26`.

The importer errors sit at a dynamic-input boundary, where validation and
narrowing help most. The `store.py` case needs a runtime assertion or explicit
error even though an insert-or-existing-row lookup is expected to succeed.

Add a repository-supported Pyright command to the verification suite and make
the annotations pass it. Declare `pydantic` as a direct dependency, since
application code imports it directly.

## Consistency and documentation observations

- The functional-core/imperative-shell classification is consistent across
  runtime files. The only runtime-path files without a marker are
  `web/src/api/ops.ts` and `web/src/api/payloads.ts`, which are type-only and
  exempt under `CLAUDE.md`.
- The design and implementation plans still describe Cmd/Ctrl-K as the global
  search shortcut. Commit `87360cb4` changed it to Cmd/Ctrl-U because of a
  Firefox conflict, and tests assert that Cmd-K no longer opens search. Update
  the design documentation to match.
- The reviewed baseline has no configured Python formatter/linter or committed
  type-check script. The frontend has strict TypeScript checks, including
  unused-symbol and switch-fallthrough checks.
- The E2E server creates a temporary directory with `tempfile.mkdtemp()` and
  never removes it. Minor, but test graphs accumulate locally.
- React Router v7 future-flag warnings appear repeatedly in frontend tests.
  They are not failures; opting into and testing the future behavior would
  reduce upgrade risk.
- The backend test suite emits a Starlette warning that the current `httpx`
  TestClient integration is deprecated in favor of `httpx2`.

## Security review

### Positive controls confirmed

- Password and session comparisons use `hmac.compare_digest`.
- Password hashing uses scrypt with a per-install salt.
- Session cookies are `HttpOnly`, `Secure` by default, `SameSite=Lax`, and
  scoped to `/`.
- API, asset, OpenAPI, and WebSocket routes require authentication; only
  `/healthz` and login are public.
- WebSocket authentication rejects invalid sessions before accepting.
- SQL values are parameterized. Dynamic SQL fragments come from constant
  planners or placeholder counts, never interpolated user data.
- Search snippets are parsed into React elements; server text is never
  injected as HTML.
- Markdown links use a scheme allowlist and reject control-character and
  protocol-relative bypasses.
- Highlight.js is called through its escaping highlighter before the returned
  HTML is inserted.
- Asset responses send `X-Content-Type-Options: nosniff`; SVG is forced to
  download.
- Production npm and Python dependency audits reported no known
  vulnerabilities at review time.

### Residual threat-model notes

The login has no rate limiting, logout/revocation workflow, or internet-grade
abuse protection. This matches the design decision that Tailscale is the
transport boundary, and is acceptable only while exposure stays tailnet-only.
The static password is not sufficient protection for public-internet binding.

The upload endpoint trusts the client-declared MIME type. The
`Content-Disposition` allowlist plus `nosniff` limits execution risk, but
detecting MIME from bytes would make the stored metadata and inline decision
more trustworthy. The endpoint also reads up to 150 MiB into memory at once;
streaming to a bounded temporary file would be more resilient.

## Verification evidence

Checks run from the repository during the review:

| Check | Result |
|---|---|
| `cd server && uv run pytest -q` | 233 passed; 1 Starlette/httpx deprecation warning |
| `cd web && pnpm test -- --run` | 37 files, 253 tests passed |
| `cd web && pnpm typecheck` | Passed |
| `cd web && pnpm build` | Passed; production bundle built successfully |
| `cd web && pnpm e2e` | 2/2 passed on each of two runs, but both runs logged the confirmed SQLite lock exception |
| `pnpm audit --prod` | No known vulnerabilities |
| Exported locked Python requirements + `pip-audit` | No known vulnerabilities |
| `uvx pyright` with the server venv | 17 errors |
| `git diff --check` before concurrent edits appeared | Passed |

## Strengths to preserve

- The functional-core/imperative-shell split makes pure behavior easy to test
  and keeps route code thin.
- The op planner and SQLite effect executor are easy to reason about and keep
  refs/FTS updates in the same transaction as block text changes.
- The operation queue serializes batches, caps them at the server limit, and
  handles reentrant failure callbacks carefully.
- Cross-page move semantics are documented and tested on server and client.
- Ref grammar parity is pinned by a shared fixture across Python and
  TypeScript.
- Rendering avoids injecting FTS/markdown content as raw HTML.
- Backup/export uses content-addressed assets, an online SQLite snapshot, and
  atomic rename for the database snapshot.
- Tests cover many edge cases, particularly for outline editing, DnD, auth,
  uploads, query parsing, importer behavior, and backups.

## Suggested implementation order

1. Fix connection initialization and add a failing concurrency regression
   test. This is the only issue already observed as a live server exception.
2. Fix focused-block remote update handling and add two-client tests for the
   draft and no-draft cases.
3. Make connection state part of the operation queue contract and test every
   asynchronous flush boundary.
4. Bound asset filenames at ingestion and export, then add backup regression
   tests.
5. Introduce generated response models/types.
6. Add Python type checking to the supported verification command and resolve
   the 17 current errors.
7. Clean up documentation, temporary E2E directories, and deprecation/future
   warnings.

After items 1-4, rerun the full backend, frontend, build, and Playwright suites
and inspect server stderr, since Playwright's exit code alone missed finding 1.

## Worktree caveat

The worktree was clean when the review began. During final verification,
concurrent user-owned changes appeared in Python editor/type configuration
files, including `pyrightconfig.json`, `pyrefly.toml`, a bean, and
`server/tests/test_server_scaffold.py`. The reviewer did not create, modify, or
revert them. An implementing agent must check `git status` and preserve those
changes before starting.
