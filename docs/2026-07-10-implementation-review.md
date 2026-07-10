# PKM implementation review handoff

**Date:** 2026-07-10  
**Reviewer:** Codex  
**Scope:** Whole-repository review of implementation quality, consistency,
tests, security, type usage, and alignment with `README.md` and the linked
design and implementation documents.  
**Status:** Review complete; no code fixes were made as part of this review.

## Executive assessment

The codebase has a strong overall shape: functional-core/imperative-shell
boundaries are consistently applied, the operation planner is cleanly
separated from SQLite effects, frontend TypeScript is strict, and both backend
and frontend have substantial behavioral test suites. SQL is parameterized,
untrusted note text is generally rendered safely, authentication matches the
documented Tailscale-only threat model, and dependency audits found no known
production vulnerabilities.

The app should nevertheless be treated as **not production-ready until the
four Important findings below are fixed**. The highest-confidence issue is a
SQLite connection race that produced real HTTP 500s on both independent
Playwright runs while the test process still exited successfully. The other
Important findings affect cross-client consistency, the promised paused-write
behavior during disconnection, and backup availability.

No Critical security vulnerability was found within the documented deployment
model. The authentication layer is deliberately not internet-grade and should
continue to be treated as defense in depth behind Tailscale, not as permission
to expose the service publicly.

## Confirmed findings

### 1. Important: per-request WAL and DDL setup causes database-lock 500s

**Locations**

- `server/src/pkm/server/db.py:14-23`
- `server/src/pkm/server/db.py:31-36`
- The E2E server is started by `server/tests/e2e_serve.py:23-44`.

**What happens**

`open_db()` runs all of the following on every request-created connection:

```python
con.execute("PRAGMA foreign_keys=ON")
con.execute("PRAGMA journal_mode=WAL")
con.executescript(SIDEBAR_ENTRIES_DDL)
```

`journal_mode=WAL` is persistent database configuration, not a setting that
needs to be re-entered on every request. `executescript()` also performs schema
work and can require locking. Under normal concurrent browser activity, a new
request can therefore fail before its route function runs.

**Evidence**

`pnpm e2e` was run twice from `web/`. Both runs reported `2 passed`, but both
server logs contained the same exception during ordinary editing:

```text
File "server/src/pkm/server/db.py", line 18, in open_db
    con.execute("PRAGMA journal_mode=WAL")
sqlite3.OperationalError: database is locked
```

This is especially important because the current E2E harness does not fail
when the application server logs an unobserved 500.

**Impact**

- Normal multi-request or multi-client activity can intermittently return 500.
- A background autocomplete, refetch, or similar request may fail without
  failing the browser test or presenting a durable error to the user.
- The behavior undermines the design claim that WAL makes reads reliably
  concurrent with writes.

**Recommended fix**

1. Apply schema migrations and `PRAGMA journal_mode=WAL` once during explicit
   database initialization/application startup, before serving requests.
2. Keep only connection-local configuration such as `foreign_keys=ON` in
   `open_db()`.
3. Set and document an appropriate `busy_timeout`/connection timeout for
   genuine writer contention.
4. Replace the ad hoc `SIDEBAR_ENTRIES_DDL`-on-open migration with an explicit,
   idempotent migration/startup step.

**Regression coverage**

- Add a backend concurrency test that opens read connections while an ops
  transaction is committing.
- Make the Playwright harness fail on unexpected server exceptions or HTTP 5xx
  responses, even when the visible assertions happen to pass.

### 2. Important: focusing a block discards remote text updates without a local draft

**Locations**

- `web/src/outline/useOutline.ts:119-136`
- The behavior is currently codified by
  `web/src/views/EditablePage.test.tsx:77-86`.

**What happens**

Remote `update_text` operations are filtered solely by whether their UID is the
currently focused block:

```ts
const ops = batch.ops.filter((op) =>
  !(op.op === "update_text" && op.uid === focusRef.current?.uid));
```

The comment says this lets a local draft win, but focus does not imply that a
draft exists. A user can click into a block, type nothing, and then receive a
newer update from another client. The server commits the remote update, while
the focused client permanently retains the old text until some unrelated
refetch or navigation occurs. Blurring without typing does not repair it
because there is no pending text operation to flush.

**Impact**

- Two clients can visibly disagree even though the WebSocket is connected.
- The client no longer reflects the server's actual last writer.
- A later edit from the stale client can overwrite the unseen remote change.

**Recommended fix**

Conflict behavior should be based on an actual pending draft, not focus alone.
One viable approach is to apply the remote text to the underlying block tree
even while the textarea retains its local component draft; when a real local
draft flushes, it then becomes the next legitimate last writer. The exact UX
choice can vary, but the no-draft case must adopt the remote value.

**Regression coverage**

- Focused block, no local change: remote update is displayed/adopted.
- Focused block with a pending local draft: explicitly verify the chosen LWW
  behavior.
- Focus then blur without editing after a remote update: client and server
  remain consistent.

### 3. Important: writes are not actually paused when the WebSocket disconnects

**Locations**

- `web/src/sync/SyncProvider.tsx:52-89`
- `web/src/sync/opQueue.ts:22-72`
- Pending debounce and asynchronous upload paths in
  `web/src/outline/useOutline.ts:42-100` and `:180-203`.
- The promised invariant is documented in
  `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md:117-120`.

**What happens**

The UI becomes read-only when `status !== "connected"`, but the queue is not
given connection state. `SyncProvider` always exposes:

```ts
enqueue: (ops) => queue.enqueue(ops)
```

and the queue pumps HTTP immediately. Therefore operations whose asynchronous
work began while connected can still be posted after the WebSocket has gone
down. Concrete cases include:

- A text debounce starts, the socket drops, and the 500 ms timer fires.
- An image upload starts, the socket drops, and the upload completion callback
  creates an `update_text` operation.
- A structural action already in flight crosses the status transition.

This violates the central design claim that disconnection pauses writes so
divergence is impossible.

**Impact**

- HTTP operations may commit while the client has no broadcast channel.
- If HTTP also fails, the local optimistic mutation is followed by a one-shot
  resync path; failed resyncs are swallowed and may leave stale state.
- The implementation's safety property is weaker than the documentation and
  UI imply.

**Recommended fix**

Give the queue explicit connectivity state. When offline, preserve pending
operations or drafts without sending them; on reconnect, first establish the
authoritative-state policy, then either flush safe pending work or discard it
with an explicit user-visible reconciliation. Avoid solving this by silently
dropping `enqueue()` calls, because that would introduce direct data loss.

**Regression coverage**

- Type text, disconnect before the debounce, advance the timer, and assert no
  HTTP POST occurs.
- Complete an upload after disconnection and assert no op is pumped.
- Reconnect and verify the documented handling of preserved pending work.
- Exercise an in-flight POST whose socket drops before the response.

### 4. Important: an unbounded uploaded filename can disable nightly exports

**Locations**

- `server/src/pkm/server/routes_assets.py:79-88`
- `server/src/pkm/export/markdown.py:37-38`
- `server/src/pkm/export/writer.py:60-70`

**What happens**

The upload route strips directory components using `Path(...).name`, but does
not bound the filename's encoded byte length. The exporter later uses
`safe_filename(row["filename"])` as a real filesystem component. That helper
replaces unsafe characters but also does not truncate.

**Evidence**

An asset row with a 300-character `.png` filename and a valid content-addressed
file was passed through `export_graph()`. It reproducibly failed with:

```text
OSError [Errno 63] File name too long: .../export/assets/<sha>/aaaa....png
```

The HTTP API can create such a row even if a normal local filesystem picker
usually cannot, and direct tailnet API clients are an explicitly supported use
case.

**Impact**

- Every later nightly export fails until the database row is manually fixed.
- The dated SQLite snapshot is created before export, but the affected asset
  is not successfully mirrored into the backup export directory.
- If launchd failures are not actively monitored, new assets may silently lack
  off-machine backup coverage.

**Recommended fix**

- Normalize and byte-truncate filenames to a safe component limit during
  upload/import while retaining a usable extension.
- Apply the same defensive truncation in the exporter because existing rows
  may already contain unsafe lengths.
- Handle `.`/`..` and empty-after-sanitization names explicitly.

**Regression coverage**

- Upload an overlong ASCII filename, run export, and verify success.
- Repeat with multibyte Unicode where character count is below the limit but
  UTF-8 byte count is above it.
- Test dot names, collisions after truncation, and preservation of file
  extensions.

## Type-safety and contract findings

### 5. Important design gap: generated API types do not cover read responses

**Locations**

- `web/src/api/payloads.ts:1-111`
- `web/src/api/client.ts:25-35`
- Bare-dictionary response routes including
  `server/src/pkm/server/routes_pages.py:88-175` and
  `server/src/pkm/server/routes_search.py:17-87`.
- The existing drift guard is `server/tests/test_openapi_sync.py`.

The design says Pydantic/OpenAPI-generated types prevent the block model from
drifting between Python and TypeScript. In practice, OpenAPI generation covers
the operation request models, while the main read payloads are manually copied
into `payloads.ts`. Backend routes return `dict`, so FastAPI has no response
model to place into OpenAPI. `apiFetch<T>()` then asserts the decoded JSON is
`T` without validation.

Consequently, a backend rename or shape change can pass:

- the OpenAPI drift test,
- strict TypeScript compilation, and
- frontend tests that construct fixtures using the same stale TS interfaces.

**Recommended fix**

Define Pydantic response models for page, journal, search, query, sidebar, and
asset responses; declare them as FastAPI `response_model`s; generate their
TypeScript definitions; and delete or reduce the handwritten interfaces.
Consider runtime validation only at trust boundaries where malformed responses
would otherwise be difficult to diagnose.

### 6. Python annotations are not currently type-check clean

Pyright was run with `server/.venv` as its interpreter and reported **17 source
errors**:

- 15 errors in `server/src/pkm/importer/parse_export.py`, primarily because
  `parse_export(db: object)` accesses nested values without narrowing or
  validation.
- One `str | None` versus `str` error in
  `server/src/pkm/server/query.py:94`.
- One `sqlite3.Row | None` versus `sqlite3.Row` error in
  `server/src/pkm/server/store.py:26`.

Most importer findings arise at a dynamic-input boundary, which is precisely
where explicit validation/type narrowing is useful. The `store.py` result also
deserves a runtime assertion or explicit error even if the expected invariant
is that an insert-or-existing-row lookup must succeed.

Add a repository-supported Pyright command to the normal verification suite
and make the existing annotations pass it. Also declare `pydantic` as a direct
dependency because application code imports it directly rather than merely
using it through FastAPI.

## Consistency and documentation observations

- The functional-core/imperative-shell classification is consistent across
  runtime files. The only runtime-path files without a marker are
  `web/src/api/ops.ts` and `web/src/api/payloads.ts`, which are type-only and
  therefore exempt under `CLAUDE.md`.
- The design and implementation plans continue to describe Cmd/Ctrl-K as the
  global search shortcut. Commit `87360cb4` intentionally changed this to
  Cmd/Ctrl-U because of a Firefox conflict, and current tests explicitly assert
  that Cmd-K no longer opens search. Update the durable design documentation so
  it describes the shipped behavior.
- There is no configured Python formatter/linter or committed type-check
  script in the reviewed baseline. The frontend does have strict TypeScript
  checks, including unused-symbol and switch-fallthrough checks.
- The E2E server creates a temporary directory with `tempfile.mkdtemp()` and
  does not remove it. This is minor but accumulates test graphs locally.
- React Router v7 future-flag warnings appear repeatedly in frontend tests.
  They are not current failures, but opting into/testing the future behavior
  would reduce upgrade risk.
- The backend test suite emits a Starlette warning that the current `httpx`
  TestClient integration is deprecated in favor of `httpx2`.

## Security review

### Positive controls confirmed

- Password and session comparisons use `hmac.compare_digest`.
- Password hashing uses scrypt with a per-install salt.
- Session cookies are `HttpOnly`, `Secure` by default, `SameSite=Lax`, and
  scoped to `/`.
- API, asset, OpenAPI, and WebSocket routes are authentication-gated; only
  `/healthz` and login are intentionally public.
- WebSocket authentication rejects invalid sessions before accepting.
- SQL values are parameterized. Dynamic SQL fragments are generated from
  constant planners or placeholder counts rather than interpolated user data.
- Search snippets are parsed into React elements instead of injecting server
  text as HTML.
- Markdown links use a scheme allowlist and reject control-character and
  protocol-relative bypasses.
- Highlight.js is invoked through its escaping highlighter before the returned
  library-generated HTML is inserted.
- Asset responses send `X-Content-Type-Options: nosniff`; SVG is forced to
  download instead of rendering inline.
- Production npm and Python dependency audits reported no known
  vulnerabilities at review time.

### Residual threat-model notes

The login has no rate limiting, logout/revocation workflow, or internet-grade
abuse protection. This matches the explicit design decision that Tailscale is
the transport boundary. It is acceptable only while network exposure remains
tailnet-only. Do not reinterpret the static password as sufficient protection
for public-internet binding.

The upload endpoint trusts the client-declared MIME type. The current
`Content-Disposition` allowlist plus `nosniff` substantially limits execution
risk, but MIME detection from bytes would make the stored metadata and inline
decision more trustworthy. The endpoint also reads up to 150 MiB into memory
at once; streaming to a bounded temporary file would be more resilient.

## Verification evidence

The following checks were executed from the repository during the review.

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

Passing unit tests should not be taken as evidence that finding 1 is harmless:
the real Uvicorn/Playwright path exposed it while the test runner still exited
zero.

## Existing strengths worth preserving

- The functional-core/imperative-shell split makes pure behavior easy to test
  and keeps route code comparatively thin.
- The op planner and SQLite effect executor are easy to reason about and keep
  refs/FTS updates in the same transaction as block text changes.
- The operation queue serializes batches, caps them to the server limit, and
  has careful handling for reentrant failure callbacks.
- Cross-page move semantics are documented and tested on both server and
  client.
- Ref grammar parity is pinned by a shared fixture across Python and
  TypeScript.
- Rendering avoids the common XSS mistake of injecting FTS/markdown content as
  raw HTML.
- Backup/export code uses content-addressed assets, an online SQLite snapshot,
  and atomic rename for the database snapshot.
- Tests cover many edge cases rather than only happy paths, particularly for
  outline editing, DnD, auth, uploads, query parsing, importer behavior, and
  backups.

## Suggested implementation order

1. Fix connection initialization and add a failing concurrency regression
   test. This is the only issue already observed as a live server exception.
2. Fix focused-block remote update handling and add two-client tests for both
   draft and no-draft cases.
3. Make connection state part of the operation queue contract and test all
   asynchronous flush boundaries.
4. Bound asset filenames at both ingestion and export, then add backup
   regression tests.
5. Introduce generated response models/types.
6. Turn on Python type checking in the supported verification command and
   resolve the 17 current errors.
7. Clean up documentation, temporary E2E directories, and deprecation/future
   warnings.

After items 1-4, rerun the full backend, frontend, build, and Playwright suites
and inspect server stderr rather than relying only on Playwright's exit code.

## Worktree caveat

The worktree was clean when the review began. During final verification,
concurrent user-owned changes appeared in files related to Python editor/type
configuration, including `pyrightconfig.json`, `pyrefly.toml`, a bean, and
`server/tests/test_server_scaffold.py`. The reviewer did not create, modify, or
revert those files. Any implementing agent must inspect `git status` and
preserve those changes before starting work.

