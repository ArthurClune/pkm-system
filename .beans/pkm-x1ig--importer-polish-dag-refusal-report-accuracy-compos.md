---
# pkm-x1ig
title: 'Importer polish: DAG refusal, report accuracy, composition tests'
status: in-progress
type: task
priority: low
created_at: 2026-07-31T19:02:40Z
updated_at: 2026-08-03T13:22:20Z
parent: pkm-ulae
---

Follow-up bundle from the pkm-ulae import-branch final review (pkm-j58o + pkm-euhp, all deferred minors — everything fails safe today):

- [x] Multi-parent (DAG) and duplicate-UID exports: deterministic structural refusal before sanitization, linked files, or output work
- [x] rows.py implicit_page_count: count after the orphan walk and subtract the recovery page, including orphan-created implicit pages in the breakdown
- [ ] Nested mermaid-in-mermaid: migration report can claim "preserved" for a uid the outer component's flatten then cascade-deletes (integrity holds; drop candidates whose subtree contains a preserved component); rows.py double-reports the pair in the same shape
- [ ] Test additions: e2e assert import-report.txt.tmp absent after failure; one to_rows test composing orphan recovery + mermaid (orphan mermaid component with externally-referenced child)
- [ ] _print_preserved: skip the header when nothing was preserved (dangling "0 preserved:" stdout)
- [ ] backend.md: tighten "both .tmp files are removed" (pre-try failures leave self-healing tmp files)
