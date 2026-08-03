# Handover: pkm-mk87 title integrity and revised title syntax

**Date:** 2026-08-02

**Integration branch:** `pkm-mk87-ulae-followups` at `9770753` before this handover commit

**Title lane:** `pkm-mk87-title-integrity` at `3f2fc3b`, clean, **not merged**

**Coordinator:** `pkm-mk87`

## Read first

- Original sweep design:
  `docs/superpowers/specs/2026-08-02-pkm-ulae-followup-tidy-design.md`
- Integration plan:
  `docs/superpowers/plans/2026-08-02-pkm-ulae-followup-integration.md`
- Original title plan:
  `docs/superpowers/plans/2026-08-02-pkm-title-integrity.md`
- Approved revised title-syntax design:
  `docs/superpowers/specs/2026-08-02-pkm-title-syntax-invariant-design.md`
- Title lane’s ignored SDD record:
  `.superpowers/sdd/2026-08-02-pkm-title-integrity/`
  in the title worktree, especially `progress.md`, `final-review.md`,
  `final-fix-report.md`, and `final-rereview.md`.

Run `beans prime` at the start of the next session.

## Executive state

The title-integrity lane implemented almost the entire original title plan over
17 commits. It has strong focused/full verification evidence and remains clean,
but it must not be merged yet.

The final whole-lane review found a nested-title migration defect and a
metadata-only sync notification defect. Commit `3f2fc3b` attempted one
consolidated fix wave:

- the forced equal-cursor generation notification is good;
- the fail-closed authoritative broadcast fix is good;
- the nested-title closure approach is not complete and introduced an ordinary
  rename regression.

The one permitted final scoped re-review therefore left the title lane blocked.
The user then clarified the domain invariant:

- page titles containing `#`, `[[`, or `]]` are unsupported and must be
  rejected;
- imports remove reference markers but preserve visible text;
- production had no titles containing `#`;
- production had one title containing `[[`/`]]`; the operator removed it.

This makes closure-complete nested-title migration unnecessary. Replace that
attempt with strict cross-stack validation plus import-only sanitization.

## Production safety and observed data

Do not rerun production inventory or migration as part of implementation.

The operator performed read-only checks and reported:

- `#` title query: zero rows;
- `[[`/`]]` title query: one row, now removed.

No production title migration was run. All prior automated migration lifecycle
verification used disposable data/config and `http://127.0.0.1:18974`. Never use
port `8974` for tests or migration verification.

## What is already implemented in the title lane

The branch range is `9770753..3f2fc3b`.

| Area | Result |
|---|---|
| Canonical primitive/meta | Control whitespace remains always normalized; boundary U+0020 is activation-gated; durable activation and generation metadata exist. |
| Planner/digest | Deterministic audit groups, survivor/source ordering, all-space blockers, complete affected rows, and SHA-256 digest. The nested closure additions in `3f2fc3b` are the part to remove. |
| Atomic apply | `BEGIN IMMEDIATE`, fresh inventory/digest comparison, stable merges, simultaneous snapshots, sidebar/FTS/journal/ref preservation, activation/generation, and `BaseException` rollback. |
| API/contracts | Authenticated GET/POST title-canonicalization routes, concrete models, 409 conflicts, OpenAPI and TS types. |
| Client/CLI | Typed methods and audit-first `pkm migrate-titles`; explicit `--apply DIGEST`; truthful human/JSON rendering; no startup migration. |
| Server/replica activation | Required sync field, generation rotation, online/offline canonicalization, metadata-before-replay ordering, old optimistic-state reconciliation. |
| Read paths | Client, page, unlinked, export, CLI, and MCP control-whitespace reads; activation-aware exactness; truthful aggregate backlink limit. |
| Broadcasts | Create/create-page/resolved-move broadcasts use authoritative stored titles; `3f2fc3b` adds fail-closed behavior. |
| Importer | Temporary imported DB runs audit/apply before publication; ordinary imports start active; all-space input refuses safely. Import sanitization is new work. |
| Documentation | README, PKM skill, backend/frontend/sync architecture, API rows, route/tool counts, and operator workflow were updated. |
| Isolated verification | Stable audit, stale digest refusal, apply, activation, generation change, canonical read/create, process/temp cleanup at port 18974. |

### Commit sequence

```text
448f924 canonical primitive and metadata
340885a deterministic migration core
eae5b5f shared canonical rule/scratch cleanup
b95001d atomic DB apply
3a3f1ff sidebar digest + BaseException rollback
6f5685f authenticated API/contracts
3c550a2 typed client/CLI
69bcff5 active-empty audit rendering
f7a37db online/offline activation gating
76bd080 optimistic activation reconciliation
9925fbc normalized reads/backlink metadata
f4bbf47 read-route coverage
ff5d307 authoritative broadcasts
2544d90 importer activation
30e7970 docs/skill/isolated verification
689cedf docs corrections
3f2fc3b final review fix wave
```

## Verification already recorded

Before lane work, the integration baseline passed:

- server: `1205 passed`, coverage `96.67%`;
- web unit: `117` files / `1808` tests;
- web E2E: `48 passed`.

The title branch’s last consolidated fix report records:

- server focused: `222 passed`;
- web focused: `148 passed`;
- pyrefly: zero errors;
- ruff: clean;
- TypeScript: clean.

These are evidence, not a substitute for the integration plan’s final full
server/web gates after every lane merges.

## Beans in the title worktree

- `pkm-2ilw`: currently `completed`; reopen it to `in-progress` while the
  revised syntax invariant is implemented, then complete it again with checked
  items and a corrected summary.
- `pkm-xo6w`: `completed`; no known new work.
- `pkm-8kw2`: `in-progress`; only authoritative broadcast is checked. Its
  traversal/blank-ref items still belong to the later parity lane.
- `pkm-7ol9`: completed test-coverage bean created during a review round.
- `pkm-mk87`: remains `in-progress` on the integration branch.

Commit bean changes with code. Do not complete a bean with unchecked items.

## Why `3f2fc3b` is only partly usable

### Keep: metadata-only activation notification

Retain these `3f2fc3b` changes and their tests/docs:

- `server/src/pkm/server/notify.py`
- forced post-commit frame use in
  `server/src/pkm/server/routes_migrations.py`
- `server/tests/test_journal_advancing_contract.py`
- related migration endpoint expectations
- `web/src/sync/socket.ts`
- force forwarding in `web/src/sync/SyncProvider.tsx`
- force handling in `web/src/sync/replicaSync.ts`
- `web/src/sync/SyncProvider.test.tsx`
- forced-frame prose in backend and sync/offline architecture docs

The forced frame uses the real journal maximum, carries the committed
generation, triggers an equal-cursor pull, and never fabricates or advances the
cursor. The final re-review marked this finding addressed.

### Keep: fail-closed authoritative broadcasts

Retain these `3f2fc3b` changes and tests/docs:

- `_require_page_title()` and explicit invariant handling in
  `server/src/pkm/server/ops_apply.py`
- defensive cases in `server/tests/test_ops_apply.py`
- corresponding backend/bean wording

The final re-review marked this finding addressed. Same-page null semantics are
preserved.

### Revert: recursive mapped-target expansion

Remove the `3f2fc3b` recursive target interpretation in
`server/src/pkm/rename.py`:

- `_mapped_title()`;
- `expanding` plumbing;
- recursive scanning of replacement values;
- the nested simultaneous rewrite regression.

Restore replacement values as opaque, simultaneous one-pass values. The failed
approach breaks an otherwise currently accepted mapping such as
`Old -> New #Old`. Under the revised design, `#` becomes invalid for page
titles, but the generic rename helper should still not recursively interpret
its replacement value.

`server/src/pkm/rename.py` and `server/tests/test_rename.py` can be compared or
restored from `689cedf` before adding the new strict-validation tests.

### Revert: nested final-title planner closure

Remove the `3f2fc3b` additions in `server/src/pkm/title_migration.py`:

- `boundary_replacements`/`final_groups` nested-title expansion;
- intermediate clean identity selection;
- final nested title grouping and replacement-map expansion.

Return to boundary-U+0020 grouping: exact clean twin wins, otherwise lowest
page ID. Add forbidden-syntax blockers instead of nested closure.

`server/src/pkm/title_migration.py` and its nested tests can use `689cedf` as the
pre-attempt reference.

### Revert: nested inventory/apply special cases

Remove the nested-final inventory and survivor-retitle behavior added to
`server/src/pkm/server/title_migration.py` by `3f2fc3b`:

- `rewrite_title_refs_map` import used for final-title inventory;
- `final_titles` selection and nested final sidebar inventory;
- survivor retitle based on nested final spelling;
- nested apply/import tests and docs claims.

The revised migration should inventory forbidden titles as blockers instead.

The transaction-local activation-before-reindex move was introduced solely for
the nested workaround. The simplest restoration is the original reviewed order
from `689cedf`: rewrite/reindex, then activate, then rotate generation, all in
the same rollback-protected transaction. Strict validation/blockers make the
nested recreation scenario impossible. If implementation evidence shows an
independent reason to keep the earlier activation point, document and test that
reason rather than carrying it accidentally.

Candidate test files to restore selectively from `689cedf` before adding new
syntax tests:

- `server/tests/test_rename.py`
- `server/tests/test_title_migration.py`
- `server/tests/test_importer_e2e.py`

Do not revert the orphan canonical-sidebar digest fix from `3a3f1ff` or the
`BaseException` rollback fix.

### Update mixed documentation/beans selectively

Do not revert all docs or all of `3f2fc3b`. Backend/sync docs contain both good
forced-notification/broadcast material and bad nested-closure claims. Remove
only nested-title support/closure prose and replace it with the strict syntax
invariant, import sanitization, and migration blocker behavior.

`pkm-2ilw`’s final-review checklist/summary currently claims nested-title
support. Reopen and rewrite that section after the new implementation. Keep its
production-safety statement.

## Approved simplification to implement

The full approved design is in
`docs/superpowers/specs/2026-08-02-pkm-title-syntax-invariant-design.md`.

In short:

1. Reject any normal page title containing `#`, `[[`, or `]]`.
2. Apply the invariant across server create/rename/ops, ref-derived page
   creation, CLI/MCP via server errors, importer output, local API, and
   optimistic replica operations.
3. Imports alone sanitize reference markup while preserving visible text:
   - `Project [[Acme]]` -> `Project Acme`
   - `Wrapper [[Outer [[Inner]]]]` -> `Wrapper Outer Inner`
   - `Project #Acme` -> `Project Acme`
4. Import sanitization is pure, recursive, reported, and occurs before rows are
   created. Malformed/unbalanced forms and blank results refuse.
5. Sanitized collisions merge deterministically with blocks/refs preserved.
6. Plain-space migration audit reports existing forbidden titles as blockers;
   apply refuses them.
7. Add a blocker reason (`all_space` or `forbidden_syntax`) to API/CLI output,
   regenerate OpenAPI/types, and update docs.
8. Restore opaque rename replacement values; no nested closure logic remains.

## Suggested implementation sequence

The next session should not treat this as an unauthorized second final fix
wave. It is an approved requirements revision and should get a fresh plan and
fresh SDD workspace.

1. Update/review the original title spec and title plan against the new syntax
   design, or write a focused follow-up plan referenced by the integration plan.
2. Reopen `pkm-2ilw` and add unchecked syntax-invariant tasks.
3. Selectively revert the failed nested portions while keeping forced sync and
   fail-closed broadcast changes.
4. TDD the Python pure validator and migration blocker reason.
5. TDD server/ops/ref-derived rejection.
6. TDD the pure importer sanitizer, collision handling, report output, and E2E
   publication.
7. TDD TypeScript validator parity and local/offline rejection.
8. Regenerate OpenAPI/types and update architecture/README/PKM skill if their
   contracts change.
9. Run title focused gates and isolated migration verification only on port
   `18974` with disposable data/config.
10. Repeat task review and a fresh whole-title-lane review.
11. Only after the title review is clean, merge
    `pkm-mk87-title-integrity` into `pkm-mk87-ulae-followups` with
    `git merge --no-ff`.
12. Then create/execute the parity, importer-follow-up, and export lanes from the
    post-title integration baseline, as the integration plan requires.

## Required TDD coverage for the revised invariant

- Python and TypeScript shared valid/invalid title fixtures.
- Any `#`, `[[`, or `]]` rejected at every normal title creation boundary.
- Rename to `New #Old` rejected before rewrite/persistence.
- Ref-derived invalid targets reject atomically and do not create pages/refs.
- Batch and optimistic/local operations do not partially mutate state.
- Import sanitizes bracket refs, nested refs, `#Tag`, and `#[[Tag]]` to visible
  text.
- Import refuses malformed/unbalanced syntax and blank sanitized results.
- Import sanitized collisions preserve page blocks, refs, and deterministic
  order and are represented truthfully in the report.
- Migration audit exposes `forbidden_syntax` blockers, includes them in the
  digest, stays side-effect free, and apply refuses.
- Ordinary rename replacement values remain opaque.
- Existing all-space blockers, atomic rollback, zero-group forced generation
  pull, fail-closed broadcasts, and importer publication ordering remain green.

## Integration status

No title merge has occurred. The integration branch remains at the plan commit,
apart from this handover/spec documentation. The parity/importer/export lanes
have not been created or executed. This preserves the required order:

1. finish and review title integrity;
2. merge title with `--no-ff`;
3. branch the three remaining lanes from the post-title integration baseline;
4. merge each with `--no-ff`;
5. full architecture/generated review, server/web verification, final review,
   seven child beans, then `pkm-mk87`.

## Safety reminders

- Never run title migration against production during development.
- Never use port `8974` for tests or isolated verification.
- Use only disposable databases/config at `127.0.0.1:18974` for migration
  verification.
- Do not copy or inspect production data again; the operator has already
  supplied the needed inventory result.
- Keep SDD reports/packages in the ignored plan-specific workspace and never
  force-add `.superpowers`.
