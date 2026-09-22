---
# pkm-8mr5
title: 'Review and restructure docs/architecture: length, slop, separate incidents from architecture, drop ''load-bearing'''
status: completed
type: task
priority: normal
created_at: 2026-09-22T20:31:39Z
updated_at: 2026-09-22T21:31:33Z
---

Arthur: docs have got big and AI-slop, and mix architecture with 'specific things that have gone wrong'. Each doc should be a reasonable length and cover one area. Remove every use of 'load-bearing'. Present proposed changes before implementing.

- [x] Per-doc review by subagents against architecture-docs + technical-writing skills
- [x] Synthesise proposal (splits, cuts, moves) and present to Arthur (approved: 10 files, comment sweep, symptom tables -> docs/troubleshooting.md)
- [ ] Implement approved changes on a worktree branch
- [ ] Run check-docs.mjs on every edited doc; fix inbound anchors
- [x] Update skill text that uses 'load-bearing'; repoint architecture-docs + check-arch-docs skills and check-docs.mjs at docs/troubleshooting.md
- [x] First pass: split into 10 files, move all symptom rows to docs/troubleshooting.md, apply review dispositions
- [x] Second pass: judgment cuts on the seven docs still over ~1300 words
- [x] Whole-branch check: check-docs.mjs clean over all 12 files; banned-phrase grep clean; standing sync invariants spot-verified

## Summary of Changes

- docs/architecture/ is now ten one-area files (was seven): backend loses the batch jobs to import-export-and-backup.md; frontend splits into frontend.md, frontend-editor.md, frontend-rendering.md; assistant-and-files.md becomes assistant.md and files-and-assets.md.
- Every symptom table moved out of the architecture docs into docs/troubleshooting.md (57 rows, grouped by area, with a Where column linking the owning section). Architecture prose keeps only present-tense invariants.
- Words: 33,625 -> 23,453 across docs/architecture/, plus 3,100 in troubleshooting.md. Two passes: review dispositions, then judgment cuts. Implementers stopped where further cuts would delete identifiers or invariants rather than restatement.
- "load-bearing" removed from the docs, docs/design.md, the architecture-docs skill and eight source comments. Fifteen stale claims corrected against the code (see the first commit message); docs/SECURITY.md's "no login throttling" claim corrected to describe LoginThrottle.
- Skills and checker repointed at docs/troubleshooting.md as the one home for bean ids; AGENTS.md enumerates the new files and the new "fix installs an invariant -> troubleshooting row" trigger.
- Skipped: the writing-skills pressure-test step for the skill edits, which were pointer corrections to a file layout that no longer existed.
