# PKM — High-Level Design

A single-user, self-hosted replacement for Roam Research: an outliner-style
notes app with daily notes, `[[page links]]`, backlinks, full-text search and
locally-hosted assets, running on a Mac and reached over Tailscale.

This is the orientation document. The authoritative details — full data model,
API contracts, rejected alternatives, and the findings from running each phase
against the real graph — live in the detailed docs linked throughout, chiefly
the **[full design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md)**.

## Core idea

**Server-authoritative, block-granular.** SQLite on the server is the single
source of truth. The browser fetches a page's block tree, applies edits
optimistically, and sends batches of block-level operations (`create`,
`update_text`, `move`, `delete`, `set_collapsed`) to the server — the only
write path. A WebSocket broadcasts committed batches to other open clients.
No CRDTs, no offline editing: per-block last-write-wins is enough for one
person, and a dropped connection pauses writes rather than risking divergence.

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
- **Functional-core / imperative-shell** throughout: op application, ref
  extraction, query evaluation are pure modules; FastAPI routes, SQLite and
  the WebSocket hub are thin shells (convention in `CLAUDE.md`).

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

Known gaps and deferred work are tracked as carry-forward sections in the
design spec and as beans in `.beans/`.

## Out of scope (by design)

Multi-user, multiple graphs, offline editing, full datalog queries, encrypted
blocks, and creating new `((block refs))` (existing ones render). The
reasoning is in the
[design spec](superpowers/specs/2026-07-08-roam-migration-pkm-design.md).
