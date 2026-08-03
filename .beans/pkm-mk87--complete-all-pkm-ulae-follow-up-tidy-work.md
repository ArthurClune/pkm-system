---
# pkm-mk87
title: Complete all pkm-ulae follow-up tidy work
status: completed
type: task
priority: normal
created_at: 2026-08-02T16:38:01Z
updated_at: 2026-08-03T14:28:05Z
parent: pkm-ulae
---

Coordinate and verify completion of every open direct follow-up under pkm-ulae.

- [x] Explore project and bean context
- [x] Clarify scope and success criteria

Scope decision: implement and verify pkm-2ilw migration tooling, but do not run it against production.
- [x] Compare implementation approaches and approve design
- [x] Write and review design spec
- [x] Write implementation plan
- [x] Complete pkm-2ilw
- [x] Complete pkm-amq2
- [x] Complete pkm-8kw2
- [x] Complete pkm-dzgw
- [x] Complete pkm-5h2k
- [x] Complete pkm-xo6w
- [x] Complete pkm-x1ig
- [x] Review architecture documentation
- [x] Run full server and web verification
- [x] Complete final review and summary

## Summary of Changes

Four implementation lanes, each with its own worktree, TDD cycles, per-task
reviews and whole-lane review, merged into `pkm-mk87-ulae-followups` with
`--no-ff` in dependency order (title first, because it owned the shared
replica/importer/read-path changes the other three build on).

**Child outcomes**

- `pkm-2ilw` — audit-first title canonicalization: durable activation and
  generation metadata, deterministic planner with SHA-256 digest, atomic
  `BEGIN IMMEDIATE` apply with `BaseException` rollback, authenticated
  GET/POST routes, `pkm migrate-titles` with explicit `--apply DIGEST`, and
  online/offline activation parity. Mid-lane the requirements were revised:
  page titles containing `#`, `[[` or `]]` are now rejected outright across
  every creation boundary, imports alone sanitize the markup while preserving
  visible text, and the migration reports such titles as `forbidden_syntax`
  blockers. That replaced an earlier nested-title closure attempt which was
  reverted along with its recursive rename-target expansion.
- `pkm-xo6w` — client, page, unlinked, export, CLI and MCP reads all
  normalize control whitespace; activation-aware exactness; truthful
  aggregate backlink limit.
- `pkm-8kw2` — broadcasts carry the authoritative stored page title (failing
  closed rather than falling back to caller spelling), blank refs are dropped
  in both pure extractors with padded-nonblank titles preserved byte-exact,
  and all three recursive traversals swapped `depth < 100` for a visited-path
  guard, making them complete *and* cycle-safe.
- `pkm-dzgw` — `pkm get --section` honours heading level for marked specs
  (`## Notes`) while bare text stays level-agnostic.
- `pkm-5h2k` — structured EDN parse errors with a friendly CLI refusal
  (zero-based character offsets); the EDN-invalid `\/` escape stays rejected.
- `pkm-x1ig` — importer structural preflight refuses duplicate UIDs and
  multi-parent blocks before any filesystem work, global Mermaid preservation,
  accurate implicit-page counts, and pinned temp-cleanup boundaries. Its
  independent review caught title activation running before asset copying;
  activation now happens only after every asset is in place.
- `pkm-amq2` — disjoint export copy/repair telemetry, abandoned staging-dir
  sweep that does not follow symlinks, and documented warning lifetime.

**Verification** (merged tree, run sequentially, `main` merged in first)

- server: 1421 passed, coverage 96.91% (≥95% required)
- server pyrefly: 0 errors; ruff: clean
- web `pnpm verify`: typecheck, lint, FCIS (140 runtime modules, no boundary
  violations), unit 120 files / 1881 tests at 97.65%, production build, and
  48 Playwright E2E tests — all passing, run alone
- `openapi.json` and `types.d.ts` regenerated once from the merged server and
  byte-identical to what the lanes committed, so no manual edits to generated
  artifacts remain
- architecture docs checked against merged code: API table covers every route
  in the schema, the eleven MCP tools still enumerate correctly, the importer
  stage order in `backend.md` matches `run.py` including the moved activation
  stage, and every changed runtime file keeps its FCIS declaration (the two
  new Core modules contain no I/O)

**Production title migration not executed.** All migration lifecycle
verification used disposable databases, a disposable CLI config, and
`http://127.0.0.1:18974`. No command in any lane targeted port 8974 or the
production CLI configuration; every occurrence of `8974` in this branch is a
prohibition in documentation or bean prose. The operator's own read-only
production inventory (zero `#` titles, one `[[`/`]]` title since removed) is
the only production data this work relied on.
