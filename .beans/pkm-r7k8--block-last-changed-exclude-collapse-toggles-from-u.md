---
# pkm-r7k8
title: 'Block last-changed: exclude collapse toggles from updated_at, backfill NULL created_at'
status: todo
type: task
priority: normal
created_at: 2026-08-01T18:37:40Z
updated_at: 2026-08-01T18:49:50Z
---

Goal: make blocks.updated_at a trustworthy "last changed" for every block, and fill the created_at gaps.

## Findings (2026-08-01, prod DB)

Block-level timestamps already exist and are genuine: blocks.created_at/updated_at have been in the schema all along; the Roam importer copies per-block :create/time and :edit/time (parse_export.py); every server write path stamps updated_at (ops_apply.py, store.py); both fields already flow to clients via sync and appear in API responses. Prod: 53,369 blocks, updated_at NULL on 0, created_at NULL on 3,290 (~6%, old Roam blocks lacking :create/time). updated_at values span 2020-2026 with ~48k distinct values — real edit times, not an import artifact. So no new columns and no schema change: the original "add block timestamps" idea reduces to the two items below.

## Decisions (Arthur)

- Collapse/expand is NOT a real change and must stop bumping updated_at (frequent enough to pollute the signal). Text edits, drag moves, heading and view_type changes ARE real changes and keep bumping.
- Backfill NULL created_at from the block's page created_at (population is small; no text-date parsing — genuine edit times already exist for recently-touched blocks).
- Implementation note: use MIN(page.created_at, block.updated_at) so the backfill can never mint created_at > updated_at (merged/moved blocks can sit on pages younger than their last edit).

## Checklist

- [ ] Server: set_collapsed effect no longer bumps updated_at (ops_apply.py) — tests first
- [ ] Server: SetCollapsedOp no longer emits TouchPage (ops_core.py) — page updated_at untouched by collapse
- [ ] Client: mirror the page-touch exclusion in localOps.ts (set_collapsed currently bumps pages.updated_at there too — verify)
- [ ] Client: mirror in web/src/replica/localOps.ts set_collapsed; keep localApi parity tests honest
- [ ] Backfill as guarded idempotent startup migration in server/db.py: UPDATE blocks SET created_at = ... WHERE created_at IS NULL (fires changes triggers, so replicas pick it up via normal sync)
- [ ] docs/architecture: prose note on updated_at semantics — what bumps it and that collapse deliberately does not
- [ ] Verify: server pytest + pyrefly + ruff, web pnpm verify

## Out of scope

- Two empty stub pages with NULL created_at and zero blocks ("40", "henderson-bvgr") — cleanup candidates, not part of this work.
- Historic pollution from past collapse toggles is unrecoverable; acceptable.
