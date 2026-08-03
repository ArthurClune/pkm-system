---
# pkm-r7k8
title: 'Block last-changed: exclude collapse toggles from updated_at, backfill NULL created_at'
status: completed
type: task
priority: normal
created_at: 2026-08-01T18:37:40Z
updated_at: 2026-08-03T16:32:16Z
---

Goal: make blocks.updated_at a trustworthy "last changed" for every block, and fill the created_at gaps.

## Findings (2026-08-01, prod DB)

Block-level timestamps already exist and are genuine: blocks.created_at/updated_at have been in the schema all along; the Roam importer copies per-block :create/time and :edit/time (parse_export.py); every server write path stamps updated_at (ops_apply.py, store.py); both fields already flow to clients via sync and appear in API responses. Prod: 53,369 blocks, updated_at NULL on 0, created_at NULL on 3,290 (~6%, old Roam blocks lacking :create/time). updated_at values span 2020-2026 with ~48k distinct values — real edit times, not an import artifact. So no new columns and no schema change: the original "add block timestamps" idea reduces to the two items below.

## Decisions (Arthur)

- Collapse/expand is NOT a real change and must stop bumping updated_at (frequent enough to pollute the signal). Text edits, drag moves, heading and view_type changes ARE real changes and keep bumping.
- Backfill NULL created_at from the block's page created_at (population is small; no text-date parsing — genuine edit times already exist for recently-touched blocks).
- Implementation note: use MIN(page.created_at, block.updated_at) so the backfill can never mint created_at > updated_at (merged/moved blocks can sit on pages younger than their last edit).

## Checklist

- [x] Server: set_collapsed effect no longer bumps updated_at (ops_apply.py) — tests first
- [x] Server: SetCollapsedOp no longer emits TouchPage (ops_core.py) — page updated_at untouched by collapse
- [x] Client: mirror the page-touch exclusion in localOps.ts (set_collapsed currently bumps pages.updated_at there too — verify)
- [x] Client: mirror in web/src/replica/localOps.ts set_collapsed; keep localApi parity tests honest
- [x] Backfill as guarded idempotent startup migration in server/db.py: UPDATE blocks SET created_at = ... WHERE created_at IS NULL (fires changes triggers, so replicas pick it up via normal sync)
- [x] docs/architecture: prose note on updated_at semantics — what bumps it and that collapse deliberately does not
- [x] Verify: server pytest + pyrefly + ruff, web pnpm verify

## Out of scope

- Two empty stub pages with NULL created_at and zero blocks ("40", "henderson-bvgr") — cleanup candidates, not part of this work.
- Historic pollution from past collapse toggles is unrecoverable; acceptable.


## Summary of Changes

Collapse/expand no longer counts as a change, on both sides of the sync
boundary, and the created_at gaps are filled.

- `ops_core.plan_op(SetCollapsedOp)` returns `(SetCollapsed(...),)` only — no
  `TouchPage`, so `pages.updated_at` is untouched by a collapse.
- `ops_apply._execute` writes `UPDATE blocks SET collapsed = ? WHERE uid = ?`
  — no `updated_at` stamp.
- `web/src/replica/localOps.ts` mirrors both exclusions in the optimistic
  local apply (`requireBlock` kept, for the unknown-uid failure parity every
  sibling case has). Local and server semantics stay identical, so a collapse
  made offline can't reorder recency lists and then un-reorder on resync.
- `db._backfill_created_at`, run from `init_db()`: fills NULL
  `blocks.created_at` with `MIN(COALESCE(page.created_at, updated_at),
  updated_at)` where `created_at IS NULL AND updated_at IS NOT NULL`.
  Idempotent, and an ordinary UPDATE, so `blocks_chg_au` fires and replicas
  adopt the values through normal sync.
- Docs: `backend.md` gains the timestamp-semantics note under the write path,
  `created_at`/`updated_at` on the blocks ER entity, and the backfill under
  schema migrations (that bullet's column enumeration was also stale — it
  omitted the three `assets` description columns). `sync-and-offline.md` gains
  the note that the local apply must mirror the server's timestamp rules, not
  just its row contents.

Collapse still syncs: the journal triggers are row-level and fire on any
UPDATE, independent of `updated_at`. Asserted, not assumed
(`test_set_collapsed_still_journals_a_change_but_no_page_touch`), and
`test_journal_advancing_contract.py` already used a collapse batch as its ops
action and still passes.

### Dry run against a copy of the prod DB

3,211 blocks have NULL `created_at`, all with a non-NULL `updated_at`, so the
backfill covers every one of them and skips none. The `MIN()` guard is
load-bearing rather than theoretical: on 197 of those rows the page's
`created_at` is younger than the block's own `updated_at`, and taking the
page's value alone would have minted a `created_at` after the block's last
edit. Post-backfill: 0 NULLs left, and no new `created_at > updated_at` rows
(prod has 5 such rows already, 1–3 ms Roam import artifacts, untouched by the
statement). Runtime 24 ms on the 53k-block database.

### Verification

Server: 1428 passed, coverage 96.91% (gate 95%); pyrefly 0 errors; ruff clean.
Web: `pnpm verify` — typecheck, lint, FCIS check, unit coverage 97.65%, build,
48/48 Playwright e2e passed.
