---
# pkm-2ilw
title: Canonicalize existing space-padded page titles (data migration)
status: in-progress
type: task
priority: normal
created_at: 2026-07-31T16:43:21Z
updated_at: 2026-08-02T19:03:18Z
parent: pkm-ulae
---

Follow-up from pkm-1rb5 review. Production data contains pages whose stored titles carry leading/trailing plain spaces (e.g. " EvilCorp" id=2 with 11 blocks/3 inbound refs; "Paper/AI-Assisted Scientific Assessment: A Case Study on Climate Change " id=2924). Since padded and stripped spellings resolve to different pages (exact-match lookup, deliberately preserved by pkm-1rb5 round 2), users can silently split content between "X" and " X".

Design a one-time data migration that trims existing padded page titles, merging into an existing clean-named twin where one exists (reuse the pkm-g0t5 rename/merge machinery), rewriting inbound [[refs]] accordingly. After migration, consider stripping plain spaces at the shared creation boundary so new padded titles cannot be created (blocked on the migration; see pkm-1rb5's recorded decision).

- [ ] Inventory padded titles in prod DB
- [ ] Migration with merge handling + ref rewrite
- [ ] Then (and only then) canonicalize new titles at the creation boundary

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
