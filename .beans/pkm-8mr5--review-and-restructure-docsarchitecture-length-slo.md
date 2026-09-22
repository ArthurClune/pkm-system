---
# pkm-8mr5
title: 'Review and restructure docs/architecture: length, slop, separate incidents from architecture, drop ''load-bearing'''
status: in-progress
type: task
created_at: 2026-09-22T20:31:39Z
updated_at: 2026-09-22T20:31:39Z
---

Arthur: docs have got big and AI-slop, and mix architecture with 'specific things that have gone wrong'. Each doc should be a reasonable length and cover one area. Remove every use of 'load-bearing'. Present proposed changes before implementing.

- [x] Per-doc review by subagents against architecture-docs + technical-writing skills
- [x] Synthesise proposal (splits, cuts, moves) and present to Arthur (approved: 10 files, comment sweep, symptom tables -> docs/troubleshooting.md)
- [ ] Implement approved changes on a worktree branch
- [ ] Run check-docs.mjs on every edited doc; fix inbound anchors
- [x] Update skill text that uses 'load-bearing'; repoint architecture-docs + check-arch-docs skills and check-docs.mjs at docs/troubleshooting.md
- [x] First pass: split into 10 files, move all symptom rows to docs/troubleshooting.md, apply review dispositions
- [ ] Second pass: judgment cuts on the docs still over ~2500 words
- [ ] Whole-branch review on the strongest model
