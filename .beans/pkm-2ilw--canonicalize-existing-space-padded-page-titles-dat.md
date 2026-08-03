---
# pkm-2ilw
title: Canonicalize existing space-padded page titles (data migration)
status: in-progress
type: task
priority: normal
created_at: 2026-07-31T16:43:21Z
updated_at: 2026-08-03T12:16:43Z
parent: pkm-ulae
---

Follow-up from pkm-1rb5 review. That earlier review noted production data contained pages whose stored titles carried leading/trailing plain spaces (e.g. " EvilCorp" id=2 with 11 blocks/3 inbound refs; "Paper/AI-Assisted Scientific Assessment: A Case Study on Climate Change " id=2924). Since padded and stripped spellings resolve to different pages (exact-match lookup, deliberately preserved by pkm-1rb5 round 2), users can silently split content between "X" and " X".

Design a one-time data migration that trims existing padded page titles, merging into an existing clean-named twin where one exists (reuse the pkm-g0t5 rename/merge machinery), rewriting inbound [[refs]] accordingly. After migration, consider stripping plain spaces at the shared creation boundary so new padded titles cannot be created (blocked on the migration; see pkm-1rb5's recorded decision).

- [x] Verify audit/planner/CLI behavior against an isolated temporary database/server only (production title migration/inventory was NOT executed)
- [x] Migration with merge handling + ref rewrite
- [x] Then (and only then) canonicalize new titles at the creation boundary

## Notes

- 2026-08-02: Task 2 landed the pure deterministic migration planner and simultaneous one-pass reference rewrite core; atomic DB inventory/apply and API surfaces remain pending in later tasks.

- 2026-08-02 fix round 1/5: task 2 now reuses the shared normalize-then-strip title rule in the migration planner, adds control-whitespace regression coverage for grouping/blockers/digest, and removes reviewed .superpowers scratch files from Git tracking while keeping them locally ignored.

## Task 3: database inventory and atomic apply

- [x] Side-effect-free inventory/audit TDD cycle
- [x] Phased store primitive composition TDD cycle
- [x] Atomic apply and rollback TDD cycle
- [x] Focused tests, type check, lint, and atomicity self-review

## Task 3 Summary of Changes

Added transaction-owned database audit/inventory, phased rename/merge store primitives, and BEGIN IMMEDIATE atomic migration apply with complete snapshots/mapping, activation and generation rotation, plus stale/blocked/active and rollback coverage. Production inventory and activation remain intentionally unexecuted; API/CLI activation work remains pending.

## Task 4: authenticated migration API and generated contracts

- [x] Write authenticated audit/apply RED tests
- [x] Add concrete Pydantic models
- [x] Implement and register routes
- [x] Verify OpenAPI drift, regenerate, and retest
- [x] Commit authenticated title migration API work

## Task 4 Summary of Changes

Added authenticated title-canonicalization audit/apply HTTP routes with concrete OpenAPI response/request models, 409 translations for stale/blocked/already-active domain conflicts, a single post-commit seq nudge after the already-atomic apply path, journal-contract coverage, regenerated OpenAPI/TypeScript artifacts, and backend API documentation for the new operator route.

## Task 5: typed client and audit-first CLI

- [x] Write client/renderer/CLI RED tests
- [x] Implement typed methods and pure renderers
- [x] Register `migrate-titles`
- [x] Verify and commit

## Task 5 Summary of Changes

Added typed client audit/apply methods for the authenticated title-canonicalization migration, pure human renderers for audit/apply payloads, and an audit-first `pkm migrate-titles` CLI with `--json` and explicit `--apply DIGEST` modes. Help now explains that startup does not run the migration automatically, conflicts still surface through the existing CLI exit path, and focused/client-contract/backend verification all passed.

## Task 6: server/offline activation gating and sync propagation

- [x] Server gating/sync payload RED/GREEN
- [x] Pure replica title core RED/GREEN
- [x] Metadata ordering and mismatch atomicity RED/GREEN
- [x] Local API/optimistic boundaries RED/GREEN
- [x] Generate contracts, run final gates, self-review, report, and commit

## Task 6 Summary of Changes

Gated server and replica title boundaries on the durable migration activation flag, propagated required activation metadata through snapshot/reset/changes contracts, persisted accepted browser metadata before pending replay without mutating generation-mismatched state, centralized pure TypeScript title canonicalization, and covered activation-aware local reads/creation/moves. Regenerated OpenAPI/types and passed the focused server/web tests, pyrefly, ruff, and TypeScript typecheck. Production inventory/apply was not run and remains the only unchecked top-level operational item; the bean stays in progress.

## Task 6 fix round 1/5

- [x] Add and capture RED server POST boundary regression
- [x] Add and capture RED replica activation replay regression
- [x] Implement minimal FCIS-consistent fixes
- [x] Run focused suites, typecheck, pyrefly, and ruff
- [x] Append report evidence and commit fix round

## Task 6 fix round 1/5 summary

Added a focused real-POST activation regression (with mutation RED because the base Task 6 commit already contained the raw-title route fix), reconciled pre-applied padded negative-id pages onto accepted canonical targets before pending replay, preserved optimistic blocks/refs and unchanged wire operations across create_page/create/cross-page move shapes, updated architecture invariants, and passed focused server/web suites plus TypeScript, pyrefly, and ruff gates. The two reviewer minors remain deferred to final review as requested.

## Task 9: importer canonicalization before publication

- [x] Write importer E2E RED tests for padded merge, ordinary activation, and all-space refusal
- [x] Reuse audit/apply on the temporary importer database before publication
- [x] Run focused importer tests, pyrefly, ruff, brief gates, self-review, and commit

## Task 9 Notes

- 2026-08-02: Added importer E2E RED coverage for clean+padded merge, ordinary activation, and all-space refusal. Observed RED: activation stays "0" on successful imports and all-space imports still publish/return 0.

## Task 9 Summary of Changes

Reused the shared title-migration audit/apply shell against importer-built temporary databases before publication, so fresh imports now publish with `plain_space_title_canonicalization = "1"`, clean/padded twins merge through the existing stable block/ref rewrite path, and all-space imports refuse with exit 2 before any db/report swap. Added importer E2E coverage for merge + activation + refusal, and documented the importer-side activation/refusal invariant in backend architecture notes.

## Task 10: documentation and isolated activation verification

- [x] Document operator, API, transaction, sync, importer, read, backlink, and broadcast title contracts
- [x] Skill-TDD the PKM migration guidance with fresh RED and GREEN agents
- [x] Run the focused server/web, generated-contract, type, and lint gates
- [x] Verify audit/apply/activation only with temporary data/config on http://127.0.0.1:18974 and clean up process/data
- [x] Reconcile title-related bean status without claiming production access

## Summary of Changes

Implemented deterministic title-migration planning and digesting; atomic audit/apply with merge, reference/sidebar reconciliation, activation, generation rotation, authenticated API and typed CLI; activation-aware online/offline title boundaries and pending replay reconciliation; authoritative title broadcasts; importer reuse before publication; control-whitespace read normalization; and truthful complete backlink pagination. Documented the complete operator and architecture contracts and verified the focused/generated gates plus an isolated CLI migration lifecycle. Production title migration/inventory was NOT executed; all Task 10 runtime verification used disposable data, a disposable CLI config, and http://127.0.0.1:18974.

## Superseded final review fix wave

- [x] Supersede nested migration closure with boundary-space-only migration mappings and opaque one-pass replacement values
- [x] Preserve immediate equal-cursor pulls after metadata-only generation rotation without fabricating a journal sequence
- [x] Preserve fail-closed applied-page broadcasts when the authoritative stored title cannot be loaded
- [x] Reconcile sync/backend architecture invariants and rerun focused server/web/type/lint gates

## Superseded final review fix summary

The approved strict title-syntax revision supersedes the former nested source-target closure and activation-before-reindex description: normal writes reject title markers, imports sanitize balanced markers recursively, and migration audit/apply blocks unsupported legacy syntax. Title activation still broadcasts a forced WebSocket seq frame containing the actual journal maximum and new generation, allowing already-current replicas to pull and rebootstrap without mutating or inventing cursor values. Applied-page broadcasts still raise on an unreachable authoritative-title lookup failure instead of retaining caller spelling, while same-page null semantics remain unchanged. The retained behaviors remain covered by focused tests; no production PKM data/config or port 8974 was used.

## Revised title-syntax invariant

The approved 2026-08-02 requirements revision supersedes the nested-title closure portion of the prior final-review fix wave. The forced equal-cursor sync notification and fail-closed authoritative broadcasts remain required.

- [x] Restore opaque one-pass rename replacements and remove nested migration closure logic
- [x] Reject `#`, `[[`, and `]]` at every normal Python/server title boundary with atomic ref-derived and batch refusal
- [x] Report `all_space` and `forbidden_syntax` migration blockers through digest, API, and CLI
- [x] Sanitize imported title markup recursively before row creation, merge collisions deterministically, and report changes
- [x] Enforce equivalent TypeScript/offline validation using shared fixtures
- [x] Regenerate contracts and update README, PKM skill, architecture docs, and bean history
- [x] Run focused gates and disposable-port-18974 lifecycle verification without production access
- [ ] Pass fresh task reviews and final whole-title-lane review

## Task 1: restore opaque rename behavior and add Python title predicate

- [x] Add `shared/fixtures/title_syntax.json` with Python-facing forbidden-title cases
- [x] Add pure `pkm.refs.title_syntax_reason()` returning `"forbidden_syntax" | None`
- [x] Restore opaque one-pass `rewrite_title_refs_map()` replacement semantics and remove the recursive mapped-target regression test
- [x] Run focused refs/rename tests plus full server pytest, pyrefly, and ruff

## Task 1 Summary of Changes

Added the shared title-syntax fixture and pure Python predicate for later boundary consumers, and restored `rewrite_title_refs_map()` to the reviewed one-pass opaque replacement behavior so replacement values are never rescanned for further rewrites. Captured RED for the missing predicate import and the recursive replacement regression before the minimal GREEN changes.

## Revised Tasks 2-4 Summary of Changes

Rejected forbidden explicit and reference-derived titles before any server operation-batch mutation; restored boundary-space-only migration planning with digest-bearing `all_space`/`forbidden_syntax` blockers and generated API/CLI contracts; and added pure recursive import sanitization before row/filesystem work with deterministic collision merges, preserved page/orphan block trees and refs, truthful reporting, and typed refusal. The human-approved coupled review required one importer fix round for extractor-normalized targets and hash-removal marker formation; the scoped re-review found both addressed. Full server verification after the fix: 1368 passed, coverage 96.69%; pyrefly reported zero errors and ruff passed.

## Revised Task 5 Summary of Changes

Added shared-fixture TypeScript title-syntax parity and operation preflight; rejected complete local and durable queue batches before optimistic or pending-row mutation; adapted local page creation to 422 before negative-page/queue creation; and preserved authoritative snapshot/feed acceptance. Verification: 113 focused and 1861 full web unit tests passed; typecheck, lint, and FCIS checks passed. Task review approved with no findings.

## Revised Task 6 Verification Evidence

Reconciled README, PKM skill, backend architecture, sync/offline architecture, generated OpenAPI route/model text, CLI help, and bean history against the shipped strict title-syntax behavior. The recorded skill RED was followed by a fresh-agent GREEN retrieval/application scenario using only the updated skill. Consolidated gates passed: 465 focused server tests, pyrefly, ruff, 193 focused web tests, TypeScript typecheck, ESLint, and the 140-module FCIS check. A disposable CLI lifecycle at exactly http://127.0.0.1:18974 verified stable audit, `forbidden_syntax` blocker visibility and blocked apply, disposable-only blocker removal, stale digest refusal, fresh apply, activation/generation change, canonical create/read, and forbidden create/rename/ref-derived op refusal. The server process, temporary data/config, and lifecycle script were removed; port 8974 was not used. Equal-cursor behavior was not manually reproduced; `test_zero_group_title_activation_forces_an_equal_cursor_replica_pull` passed in the focused server gate.

## Summary of Changes

Replaced stale nested-closure history with the shipped strict title-syntax invariant, documented import-only recursive marker sanitization and reasoned migration blockers, and preserved the forced equal-cursor notification and fail-closed authoritative broadcast outcomes. The final whole-title-lane review remains pending, so this bean remains in progress.

Production title migration/inventory was NOT executed.
