---
# pkm-ulae
title: Server hardening from recent-change review
status: in-progress
type: epic
priority: high
created_at: 2026-07-31T15:45:04Z
updated_at: 2026-08-01T07:52:07Z
---

## Context

A read-only review of `server/` after substantial recent churn was performed with five parallel tracks: HTTP/database/sync, assistant/describe, CLI/MCP/client, import/export/assets, and cross-cutting Python/FCIS architecture. The strongest claims were checked against the current source and existing tests. No implementation changes were made and the full server verification suite was not run as part of the review.

This epic records confirmed correctness, data-safety, concurrency, security, duplication, over-generalisation, typing, lifecycle, and complexity findings. Split independent findings into child bugs/tasks before implementation.

## High-priority findings

### 1. Remove the 100-level traversal corruption boundary

**References:** `server/src/pkm/server/ops_apply.py:20-58,70-80`

Both ancestry cycle detection and subtree enumeration silently stop at depth 100. A legal deeper hierarchy can be moved under one of its descendants because the root is no longer seen, creating a cycle. A cross-page move updates only the first 101 levels, leaving deeper descendants on the source page with parents on the destination page.

**Direction:** Traverse the complete hierarchy with cycle-safe recursive SQL, or enforce a documented depth limit before mutation. Cross-page moves must update every descendant or fail atomically.

- [ ] Add depth-boundary tests at 100, 101, and deeper
- [ ] Verify cycle prevention and every descendant's page after a cross-page move
- [ ] Replace the silent traversal cap with complete traversal or explicit validation

### 2. Reject normalized-empty page titles at the shared creation boundary

**References:** `server/src/pkm/server/store.py:18-38`; `server/src/pkm/server/ops_apply.py:61-79`; `server/src/pkm/server/routes_pages.py:197-204`

`get_or_create_page()` normalizes control whitespace but does not reject a title that becomes `""`. The normal page route checks this, but create/create_page/cross-page move operations call the store directly and can commit an unreachable blank-titled page.

**Direction:** Make the shared creation boundary define normalized-empty behavior. Prefer rejecting the operation before mutation with a stable operation error; if offline replay needs a different recovery policy, specify it explicitly.

- [ ] Add whitespace-only title tests for create, create_page, and move operations
- [ ] Enforce the invariant in the shared creation path

### 3. Serialize assistant conversation admission

**References:** `server/src/pkm/assistant/service.py:54-69`

The conversation-cap check occurs before awaiting `engine.create_conversation()`. Concurrent requests can both observe free capacity and start harnesses, bypassing the configured cap or over-evicting idle conversations.

**Direction:** Serialize admission with a lock or atomically reserve creation slots, releasing reservations on every failure/cancellation path.

- [ ] Add barrier-controlled concurrent creation tests
- [ ] Enforce the cap across active and in-progress creations

### 4. Make Claude harness startup transactional and cancellation-safe

**References:** `server/src/pkm/assistant/claude_engine.py:245-280`

Startup writes a 0600 config containing a long-lived session token, creates the SDK client, and connects it without cleanup around failure or cancellation. Factory/connect failures can leave the credential file and a partially started subprocess/client behind.

**Direction:** Wrap all work after config creation in cancellation-safe cleanup that disconnects any created client and always unlinks the config before re-raising.

- [ ] Test factory failure, partial connect failure, and cancellation during connect
- [ ] Assert credential unlink and client disconnect on every failed startup path

### 5. Keep CLI/MCP batch page creation inside the advertised atomic transaction

**References:** `server/src/pkm/cli/main.py:360-367,420-433`; `server/src/pkm/mcp/server.py:38-46,134-150`; `server/src/pkm/server/ops_core.py:75-95`

Both shells call `_ensure_page()` before fully validating and posting a batch. A batch with a missing page followed by an invalid command can fail while leaving the page committed, contradicting the CLI/MCP “one atomic transaction” contract.

**Direction:** Validate the complete command batch before I/O. Represent missing pages as empty planning payloads and include supported create_page operations in the same `OpBatch`.

- [ ] Add failed-batch tests asserting no pages or blocks remain
- [ ] Move page creation into the atomic operation batch

### 6. Generate CLI-safe UIDs and preserve access to legacy leading-dash UIDs

**References:** `server/src/pkm/client/api.py:55-56`; `server/src/pkm/server/ops_core.py:15`; `server/src/pkm/cli/main.py:475-476,521-525`

`secrets.token_urlsafe()` can generate a UID beginning with `-`. The server accepts it, but argparse interprets it as an option, so the CLI can create blocks it cannot subsequently address normally. This also makes write tests probabilistically flaky.

**Direction:** Generate UIDs with an alphanumeric first character. Preserve access to existing leading-dash UIDs through documented `--` handling or an explicit `--uid` option and plan any regex tightening compatibly.

- [ ] Add deterministic leading-dash parser and end-to-end tests
- [ ] Make new UID generation CLI-safe
- [ ] Document or implement access to legacy UIDs

### 7. Resolve heading parents by text and heading level

**References:** `server/src/pkm/cli/build.py:55-82,164-175,197-202`

`resolve_parent("## Notes")` compares only block text and ignores `heading`. It can choose a plain `Notes` block or a level-3 heading instead of a level-2 heading, while same-batch heading memoization is level-aware.

**Direction:** Require the requested heading level when resolving heading specifications and define duplicate-heading selection semantics.

- [ ] Add plain-text collision, wrong-level collision, and duplicate-heading tests
- [ ] Align fetched-page and in-batch heading resolution

### 8. Do not silently discard valid orphan blocks during import

**References:** `server/src/pkm/importer/parse_export.py:116-135`; `server/src/pkm/importer/run.py:78-126`

The importer records only the count of valid UID/string blocks unreachable from pages; it does not retain them. The replacement database is published before the warning report is written, so user content can be omitted and report failure can hide the warning.

**Direction:** Preserve orphan subtrees on a deterministic recovery page, or refuse publication unless an explicit lossy-import option is supplied. Complete preflight/reporting before swapping databases.

- [ ] Assert every orphan UID/text remains recoverable or import is refused
- [ ] Verify the existing database remains untouched on refusal/report failure
- [ ] Make lossy behavior explicit rather than warning after publication

### 9. Preserve block-reference integrity during Mermaid conversion

**References:** `server/src/pkm/importer/rows.py:48-61`; `server/src/pkm/importer/migrate_mermaid_blocks.py:82-93`; `docs/architecture/backend.md:325-328`

Mermaid conversion flattens descendant text and drops/deletes descendant rows and stable UIDs. Any external `((child-uid))` reference becomes permanently unresolved, contradicting the documented UID-preservation invariant.

**Direction:** Detect inbound references before conversion. Preserve referenced descendants, rewrite references only where semantics are valid, or refuse/report conversion. If a lossy mode remains, enumerate every affected UID.

- [ ] Test referenced nested Mermaid descendants
- [ ] Add dry-run reporting of affected UIDs and inbound references
- [ ] Preserve or explicitly gate lossy metadata/UID removal

## Medium-priority findings

### 10. Nudge connected replicas after journal cleanup

**References:** `server/src/pkm/server/routes_pages.py:423-448`; `server/src/pkm/server/notify.py:1-38`; change triggers in `server/src/pkm/schema.py:129-150`

Journal cleanup commits page/block deletions and advances `changes.seq` but sends no sequence nudge. Connected replicas can retain deleted pages until another mutation or reconnect. This overlaps the previously scrapped `pkm-ie73`, but the current invariant remains broken.

**Direction:** Send a post-commit nudge when cleanup deletes rows, and centralize the commit-then-nudge protocol to prevent route omissions.

- [ ] Add WebSocket coverage for journal cleanup
- [ ] Add a mutation-route contract test for every journal-advancing endpoint
- [ ] Centralize or enforce post-commit notification

### 11. Make WebSocket fan-out concurrent without losing per-client ordering

**References:** `server/src/pkm/server/ws.py:15-35`; `server/src/pkm/server/routes_ops.py:59-67`

`Hub.broadcast()` awaits each client sequentially with a one-second timeout. Writes await multiple broadcasts after commit, so stalled clients can add latency proportional to connection count.

**Direction:** Send concurrently with bounded concurrency and per-client timeout. Preserve per-client frame ordering via queues or locks and consider connection limits.

- [ ] Add multiple-stalled-client latency tests
- [ ] Implement bounded concurrent fan-out with ordered per-client delivery

### 12. Batch sync hydration queries

**References:** `server/src/pkm/server/routes_sync.py:36-71,93-104,124-135`

Changed blocks are hydrated with one block query and one refs query per UID; pages/sidebar entries are also fetched individually. A legal 5,000-entity window can execute over 10,000 SQL statements, and snapshots have no block limit while holding a read transaction.

**Direction:** Fetch blocks, refs, pages, and sidebar rows in chunked set queries under SQLite's parameter limit and group them in memory.

- [ ] Add distinct-UID query-count or benchmark coverage
- [ ] Replace N+1 hydration with bounded set queries

### 13. Throttle expensive unauthenticated password checks

**References:** `server/src/pkm/server/auth.py:45-56`; `server/src/pkm/server/auth_core.py:8-15`

Every login failure runs scrypt with no rate limit, concurrency bound, or backoff. Any host able to reach the configured bind address can consume substantial CPU and memory with concurrent attempts.

**Direction:** Add global/per-source throttling and bound concurrent checks while keeping failure responses uniform.

- [ ] Add rate-limit and concurrent-attempt tests
- [ ] Bound unauthenticated scrypt work

### 14. Retire assistant conversations after failed interrupts

**References:** `server/src/pkm/assistant/claude_engine.py:147-201`; `server/src/pkm/assistant/service.py:86-93`

If interrupt times out or raises, local cleanup continues and the service marks the conversation not busy even though the subprocess may still be running. The uncertain harness is then reusable for later turns, risking stale events, concurrent queries, or continued token use.

**Direction:** Treat unacknowledged interrupt as terminal: disconnect/kill the harness and remove or invalidate the conversation.

- [ ] Add a second-send test after interrupt timeout/failure
- [ ] Prevent reuse of uncertain harnesses

### 15. Deduplicate queued and in-flight image descriptions

**References:** `server/src/pkm/describe/service.py:60-79,96-122`; `server/src/pkm/describe/routes.py:23-28`

Uploads and scans enqueue SHA values without pending/in-flight deduplication. Duplicate entries after a failure can repeatedly send the same private image to the external describer, multiplying cost and rate-limit pressure.

**Direction:** Track queued/in-flight SHAs with `finally` cleanup and model force-retry intent explicitly.

- [ ] Add duplicate upload/scan tests with a failing describer
- [ ] Guarantee at most one ordinary in-flight attempt per asset

### 16. Preserve the last good Markdown backup until replacement succeeds

**References:** `server/src/pkm/export/writer.py:39-59`; `server/src/pkm/backup/__main__.py:79-84`

`export_graph()` deletes all current page/journal Markdown files before rendering replacements. Rendering, disk, permission, or asset-copy failure leaves a partial export and destroys the last known-good working tree.

**Direction:** Render and validate in staging, then atomically publish while preserving the export repository, or implement rollback-safe replacement.

- [ ] Inject rendering and copy failures and assert the previous export is byte-identical
- [ ] Publish exports atomically

### 17. Verify content-addressed files instead of trusting existence

**References:** `server/src/pkm/importer/run.py:101-107`; `server/src/pkm/export/writer.py:64-72`

Importer and backup export skip copying whenever the destination exists; they do not verify that bytes match the SHA in the path. Truncated or corrupted files can survive every later import/export.

**Direction:** Verify size and SHA-256 and atomically repair mismatches from the known source.

- [ ] Add same-size and truncated corruption repair tests
- [ ] Validate and repair existing content-addressed files

### 18. Guarantee ZIP member-name uniqueness after suffix generation

**References:** `server/src/pkm/assets_core.py:64-76`

`zip_arcnames()` checks whether the original filename is used but does not recheck the generated `name (<sha8>).ext`. Generated-looking input names or shared eight-character SHA prefixes can still produce duplicate ZIP members.

**Direction:** Loop until the candidate is unused, using a longer SHA or incrementing suffix when necessary.

- [ ] Test generated-looking names, shared SHA prefixes, and case-insensitive collisions
- [ ] Assert every archive name is unique

### 19. Make EDN parsing strict and Unicode-safe

**References:** `server/src/pkm/edn.py:97-113,120-141`

Unsupported string/character escapes can be silently changed, surrogate-pair escapes produce invalid Python strings, truncated Unicode escapes leak raw `ValueError`, and discard forms at collection ends are rejected. Silent text corruption is worse than a clear import failure.

**Direction:** Validate escape names and hex length, combine/reject surrogates correctly, normalize parser errors to `EdnError`, and model discard forms at collection-parser level.

- [ ] Add unknown/truncated/lone-surrogate/supplementary-codepoint tests
- [ ] Add collection-end discard tests
- [ ] Reject unsupported forms without altering text

### 20. Introduce typed transport-neutral client contracts and remove dependency inversion

**References:** `server/src/pkm/client/api.py:18,91-148`; `server/src/pkm/cli/build.py:10,38-342`; `server/src/pkm/server/response_models.py:18-264`; imports in `server/src/pkm/cli/main.py:27-28` and `server/src/pkm/mcp/server.py:19`

`PkmClient` returns bare dictionaries and downstream planners/renderers access nested untyped data, so static checking cannot catch response drift despite exact Pydantic models existing. CLI/MCP depend inward on `pkm.server.*` and duplicate ensure-page/default-date/fetch-plan-post workflows.

**Direction:** Move transport-neutral operation/response contracts into an independent domain package, return validated models or precise `TypedDict`s, and extract shared application workflows while keeping presentation shells separate.

- [ ] Define dependency direction and transport-neutral contracts
- [ ] Add malformed/stale response contract tests
- [ ] Replace duplicate CLI/MCP workflows without over-generalising presentation

### 21. Validate batch commands with a discriminated schema before planning or I/O

**References:** `server/src/pkm/cli/build.py:296-320,341-414`; `server/src/pkm/cli/main.py:420-432,561-572`; `server/src/pkm/mcp/server.py:134-149`

The only contract is `list[dict]`; malformed items and nested values can escape as `AttributeError`/`KeyError`. `plan_batch()` is also an oversized dispatcher combining validation, alias state, and planning.

**Direction:** Add command-specific discriminated models in the functional core, validate the full envelope before page discovery, and dispatch to small per-command planners with one stable user-facing error contract.

- [ ] Test non-object items/params, missing/wrong fields, indexes, and aliases in CLI and MCP
- [ ] Split validation from command planning

### 22. Use canonical page titles returned by creation

**References:** `server/src/pkm/cli/main.py:360-367`; `server/src/pkm/mcp/server.py:38-46`; `server/src/pkm/client/api.py:126-127`; `server/src/pkm/server/routes_pages.py:193-203`

Both `_ensure_page()` implementations ignore the canonical title returned by POST and refetch the original spelling. Leading/trailing or control whitespace can create the normalized page and then 404 on refetch, leaving side effects after a failed command.

**Direction:** Use the returned canonical title and centralize ensure-page behavior.

- [ ] Add whitespace-normalization tests for CLI and MCP
- [ ] Remove duplicate, non-canonical ensure-page implementations

### 23. Do not silently truncate CLI/MCP backlinks

**References:** `server/src/pkm/client/api.py:102-105`; `server/src/pkm/cli/main.py:78-81,335-339`; `server/src/pkm/mcp/server.py:80-84`; `server/src/pkm/server/routes_pages.py:165-187`

`get_page()` requests at most 100 backlink groups while the route is paginated. CLI/MCP render the partial result without a truncation marker despite CLI wording that promises every block.

**Direction:** Fetch all pages or expose pagination and clearly report truncation through a dedicated client method.

- [ ] Test `total_pages > len(groups)` in client, CLI, and MCP
- [ ] Make completeness/truncation explicit

### 24. Avoid orphan assets in upload-and-link workflows

**References:** `server/src/pkm/cli/main.py:405-416`; `server/src/pkm/mcp/server.py:153-168`; `server/src/pkm/client/api.py:135-142`

The asset is uploaded before page/parent validation and before the block operation. Invalid parents or failed operations leave unlinked assets; CLI prints the URL before linking succeeds.

**Direction:** Resolve/validate destination before upload, delay success output, and add either a transactional endpoint or compensating deletion for post-upload write failure.

- [ ] Add invalid-parent and post-upload operation-failure tests
- [ ] Prevent or compensate orphaned uploads

### 25. Configure production logging through a parent package logger

**References:** logger declarations in `server/src/pkm/server/routes_assets.py:34`, `server/src/pkm/assistant/claude_engine.py:50`, and `server/src/pkm/assistant/service.py:16`; `server/src/pkm/server/logfmt.py:34-57`

Production logging explicitly configures only `pkm.access` and `pkm.describe`. New `pkm.assets` and `pkm.assistant` loggers can lose intended INFO lifecycle output and project formatting, repeating the logger-registration drift previously fixed for describe.

**Direction:** Configure a parent `pkm` logger once, with explicit stream/format overrides only where required.

- [ ] Add a test enumerating `pkm.*` loggers and asserting effective handlers/levels
- [ ] Replace the open-ended logger allowlist with a parent policy

### 26. Bound memory use for ZIP responses

**References:** `server/src/pkm/server/routes_export.py:155-168`; `server/src/pkm/server/routes_assets.py:202-228`

Whole-graph and selected-asset exports build complete ZIPs in `BytesIO` and call `getvalue()`. Selected assets have no count or total-byte bound, so a large request can exhaust the process.

**Direction:** Use a temporary-file-backed or streaming response and enforce count/byte limits.

- [ ] Add archive size/count limit tests
- [ ] Verify temporary archive cleanup on cancellation/error
- [ ] Replace unbounded in-memory buffering

## Lower-priority findings

### 27. Make sidebar append concurrency-safe

**References:** `server/src/pkm/server/routes_sidebar.py:35-49`

Concurrent additions use read/check/compute/insert. Different titles can receive duplicate order indexes; identical titles can surface an uncaught uniqueness error as 500 instead of 409.

- [ ] Add concurrent same-title and different-title tests
- [ ] Serialize index allocation and map uniqueness conflicts to 409

### 28. Close the owned OpenAI HTTP client during application shutdown

**References:** `server/src/pkm/describe/openai_client.py:17-22,40-41`; `server/src/pkm/describe/service.py:27-30,51-58`; `server/src/pkm/server/app.py:57-65`

`OpenAIDescriber` owns an async client and exposes `close()`, but `DescribeService.close()` only cancels the worker. Lifespan restarts can leak sockets and transport resources.

- [ ] Define describer ownership/lifecycle semantics
- [ ] Close owned clients from application shutdown and test it

### 29. Remove duplicate HTTP status prefixes from CLI/MCP errors

**References:** `server/src/pkm/client/core.py:43-57`; `server/src/pkm/client/api.py:91-100`

`friendly_error()` prefixes status and `ApiError` prefixes it again, producing strings such as `404: 404: page not found`.

- [ ] Add exact end-to-end error-string tests
- [ ] Assign status formatting to one layer

## Verification and documentation

- [ ] Use test-driven development for every behavior change
- [ ] Run `cd server && uv run pytest -q`
- [ ] Run `cd server && uv run pyrefly check`
- [ ] Run `cd server && uv run ruff check`
- [ ] Review and update `docs/architecture/backend.md` for route, contract, dependency, importer, logging, and archive changes
- [ ] Update `docs/architecture/sync-and-offline.md` for notification and sync hydration invariants
- [ ] Recheck FCIS classifications for any modules split or moved
- [ ] Split independent findings into child beans before implementation

## High-priority sweep — completed 2026-07-31

All nine high-priority findings fixed via child beans, each TDD'd, task-reviewed, and re-reviewed; four track branches merged to main with --no-ff (assistant 651fd7b, cli 78169c1, import 0cfda26, ops a535a36). Full verification on merged main: 1031 server tests passed (96.27% coverage), pyrefly 0 errors, ruff clean, web pnpm verify green incl. 46/46 e2e.

- Finding 1 -> pkm-2fw1 (completed): cycle-safe recursive CTEs, corrupt-cycle termination test; real cap onset was depth 102
- Finding 2 -> pkm-1rb5 (completed): BlankTitleError at store boundary; ops fall back to "Untitled" (hjhy no-422 invariant); blank [[   ]] refs skipped at index_ref; broadcast enriched
- Finding 3 -> pkm-rovq (completed): admission lock, bounded create, teardown outside lock and cancellation-safe drain
- Finding 4 -> pkm-4zq4 (completed): BaseException cleanup around startup; config unlink in finally survives double cancellation
- Finding 5 -> pkm-w80k (completed): create_page rides in the OpBatch; _ensure_page removed from both shells
- Finding 6 -> pkm-y5yv (completed): all three uid minters (client, server, web) alnum-first; documented -- for legacy uids
- Finding 7 -> pkm-5ayg (completed): heading parents match level+text, first in document order, page before batch memo
- Finding 8 -> pkm-j58o (completed): orphans recovered to a deterministic page (two-pass rooting incl. cycles); report written before DB swap
- Finding 9 -> pkm-euhp (completed): externally referenced mermaid descendants never dropped; migration reports before deleting

New follow-up beans filed during review: pkm-2ilw (padded-title migration), pkm-8kw2 (client parity: depth caps, blank-ref handling), pkm-dzgw (select_section level), pkm-x1ig (importer polish bundle).

Medium/lower-priority findings (10-29) remain open in this epic.

## Medium sweep — started 2026-08-01

Child beans (finding → bean), grouped into five parallel track branches:

- **sync track**: 10 → pkm-getl, 11 → pkm-nn57, 12 → pkm-ldqx
- **services track**: 13 → pkm-lk7t, 14 → pkm-rwwc, 15 → pkm-1wv1
- **exports track**: 16 → pkm-n8eq, 17 → pkm-x3l7, 18 → pkm-9mdl, 26 → pkm-13ty
- **climcp track** (sequential): 22 → pkm-5k8p, 23 → pkm-3cyg, 24 → pkm-c17m, 21 → pkm-4w23, 20 → pkm-0wr8
- **misc track**: 19 → pkm-r72f, 25 → pkm-5g3d
