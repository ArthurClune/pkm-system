---
# pkm-8myl
title: Following a ref or search into a collapsed subtree lands at page top
status: in-progress
type: bug
created_at: 2026-10-12T19:12:49Z
updated_at: 2026-10-12T19:12:49Z
---

A #uid navigation (block ref click, search block hit, toc entry, sidebar shift-click) to a block under a collapsed ancestor scrolls nowhere: the row isn't rendered, so useScrollFlashTarget's lookup finds no element and returns (by design, per its comment). Repro: AI Agents page, 'especially ((eaPXmj2QKGsEK7DP))' -> AI in Research, whose parent 'Proof of the Crouzeix Conjecture…' (0928kYg4NbGHuPbp) is collapsed.

Wanted (Arthur): navigating to a block inside a collapsed subtree expands it. Expansion is persisted with set_collapsed(false) on each hiding ancestor, the same way indent/move already expand a collapsed row before placing a block under it.

- [x] Failing tests: core reveal edit; main pane and sidebar land on the target under a collapsed ancestor
- [x] Core: reveal edit expands every hiding ancestor (hidesChildren) in one batch; no-op when none
- [x] Shell: main pane and sidebar panel reveal then scroll+flash once the rows render
- [x] e2e spec
- [x] Docs: frontend-editor.md (toc/#uid paragraph, edit-rules table), hook and PageView comments
- [ ] pnpm verify; proptest web outline; perf frontend (verify and proptest pass; perf left to the merge check)
