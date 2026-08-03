---
# pkm-x1ig
title: 'Importer polish: DAG refusal, report accuracy, composition tests'
status: in-progress
type: task
priority: low
created_at: 2026-07-31T19:02:40Z
updated_at: 2026-08-03T13:25:19Z
parent: pkm-ulae
---

Follow-up bundle from the pkm-ulae import-branch final review (pkm-j58o + pkm-euhp, all deferred minors — everything fails safe today):

- [x] Multi-parent (DAG) and duplicate-UID exports: deterministic structural refusal before sanitization, linked files, or output work
- [x] rows.py implicit_page_count: count after the orphan walk and subtract the recovery page, including orphan-created implicit pages in the breakdown
- [x] Nested Mermaid-in-Mermaid: shared fixed-point planner protects every candidate ancestor and deduplicates descendant-keyed report rows in fresh imports and SQLite migration
- [ ] Test additions: e2e assert import-report.txt.tmp absent after failure; one to_rows test composing orphan recovery + mermaid (orphan mermaid component with externally-referenced child)
- [x] _print_preserved: skip all output when nothing was preserved
- [ ] backend.md: tighten "both .tmp files are removed" (pre-try failures leave self-healing tmp files)
