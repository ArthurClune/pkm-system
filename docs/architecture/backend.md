# Backend architecture (server/ + HTTP API)

The backend is a Python 3.12+ FastAPI application over a single SQLite file.
It is the sole authority for the graph. Block-graph mutations flow through
`POST /api/ops`, other writes use dedicated routes, refs and full-text indexes
are re-derived inside the same transaction, and a trigger-based change journal
feeds the sync protocol. There is no ORM and no migration framework: raw
`sqlite3` with replayable DDL.

Start with [overview.md](overview.md) for the system-level picture and the
tech stack. Siblings own the rest: the sync protocol
([sync-and-offline.md](sync-and-offline.md)), the CLI and MCP server
([cli-and-mcp.md](cli-and-mcp.md)), and the embedded assistant, asset store
and `/files` browser ([assistant-and-files.md](assistant-and-files.md)).

## Module map

Everything lives under `server/src/pkm/`. Every runtime file declares
`# pattern: Functional Core` (pure logic) or `# pattern: Imperative Shell`
(I/O) near the top — see [overview.md](overview.md#functional-core--imperative-shell)
for the pattern.

```
pkm/
├── schema.py            Core   Single source of DDL: BASE_DDL (replicated to clients)
│                               + SERVER_DDL (journal, idempotency) = DDL
├── refs.py              Core   Ref grammar: [[links]], #tags, attr::, ((refs)), {{embeds}}
├── rename.py            Core   one-pass, opaque-value title-ref rewrite for page rename/merge
├── title_migration.py   Core   boundary-space grouping, blockers, survivor plan + digest
├── todo.py              Core   {{TODO}}/{{DONE}} marker parsing (mirrors web/src/grammar/todo.ts)
├── filenames.py         Core   safe_filename() shared by upload + export
├── assets_core.py       Core   Asset-browser helpers: reference-token stripping,
│                               MIME categorisation (+ its SQL twin), zip arcnames
├── edn.py               Core   Minimal EDN parser for Roam exports
├── schema_dump.py       Shell  Generates web/src/replica/baseSchema.gen.ts
├── refs_parity_dump.py  Shell  Generates shared/fixtures/refs_parity.json
│
├── contracts/           Core   The wire contract, depended on by BOTH sides:
│                               ops.py (op models + UID_RE + text_hash),
│                               responses.py (JSON response models),
│                               daily.py (date <-> "July 8th, 2026" titles)
│
├── server/              The FastAPI app (details below)
├── importer/            Roam EDN import pipeline: run.py Shell; preflight.py and
│                        mermaid_preservation.py Core validation/planning
├── export/              Markdown export (markdown.py Core render, writer.py Shell)
├── backup/              Nightly backup job (__main__.py Shell, rotation.py Core)
├── cli/                 `pkm` CLI (main.py Shell; build.py/render.py Core planners)
├── client/              Shared HTTP client (api.py Shell PkmClient, core.py Core,
│                        workflows.py Shell: the write workflows CLI+MCP share)
├── mcp/                 `pkm-mcp` FastMCP stdio server over the same client
├── assistant/           Embedded LLM assistant: SSE routes + Claude Agent SDK
│                        harness confined to the pkm MCP tools
├── describe/            Image-description queue + OpenAI vision client
└── test_data/           Synthetic fixture graph generator
```

**Dependency direction.** `cli`/`mcp`/`client` → `contracts` ← `server`, and
`contracts` imports neither side. The op models, the uid regex and the
daily-title spelling are transport contracts, not server internals, so they
live in `pkm/contracts/`; `pkm.server` still owns everything that acts on
them (`ops_core.plan_op`, `server/daily.py`'s journal-day selection). Two
tests in `tests/test_client_contracts.py` enforce the direction by parsing
imports, so a re-crossing fails the suite rather than review.

Inside `pkm/server/`:

| File | Pattern | Role |
|---|---|---|
| `app.py` | Shell | App factory `create_app(config)`; runs `init_db()`, builds the `AssistantService` (engine injectable), mounts routers, serves the SPA |
| `config.py` | Shell | Frozen `Config` loaded from the data dir's `config.json` |
| `db.py` | Shell | `init_db()`/`open_db()`, per-request connection dependency, column migrations |
| `auth.py` / `auth_core.py` / `throttle_core.py` | Shell / Core / Core | Login routes + `require_auth`; scrypt password check, HMAC session tokens; per-source login backoff policy (see [Auth](#auth)) |
| `routes_pages.py`, `routes_ops.py`, `routes_search.py`, `routes_sidebar.py`, `routes_sync.py`, `routes_assets.py`, `routes_export.py`, `routes_migrations.py` | Shell | The HTTP surface (table below), including the authenticated title-canonicalization audit/apply operator route |
| `title_migration.py` / `sync_meta.py` | Shell / Shell | Transaction-owned title inventory/apply and durable activation/generation accessors |
| `ops_core.py` | Core | Pure `plan_op()` → effect tuples, over the op models in `pkm/contracts/ops.py` |
| `ops_apply.py` | Shell | Reads SQLite into an `OpContext`, executes planned effects |
| `store.py` | Shell | Reusable page mutations (create/delete/rename/merge); never commits |
| `tree.py`, `backlinks.py`, `daily.py`, `fts.py`, `query.py`, `sync_core.py`, `mime_sniff.py` | Core | Pure helpers: tree building, backlink shaping, journal-day selection + empty-daily test, FTS queries, `{{[[query]]}}` evaluation, sync windowing and hydration ordering, MIME sniffing |
| `ws.py` / `notify.py` | Shell | WebSocket hub + broadcast nudges |
| `tempfile_response.py` | Shell | `CleanupFileResponse`: a `FileResponse` whose cleanup callback runs even on a missing/unreadable file or a send-time error, not only after a completed transfer (used by the zip export routes; see [assistant-and-files.md](assistant-and-files.md#assets-and-the-file-browser)) |
| `request_log.py` / `logfmt.py` | Shell / Core | The `pkm.access` request log — one line per request, with durations (see [Logging](#logging-and-observability)) |
| `run.py` / `setup.py` | Shell | `python -m pkm.server.run` entrypoint; `setup` writes `config.json` |
| `openapi_dump.py` / `shim_parity_dump.py` | Shell | Generated-artifact writers (see [Generated artifacts](#generated-artifacts-and-parity-fixtures)) |

Two HTTP surfaces live outside this package: the assistant routes
(`pkm/assistant/`) and the image-description status/scan routes
(`pkm/describe/`). `app.py` constructs their services and mounts their routers
alongside the ones above; both subsystems are described in
[assistant-and-files.md](assistant-and-files.md).

## Database

One SQLite file (`pkm.sqlite3`) in the data directory. WAL mode and schema
are applied **once at startup** by `init_db()` (`server/db.py`), not
per-request: per-connection WAL/DDL setup racing an in-flight transaction is
a far larger, un-retriable source of lock errors than genuine writer
contention. Request handlers get a fresh connection each (`check_same_thread=False`, `Row` factory, `foreign_keys=ON`,
`recursive_triggers=ON`, `busy_timeout=5000`).

Schema lives in `pkm/schema.py` as two DDL blocks. `BASE_DDL` is the data
model, and is **replicated verbatim to browser clients** via the generated
`baseSchema.gen.ts`. `SERVER_DDL` adds server-only sync machinery and never
leaves the server.

```mermaid
erDiagram
    pages ||--o{ blocks : "page_id"
    blocks ||--o{ blocks : "parent_uid"
    blocks ||--o{ refs : "src_block_uid"
    pages ||--o{ refs : "target_page_id"

    pages {
        int id PK
        text title UK
        int created_at
        int updated_at
    }
    blocks {
        text uid PK "Roam uids preserved on import"
        int page_id FK
        text parent_uid FK "null = top-level"
        int order_idx "position among siblings"
        text text "unmodified Roam-flavoured markdown"
        int heading
        int collapsed
        text view_type "numbered | document"
        int created_at
        int updated_at "last real change (see write path)"
    }
    refs {
        text src_block_uid PK
        int target_page_id PK
        text kind PK "link | tag | attribute"
    }
    assets {
        text sha256 PK
        text filename
        text mime
        int size
    }
    sidebar_entries {
        int id PK
        text title UK
        int order_idx
    }
```

Around that base model:

- **Derived indexes.** `blocks_fts` and `pages_fts` are external-content FTS5
  tables kept in sync by `AFTER INSERT/UPDATE/DELETE` triggers. Block text is
  the only durable data; `refs` and FTS are always rebuilt from it.
  (`blocks_fts` is keyed by implicit rowid, so `VACUUM` would break it.)
- **Server-only tables** (`SERVER_DDL`):
  - `changes(seq AUTOINCREMENT, kind, entity_id, deleted)` — the append-only
    change journal. Populated by **row-level triggers** on
    blocks/pages/sidebar, not by route code, so any new write path is
    journalled automatically. Cascade deletes journal correctly only because
    `recursive_triggers=ON`.
  - `applied_batches(batch_id, request_hash, response)` — op idempotency.
  - `sync_meta` — durable server sync and title metadata. Today it holds the
    random `db_generation` token (a rebuilt database gets a new one and
    clients rebootstrap) plus `plain_space_title_canonicalization`, the
    rollout flag for stripping leading and trailing plain spaces from
    canonicalized page titles.
- **Schema migrations.** No framework. Additive tables and indexes are
  replayable `IF NOT EXISTS` statements in `schema.py`; additive columns are
  guarded `PRAGMA` checks in `db._ensure_schema_migrations` (currently
  `blocks.view_type` and the three `assets` description columns). One *data*
  backfill runs alongside them: blocks the Roam import left with a NULL
  `created_at` (old blocks carrying no `:create/time`) take
  `MIN(page.created_at, block.updated_at)`, so a filled-in `created_at` can
  never postdate the block's own last edit. It is a plain
  `WHERE created_at IS NULL` update — re-running is a no-op — and it fires the
  block triggers, so replicas pick the values up through ordinary sync.
  Client replicas rebootstrap on a schema-hash change.
  This startup work does **not** run the existing-data title migration; title
  activation is the explicit audited operator path described below.

## The write path

`POST /api/ops` is the transactional block-operation write path. Clients send
an `OpBatch` (`client_id`, optional `batch_id`, 1–500 ops) of block-level
operations: `create`, `update_text`, `move`, `delete`, `set_collapsed`,
`set_heading`, `set_view_type`, `create_page`.

The path is the clearest FCIS example in the repo: a pure planner between two
thin shells.

```mermaid
flowchart LR
    C[Client batch] --> R["routes_ops.py (Shell)<br/>idempotency check"]
    R --> CTX["ops_apply._context_for (Shell)<br/>read SQLite → OpContext"]
    CTX --> P["ops_core.plan_op (Core)<br/>pure: op + context → effect tuples"]
    P --> X["ops_apply._execute (Shell)<br/>effects → SQL, one transaction"]
    X --> J["change journal<br/>(triggers, automatic)"]
    X --> B["WS broadcast + seq nudge<br/>(after commit)"]
```

Key mechanics:

- **Ordering.** Siblings hold integer `order_idx`. An insert or move emits a
  `ShiftSiblings` effect — bump every sibling ≥ the target index — before
  placing the block. Cross-page moves re-page the whole subtree and touch
  both pages, and a parent-chain check prevents cycles.
- **Refs re-derivation.** Every text change emits `ReindexRefs`: delete the
  block's refs, re-extract with `refs.py`, get-or-create referenced pages,
  re-insert.
- **Timestamps: what counts as a change.** Blocks and pages both carry
  `created_at`/`updated_at` in epoch milliseconds, and the block-level values
  are genuine all the way back to the import — `parse_export.py` copies each
  Roam block's `:create/time` and `:edit/time`. `blocks.updated_at` is meant
  to answer "when was this block last really changed". `set_collapsed`
  therefore stamps neither the block's `updated_at` nor its page's:
  collapsing a subtree is a view-state toggle, frequent enough that counting
  it would drown the signal and churn the recently-changed page ordering.
  `update_text`, `move`,
  `set_heading` and `set_view_type` all do bump both. The change journal is
  trigger-driven and independent of this — a collapse still journals its block
  row, so the toggle still reaches other clients.
- **Conflict handling: per-block last-write-wins, with preservation.**
  `update_text` carries an optional `base_text_hash`, the sha256 of the text
  the edit was based on. It is a *text* hash rather than a version counter,
  so structural changes don't manufacture conflicts. On mismatch the incoming
  edit wins, and the losing text is preserved as a `[[conflict]]` sibling
  block. An edit to a since-deleted block is appended to today's daily page
  instead of vanishing. The sibling's uid comes from the server's own
  generator (`ops_apply.py`), which mints an alphanumeric first character like
  every other uid minter in the project, so the CLI can address it without
  `--` (see the uid note in
  [cli-and-mcp.md](cli-and-mcp.md#writes-uids-and-missing-pages)).
- **Idempotency.** A retried batch — same `batch_id`, identical canonical
  request hash — replays the stored ack with no effects. The same id with a
  different payload is a 409. This is what makes offline queue replay safe.
- **Broadcast.** After commit, the WebSocket hub pushes the applied ops and a
  `{type:"seq", seq}` nudge to other clients (see
  [sync-and-offline.md](sync-and-offline.md)).

Page-level mutations (create, delete, rename, merge) live in `store.py` as
composable functions that never commit; routes own the transaction.
`POST /api/page/{title}/rename` rewrites all referencing block text via
`rename.py`, and merges by concatenating blocks when `allow_merge` is set.

Sidebar pinning is a separate write path. `POST /api/sidebar` takes SQLite's
writer reservation with `BEGIN IMMEDIATE` before it checks title uniqueness
and computes the append slot as `max(order_idx) + 1`. A same-title race
therefore becomes HTTP 409, and two distinct concurrent appends cannot land
on the same `order_idx`. That serialization is transactional, not a
schema-level uniqueness constraint on `sidebar_entries.order_idx`.

## Auth

Modest by design, layered under Tailscale (see `docs/SECURITY.md`):

- One shared password, checked with scrypt in constant time
  (`auth_core.py`). `POST /api/login` sets a `pkm_session` cookie:
  HMAC-SHA256-signed `v1.<issued_ms>.<sig>`, httponly, `samesite=lax`,
  1-year expiry.
- `LoginThrottle` (`auth.py`, one instance per app on `app.state`) bounds the
  cost of unauthenticated login attempts two ways. A per-source exponential
  backoff (1s, 2s, 4s, … capped at 30s, cleared by a success) rejects a
  throttled attempt *before* scrypt runs. A process-wide semaphore caps
  concurrent scrypt computations regardless of source.

  A throttled attempt gets the same 401 as a wrong password, including an
  attempt with the *correct* password. The only signal distinguishing them is
  the timing difference between a fast reject and a real scrypt computation,
  which the design accepts.

  Acquiring that semaphore slot (`scrypt_slot()`) is bounded by a timeout
  (`SCRYPT_ACQUIRE_TIMEOUT_S`, 2s) rather than an unbounded wait. `login()` is
  a sync route, so it runs on the same shared worker-thread pool as every
  other sync route. Blocking indefinitely on a full semaphore would let
  enough concurrent connections to `/api/login` — which cost nothing while
  queued — starve that pool and freeze the whole app, not just login. A
  timed-out acquire fails into the same uniform 401. Per-source backoff
  cannot defend against this on its own, because it only engages after a
  failure is recorded, which requires having got a slot and run a password
  check first. The timeout is what actually bounds it.

  In production the server sits behind `tailscale serve`, so
  `request.client.host` is the proxy's address for every request and all
  clients collapse into one throttle bucket. The per-source backoff is
  therefore effectively *global* there: one wrong password from anyone
  throttles everyone, including a subsequent correct-password login, for that
  backoff window. The global semaphore plus its 2s acquire timeout, not
  per-source isolation, is the real defense against a concurrency flood in
  the deployed setup.
- Every feature router is declared with
  `dependencies=[Depends(require_auth)]`. The public surface is only
  `GET /login`, `POST /api/login`, `GET /healthz`, and the static SPA shell.
- The WebSocket verifies the same cookie and closes unauthenticated
  connections with code 4401.
- The server binds loopback plus the Tailscale IP only (default port 8974).
  Tailscale is the real transport boundary.

## HTTP API reference

Authoritative sources: the `routes_*.py` modules and the generated
`web/src/api/openapi.json` (regenerate with `pkm.server.openapi_dump`; the
server test suite fails if it is stale). Response models are Pydantic classes
in `pkm/contracts/responses.py`. That is what makes the generated TS types
trustworthy, and — since `PkmClient` validates every response with the same
classes — what makes a drifting payload fail loudly in the CLI/MCP client
too. All endpoints require the session cookie unless marked public. FastAPI's
`/docs` and `/redoc` are disabled.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` *(public)* | Password → signed session cookie |
| GET | `/login` *(public)* | Inline HTML login form |
| GET | `/healthz` *(public)* | Liveness check |
| GET | `/{path}` *(public)* | SPA fallback: serves `web_dist` (index.html no-cache, hashed bundles under `/app-assets/`) |
| GET | `/api/openapi.json` | Live OpenAPI schema |
| **Writes** | | |
| POST | `/api/ops` | Transactional block-operation write path — apply an `OpBatch` transactionally |
| **Pages & blocks** | | |
| GET | `/api/page/{title}?bl_offset&bl_limit` | Page tree + paginated backlinks (daily pages auto-created) |
| GET | `/api/block/{uid}` | One block subtree with page context + breadcrumbs |
| GET | `/api/block-refs?uids=` | Resolve `((uid))` references on demand |
| POST | `/api/pages` | Idempotent page create |
| DELETE | `/api/page/{title}` | Delete page + blocks (+ sidebar entry); inbound links remain as text |
| POST | `/api/page/{title}/rename` | Rename and rewrite refs; 409 on collision unless `allow_merge`. Returns `RenamePageResponse` (`result: "renamed" \| "merged"`, `title`) |
| GET | `/api/unlinked?title` | Unlinked mentions of a title |
| GET | `/api/journal?before&days` | Daily-notes feed (infinite scroll) |
| POST | `/api/journal/cleanup` | Prune empty daily pages (spares today + referenced blocks) |
| GET | `/api/current-work` | Recently edited pages, bucketed by age |
| **Migrations** | | |
| GET | `/api/migrations/title-canonicalization` | Side-effect-free `TitleMigrationAuditPayload`: `active`, digest, grouped survivor/source plans and counts, and blockers whose `reason` is `all_space` or `forbidden_syntax` |
| POST | `/api/migrations/title-canonicalization` | `TitleMigrationApplyRequest.audit_digest` (required 64 lowercase hex) → `TitleMigrationApplyResponse` with digest, applied/retitled/merged/moved/rewritten counts, and new `generation`; 409 on stale, blocked, or already-active databases |
| **Search & queries** | | |
| GET | `/api/search?q` | FTS5 search over pages + blocks |
| GET | `/api/query?expr` | `{{[[query]]}}` evaluation (`and`/`or`/`not` over refs) |
| GET | `/api/titles?q` | Title completion for `[[` / `#` autocomplete |
| GET | `/api/todos?page` | `{{TODO}}` blocks grouped by page |
| **Sidebar** | | |
| GET / POST / PUT / DELETE | `/api/sidebar`… | Pinned pages: list / pin / reorder (permutation-validated) / unpin |
| **Sync** (see [sync-and-offline.md](sync-and-offline.md)) | | |
| GET | `/api/sync/snapshot` | Full graph bootstrap + `seq` + `generation` + title-canonicalization activation |
| GET | `/api/sync/changes?since&limit` | Windowed incremental feed with the same generation/activation metadata |
| WS | `/api/ws` | Push nudges: applied-op broadcasts + real `seq` hints; title generation rotation adds `force:true,generation` without fabricating a cursor |
| **Assistant** (SSE — see [assistant-and-files.md](assistant-and-files.md#embedded-assistant-pkmassistant)) | | |
| POST | `/api/assistant/conversations` | Create a conversation (`model`: `sonnet` default / `opus` / `haiku`); 409 over the 3-conversation cap |
| POST | `/api/assistant/conversations/{id}` | Beacon cleanup close (`navigator.sendBeacon`): delete the conversation, shut down its harness, and return `AssistantAck` |
| POST | `/api/assistant/conversations/{id}/messages` | Send one user turn → SSE stream of `text_delta` / `tool_started` / `tool_finished` / `confirm_request` / `turn_done` / `error` events; 409 while a turn is in flight |
| POST | `/api/assistant/conversations/{id}/confirm` | Answer a pending write confirmation (`tool_use_id`, `allow`) |
| DELETE | `/api/assistant/conversations/{id}` | Close the conversation and shut down its harness |
| **Assets** (see [assistant-and-files.md](assistant-and-files.md#assets-and-the-file-browser)) | | |
| POST | `/api/assets` | Multipart upload → content-addressed storage |
| GET | `/assets/{sha256}/{filename}` | Serve by digest (immutable cache) |
| GET | `/api/assets/describe-status` | Whether image descriptions are enabled, and why not if disabled |
| POST | `/api/assets/scan?force` | Enqueue undescribed (or, with `force`, previously-failed) eligible images |
| GET | `/api/assets/search?q&limit&offset&type&from_ms&to_ms&linked` | `LIKE` search over asset description + filename, filtered and paginated, with a `total` (backs the `/files` browser) |
| DELETE | `/api/assets/{sha256}` | Delete an asset, stripping its reference tokens from block text |
| POST | `/api/assets/export.zip` | Zip the selected assets (form-encoded `sha256s`, download) |
| **Export** | | |
| GET | `/api/export/page/{title}` | One page rendered to markdown (download) |
| GET | `/api/export.zip` | Whole-graph markdown export, zipped (download) |

### Breadcrumbs and recursive traversal

`routes_pages.py::_fetch_ancestors` builds the breadcrumb trail behind
`GET /api/block/{uid}` and, via `backlinks.py`, every backlink group. It walks
parents with a recursive CTE. Its termination condition is a **visited path,
not a depth limit**: the CTE carries `path` as `,uid,uid,…,`, and the
recursive arm keeps a row only while `instr(a.path, ',' || b.uid || ',') = 0`.

That shape is *complete*: no user-visible output in this project truncates
silently, so the trail must reach however many levels a page actually has.
It is also *cycle-safe*: a parent cycle, which the write path forbids but a
corrupted or hand-edited database can still hold, stops at the repeat instead
of recursing until SQLite gives up.

The comma delimiters are what make the `instr` test exact. `UID_RE` is
`^[a-zA-Z0-9_-]{6,32}$`, so no uid can contain a comma, and `,abc,` cannot
match a fragment of a neighbouring uid.

Both replica mirrors of this traversal use the identical guard — see
[sync-and-offline.md](sync-and-offline.md). When editing any of the three,
change them together: the whole point is that an offline read and a server
read return the same trail.

## Importer (Roam EDN → fresh database)

`python -m pkm.importer.run export.edn --files <dir> --out <data-dir>`. Each
run builds a complete new database and atomically swaps it in, so re-running
is always safe.

Asset copying (the "copy assets" step below) never trusts an existing
content-addressed destination just because it is present. It verifies against
the freshly-indexed source's size and sha256
(`assets_core.asset_needs_repair`, shared with the export writer's own
verify-then-hardlink check). It rewrites a mismatch atomically — temp file
plus `os.replace` — from the linked-files source, the same path used for a
brand-new hash.

```mermaid
flowchart TD
    A["verify export.edn exists"] --> B["edn.py — strict EDN parse (Core)"]
    B --> C["parse_export.py — datoms → page/block trees (Core)"]
    C --> P["preflight.py — duplicate UID / multi-parent refusal (Core)"]
    P --> T["titles.py — import-only sanitization (Core)"]
    F["linked-files dir"] --> G["index files + transform asset URLs"]
    T --> G
    G --> D["rows.py + mermaid_preservation.py<br/>rows, refs, global Mermaid plan (Core)"]
    D --> E["write pkm.sqlite3.tmp + copy assets"]
    E --> M["audit + apply shared title migration on tmp DB"]
    M --> R["render + write import-report.txt.tmp (Core render, Shell write)"]
    R --> H["atomic os.replace: database, then report"]
```

The EDN parser is strict. Malformed input returns exit 2 with
`error: malformed export at offset N: DETAIL`, where `N` is a zero-based
Python character offset. The EDN-unsupported solidus escape `\/` stays
invalid, rather than being accepted for JSON/Logseq compatibility.

`parse_export()` then builds the transport-neutral trees. Before title
sanitization, linked-file indexing, output-directory creation, SQLite, assets
or report work, `preflight.py` traverses every page and orphan subtree and
refuses duplicate block UIDs, or one block entity reached through multiple
parents. It selects the lexicographically first offending UID and reports all
sorted structural locations, so the diagnostic is deterministic.

Only after structural preflight, and still before linked-file indexing and
row construction, `importer/titles.py` runs. It recursively removes balanced
`[[`/`]]` markers and `#` markers from every explicit and ref-derived title,
then rewrites refs with the resulting map. Collisions merge in stable source
order, preferring an already-clean spelling as survivor. The report lists each
changed spelling, all its locations, and whether it merged. Malformed marker
syntax, or a result made blank by sanitization, refuses the run before the
output directory is created.

Before either `os.replace`, the importer also runs the same shared
`audit_title_migration()` / `apply_title_migration()` shell the operator
route uses, against the temporary database it just built. Fresh imports
therefore start on the post-migration title rule
(`sync_meta.plain_space_title_canonicalization = '1'`), and any imported
clean/padded twins are merged through the normal stable block/ref rewrite path
before the swap. If that audit finds a blocker, the importer refuses the run,
prints the friendly title-migration error, deletes the temp database, and
leaves the already-published database and report untouched.

Roam block uids, ordering and timestamps are preserved, so every existing
`((block ref))` and daily-note link keeps resolving. Mermaid conversion is
the one place that could otherwise break quietly, because flattening a
component block's descendants into a single fenced block drops their rows.
Both fresh row derivation and the one-off `migrate_mermaid_blocks.py`
migration gather every candidate and call the same `mermaid_preservation.py`
core before flattening.

A candidate is directly protected when an inbound `((uid))` from outside its
subtree targets a descendant. Protection then reaches a fixed point by
protecting every candidate ancestor that contains a protected component,
which stops an outer flatten from deleting a nested component that was kept.
Protected components remain ordinary nested blocks, with uid, text and
children intact. Reports are keyed by descendant UID, deduplicate that
descendant across components, and union and sort source UIDs
(`Rows.mermaid_preserved_refs` in the import report; migration
`Plan.preserved`, printed by `--dry-run` and by a normal run before
deletion). The migration prints no preserved section when the plan has no such
rows.

Blocks with a `:block/uid` and `:block/string` that Roam's export leaves
unreachable from any page (`parse_export.py`'s `Export.orphan_blocks`) are not
dropped. Each unreachable subtree's root, with its internal uid/text/children
structure intact, is attached under a deterministic
`"Import recovery: unreachable blocks"` page (`rows.py`'s
`RECOVERY_PAGE_TITLE`, suffixed `" (2)"` and so on if a page already has that
title). So every `((block ref))` into one still resolves.

A root is found in two passes:

1. Any unreached block with no *valid* parent becomes a root directly. A
   parent is valid only if that entity itself has `:block/string`; one that
   doesn't fails `is_block` and is never visited at all, so its real children
   would otherwise vanish along with it. This pass also recovers cyclic
   subtrees hanging off some other root's descendants.
2. Anything still unbuilt lives entirely inside a cycle with no such entry
   point (`A`'s only pointer is from `B`, `B`'s only pointer is from `A`, …).
   Its parent chain is walked until a node repeats, and that node is rooted.
   Rooting an arbitrary member instead could root a non-cycle branch first and
   later re-attach it a second time under its real parent, which is a real
   `blocks.uid` primary-key collision, not just a documentation nicety.

Only entities with no `:block/string` at all (`skipped_entities`, with no
text to reconstruct even from a subtree) are just counted, and never appear
on the recovery page. Implicit-page counting happens after orphan rows have
been walked, so pages referenced only by orphan text are included, and the
recovery page itself is subtracted from the implicit total.

Temporary-file cleanup follows stage boundaries rather than one universal
rule:

- The importer removes a stale `pkm.sqlite3.tmp` at the start of a new output
  build, so an early database-build or asset-copy failure may leave that
  self-healing temp in place. `import-report.txt.tmp` does not exist yet at
  that point.
- Once report rendering, writing or publication begins, any exception removes
  both remaining named temps. A report render/write failure, or a failure of
  the first (database) `os.replace`, therefore leaves the published database
  and report unchanged.
- Publication is two ordered atomic replacements — database first, report
  second — not one transaction across both files. If the second replace
  fails, the new database may already be published while the old report
  remains; the next successful run repairs the pair.

## Export and backup

### Markdown export

`export/writer.py::export_graph` renders every page to
`export/pages/<title>.md` and dailies to `export/journal/YYYY-MM-DD.md`.
`markdown.py` resolves `((refs))` to text one level deep and keeps
`{{query: ...}}` macros as the raw command. Assets are mirrored
incrementally.

A previously-exported asset's mere presence at its content-addressed path is
never trusted. It is verified against the `assets` row's known size and sha256
(`assets_core.asset_needs_repair` — a cheap stat first, a full hash only once
the size matches) before being hardlinked into the new tree. A mismatch is
re-copied from the live store instead. A truncated or corrupted file from a
past export therefore doesn't survive forever. A successful fresh transfer
increments only `assets_copied`; a successful corrupt replacement increments
only `assets_repaired`. If the repair source is itself missing, no transfer
happens: the asset is dropped from this export with a `pkm.export` warning and
its own `assets_missing_source_on_repair` count, rather than disappearing into
the ordinary "missing asset" case. Successful assets publication drops the
corrupt residue, so that warning is normally a one-run event; a failure after
the warning but before publication may leave the old corrupt tree active and
repeat the warning next run.

The export directory has one writer. Before writing `.gitignore`, rendering,
creating this run's staging tree, or publishing a last-good subtree, each run
sweeps abandoned `.export-staging-*` entries. Matching symlinks are unlinked
without following their targets; real directories are removed recursively.
Disappearance during cleanup counts as success, while every other error aborts
the run. The single-writer invariant needs neither a lock nor an age
heuristic.

Markdown files are rewritten byte-identically when unchanged, so the git diff
of a nightly export is minimal. Rendering and asset copying happen into a
scratch `.export-staging-*` directory beside the live one, and the previous
`pages/`, `journal/` and `assets/` are replaced only once a full new export is
ready, via `_publish_dir`'s atomic directory rename. A rendering, disk or
asset-copy failure *before publishing starts* therefore leaves the last
known-good export byte-identical. It is the same "stage, then swap" shape as
the database/report publish above, applied to a directory tree instead of a
file.

Publishing itself is three separate atomic renames, one per subtree, not one
transaction. A failure partway through — journal's publish erroring after
pages' has landed, say — leaves a genuine mixed old/new state for that run,
which the next successful run heals. Nothing is corrupted or lost in between:
the not-yet-published subtree's old content survives under `<name>.stale`
until superseded, and the raised exception stops the nightly job from ever
git-committing that mixed state.

The whole-database export is also exposed over HTTP as `routes_export.py`'s
`/api/export.zip`: the same `export_graph()` into a temp dir, downloaded
zipped, with the same backup semantics.

### Single-page export

`GET /api/export/page/{title}` (`routes_export.py` + `export/resolve.py`) is
the end-user download. It is deliberately a *different* rendering mode from
the backup path above: it resolves dynamic content to plain text, so the
download reads like what a reader of the live page would see.

- `((refs))` resolve recursively, not one level, and are inlined as plain text
  rather than wrapped in parens.
- `{{query: ...}}` and `{{[[query]]: ...}}` macros execute — via `query.py`'s
  `parse_query`/`plan_sql`, the same plan live `/api/query` runs — and render
  as a results list grouped by page.
- Depth caps mirror the live UI's own recursion guards exactly, so nesting
  behaves identically to the browser: `BlockRef.tsx`'s `MAX_DEPTH = 3` for
  refs, `QueryBlock.tsx`'s `MAX_DEPTH = 2` for nested queries.

Resolution and rendering are pure (`export/resolve.py`, given precomputed
uid→text and expr→results maps). The route gathers that data with a
depth-capped, cycle-safe breadth-first fetch, where a `visited` set stops a
cyclic `((ref))` chain from refetching forever; the caps alone only stop it
from *rendering* forever.

The web UI surfaces both exports as "Export as Markdown" in the page menu for
a single page, and a whole-database export link on the Settings page. Settings
is a plain growable list of sections; Help now hosts only the static
keyboard-shortcut doc.

### Why `extract()` is O(n) per call

`refs.py`'s `extract()` strips leading whitespace in Python (`str.lstrip()`,
linear, no backtracking) before its attribute regex runs. The regex then
never backtracks against a long run containing no `::` — exactly what one
large fenced code block becomes once `_strip_code()` blanks it out.
`export_graph()` calls `extract()` once per block, via
`collect_block_ref_uids`, so a single pathological block in a real graph
would otherwise cost the whole-database export minutes instead of an
instant. From the browser, that is indistinguishable from the download not
working.

### Backup job

`python -m pkm.backup`, run nightly via launchd, takes an online SQLite
`.backup()` snapshot from a read-only connection into
`backups/sqlite/pkm-YYYY-MM-DD.sqlite3`. `rotation.py` prunes it to the newest
14 dailies plus the latest of each month, kept forever. It then runs the
markdown export **from that same snapshot** and git-commits it. Its success
line renders the complete export-count dictionary, including `assets_copied`,
`assets_repaired` and `assets_missing_source_on_repair`. The live database is
never opened for writing, and any failure exits non-zero.

## Generated artifacts and parity fixtures

Several artifacts are generated from the server and checked in, and **the
server test suite fails if any is stale**. Regenerate and commit them together
with the change that invalidates them.

| Artifact | Generator | Guarded by | Consumed by |
|---|---|---|---|
| `web/src/api/openapi.json` (→ `types.d.ts` via `pnpm gen-types`) | `pkm.server.openapi_dump` | `tests/test_openapi_sync.py` | Web API layer — Pydantic models are the single source of API types |
| `web/src/replica/baseSchema.gen.ts` | `pkm.schema_dump` | `tests/test_schema_artifact.py` | Browser sqlite-wasm replica (BASE_DDL only, never SERVER_DDL) |
| `shared/fixtures/ref_grammar.json` | hand-maintained cases | both parsers' test suites | Pins Python `refs.py` and the TS grammar scanner to identical behaviour |
| `shared/fixtures/refs_parity.json` | `pkm.refs_parity_dump` | `tests/test_refs_parity_fixture.py` | TS extractors replay the exact Python outputs |
| `shared/fixtures/shim_parity.json` | `pkm.server.shim_parity_dump` | `tests/test_shim_parity_fixture.py` | The offline API shim (`web/src/replica/localApi/`) must return byte-identical JSON to the real routes |

## Configuration and entrypoints

`config.json` lives in the data directory. It is never in git, and
`python -m pkm.server.setup` writes it mode 0600.

| Key | Required | Meaning |
|---|---|---|
| `db_file` | yes | SQLite database path |
| `assets_dir` | yes | Content-addressed asset store |
| `password_salt`, `password_hash` | yes | scrypt password check (hex) |
| `session_secret` | yes | HMAC key for session cookies (hex) |
| `cookie_secure` | no (default true) | `Secure` flag on the session cookie |
| `web_dist` | no | Built SPA directory; unset means an API-only server |
| `bind_hosts` | no (default `["127.0.0.1"]`) | Interfaces to listen on |
| `max_upload_bytes` | no (default 150 MB) | Upload size cap |
| `image_descriptions` | no (default true) | Master switch for image captions |
| `image_description_model` | no (default `gpt-4o-mini`) | Vision model |
| `openai_api_key_file` | no (default `../openai_key`) | Key file for image captions |

Every path key is resolved relative to `config.json`'s own directory, so the
data directory can move as a unit.

`python -m pkm.server.run` is the entrypoint. It serves on port 8974 and binds
loopback plus the machine's Tailscale IP, taken from `bind_hosts`.
`create_app()` always runs `init_db()`, so every entrypoint — server, tests,
artifact dumps — works against a brand-new data directory.

Daily pages are special throughout. Their titles use Roam's ordinal format
(`July 8th, 2026`, in `daily.py`) for import compatibility, they are
auto-created on read, and they cannot be renamed.

## Title integrity and one-time activation

Title canonicalization (`refs.canonicalize_title`) has two layers. Control
whitespace is always normalized. Leading and trailing ordinary U+0020 is
removed only once the durable `plain_space_title_canonicalization` flag is
active.

A control character makes ASCII-whitespace runs collapse to one space and
trims their boundary. Titles containing only ordinary spaces stay byte-exact
while the flag is inactive, so legacy padded rows still resolve. Activation
adds boundary-U+0020 stripping and nothing else: internal ordinary spaces and
NBSP are unchanged.

The flag defaults to `"0"`, for an existing database and a newly initialized
one alike. `create_app()`/`init_db()` replay schema setup at startup, but never
audit or apply the existing-data migration. Activating an existing deployment,
production included, is a deliberate later operator action: run
`pkm migrate-titles` against an explicitly configured target, review the
result, then pass its digest to `pkm migrate-titles --apply DIGEST` (the
procedure is in [docs/cli.md](../cli.md#one-time-title-canonicalization)). A
deploy or a restart alone cannot change title identity.

The operator path is split along FCIS boundaries:

- `pkm/title_migration.py` is the pure, deterministic planner. For each
  canonical spelling it:
  - normalizes control whitespace and removes boundary ordinary U+0020 only;
  - groups padded titles under that spelling;
  - chooses a survivor: an existing clean twin if there is one, otherwise the
    lowest padded page id;
  - lists source pages in stable id order and counts affected blocks, inbound
    refs and sidebar entries;
  - reports `all_space` and `forbidden_syntax` blockers.

  Replacement values are opaque: `rename.rewrite_title_refs_map()` inserts
  each mapped value once and never rescans it as another source. The plan's
  SHA-256 digest covers the active state plus the exact relevant page, block,
  ref, sidebar, group, blocker and replacement snapshots, so repeated
  unchanged audits produce a stable digest.
- `server/title_migration.py::audit_title_migration()` owns a read
  transaction and always rolls it back. The authenticated GET route exposes
  concrete `TitleMigrationAuditPayload`, group and page models, and has no side
  effects.
- Apply requires a 64-lowercase-hex `audit_digest`, takes `BEGIN IMMEDIATE`,
  and re-inventories under that writer reservation. It refuses a stale digest,
  either blocker reason, or an already-active database, with HTTP 409. It then
  retitles or merges in stable order, moves blocks, rewrites each snapshotted
  inbound block and rebuilds its refs, reconciles sidebar identities, activates
  boundary-space canonicalization, and rotates `db_generation` — all in one
  transaction. Any error or interruption rolls every row and metadata change
  back before it can become visible. After commit the route emits one forced
  seq frame carrying the real journal maximum and the new generation, then
  returns the applied counts plus that generation.

The generation rotation is part of activation, not bookkeeping. Connected
browser replicas see a generation mismatch, reject that changes payload without
partially accepting its cursor or activation state, and rebootstrap from a
snapshot before replaying pending intent. See
[sync-and-offline.md](sync-and-offline.md#title-activation-across-online-and-offline-paths).

### Online title boundaries

Every creation path funnels through `store.get_or_create_page()`, which
consults the activation flag. After control normalization, normal page creation
and rename reject any title containing `#`, `[[` or `]]`.

`POST /api/ops` preflights both explicit `page_title` fields and ref-derived
titles across the complete batch, so a violation refuses before any page,
block, ref, journal or idempotency mutation. CLI and MCP writes share that op
path. The page and unlinked read routes use the same activation-aware
canonicalization, as does single-page export.

`PkmClient.get_page`, `get_backlinks` and `get_page_blocks` normalize control
whitespace before constructing the URL, so CLI and MCP callers can read a title
using the spelling they originally wrote; the server adds boundary-space
stripping once active. Browser offline reads and creates mirror this gate
rather than activating ahead of the server.

### Blank titles

A normalized-but-nonempty title is fine. A blank one is permanently
unreachable: no `[[link]]` resolves to it, and no route can name it. So
`get_or_create_page()` raises `BlankTitleError` instead of committing it, and
each caller picks its own recovery:

- The interactive route `POST /api/pages` turns it into a 422, since a live
  client can retry with a real title.
- `ops_apply.py`'s `_resolve_page()` substitutes the fixed fallback title
  `"Untitled"`, so a `create`, `create_page` or cross-page `move` op with a
  blank `page_title` still lands the batch. The "never 422" rule holds for the
  ops path specifically, not for every route.

If a real page is already titled `"Untitled"` — a user typed it on purpose —
blank-title ops deposit onto that same page rather than a dedicated sentinel.
That is an accepted trade-off: the fallback is an ordinary, addressable title
going through the normal get-or-create path, not a reserved one, so it can
collide with real user content.

### Broadcasts carry authoritative title identity

After each `create`, `create_page`, or `move` with a resolved page target,
`ops_apply._broadcast_op()` reads the applied page row and replaces the
caller's `page_title` with that stored title — covering the `"Untitled"`
fallback, control-whitespace normalization, and post-activation boundary-space
stripping. A same-page move with no `page_title` stays null.

If that row lookup ever violates its normally unreachable invariant, broadcast
assembly raises and the owning op transaction rolls back rather than emit caller
spelling. What a replica does with the stored title it receives is covered in
[sync-and-offline.md](sync-and-offline.md#title-activation-across-online-and-offline-paths).

### Blank refs are dropped by the extractor

Ref indexing needs the same blankness check as page creation, and the check is
made in the pure extractor on both sides. `refs.is_blank_title()` — normalize,
then strip — is the one blankness predicate, and `refs.extract()`'s bracket
branch calls it. So `[[]]`, `[[\n]]` *and* the plain-spaces `[[   ]]` are all
dropped before anything downstream sees a `Ref`.
`web/src/grammar/refs.ts::extractRefs` filters on `r.title.trim() === ""` for
the same reason.

The shared fixtures pin the pair together: `shared/fixtures/ref_grammar.json`
and `shared/fixtures/refs_parity.json` both carry
`skip [[   ]] but keep [[ Valid ]]`. That is the case distinguishing "blank
once stripped", which is dropped, from "padded but nonblank", which is kept
byte-exact as ` Valid ` — a nonblank padded title must never be trimmed
without saying so. The other two branches need no change: an attribute name is
`.strip()`ed before normalizing, and hashtag titles cannot hold whitespace at
all.

`store.index_ref()` also catches `BlankTitleError` and skips the ref
entirely: no page created, no `refs` row inserted, no fallback. That catch is
defense in depth at the store boundary, not the only guard. Both
places that resolve an extracted `Ref` onto a page go through it —
`ops_apply.py`'s `ReindexRefs` handling, and `store.py`'s
`rewrite_referencing_blocks`, used by rename and merge.

The intended behaviour on a blank title is to index *nothing*, the opposite of
the ops `page_title` fallback. An op needs *some* page to land its content on,
but a ref whose title normalizes to blank is not a reference at all, so
resolving it onto `"Untitled"` would fabricate a phantom backlink.

Both call sites route through this guard instead of calling
`get_or_create_page()` directly. `routes_ops.py` catches only `OpError`, and
rename catches only `sqlite3.IntegrityError` — neither catches
`BlankTitleError` itself. Letting it escape there would be worse than the
silent blank-page creation the guard replaces, or the 422 the ops path
forbids.

## Logging and observability

There is no metrics stack. The logs are the whole observability story, so they
are shaped to answer the one question that actually gets asked: *"the app was
slow or hung yesterday, what was it doing?"* Stock uvicorn output could not
answer it — no timestamps on any line, and no request durations anywhere.

- **`uvicorn`'s own access log is disabled** in `run.py`, replaced by
  `RequestLogMiddleware` (`server/request_log.py`). It emits one `pkm.access`
  line *after the response body finishes*, so the duration covers the whole
  request including body send:

      <client> "GET /api/page/Foo?bl_limit=20" 200 4ms

  Status is captured off the `http.response.start` message and defaults to
  500, so a request that dies before responding still logs what the client
  saw. The line is formatted by the pure `logfmt.request_line`.
- **`logfmt.uvicorn_log_config()`** is uvicorn's default dictconfig plus
  timestamps on every formatter, and it wires a **parent `pkm` logger** to the
  default (stderr) handler at INFO. Every `pkm.*` child — `pkm.assets`,
  `pkm.assistant`, `pkm.describe`, and any future addition — inherits that
  handler, level and format by propagation, with no entry of its own.

  Without a configured ancestor, a child's INFO lines vanish, because nothing
  configures the root logger. The parent-logger policy is what stops a new
  `pkm.*` logger from needing its own individual fix.
  `test_every_declared_pkm_logger_has_an_effective_info_handler` in
  `test_request_log.py` enumerates every `pkm.*` logger declared in the
  codebase and asserts it resolves to a real handler, so the next new logger
  cannot repeat the drift.
- **`pkm.access` keeps an explicit override**, the only one left. Its lines are
  pre-formatted request summaries (`request_line`), not level-prefixed
  lifecycle messages, and they go to stdout like uvicorn's own access log did.
  Streams otherwise follow uvicorn's convention — lifecycle and errors to
  stderr, access lines to stdout — so launchd's two log files keep their roles.

When measuring a slow request, prefer these durations to client-side timing.
The filter-hang investigation found ~4 ms server-side, which is what ruled the
server out.

## When something looks wrong

Each row is a failure this system has actually produced, and the invariant
its fix installed. The bean has the full investigation.

| Symptom | Cause | Ref |
|---|---|---|
| A server refactor breaks the CLI/MCP client with no compile-time warning | client-side code imported `pkm.server.ops_core`/`pkm.server.daily` directly instead of the shared `pkm/contracts/` models | test_client_contracts.py |
| Request handlers hit a database-locked error under concurrent startup | per-connection WAL/DDL setup raced an in-flight transaction; schema setup now runs once in `init_db()`, never per request | — |
| A breadcrumb trail or backlink group truncates at 100 levels on a deeply nested page | `_fetch_ancestors`'s CTE guarded on `depth < 100` instead of a visited-path check | pkm-8kw2 |
| A whole-database export takes minutes instead of being instant, on one large fenced code block | the attribute regex paired a greedy `\s*` with an overlapping lazy class, quadratic to *fail* against a long `::`-free run | pkm-7myl |
| A spaces-only `[[   ]]` ref typed in the editor 500s the whole write, or crashes a rename | `get_or_create_page()` raised `BlankTitleError` with nothing above it to catch it; `routes_ops.py` catches only `OpError`, rename only `sqlite3.IntegrityError` | test_blank_titles.py |
| A newly added `pkm.*` logger's INFO lines never appear in the server log | nothing configured that logger's ancestor before the parent-logger policy existed; each addition needed its own individual fix | pkm-5g3d |

## Testing

- `cd server && uv run pytest -q` — ~70 test files, roughly one per module.
  Branch coverage is enforced at 95% (`--cov-fail-under=95` in
  `pyproject.toml`), so new code without tests fails the suite.
- `conftest.py` provides a seeded temp database (a fixed 5-page fixture, with
  daily page "July 7th, 2026"), an authenticated `TestClient`, and a
  `PkmClient` wired to the in-process app.
- `uv run pyrefly check` type-checks (pyright is configured as a second
  opinion) and `uv run ruff check` lints, at line length 120.
