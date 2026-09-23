# PKM — High-Level Design

A single-user, self-hosted replacement for Roam Research: an outliner-style
notes app with daily notes, `[[page links]]`, backlinks, full-text search and
locally hosted assets, running on a Mac and reached over Tailscale.

This document covers the design decisions and why they were made. The full
data model, API contracts, rejected alternatives and per-phase findings are in
the **[full design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md)**.
For the codebase as it stands (modules, API reference, diagrams), start at
**[architecture/overview.md](architecture/overview.md)**.

## Core idea

**Server-authoritative, block-granular.** SQLite on the server is the single
source of truth. The browser applies edits optimistically and sends batches of
block-level operations to `POST /api/ops`, the write path for block content
([op list](architecture/backend.md#the-write-path)). A WebSocket tells other
open clients that a batch committed. There are no CRDTs: per-block
last-write-wins is enough for one person.

**Offline is a cache of server state.** Each browser keeps a sqlite-wasm
replica of the graph (hydrated from a snapshot, kept current by a change
journal) and a durable queue of op batches the server has not yet
acknowledged. While disconnected, reads and search come from the replica
through a local shim that returns the API's shapes, and edits keep queueing.
On reconnect the queue flushes (batch ids make replays idempotent), the feed
catches up and views refetch. The server stays the sole authority. A text
edit carries the hash of the text it was based on; on a mismatch the losing
version is kept as a `[[conflict]]` block, and an edit to a since-deleted
block lands on today's daily page. A service worker precaches the app shell,
so a cold start needs no network.
[sync-and-offline.md](architecture/sync-and-offline.md) has the protocol.

Two alternatives were rejected. A client-side graph with op-log sync (Roam's
own architecture) is fast, but means owning a sync protocol and its data-loss
modes. Markdown files plus an index (Obsidian-style) are portable, but files
conflict with stable block uids and live structural edits. Portability comes
instead from a nightly plain-markdown export. The
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) has
the full trade-off.

## The pieces

| Piece | What it is | Detail |
|---|---|---|
| Data model | SQLite: `pages`, `blocks` (Roam uids preserved), `refs`, `assets`, FTS5 index. Block text is unmodified Roam-flavoured markdown; refs and FTS are derived indexes. | [Spec §1](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) |
| Import | Re-runnable pipeline from a Roam EDN export plus linked-files download; builds a fresh DB, swaps it in atomically, and ends with a report of anything it could not import. | [Spec §2](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-import-pipeline.md) |
| Read API | Page trees, backlinks, unlinked refs, FTS search, Roam query evaluation and asset serving, all paginated. | [Spec §3](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-backend-read-api.md) |
| Write path & sync | `POST /api/ops` batches applied in one transaction, with refs and FTS re-derived in the same transaction; WebSocket broadcast to other clients. | [Spec §3](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-08-write-path-sync.md) |
| Frontend (read) | React + Vite SPA: journal home with infinite scroll, page view with lazy backlinks, shift-click sidebar stack, search. | [plan](superpowers/plans/2026-07-08-frontend-read.md) |
| Frontend (edit) | Roam-style outliner. Only the focused block is a live textarea; the rest is rendered HTML. Keyboard-first; the phone gets a bottom composer in place of outline editing. | [Spec §4](superpowers/specs/2026-07-08-roam-migration-pkm-design.md) · [plan](superpowers/plans/2026-07-09-frontend-edit.md) |
| Deployment | launchd services on a Mac, Tailscale Serve for HTTPS, and a nightly backup job (rotated SQLite snapshots plus a git-committed markdown export). | [Deployment design](superpowers/specs/2026-07-09-plan6-deployment-design.md) · [plan](superpowers/plans/2026-07-09-plan6-deployment.md) · [ops guide](../deploy/README.md) |
| Embedded assistant | Server-side LLM harness (Claude Agent SDK) confined to the [`pkm-mcp` tools](architecture/cli-and-mcp.md#the-mcp-tool-surface); floating chat panel with SSE streaming and confirm-gated writes. | [Spec](superpowers/specs/2026-07-26-pkm-wn2s-assistant-design.md) · [plan](superpowers/plans/2026-07-26-pkm-wn2s-assistant.md) |
| Offline & PWA | Server: append-only change journal, snapshot/changes feed with a generation token, batch-id dedup on `/api/ops`, base-text-hash conflict copies. Client: sqlite-wasm replica (worker + OPFS), durable op queue with optimistic apply, offline API shim pinned to the server's responses, FTS search, service-worker app shell and asset runtime cache. | [Offline design](superpowers/specs/2026-07-12-offline-editing-design.md) · [server plan](superpowers/plans/2026-07-12-offline-sync-server.md) · [web plan](superpowers/plans/2026-07-13-offline-sync-web.md) |

## Key decisions

- **Block text is stored unmodified** (Roam-flavoured markdown, literal
  `[[links]]` / `#tags` / `Attr::` / `{{[[query]]}}`). The `refs` table and
  the FTS index are derived and rebuilt on change, so the durable data is
  always plain text.
- **Roam compatibility is kept where it keeps links working.** Block uids
  survive import, and daily pages keep Roam's ordinal title format
  (`July 8th, 2026`), so imported daily-note links still resolve.
- **Assets are content-addressed** (sha256, deduplicated) on the filesystem,
  outside SQLite. Backup is one database file plus one append-only directory.
- **Pydantic models generate the TypeScript API types** via OpenAPI, so the
  block model cannot drift between server and client. The ref grammar exists
  in Python and TypeScript, pinned to identical behaviour by a shared fixture
  ([how](architecture/overview.md#one-grammar-two-languages-pinned-by-fixtures)).
- **Rendering is the scale constraint** (targets: 50k pages / 500k blocks).
  The UI never renders unbounded lists: backlinks load lazily and paginate,
  unlinked refs compute on demand, and the journal loads a few days at a
  time. Server queries measured against the real imported graph take tens of
  milliseconds.
- **Auth is layered and not internet-grade.** Tailscale is the transport
  boundary; a single static password and a signed session cookie guard
  against other devices on the LAN. The server binds loopback and the
  Tailscale IP only. [SECURITY.md](SECURITY.md) has the threat model.
- **The replica is a cache; the queue is the user's intent.** Optimistic
  local application is best-effort (an op that cannot apply locally is
  skipped, never dropped from the queue), authoritative writes re-apply the
  pending queue over themselves, and a re-bootstrap never discards a database
  whose queue has not flushed. Where the choice is between degrading and
  losing data, the app degrades.
- **Sync stays debuggable.** The change journal is append-only rows in the
  same SQLite file, a generation token detects rebuilt databases, and batch
  ids make client retries idempotent. There are no vector clocks and no merge
  machinery.
- **Functional core, imperative shell** throughout. Op application, ref
  extraction and query evaluation are pure modules; FastAPI routes, SQLite and
  the WebSocket hub are thin shells. On the web client a checker enforces the
  boundary (see [below](#web-client-architecture-sync-outline-and-fcis-hardening)).

## How it was built

Six plans (import, read API, write path, frontend read, frontend edit,
deployment), each linked in the table above, were each finished with a smoke
test against the real imported graph. The findings appended to the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md)
record what each phase proved and deferred. Offline editing followed from the
[offline design spec](superpowers/specs/2026-07-12-offline-editing-design.md).
Known gaps are tracked in the spec's carry-forward sections and as beans in
`.beans/`.

## Web client architecture (sync, outline, and FCIS hardening)

The rules below came out of a hardening pass on the offline replica and the
outliner. The design and its rejected alternatives are in the
**[web architecture & FCIS hardening design](superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md)**;
the mechanisms are documented where they live.

| Rule | Where it is documented |
|---|---|
| Persisted locally and delivered to the server are separate outcomes of a write. The queue reports a typed reason when it cannot drain, and every replica RPC can fail on worker error, timeout or disposal. | [frontend.md § Sync and offline](architecture/frontend.md#sync-and-offline-ui-side-summary), [sync-and-offline.md § What the queue and the UI do with it](architecture/sync-and-offline.md#what-the-queue-and-the-ui-do-with-it) |
| Recovery can never erase an acknowledged enqueue. A worker-owned gate serializes database writes, and recovery re-checks the pending rows just before any destructive step. | [sync-and-offline.md § The replica and its recovery invariants](architecture/sync-and-offline.md#the-replica-and-its-recovery-invariants) |
| A batch the server rejects is marked poisoned, delivery pauses, and a full-snapshot repair drops it and resumes. Connectivity and delivery health are reported separately. | [sync-and-offline.md § The replica and its recovery invariants](architecture/sync-and-offline.md#the-replica-and-its-recovery-invariants) |
| All views of a page share one outline session, and only one of them can edit. A fetched payload is adopted only if no newer request or unsettled write makes it stale. | [frontend-editor.md § Per-title outline sessions](architecture/frontend-editor.md#per-title-outline-sessions) |
| Async UI components (query blocks, block trees, Bluesky embeds, sidebar nav) each use a lifecycle suited to them, with no shared `useAsync`. | Component source |
| One client-side grammar scanner (`grammar/scan.ts`), mirroring the server parser and pinned to it by fixture, feeds rendering, ref extraction, autocomplete and slash commands. | [frontend-rendering.md § The pipeline](architecture/frontend-rendering.md#the-pipeline) |
| Deterministic transitions (keyboard policy, outline, queue, sync state) are Functional Core modules that test with no React, DOM, fetch, worker or SQLite mocks. `pnpm check:fcis` fails any Core module that imports a Shell. Components that compose shells count as Shell. `replicaSync.ts` stays a Shell because its recovery ordering is I/O control flow. | [overview.md § Functional Core / Imperative Shell](architecture/overview.md#functional-core--imperative-shell) |
| Type-aware lint rules (React Hooks, promise and error safety) and byte budgets gate the build. Mermaid's chunks stay precached under their own budget so diagrams render offline. | [frontend.md § Testing and quality gates](architecture/frontend.md#testing-and-quality-gates) |

## Out of scope

Multi-user, multiple graphs, full datalog queries and encrypted blocks. The
reasoning is in the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md).
Offline mode does not sync every asset, and some features stay online-only:
[sync-and-offline.md § Ancillary details](architecture/sync-and-offline.md#ancillary-details)
lists them, and the
[offline design spec](superpowers/specs/2026-07-12-offline-editing-design.md)
explains the deferral.
