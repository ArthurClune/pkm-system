---
# pkm-ulae
title: Server hardening from recent-change review
status: completed
type: epic
priority: high
created_at: 2026-07-31T15:45:04Z
updated_at: 2026-08-01T20:10:18Z
---

## Context

A read-only review of `server/` after substantial recent churn was performed with five parallel tracks: HTTP/database/sync, assistant/describe, CLI/MCP/client, import/export/assets, and cross-cutting Python/FCIS architecture. The strongest claims were checked against the current source and existing tests. No implementation changes were made and the full server verification suite was not run as part of the review.

This epic records confirmed correctness, data-safety, concurrency, security, duplication, over-generalisation, typing, lifecycle, and complexity findings. Split independent findings into child bugs/tasks before implementation.

## High-priority findings

### 1. Remove the 100-level traversal corruption boundary

**References:** `server/src/pkm/server/ops_apply.py:20-58,70-80`

Both ancestry cycle detection and subtree enumeration silently stop at depth 100. A legal deeper hierarchy can be moved under one of its descendants because the root is no longer seen, creating a cycle. A cross-page move updates only the first 101 levels, leaving deeper descendants on the source page with parents on the destination page.

**Direction:** Traverse the complete hierarchy with cycle-safe recursive SQL, or enforce a documented depth limit before mutation. Cross-page moves must update every descendant or fail atomically.

- [x] Add depth-boundary tests at 100, 101, and deeper
- [x] Verify cycle prevention and every descendant's page after a cross-page move
- [x] Replace the silent traversal cap with complete traversal or explicit validation

### 2. Reject normalized-empty page titles at the shared creation boundary

**References:** `server/src/pkm/server/store.py:18-38`; `server/src/pkm/server/ops_apply.py:61-79`; `server/src/pkm/server/routes_pages.py:197-204`

`get_or_create_page()` normalizes control whitespace but does not reject a title that becomes `""`. The normal page route checks this, but create/create_page/cross-page move operations call the store directly and can commit an unreachable blank-titled page.

**Direction:** Make the shared creation boundary define normalized-empty behavior. Prefer rejecting the operation before mutation with a stable operation error; if offline replay needs a different recovery policy, specify it explicitly.

- [x] Add whitespace-only title tests for create, create_page, and move operations
- [x] Enforce the invariant in the shared creation path

### 3. Serialize assistant conversation admission

**References:** `server/src/pkm/assistant/service.py:54-69`

The conversation-cap check occurs before awaiting `engine.create_conversation()`. Concurrent requests can both observe free capacity and start harnesses, bypassing the configured cap or over-evicting idle conversations.

**Direction:** Serialize admission with a lock or atomically reserve creation slots, releasing reservations on every failure/cancellation path.

- [x] Add barrier-controlled concurrent creation tests
- [x] Enforce the cap across active and in-progress creations

### 4. Make Claude harness startup transactional and cancellation-safe

**References:** `server/src/pkm/assistant/claude_engine.py:245-280`

Startup writes a 0600 config containing a long-lived session token, creates the SDK client, and connects it without cleanup around failure or cancellation. Factory/connect failures can leave the credential file and a partially started subprocess/client behind.

**Direction:** Wrap all work after config creation in cancellation-safe cleanup that disconnects any created client and always unlinks the config before re-raising.

- [x] Test factory failure, partial connect failure, and cancellation during connect
- [x] Assert credential unlink and client disconnect on every failed startup path

### 5. Keep CLI/MCP batch page creation inside the advertised atomic transaction

**References:** `server/src/pkm/cli/main.py:360-367,420-433`; `server/src/pkm/mcp/server.py:38-46,134-150`; `server/src/pkm/server/ops_core.py:75-95`

Both shells call `_ensure_page()` before fully validating and posting a batch. A batch with a missing page followed by an invalid command can fail while leaving the page committed, contradicting the CLI/MCP “one atomic transaction” contract.

**Direction:** Validate the complete command batch before I/O. Represent missing pages as empty planning payloads and include supported create_page operations in the same `OpBatch`.

- [x] Add failed-batch tests asserting no pages or blocks remain
- [x] Move page creation into the atomic operation batch

### 6. Generate CLI-safe UIDs and preserve access to legacy leading-dash UIDs

**References:** `server/src/pkm/client/api.py:55-56`; `server/src/pkm/server/ops_core.py:15`; `server/src/pkm/cli/main.py:475-476,521-525`

`secrets.token_urlsafe()` can generate a UID beginning with `-`. The server accepts it, but argparse interprets it as an option, so the CLI can create blocks it cannot subsequently address normally. This also makes write tests probabilistically flaky.

**Direction:** Generate UIDs with an alphanumeric first character. Preserve access to existing leading-dash UIDs through documented `--` handling or an explicit `--uid` option and plan any regex tightening compatibly.

- [x] Add deterministic leading-dash parser and end-to-end tests
- [x] Make new UID generation CLI-safe
- [x] Document or implement access to legacy UIDs

### 7. Resolve heading parents by text and heading level

**References:** `server/src/pkm/cli/build.py:55-82,164-175,197-202`

`resolve_parent("## Notes")` compares only block text and ignores `heading`. It can choose a plain `Notes` block or a level-3 heading instead of a level-2 heading, while same-batch heading memoization is level-aware.

**Direction:** Require the requested heading level when resolving heading specifications and define duplicate-heading selection semantics.

- [x] Add plain-text collision, wrong-level collision, and duplicate-heading tests
- [x] Align fetched-page and in-batch heading resolution

### 8. Do not silently discard valid orphan blocks during import

**References:** `server/src/pkm/importer/parse_export.py:116-135`; `server/src/pkm/importer/run.py:78-126`

The importer records only the count of valid UID/string blocks unreachable from pages; it does not retain them. The replacement database is published before the warning report is written, so user content can be omitted and report failure can hide the warning.

**Direction:** Preserve orphan subtrees on a deterministic recovery page, or refuse publication unless an explicit lossy-import option is supplied. Complete preflight/reporting before swapping databases.

- [x] Assert every orphan UID/text remains recoverable or import is refused
- [x] Verify the existing database remains untouched on refusal/report failure
- [x] Make lossy behavior explicit rather than warning after publication

### 9. Preserve block-reference integrity during Mermaid conversion

**References:** `server/src/pkm/importer/rows.py:48-61`; `server/src/pkm/importer/migrate_mermaid_blocks.py:82-93`; `docs/architecture/backend.md:325-328`

Mermaid conversion flattens descendant text and drops/deletes descendant rows and stable UIDs. Any external `((child-uid))` reference becomes permanently unresolved, contradicting the documented UID-preservation invariant.

**Direction:** Detect inbound references before conversion. Preserve referenced descendants, rewrite references only where semantics are valid, or refuse/report conversion. If a lossy mode remains, enumerate every affected UID.

- [x] Test referenced nested Mermaid descendants
- [x] Add dry-run reporting of affected UIDs and inbound references
- [x] Preserve or explicitly gate lossy metadata/UID removal

## Medium-priority findings

### 10. Nudge connected replicas after journal cleanup

**References:** `server/src/pkm/server/routes_pages.py:423-448`; `server/src/pkm/server/notify.py:1-38`; change triggers in `server/src/pkm/schema.py:129-150`

Journal cleanup commits page/block deletions and advances `changes.seq` but sends no sequence nudge. Connected replicas can retain deleted pages until another mutation or reconnect. This overlaps the previously scrapped `pkm-ie73`, but the current invariant remains broken.

**Direction:** Send a post-commit nudge when cleanup deletes rows, and centralize the commit-then-nudge protocol to prevent route omissions.

- [x] Add WebSocket coverage for journal cleanup
- [x] Add a mutation-route contract test for every journal-advancing endpoint
- [x] Centralize or enforce post-commit notification

### 11. Make WebSocket fan-out concurrent without losing per-client ordering

**References:** `server/src/pkm/server/ws.py:15-35`; `server/src/pkm/server/routes_ops.py:59-67`

`Hub.broadcast()` awaits each client sequentially with a one-second timeout. Writes await multiple broadcasts after commit, so stalled clients can add latency proportional to connection count.

**Direction:** Send concurrently with bounded concurrency and per-client timeout. Preserve per-client frame ordering via queues or locks and consider connection limits.

- [x] Add multiple-stalled-client latency tests
- [x] Implement bounded concurrent fan-out with ordered per-client delivery

### 12. Batch sync hydration queries

**References:** `server/src/pkm/server/routes_sync.py:36-71,93-104,124-135`

Changed blocks are hydrated with one block query and one refs query per UID; pages/sidebar entries are also fetched individually. A legal 5,000-entity window can execute over 10,000 SQL statements, and snapshots have no block limit while holding a read transaction.

**Direction:** Fetch blocks, refs, pages, and sidebar rows in chunked set queries under SQLite's parameter limit and group them in memory.

- [x] Add distinct-UID query-count or benchmark coverage
- [x] Replace N+1 hydration with bounded set queries

### 13. Throttle expensive unauthenticated password checks

**References:** `server/src/pkm/server/auth.py:45-56`; `server/src/pkm/server/auth_core.py:8-15`

Every login failure runs scrypt with no rate limit, concurrency bound, or backoff. Any host able to reach the configured bind address can consume substantial CPU and memory with concurrent attempts.

**Direction:** Add global/per-source throttling and bound concurrent checks while keeping failure responses uniform.

- [x] Add rate-limit and concurrent-attempt tests
- [x] Bound unauthenticated scrypt work

### 14. Retire assistant conversations after failed interrupts

**References:** `server/src/pkm/assistant/claude_engine.py:147-201`; `server/src/pkm/assistant/service.py:86-93`

If interrupt times out or raises, local cleanup continues and the service marks the conversation not busy even though the subprocess may still be running. The uncertain harness is then reusable for later turns, risking stale events, concurrent queries, or continued token use.

**Direction:** Treat unacknowledged interrupt as terminal: disconnect/kill the harness and remove or invalidate the conversation.

- [x] Add a second-send test after interrupt timeout/failure
- [x] Prevent reuse of uncertain harnesses

### 15. Deduplicate queued and in-flight image descriptions

**References:** `server/src/pkm/describe/service.py:60-79,96-122`; `server/src/pkm/describe/routes.py:23-28`

Uploads and scans enqueue SHA values without pending/in-flight deduplication. Duplicate entries after a failure can repeatedly send the same private image to the external describer, multiplying cost and rate-limit pressure.

**Direction:** Track queued/in-flight SHAs with `finally` cleanup and model force-retry intent explicitly.

- [x] Add duplicate upload/scan tests with a failing describer
- [x] Guarantee at most one ordinary in-flight attempt per asset

### 16. Preserve the last good Markdown backup until replacement succeeds

**References:** `server/src/pkm/export/writer.py:39-59`; `server/src/pkm/backup/__main__.py:79-84`

`export_graph()` deletes all current page/journal Markdown files before rendering replacements. Rendering, disk, permission, or asset-copy failure leaves a partial export and destroys the last known-good working tree.

**Direction:** Render and validate in staging, then atomically publish while preserving the export repository, or implement rollback-safe replacement.

- [x] Inject rendering and copy failures and assert the previous export is byte-identical
- [x] Publish exports atomically

### 17. Verify content-addressed files instead of trusting existence

**References:** `server/src/pkm/importer/run.py:101-107`; `server/src/pkm/export/writer.py:64-72`

Importer and backup export skip copying whenever the destination exists; they do not verify that bytes match the SHA in the path. Truncated or corrupted files can survive every later import/export.

**Direction:** Verify size and SHA-256 and atomically repair mismatches from the known source.

- [x] Add same-size and truncated corruption repair tests
- [x] Validate and repair existing content-addressed files

### 18. Guarantee ZIP member-name uniqueness after suffix generation

**References:** `server/src/pkm/assets_core.py:64-76`

`zip_arcnames()` checks whether the original filename is used but does not recheck the generated `name (<sha8>).ext`. Generated-looking input names or shared eight-character SHA prefixes can still produce duplicate ZIP members.

**Direction:** Loop until the candidate is unused, using a longer SHA or incrementing suffix when necessary.

- [x] Test generated-looking names, shared SHA prefixes, and case-insensitive collisions
- [x] Assert every archive name is unique

### 19. Make EDN parsing strict and Unicode-safe

**References:** `server/src/pkm/edn.py:97-113,120-141`

Unsupported string/character escapes can be silently changed, surrogate-pair escapes produce invalid Python strings, truncated Unicode escapes leak raw `ValueError`, and discard forms at collection ends are rejected. Silent text corruption is worse than a clear import failure.

**Direction:** Validate escape names and hex length, combine/reject surrogates correctly, normalize parser errors to `EdnError`, and model discard forms at collection-parser level.

- [x] Add unknown/truncated/lone-surrogate/supplementary-codepoint tests
- [x] Add collection-end discard tests
- [x] Reject unsupported forms without altering text

### 20. Introduce typed transport-neutral client contracts and remove dependency inversion

**References:** `server/src/pkm/client/api.py:18,91-148`; `server/src/pkm/cli/build.py:10,38-342`; `server/src/pkm/server/response_models.py:18-264`; imports in `server/src/pkm/cli/main.py:27-28` and `server/src/pkm/mcp/server.py:19`

`PkmClient` returns bare dictionaries and downstream planners/renderers access nested untyped data, so static checking cannot catch response drift despite exact Pydantic models existing. CLI/MCP depend inward on `pkm.server.*` and duplicate ensure-page/default-date/fetch-plan-post workflows.

**Direction:** Move transport-neutral operation/response contracts into an independent domain package, return validated models or precise `TypedDict`s, and extract shared application workflows while keeping presentation shells separate.

- [x] Define dependency direction and transport-neutral contracts
- [x] Add malformed/stale response contract tests
- [x] Replace duplicate CLI/MCP workflows without over-generalising presentation

### 21. Validate batch commands with a discriminated schema before planning or I/O

**References:** `server/src/pkm/cli/build.py:296-320,341-414`; `server/src/pkm/cli/main.py:420-432,561-572`; `server/src/pkm/mcp/server.py:134-149`

The only contract is `list[dict]`; malformed items and nested values can escape as `AttributeError`/`KeyError`. `plan_batch()` is also an oversized dispatcher combining validation, alias state, and planning.

**Direction:** Add command-specific discriminated models in the functional core, validate the full envelope before page discovery, and dispatch to small per-command planners with one stable user-facing error contract.

- [x] Test non-object items/params, missing/wrong fields, indexes, and aliases in CLI and MCP
- [x] Split validation from command planning

### 22. Use canonical page titles returned by creation

**References:** `server/src/pkm/cli/main.py:360-367`; `server/src/pkm/mcp/server.py:38-46`; `server/src/pkm/client/api.py:126-127`; `server/src/pkm/server/routes_pages.py:193-203`

Both `_ensure_page()` implementations ignore the canonical title returned by POST and refetch the original spelling. Leading/trailing or control whitespace can create the normalized page and then 404 on refetch, leaving side effects after a failed command.

**Direction:** Use the returned canonical title and centralize ensure-page behavior.

- [x] Add whitespace-normalization tests for CLI and MCP
- [x] Remove duplicate, non-canonical ensure-page implementations

### 23. Do not silently truncate CLI/MCP backlinks

**References:** `server/src/pkm/client/api.py:102-105`; `server/src/pkm/cli/main.py:78-81,335-339`; `server/src/pkm/mcp/server.py:80-84`; `server/src/pkm/server/routes_pages.py:165-187`

`get_page()` requests at most 100 backlink groups while the route is paginated. CLI/MCP render the partial result without a truncation marker despite CLI wording that promises every block.

**Direction:** Fetch all pages or expose pagination and clearly report truncation through a dedicated client method.

- [x] Test `total_pages > len(groups)` in client, CLI, and MCP
- [x] Make completeness/truncation explicit

### 24. Avoid orphan assets in upload-and-link workflows

**References:** `server/src/pkm/cli/main.py:405-416`; `server/src/pkm/mcp/server.py:153-168`; `server/src/pkm/client/api.py:135-142`

The asset is uploaded before page/parent validation and before the block operation. Invalid parents or failed operations leave unlinked assets; CLI prints the URL before linking succeeds.

**Direction:** Resolve/validate destination before upload, delay success output, and add either a transactional endpoint or compensating deletion for post-upload write failure.

- [x] Add invalid-parent and post-upload operation-failure tests
- [x] Prevent or compensate orphaned uploads

### 25. Configure production logging through a parent package logger

**References:** logger declarations in `server/src/pkm/server/routes_assets.py:34`, `server/src/pkm/assistant/claude_engine.py:50`, and `server/src/pkm/assistant/service.py:16`; `server/src/pkm/server/logfmt.py:34-57`

Production logging explicitly configures only `pkm.access` and `pkm.describe`. New `pkm.assets` and `pkm.assistant` loggers can lose intended INFO lifecycle output and project formatting, repeating the logger-registration drift previously fixed for describe.

**Direction:** Configure a parent `pkm` logger once, with explicit stream/format overrides only where required.

- [x] Add a test enumerating `pkm.*` loggers and asserting effective handlers/levels
- [x] Replace the open-ended logger allowlist with a parent policy

### 26. Bound memory use for ZIP responses

**References:** `server/src/pkm/server/routes_export.py:155-168`; `server/src/pkm/server/routes_assets.py:202-228`

Whole-graph and selected-asset exports build complete ZIPs in `BytesIO` and call `getvalue()`. Selected assets have no count or total-byte bound, so a large request can exhaust the process.

**Direction:** Use a temporary-file-backed or streaming response and enforce count/byte limits.

- [x] Add archive size/count limit tests
- [x] Verify temporary archive cleanup on cancellation/error
- [x] Replace unbounded in-memory buffering

## Lower-priority findings

### 27. Make sidebar append concurrency-safe

**References:** `server/src/pkm/server/routes_sidebar.py:35-49`

Concurrent additions use read/check/compute/insert. Different titles can receive duplicate order indexes; identical titles can surface an uncaught uniqueness error as 500 instead of 409.

- [x] Add concurrent same-title and different-title tests
- [x] Serialize index allocation and map uniqueness conflicts to 409

### 28. Close the owned OpenAI HTTP client during application shutdown

**References:** `server/src/pkm/describe/openai_client.py:17-22,40-41`; `server/src/pkm/describe/service.py:27-30,51-58`; `server/src/pkm/server/app.py:57-65`

`OpenAIDescriber` owns an async client and exposes `close()`, but `DescribeService.close()` only cancels the worker. Lifespan restarts can leak sockets and transport resources.

- [x] Define describer ownership/lifecycle semantics
- [x] Close owned clients from application shutdown and test it

### 29. Remove duplicate HTTP status prefixes from CLI/MCP errors

**References:** `server/src/pkm/client/core.py:43-57`; `server/src/pkm/client/api.py:91-100`

`friendly_error()` prefixes status and `ApiError` prefixes it again, producing strings such as `404: 404: page not found`.

- [x] Add exact end-to-end error-string tests
- [x] Assign status formatting to one layer

## Verification and documentation

- [x] Use test-driven development for every behavior change
- [x] Run `cd server && uv run pytest -q`
- [x] Run `cd server && uv run pyrefly check`
- [x] Run `cd server && uv run ruff check`
- [x] Review and update `docs/architecture/backend.md` for route, contract, dependency, importer, logging, and archive changes
- [x] Update `docs/architecture/sync-and-offline.md` for notification and sync hydration invariants
- [x] Recheck FCIS classifications for any modules split or moved
- [x] Split independent findings into child beans before implementation

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

## Medium sweep — completed 2026-08-01

All seventeen medium-priority findings (10-26) fixed via child beans, each TDD'd, task-reviewed, and re-reviewed; five track branches merged to main with --no-ff (misc 76c0b8e, services f2d862e, sync eb1325f, exports b97045f, climcp 1442499). Full verification on merged main: 1193 server tests passed (96.74% coverage), pyrefly 0 errors, ruff clean, web pnpm verify green incl. 46/46 e2e. openapi.json + web types regenerated from merged code.

- Finding 10 -> pkm-getl (completed): post-commit nudge after journal cleanup; commit+nudge centralized; 11-route contract test incl. delete_asset's conditional branch
- Finding 11 -> pkm-nn57 (completed): per-client bounded queues + drain tasks; structural FIFO; dropped clients get a bounded socket close (3 fix rounds hardened self-/cross-task cancel races)
- Finding 12 -> pkm-ldqx (completed): chunked IN-clause hydration, byte-identical wire format, trace-hook query-count test
- Finding 13 -> pkm-lk7t (completed): scrypt slots w/ 2s timeout into uniform 401, hard-capped source table; docs note tailscale-serve source collapse
- Finding 14 -> pkm-rwwc (completed): unacknowledged interrupt is terminal; busy->pop with no await window
- Finding 15 -> pkm-1wv1 (completed): queued/in-flight SHA dedupe with finally cleanup; force-retry preserved
- Finding 16 -> pkm-n8eq (completed): stage-then-swap export publish, next-run self-heal, failure never git-committed
- Finding 17 -> pkm-x3l7 (completed): size+SHA verification before hardlink/skip in writer+importer; missing-source repairs surfaced
- Finding 18 -> pkm-9mdl (completed): arcname uniqueness through full-sha extension + numeric fallback, case-insensitive
- Finding 19 -> pkm-r72f (completed): EDN strict escapes/surrogates/discards; final review caught int(x,16) laxness
- Finding 20 -> pkm-0wr8 (completed): pkm.contracts package; response_models.py deleted; client validates every response; zero client/cli/mcp->server imports (AST-enforced)
- Finding 21 -> pkm-4w23 (completed): discriminated batch models validated before I/O; flatten-aware outline emptiness; stable batch[i] error contract
- Finding 22 -> pkm-5k8p (completed): original finding obsolete (pkm-w80k); successor gap fixed — client lookups normalize control-whitespace titles
- Finding 23 -> pkm-3cyg (completed): get_backlinks pages to completion, reorder-safe, loud on non-convergence
- Finding 24 -> pkm-c17m (completed): validate-before-upload, success output after link, compensation gated on existing flag
- Finding 25 -> pkm-5g3d (completed): parent pkm logger policy + enumeration drift test; describe now logs to stderr (deploy-visible)
- Finding 26 -> pkm-13ty (completed): temp-file-backed ZIP responses, 500-file/1GiB selected-asset limits, loud 413

New follow-up beans filed during the sweep: pkm-5h2k (importer CLI EDN error UX — strict parser makes it likelier to fire), pkm-amq2 (export writer polish: repair telemetry, staging-dir sweep, one-shot warning note). Candidate future bean from climcp final review: read-path title normalization (pkm get/refs 404 on control-whitespace spellings that save now handles).

Deploy notes: pkm.describe log lines move stdout->stderr under the parent-logger policy (launchd log files swap roles for those lines); login gains throttling (global scrypt bound is the real defense behind tailscale serve).

Lower-priority findings (27-29) were the only remaining items at the end of the medium sweep and are completed below.

## Low-priority sweep — completed 2026-08-01

All three lower-priority findings (27–29) were fixed via child beans and isolated branches, developed test-first, independently reviewed, and merged with `--no-ff`.

- Finding 27 → pkm-9nzn (completed): SQLite writer reservation serializes sidebar append allocation; duplicate races return 409.
- Finding 28 → pkm-wztk (completed): DescribeService owns and closes its describer after worker shutdown; app teardown remains failure-safe.
- Finding 29 → pkm-qvus (completed): friendly details are status-neutral and ApiError renders one numeric prefix.

Architecture documentation records the sidebar and describer lifecycle invariants.

Full server verification: 1205 server tests passed (96.67% coverage); pyrefly 0 errors; ruff clean.

## Summary of Changes

All 29 server-hardening review findings are now complete across three sweeps. Final-review hardening now also makes describer shutdown shared and cancellation-safe and proves sidebar concurrency at the real database dependency boundary.

- Findings 1–9 (high priority): removed the traversal corruption boundary; rejected normalized-empty titles at the shared creation boundary; serialized assistant admission; made Claude startup transactional and cancellation-safe; kept CLI/MCP page creation inside one OpBatch; made new UIDs CLI-safe while preserving legacy `--` access; resolved heading parents by heading level and text; preserved orphan import blocks; and kept Mermaid conversion from breaking inbound block refs.
- Findings 10–26 (medium priority): restored post-commit sync nudges and route coverage; made WebSocket fan-out bounded and ordered; batched sync hydration; throttled unauthenticated scrypt work; retired conversations after failed interrupts; deduplicated queued/in-flight image descriptions; staged Markdown exports atomically; verified and repaired content-addressed files; guaranteed ZIP member uniqueness; made EDN parsing strict and Unicode-safe; moved typed contracts to `pkm.contracts`; validated batch commands before planning/I/O; normalized client title lookups; fetched backlinks to completion; prevented or compensated orphan asset uploads; configured logging through the parent `pkm` logger; and replaced in-memory ZIP buffering with bounded temp-file-backed responses.
- Findings 27–29 (low priority): serialized sidebar append allocation under SQLite's write reservation; made `DescribeService` own worker-first describer shutdown while app teardown still closes assistant resources; and removed duplicate HTTP status prefixes so ApiError is the sole numeric status renderer.

Architecture docs now match the merged code's sidebar writer-reservation invariant, the DescribeService ownership/close ordering, and the transactional `POST /api/ops` wording.
