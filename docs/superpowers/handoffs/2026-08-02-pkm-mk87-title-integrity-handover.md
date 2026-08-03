# Handover: pkm-mk87 title integrity and revised title syntax

> **SUPERSEDED 2026-08-03 — this document describes a state that no longer
> exists.** It was written while the title lane was blocked, and its status
> tables say the title lane is unmerged and the parity/importer/export lanes do
> not exist. All four lanes have since been implemented, reviewed and merged
> `--no-ff`, `main` has been merged in, and `pkm-mk87` is complete. Read it only
> as the record of *why* the nested-title closure approach was abandoned in
> favour of rejecting `#`/`[[`/`]]` in page titles — that reasoning is still
> accurate and still worth having. For what shipped, read
> `docs/architecture/backend.md` and `docs/architecture/sync-and-offline.md`;
> for how the sweep was executed, read the coordinator bean `pkm-mk87`.

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

## Wider `pkm-mk87` coordinator scope

`pkm-mk87` coordinates every open direct follow-up under `pkm-ulae`. The work
is intentionally split into four implementation lanes plus central integration.
The title lane is only the first lane.

### Four lane plans

| Lane | Plan | Scope | Current state |
|---|---|---|---|
| Title integrity | `docs/superpowers/plans/2026-08-02-pkm-title-integrity.md` | Audit/apply migration, activation metadata, API/CLI, online/offline title parity, read normalization, broadcasts, importer activation, docs | Implemented on `pkm-mk87-title-integrity`, but blocked pending the revised forbidden-title invariant and selective nested-closure revert |
| Traversal/ref/section parity | `docs/superpowers/plans/2026-08-02-pkm-traversal-ref-section-parity.md` | Uncapped cycle-safe server/local traversal, Python/TS blank-ref parity, level-aware `pkm get --section`, docs | Not started; must branch from the post-title integration baseline |
| Importer follow-ups | `docs/superpowers/plans/2026-08-02-pkm-importer-followups.md` | Structured EDN errors, friendly refusal, duplicate/DAG preflight, global Mermaid preservation, implicit counts, temp cleanup boundaries, docs | Not started; must branch from the post-title integration baseline and preserve title-lane import activation/sanitization ordering |
| Export writer polish | `docs/superpowers/plans/2026-08-02-pkm-export-writer-polish.md` | Disjoint copy/repair telemetry, abandoned staging cleanup without symlink following, warning-lifetime docs | Not started; must branch from the post-title integration baseline |

### Seven target child beans

| Bean | Owning lane(s) | Required outcome | Current title-branch state |
|---|---|---|---|
| `pkm-2ilw` | Title | Safe title migration and post-activation creation invariant | Currently completed on title branch, but must be reopened for forbidden-title validation/import sanitization and completed again |
| `pkm-xo6w` | Title | Client/server/CLI/MCP read normalization and truthful backlink metadata | Completed on title branch |
| `pkm-8kw2` | Title + parity | Authoritative broadcast plus server/local traversal and blank-ref parity | In progress; broadcast complete, three parity items remain unchecked |
| `pkm-dzgw` | Parity | Marked section specs honor heading level; bare text remains lenient | Not started |
| `pkm-5h2k` | Importer | Friendly structured malformed-EDN CLI error while retaining strict `\/` rejection | Not started |
| `pkm-x1ig` | Importer | DAG/duplicate refusal, global Mermaid safety, report/count/temp-boundary accuracy | Not started |
| `pkm-amq2` | Export | Repair telemetry, no-follow staging cleanup, warning documentation | Not started |

The integration branch’s bean files still reflect the pre-implementation plan
until lane commits are merged. Inspect bean status in the owning lane before
assuming an item is undone or complete.

## Integration-plan task status

The central plan is
`docs/superpowers/plans/2026-08-02-pkm-ulae-followup-integration.md`.

| Integration task | State |
|---|---|
| Task 1 — commit/review plan set | Complete at `9770753` |
| Task 2 — execute and merge title first | In progress and blocked; title lane is at `3f2fc3b`, unmerged, with the approved revised design documented here |
| Task 3 — create/execute parity, importer, export lanes | Not started |
| Task 4 — merge remaining lanes with `--no-ff` | Not started |
| Task 5 — architecture and cross-file review | Not started centrally; title docs were updated only in the title lane |
| Task 6 — full server/web verification | Not started on the merged integration tree |
| Task 7 — final review and bean/coordinator completion | Not started |

The integration SDD ledger is ignored at:

```text
.superpowers/sdd/2026-08-02-pkm-ulae-followup-integration/progress.md
```

It records Task 1 complete and Task 2 blocked at the title final re-review.

## Cross-lane overlap and conflict rules

### Title versus parity

Both lanes touch:

- `server/src/pkm/refs.py`
- `server/src/pkm/server/routes_pages.py`
- `web/src/replica/localOps.ts`
- `README.md`
- `.claude/skills/pkm/SKILL.md`
- `docs/architecture/backend.md`
- `docs/architecture/sync-and-offline.md`
- `pkm-8kw2`

Therefore parity must start from the final merged title baseline. Preserve title
activation/read/validation behavior while adding visited-path traversal,
blank-ref filtering, and section semantics around it. `pkm-8kw2` must retain
the authoritative-broadcast summary and add the three parity outcomes before
completion.

### Title versus importer

Both lanes touch `server/src/pkm/importer/run.py`, importer E2E tests, and
backend architecture docs. The final importer order must be:

```text
verify export file
-> strict EDN parse
-> parse_export
-> structural preflight
-> import-only title sanitization
-> linked-file indexing / row derivation / global Mermaid plan
-> temporary database and assets
-> title audit/apply activation
-> report and publication
```

Structural refusal must occur before filesystem/output work. Title
sanitization must occur before rows are created. The shared title audit/apply
step must remain after database build and before publication. Do not duplicate
migration logic in the importer lane.

### Title versus export

Runtime overlap should be minimal. The main shared file is
`docs/architecture/backend.md`. Preserve both title/importer invariants and
export telemetry/cleanup semantics in their correct sections.

### Generated API artifacts

Title syntax blocker reasons will change the HTTP schema, so regenerate:

- `web/src/api/openapi.json`
- `web/src/api/types.d.ts`

The parity/importer/export plans do not otherwise require API schema changes.
After all lane merges, regenerate once from the merged server and require
`server/tests/test_openapi_sync.py` to prove no manual generated edits remain.

### Documentation and beans

Resolve overlapping README, PKM skill, architecture, and bean edits only on the
integration branch after lane merges. Retain all non-conflicting invariants; do
not choose one lane’s version wholesale. Invoke `superpowers:writing-skills`
before any further PKM skill edit.

## Remaining integration sequence

Follow this order exactly:

1. Review the revised title-syntax spec and write a focused implementation plan.
2. Resume `pkm-mk87-title-integrity`; reopen `pkm-2ilw`.
3. Selectively revert only the failed nested-closure changes from `3f2fc3b`.
4. Implement strict title validation, import sanitization, and migration blocker
   reasons with TDD and per-task reviews.
5. Run title focused gates and disposable-port-18974 verification.
6. Run a fresh whole-title-lane review; resolve all load-bearing findings.
7. Merge `pkm-mk87-title-integrity` into `pkm-mk87-ulae-followups` with
   `git merge --no-ff`.
8. Create `pkm-mk87-parity`, `pkm-mk87-importer`, and `pkm-mk87-export` from
   that post-title integration HEAD.
9. Execute those three independent lanes in parallel, each with its own
   worktree, SDD ledger, TDD cycles, task reviews, and focused gates.
10. Merge parity, importer, then export with `git merge --no-ff`.
11. Resolve overlap centrally and rerun affected title/other-lane focused tests
    after each merge.
12. Regenerate OpenAPI/types once from merged code and inspect the generated
    diff.
13. Perform architecture, stale-count/enumeration, FCIS, README, skill, and
    bean consistency review.
14. Run full verification, final spec review, final code-quality review, bean
    completion, and coordinator completion.

## Focused gates for the remaining lanes

### Parity

- Server ancestor, refs, blank-title, section-render/CLI/help tests.
- Web local subtree, local ancestor, grammar refs, replica refs tests.
- Server pyrefly/ruff; web typecheck/lint/FCIS.

### Importer

- EDN, structure preflight, importer E2E, Mermaid planner/migration, rows, and
  report tests.
- Server pyrefly and ruff.
- Explicitly re-run title import sanitization/activation tests after merge.

### Export

- Assets core, export writer, and backup CLI tests.
- Server pyrefly and ruff.

## Final merged verification

Run from the integration worktree, sequentially as documented:

```bash
cd server && uv run pytest -q
cd server && uv run pyrefly check
cd server && uv run ruff check
cd web && pnpm verify
```

Expected conditions:

- server coverage remains at least 95%;
- pyrefly reports zero errors;
- ruff passes;
- web typecheck, lint, FCIS, unit coverage, build, and all Playwright tests pass;
- web verification runs alone rather than concurrently with server pytest;
- generated OpenAPI/types match the merged live schema;
- shell/bean/report evidence contains no production migration and no test use of
  port `8974`.

Also repeat the supported CLI migration lifecycle only against disposable data,
a disposable CLI config, and exactly `http://127.0.0.1:18974`. Confirm stable
audit, stale refusal, apply, activation, generation change, canonical behavior,
and complete process/temp cleanup.

## Architecture and documentation completion

Before checking the coordinator documentation item:

- verify every API row/model against code and generated OpenAPI;
- verify title validation, activation transaction, forced generation pull,
  importer preflight/sanitization/publication, Mermaid transitivity, export
  telemetry/cleanup, section matching, blank-ref filtering, and cycle-safe local
  traversal against merged runtime code;
- search stale route/tool/count/depth/temp-file/asset-count claims;
- audit every changed runtime file’s FCIS declaration and actual boundary;
- run the web FCIS checker;
- ensure README and PKM skill use the final CLI syntax and safety rules.

Architecture docs describe merged code, never planned behavior.

## Bean and coordinator completion

Before completing `pkm-mk87`, run:

```bash
beans show --json pkm-2ilw pkm-amq2 pkm-8kw2 pkm-dzgw pkm-5h2k pkm-xo6w pkm-x1ig
```

Every child must:

- have status `completed`;
- contain no unchecked checklist items;
- include `## Summary of Changes`;
- accurately state verification and any production-safety facts.

Then update `pkm-mk87`:

- check all seven child completion items;
- check architecture review;
- check full server/web verification;
- check final review;
- append a summary with child outcomes and final test counts;
- state exactly: production title migration not executed;
- mark completed only when no unchecked item remains.

Commit all final bean/docs changes. Final status must be clean on
`pkm-mk87-ulae-followups`, and merge commits must preserve every lane with
`--no-ff`.

## Integration status

No title merge has occurred. The integration branch contains the original
approved plan set plus this handover/revised design documentation. The
parity/importer/export branches and worktrees have not been created or executed.
This preserves the required title-first dependency and leaves the wider sweep
ready for a new session to resume without guessing.

## Safety reminders

- Never run title migration against production during development.
- Never use port `8974` for tests or isolated verification.
- Use only disposable databases/config at `127.0.0.1:18974` for migration
  verification.
- Do not copy or inspect production data again; the operator has already
  supplied the needed inventory result.
- Keep SDD reports/packages in the ignored plan-specific workspace and never
  force-add `.superpowers`.
