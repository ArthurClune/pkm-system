# pkm-ulae Follow-up Tidy Sweep Design

**Coordinator:** `pkm-mk87`  
**Follow-ups:** `pkm-2ilw`, `pkm-amq2`, `pkm-8kw2`, `pkm-dzgw`, `pkm-5h2k`, `pkm-xo6w`, `pkm-x1ig`

## Goal and scope

Complete every open direct follow-up under `pkm-ulae`. The sweep covers title migration and read-path normalization, online/offline traversal and reference parity, CLI section selection, importer refusal/reporting polish, and export-writer telemetry and staging cleanup.

The title migration will be implemented and verified only against isolated test databases. This work must not audit, mutate, or otherwise run the migration against the production PKM. Production activation remains an explicit later operator action through the supported CLI.

Unrelated open beans and opportunistic refactors are out of scope.

## Chosen approach

Use a coordinated invariant sweep. Each child bean remains independently testable and reviewable, but changes that define the same contract must land together across the server, Python client, CLI/MCP shells, web replica, importer, and architecture documentation.

Alternatives rejected:

- **Independent minimal patches:** smaller local diffs, but they would leave title and replica semantics dependent on which layer receives a request.
- **Broad subsystem refactors:** unified title, importer, and export abstractions could be cleaner eventually, but exceed the tidy-work scope and increase regression risk.
- **Automatic production title migration at startup:** removes the activation protocol but can perform an irreversible merge without operator review. Explicit audit/apply is required instead.

## 1. Title canonicalization and read parity

### Supported migration flow

Add an authenticated server migration surface and corresponding `pkm` CLI command with separate audit and apply modes. Audit is the default and has no side effects. It returns every title with leading or trailing ASCII spaces, grouped by canonical trimmed title, including:

- source and candidate survivor page IDs and titles;
- whether an exact clean-named twin already exists;
- deterministic source merge order;
- block and inbound-reference counts;
- a digest of the complete plan.

Apply requires the audit digest. It re-inventories inside one SQLite write transaction and returns `409` if the digest no longer matches. A legacy title made entirely of ASCII spaces is an explicit audit blocker: apply refuses it rather than inventing a destination such as `Untitled` or an empty title. Otherwise the transaction:

1. prefers an existing exact clean title as survivor, otherwise the lowest page ID;
2. snapshots every initially affected inbound block and establishes the complete source-to-survivor map before the first mutation;
3. merges source pages in ascending page-ID order so appended block order is stable;
4. rewrites each snapshotted block against the complete map and reindexes only after final text is known, preventing an early merge from hiding refs to a later source;
5. reuses existing rename/merge mechanics for sidebar, FTS, parent/page relationships, deletion, and journal changes;
6. records that plain-space canonicalization is active;
7. rotates replica database generation so stale exact-title keys rebuild from a snapshot.

Matching and grouping are exact and case-sensitive apart from removing boundary U+0020 characters. Any preflight, rewrite, or database failure rolls back the complete operation. Audit/apply code must not query production directly; the only supported operational path is the authenticated CLI/API.

### Activation and cross-stack behavior

Legacy databases begin with plain-space canonicalization inactive. Applying the migration activates it atomically. Fresh imported databases run the same planner before publication and start active because no legacy padded rows remain.

The server exposes activation state through sync metadata. The server creation boundary and the offline replica trim leading/trailing ASCII spaces only while active. This avoids changing lookup semantics before migration while keeping post-activation online and offline writes aligned.

Control-whitespace normalization remains independently safe and always active. `PkmClient.get_page()` and `get_backlinks()` normalize control whitespace before constructing paths. Server GET routes normalize at their lookup choke point as defense in depth, including callers outside the Python client. The CLI and MCP inherit the corrected client behavior. Backlink JSON keeps truthful pagination metadata rather than synthesizing a misleading request limit.

`_broadcast_op()` resolves the authoritative page title from the applied operation's `page_id` and broadcasts that stored title. It does not re-run a partial normalizer or relay caller spelling. This covers control whitespace, blank-title fallback, cross-page moves, and later plain-space activation without adding a new operation rejection path.

## 2. Traversal, references, and section selection

### Complete cycle-safe traversal

Remove the remaining depth-100 limits from:

- server ancestor/breadcrumb reads;
- web replica subtree enumeration used by optimistic move/delete;
- web replica local-API ancestor reads.

All three use uncapped visited-path traversal matching the established server operation pattern. A legal hierarchy is complete at any depth; a corrupt cycle terminates with each UID emitted at most once. The starting block must not reappear as its own ancestor.

### Blank reference parity

The pure Python and TypeScript reference extractors both drop a bracket reference when normalization followed by a blankness check yields an empty target. They continue preserving nonblank padding byte-for-byte while plain-space canonicalization is inactive. Store-level blank-title rejection remains defense in depth.

Shared fixtures drive Python grammar tests, TypeScript grammar tests, and replica reference tests. Local indexing must prove that `[[   ]]` creates neither a page nor a ref row while valid refs in the same block still index.

### CLI section semantics

`pkm get --section "## Notes"` matches both heading level and exact text. It selects the first matching heading in document order. Bare `--section "Notes"` retains the current lenient read behavior and selects the first exact-text block regardless of heading status. Error output lists available headings with markers so collisions are diagnosable. CLI help, README text, the PKM skill, and backend architecture documentation state the distinction.

## 3. Importer hardening and reporting

### Friendly EDN errors

`EdnError` carries a structured parser message and character offset. Every parser raise supplies that offset. The importer catches only `EdnError`, prints `error: malformed export at offset N: {detail}`, and exits 2 without a traceback or filesystem publication.

The parser continues rejecting `\/`. The supported input is Roam EDN, the committed fixtures do not require that JSON escape, and silently broadening the grammar would undo the strict-parser invariant. Logseq compatibility, if needed later, requires an explicit compatibility mode rather than global leniency.

### Tree preflight

Before database or report temporary files are created, importer preflight traverses the original export structure and records each block UID and structural location. A duplicate UID or multi-parent DAG raises a transport-neutral import-structure error. The CLI reports the refusal with the affected UID and locations, exits 2, and leaves the published database and report untouched.

### Global Mermaid preservation plan

Mermaid preservation is planned globally before flattening. A component whose referenced descendant must be preserved protects every candidate ancestor containing that component. Migration candidates containing preserved components are removed transitively. Report data is aggregated by descendant UID with the union of external source UIDs, so nested structures cannot double-report a pair.

`_print_preserved()` emits nothing for an empty result. Orphan recovery and Mermaid conversion compose: an orphan Mermaid subtree with an externally referenced child remains recoverable and keeps the reference resolving.

### Counts and cleanup claims

`implicit_page_count` is calculated after orphan walking and excludes the synthetic recovery page, so implicit pages discovered only through orphan text are included.

Tests distinguish preflight failures, report-render/publication failures, and earlier database-build or asset-copy failures. Documentation must not claim universal temporary-file cleanup: preflight leaves no temp files; report publication failures remove both temporary files; earlier build failures may leave an unpublished `pkm.sqlite3.tmp`, which the next import removes before rebuilding.

## 4. Export-writer polish

`export_graph()` returns disjoint `assets_copied` and `assets_repaired` counts. A fresh copy increments only `assets_copied`; replacement of a corrupt destination increments only `assets_repaired`. The nightly backup log prints both values, making nonzero repairs a visible disk-health signal.

At run start, under the documented single-writer-per-export-directory invariant, the writer removes abandoned `.export-staging-*` entries. Cleanup never follows symlinks: matching symlinks are unlinked, real directories are recursively removed, and entries disappearing during cleanup count as success. A persistent cleanup error aborts before modifying the last known-good export. No advisory locking or age heuristic is added because production has one writer per export directory and either alternative adds machinery without a current concurrency requirement.

The writer and architecture documentation explain that a corrupt destination with a missing source normally warns once after the successful publication drops the residue from the exported tree; a failure before publication may cause the warning to repeat.

## Functional-core / imperative-shell boundaries

Pure functional-core logic includes:

- migration inventory grouping, deterministic survivor selection, plan digest input, and activation-dependent title transformation;
- blank-reference filtering and section matching;
- importer duplicate-location validation and global Mermaid candidate filtering;
- export copy-versus-repair classification.

Imperative shells gather database/filesystem state, invoke the pure planners, transact or publish effects, expose HTTP/CLI adapters, and send sync notifications. Every changed runtime file keeps or gains the required FCIS declaration. No new mixed module is planned.

## API, generated files, and documentation

The migration route and sync activation field change the API surface. Update the backend API reference, regenerate `web/src/api/openapi.json` and `web/src/api/types.d.ts`, and update typed response contracts. The web replica schema/meta handling must consume activation state explicitly.

Update:

- `docs/architecture/backend.md` for migration, read normalization, importer refusals, section behavior, and export cleanup/telemetry;
- `docs/architecture/sync-and-offline.md` for canonicalization activation, generation rotation, and complete cycle-safe local traversal;
- CLI help, `README.md`, and `.claude/skills/pkm/SKILL.md` for migration and section syntax.

Recheck counts and enumerations that mention routes, response fields, migration steps, or replica metadata.

## Test-driven implementation

Every behavior change begins with a focused failing test.

### Title integrity

- deterministic audit groups, survivor choice, merge order, digest, and all-space-title refusal;
- clean-twin and multiple-padded-source merges, including blocks that reference more than one source;
- blocks, descendants, refs, sidebar, FTS, and block order preserved;
- stale digest returns 409; any failure rolls back;
- activation and database-generation rotation are atomic;
- imported databases start canonicalized;
- client, route, CLI, MCP, broadcast, and replica control-whitespace round trips;
- no test or command targets production.

### Traversal, refs, and sections

- depths 100, 101, 102, and 150 for server and local traversal;
- corrupt cycles terminate without duplicates;
- shared blank-ref and padded-nonblank fixtures across Python and TypeScript;
- local indexing creates no blank page/ref;
- marked section level, plain-block and wrong-level collisions, duplicate order, bare-text compatibility, integration errors, and help text.

### Importer

- structured EDN offsets and strict `\/` rejection;
- friendly malformed-input exit with no traceback;
- DAG/duplicate refusal before filesystem work and unchanged published files;
- report temp cleanup on publication failure;
- orphan-created implicit page counts;
- nested Mermaid ancestor protection and report deduplication;
- orphan recovery plus Mermaid preservation composition;
- empty preservation output.

### Export

- exact fresh-copy versus repair counts and backup log output;
- abandoned-directory cleanup;
- matching symlink removal without touching its target;
- cleanup failure before publication;
- one-successful-publish warning behavior.

## Verification and delivery

Implementation occurs on isolated branches/worktrees. Independent lanes may run in parallel; overlapping title/server/replica work stays in one lane. Integration uses `git merge --no-ff` to preserve branch history.

Before completion, run from the integration worktree:

```bash
cd server && uv run pytest -q
cd server && uv run pyrefly check
cd server && uv run ruff check
cd web && pnpm verify
```

Also launch an isolated test server and exercise migration audit/stale-plan/apply behavior through the supported CLI. Do not point any command at port 8974 or the production CLI configuration.

Each child bean receives checked tasks and a `## Summary of Changes`. The coordinating bean completes only after architecture review, generated-file review, full verification, final code review, and confirmation that no production migration was run.
