# PKM — High-Level Design

A single-user, self-hosted replacement for Roam Research: an outliner-style
notes app with daily notes, `[[page links]]`, backlinks, full-text search and
locally-hosted assets, running on a Mac and reached over Tailscale.

This is the orientation document for the *design* — the decisions and their
why. The authoritative details — full data model, API contracts, rejected
alternatives, and the findings from running each phase against the real graph
— live in the detailed docs linked throughout, chiefly the
**[full design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md)**.
For a map of the codebase as it stands (modules, API reference, diagrams),
start at **[architecture/overview.md](architecture/overview.md)**.

## Core idea

**Server-authoritative, block-granular.** SQLite on the server is the single
source of truth. The browser applies edits optimistically and sends batches
of block-level operations (`create`, `update_text`, `move`, `delete`,
`set_collapsed`) to `POST /api/ops` — the only write path. A WebSocket
broadcasts committed batches to other open clients. No CRDTs: per-block
last-write-wins is enough for one person.

**Offline is a cache, not a fork.** Each browser keeps a sqlite-wasm replica
of the graph (hydrated from a snapshot, kept warm by a change journal) plus a
durable queue of not-yet-acknowledged op batches. While disconnected, reads
and search are served from the replica through a local shim that mimics the
API's shapes, and edits keep queueing; on reconnect the queue flushes (batch
ids make replays idempotent), the feed catches up, and views refetch. The
server stays the sole authority — a text edit carries the hash of the text it
was based on, and a mismatch preserves the losing version as a `[[conflict]]`
block rather than silently overwriting (an edit to a since-deleted block
lands on today's daily page). A service worker precaches the app shell so a
cold start needs no network at all.

Two alternatives were rejected — a client-side graph with op-log sync (Roam's
own architecture: snappy, but you own a sync protocol and its data-loss modes)
and markdown-files-plus-index (Obsidian-style: portable, but files fight
stable block uids and live structural edits). The portability win is taken a
different way: a nightly plain-markdown export. See the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) for
the full trade-off discussion.

## The pieces

| Piece | What it is | Detail |
|---|---|---|
| Data model | SQLite: `pages`, `blocks` (Roam uids preserved), `refs`, `assets`, FTS5 index. Block text is unmodified Roam-flavoured markdown; refs and FTS are derived indexes. | [Spec §1](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) |
| Import | Re-runnable pipeline from a Roam EDN export + linked-files download; builds a fresh DB and atomically swaps it in; ends with a nothing-silently-dropped report. | [Spec §2](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-import-pipeline.md) |
| Read API | Page trees + backlinks + unlinked refs, FTS search, Roam query evaluation, asset serving — everything paginated. | [Spec §3](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-backend-read-api.md) |
| Write path & sync | `POST /api/ops` batches applied transactionally (refs + FTS re-derived in the same transaction); WebSocket broadcast to other clients. | [Spec §3](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-write-path-sync.md) |
| Frontend (read) | React + Vite SPA: journal home with infinite scroll, page view with lazy backlinks, shift-click sidebar stack, search. | [plan](superpowers/plans/2026-07-08-frontend-read.md) |
| Frontend (edit) | Roam-style outliner — only the focused block is a live textarea, everything else is rendered HTML; keyboard-first; phone gets a bottom composer instead of outline editing. | [Spec §4](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-09-frontend-edit.md) |
| Deployment | launchd services on a Mac + Tailscale Serve for HTTPS; nightly backup job (rotated SQLite snapshots + git-committed markdown export). | [Deployment design](superpowers/specs/2026-07-09-plan6-deployment-design.md) · [plan](superpowers/plans/2026-07-09-plan6-deployment.md) · [ops guide](../deploy/README.md) |
| Offline & PWA | Server: append-only change journal + snapshot/changes feed with a generation token; batch-id dedup on `/api/ops`; base-text-hash conflict copies. Client: sqlite-wasm replica (worker + OPFS), durable op queue with optimistic apply, offline API shim (parity-pinned against the server), FTS search, service-worker app shell + asset runtime cache. | [Offline design](superpowers/specs/2026-07-12-offline-editing-design.md) · [server plan](superpowers/plans/2026-07-12-offline-sync-server.md) · [web plan](superpowers/plans/2026-07-13-offline-sync-web.md) |

## Load-bearing decisions

- **Block text is stored unmodified** (Roam-flavoured markdown, literal
  `[[links]]` / `#tags` / `Attr::` / `{{[[query]]}}`). Everything else —
  the `refs` table, the FTS index — is derived and rebuilt on change. The
  durable data is always plain text.
- **Roam compatibility is preserved where it keeps links working:** block uids
  survive import, and daily pages keep Roam's ordinal title format
  (`July 8th, 2026`) so every imported daily-note link still resolves.
- **Assets are content-addressed** (sha256, deduplicated) on the filesystem,
  not in SQLite; backup is one database file plus one append-only directory.
- **Pydantic models generate the TypeScript API types** via OpenAPI, so the
  block model can't drift between server and client. Similarly, the ref
  grammar exists in both Python and TS, pinned to identical behaviour by a
  shared fixture (`shared/fixtures/ref_grammar.json`).
- **Rendering, not the server, is the scale constraint** (targets: 50k pages /
  500k blocks). The UI never renders unbounded lists — backlinks load lazily
  and paginate, unlinked refs compute on demand, the journal loads a few days
  at a time. Server-side, everything measured is tens of milliseconds against
  the real 52k-block graph.
- **Auth is layered, deliberately not internet-grade:** Tailscale is the
  transport boundary; a single static password + signed session cookie guards
  against other LAN devices. The server binds loopback + the Tailscale IP
  only.
- **The replica is a cache; the queue is the user's intent.** Optimistic
  local application is best-effort (an op that can't apply locally is skipped,
  never dropped from the queue), authoritative writes re-apply the pending
  queue over themselves, and a re-bootstrap never discards a database whose
  queue hasn't flushed. Degraded beats data loss at every decision point.
- **Sync stays debuggable:** the change journal is append-only rows in the
  same SQLite file, a generation token detects rebuilt databases, and batch
  ids make client retries idempotent — no vector clocks, no merge machinery.
- **Functional-core / imperative-shell** throughout: op application, ref
  extraction, query evaluation are pure modules; FastAPI routes, SQLite and
  the WebSocket hub are thin shells (convention in `CLAUDE.md`). On the web
  client the boundary is now machine-checked — a checker rejects any
  Functional-Core module that imports a Shell — and composition of shells
  (React contexts, stateful components, `InlineSegments`) counts as Shell, not
  Core. See [Web client architecture](#web-client-architecture-sync-outline-and-fcis-hardening).

## How it was built

Six plans, each executed with TDD and finished with a smoke test against the
**real imported graph** (4.3k pages / 52.7k blocks / 2 GB assets) rather than
fixtures — the findings appended to the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) record
what each phase proved and what it deferred:

1. [Import pipeline](superpowers/plans/2026-07-08-import-pipeline.md)
2. [Backend read API](superpowers/plans/2026-07-08-backend-read-api.md)
3. [Write path & sync](superpowers/plans/2026-07-08-write-path-sync.md)
4. [Frontend read](superpowers/plans/2026-07-08-frontend-read.md)
5. [Frontend edit](superpowers/plans/2026-07-09-frontend-edit.md)
6. [Deployment, backup & hardening](superpowers/plans/2026-07-09-plan6-deployment.md)

Offline editing followed as a seventh phase in two plans —
[server sync protocol](superpowers/plans/2026-07-12-offline-sync-server.md)
and [web replica/PWA](superpowers/plans/2026-07-13-offline-sync-web.md) —
from the [offline design spec](superpowers/specs/2026-07-12-offline-editing-design.md),
with the client/server API shim pinned byte-identical to the real routes by a
shared fixture (`shared/fixtures/shim_parity.json`).

Known gaps and deferred work are tracked as carry-forward sections in the
design spec and as beans in `.beans/`.

## Web client architecture (sync, outline, and FCIS hardening)

The offline replica and outliner grew several concurrency hazards and blurred
Functional-Core boundaries as features landed. The `pkm-c1cg` hardening epic
(ten child beans) closed them and added machine-checked guardrails. The
authoritative details, rejected alternatives, and the error-handling invariants
live in the
**[web architecture & FCIS hardening design](superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md)**;
the load-bearing shape:

- **Queue, RPC, and worker lifecycle** (`web/src/sync/opQueue.ts`,
  `web/src/replica/rpc.ts`, `web/src/replica/client.ts`). `OpQueue.enqueue()`
  returns a `WriteTicket` whose `settled` promise resolves to a `WriteOutcome`
  (`persisted` | `failed`) — local durability, deliberately distinct from
  server delivery. `drain()` returns a typed `DrainOutcome`: `drained` only
  after a fresh durable pending count proves nothing is deliverable, otherwise
  `blocked` with a reason (`offline` | `retryable` | `recovering` |
  `disposed`). Retry uses cancellable 250 ms / 1 s / 5 s-capped backoff
  (`RETRY_DELAYS`). The RPC client is an owned Imperative Shell: pending calls
  reject on worker `error`/`messageerror`, timeout (30 s ordinary, 120 s
  snapshot/reset), or `dispose()`; late replies are ignored. `SyncProvider`
  disposes only the worker/replica it created — an injected replica stays
  caller-owned.
- **Exclusive replica recovery lease** (`web/src/replica/client.ts`,
  `web/src/replica/workerHandlers.ts`, `web/src/replica/recoveryGate.ts`). A
  worker-owned FIFO gate covers every database-mutating RPC. `prepareRecovery()`
  captures and fingerprints the durable pending rows and blocks later writes;
  `commitRecovery()` re-compares those rows inside the held gate immediately
  before reset-or-rebase and aborts non-destructively if they differ, so **no
  acknowledged enqueue can be erased by recovery**. Schema mismatch resets and
  reapplies the snapshot in one rolled-back-on-failure transaction; a rebuilt
  database (generation token) rebases without file deletion.
- **Poison repair for rejected batches** (`web/src/sync/opQueue.ts`,
  `web/src/sync/SyncProvider.tsx`). A 4xx marks the durable row poisoned,
  pauses later delivery, and emits a typed `PoisonEvent` (`onPoison`).
  `SyncProvider` runs an authoritative full-snapshot repair through the same
  recovery coordinator, which reapplies non-poisoned pending batches and skips
  the poisoned one, then deletes the rejected row, bumps the resync generation,
  and resumes. Repair failure stays visible with Retry; retained mark intents
  plus `retryPoisonMarks()` survive a mark-write failure. Connectivity and
  delivery health are reported independently.
- **Per-title outline sessions, editor lease, and versioned reads**
  (`web/src/outline/outlineSessions.ts`, `web/src/outline/outlineState.ts`,
  `web/src/dnd/DndContext.tsx`). `acquireOutlineSession(title)` hands every
  view of a title one ref-counted session that shares the flushed tree and a
  monotonic revision; exactly one view wins an idempotent editor lease through
  a subscription-backed store, others render read-only and inert. DnD
  `registerOutline` returns a `DndRegistration` (`accepted` |
  `{accepted:false, reason:"duplicate-title"}`) with token-checked cleanup.
  Authoritative fetches call `beginAuthoritativeRead()` and carry a `ReadToken`
  (`requestId`, `revisionAtDispatch`); a payload is adopted only if it is the
  newest request, the revision is unchanged, and no title-relevant write ticket
  is unsettled — otherwise the newest candidate is retained and reconsidered
  after settlement, and a Shell-owned repair epoch re-enrolls live sessions.
- **Standardized async UI lifecycles** (`QueryBlock`, `BlockTree`,
  `BlueskyEmbed`, `SidebarNav`). Each uses a component-specific mechanism (no
  shared `useAsync`): request-id staleness + single-flight pagination;
  authoritative-vs-view-only collapse reconciliation; actor/post-keyed
  resolution and height reset; and one serialized mutation lane that disables
  conflicting controls and surfaces failures.
- **Extracted pure cores and thin shells** (`pkm-wudz`). Deterministic
  transitions live in Functional Core modules — `outline/keyboardPolicy.ts`
  (`decideEditorKey`), `outline/outlineState.ts` (`transitionOutline`,
  `pendingTextOps`, `spliceUploadedMarkdown`), `sync/queueState.ts`
  (`transitionQueue`, `terminalReason`), `sync/syncState.ts` (`transitionSync`,
  `computeEditability`) — testable with no React/DOM/fetch/worker/SQLite mocks.
  The shells (`EditableBlockTree`, `useOutline`, `opQueue`, `SyncProvider`)
  gather inputs, dispatch, and run the returned effects. `replicaSync.ts`
  deliberately remains a shell: its recovery ordering is I/O control flow with
  no deterministic sub-policy separable from the queue/sync cores.
- **Shared reference/TODO grammar scanner** (`web/src/grammar/scan.ts`).
  `scanGrammar(text)` is the single Functional Core producing a source-ordered
  `GrammarToken` stream on UTF-16 half-open spans, matching balanced `[[...]]`
  iteratively with an explicit stack (10 000-deep nesting without recursion),
  blanking opaque code first — mirroring `server/src/pkm/refs.py`. `tokenize.ts`,
  `grammar/refs.ts`, `replica/refs.ts`, `grammar/todo.ts`,
  `outline/refAtCaret.ts`, and `outline/slashCommands.ts` are thin adapters over
  it. New behavior is pinned by `shared/fixtures/ref_grammar.json`, replayed by
  the server parser and both web extractors.
- **Enforced FCIS boundary** (`web/tooling/fcis.mjs` shell + `fcis-core.mjs`
  pure core + `fcis-exemptions.json`). `check:fcis` requires a `// pattern: …`
  header in the first five lines of every runtime module and walks each file's
  import/export/dynamic-import edges via the TypeScript compiler API; any
  Functional-Core → Shell/Mixed edge fails unless it is type-only. The current
  tree classifies 101 modules (39 Core, 62 Shell, 0 Mixed) with zero forbidden
  edges. Misclassified files were relabelled Shell (`contexts.ts`,
  `InlineSegments.tsx`, `BlockRef.tsx`, `AssetImage.tsx`, `PageLink.tsx`,
  `TodoCheckbox.tsx`, `ErrorBoundary.tsx`) and the pure UID byte→alphabet
  mapping was split into `uidCore.ts` (Core) beneath `uid.ts` (Shell).
- **Lint and build budgets** (`web/eslint.config.js`, `web/tooling/buildBudgets.ts`
  + `viteBudgetPlugin.ts` + `budgets.json`). Flat, type-aware ESLint enforces
  the React Hooks rules plus `no-floating-promises`, `no-misused-promises`,
  `only-throw-error`, and unknown catch variables, with
  `reportUnusedDisableDirectives` — and zero `eslint-disable` remain in
  `web/src`. A pure budget core with a Vite/Rollup + Workbox adapter fails the
  build on any single byte or entry over the caps: `initialEntryBytes` 462016,
  `largestAssetBytes` 907990, `totalOutputBytes` 5520272, `precacheBytes`
  5494604, `precacheEntries` 82, `mermaidOwnedBytes` 3461961. The
  `initialEntryBytes` cap is the **user-ratified** 462016 (actual eager entry
  440910 + ~4.8 % headroom), superseding the plan/spec's stale 423707 — the
  eager entry outgrew that target once the pure cores and the consolidated
  grammar scanner became startup imports; no shrink follow-up is owed.
- **Mermaid stays offline-capable.** The entire Mermaid module-graph chunk
  family remains precached (never-online) under the explicit `mermaidOwnedBytes`
  cap. Ownership is decided by Rollup module reachability, all-or-nothing per
  chunk, so the exception cannot silently absorb unrelated output. An offline
  Playwright E2E proves a diagram renders with no network.

`pnpm verify` runs these gates in cost order: `typecheck → lint → check:fcis →
test:coverage → one guarded vite build (bundle/precache enforcement) →
playwright` against that same dist.

## Out of scope (by design)

Multi-user, multiple graphs, full datalog queries, and encrypted blocks. The
reasoning is in the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md).
Within offline mode, asset upload, sidebar edits, page deletion, query
blocks, and full asset sync stay online-only — deferred deliberately, see the
[offline design spec](superpowers/specs/2026-07-12-offline-editing-design.md).
