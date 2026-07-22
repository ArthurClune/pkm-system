---
# pkm-awrv
title: Architecture documentation in docs/
status: completed
type: task
created_at: 2026-07-22T09:00:03Z
updated_at: 2026-07-22T09:30:00Z
---

Write architecture doc(s) in docs/ covering frontend, backend, API, patterns, tech stack, key design decisions, with Mermaid diagrams. Goal: get a person or agent up to speed on the codebase.

Docs live in `docs/architecture/`: overview.md, backend.md, frontend.md, sync-and-offline.md. Branch: `docs/architecture-docs` (worktree).

- [x] Explore codebase (backend, frontend, API/sync/deploy maps)
- [x] docs/architecture/backend.md — server modules, DB, write path, API reference, importer, backup, CLI/MCP
- [x] docs/architecture/sync-and-offline.md — protocol both sides, offline/replica invariants, sequence diagrams
- [x] docs/architecture/overview.md — system context, stack, repo layout, FCIS, decisions, deployment summary
- [x] docs/architecture/frontend.md — web client modules, editor, rendering, state, testing
- [x] Cross-link from docs/design.md and README.md
- [x] Verify Mermaid diagrams render (all 8 parse via mermaid.parse) + factual spot-checks
- [x] Independent fact-check pass over the four docs
- [x] Commit, merge --no-ff to main, push

## Summary of Changes

Added `docs/architecture/` — a four-document "get up to speed" layer for new
contributors (human or agent), complementing `docs/design.md` (the *why*)
with the *what/where*:

- `overview.md` — system context diagram, tech stack, repo layout,
  cross-cutting patterns (FCIS, fixture-pinned dual parsers, generated API
  types), load-bearing decisions, deployment summary, dev workflow.
- `backend.md` — server module map, DB schema (ER diagram), the
  `POST /api/ops` write path (flow diagram), full HTTP API reference table,
  auth, importer pipeline, export/backup, CLI/MCP, generated artifacts,
  testing.
- `frontend.md` — web module map, views/state layers (outline sessions,
  SyncProvider), the textarea-based editor + keyboard policy, rendering
  pipeline, styling/theming, testing/quality gates, build notes.
- `sync-and-offline.md` — the sync protocol end to end with sequence
  diagrams: change journal, windowed feed, idempotent batches, conflict
  handling, replica/queue recovery invariants, rebootstrap triggers.

Cross-linked from `README.md` (Documentation section) and `docs/design.md`
intro. All 8 Mermaid diagrams parse-checked with mermaid 11; content
fact-checked against the code by an independent review pass (one count nit
fixed, no substantive discrepancies).
