---
# pkm-x1ig
title: 'Importer polish: DAG refusal, report accuracy, composition tests'
status: in-progress
type: task
priority: low
created_at: 2026-07-31T19:02:40Z
updated_at: 2026-08-03T13:44:53Z
parent: pkm-ulae
---

Follow-up bundle from the pkm-ulae import-branch final review (pkm-j58o + pkm-euhp, all deferred minors — everything fails safe today):

- [x] Multi-parent (DAG) and duplicate-UID exports: deterministic structural refusal before sanitization, linked files, or output work
- [x] rows.py implicit_page_count: count after the orphan walk and subtract the recovery page, including orphan-created implicit pages in the breakdown
- [x] Nested Mermaid-in-Mermaid: shared fixed-point planner protects every candidate ancestor and deduplicates descendant-keyed report rows in fresh imports and SQLite migration
- [x] Test additions: exact report/publication/early-failure temp boundaries plus orphan recovery + externally protected Mermaid composition
- [x] _print_preserved: skip all output when nothing was preserved
- [x] backend.md: document strict parse/preflight ordering, global Mermaid protection, post-orphan counts, and exact stage-specific temp cleanup

## Summary of Changes

Added deterministic duplicate-UID and multi-parent refusal before title sanitization or filesystem work; shared fixed-point Mermaid preservation across fresh imports and SQLite migration with descendant-keyed deduplicated reports; corrected orphan-derived implicit page counts; pinned report/publication versus early self-healing temp boundaries; documented the exact importer pipeline while preserving title sanitization, temporary-database title audit/apply activation, and database-then-report publication order.

## Independent Final Review Follow-ups

- [x] Move shared title audit/apply activation after successful asset copying with an ordering regression test
- [x] Characterize second report-publication replacement failure and named-temp cleanup
- [x] Use six-plus-character UIDs in the raw multi-parent e2e fixture
- [ ] Re-review the complete lane and record a clean verdict
