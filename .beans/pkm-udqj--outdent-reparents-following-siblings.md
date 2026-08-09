---
# pkm-udqj
title: Outdent reparents following siblings
status: in-progress
type: feature
created_at: 2026-08-09T15:01:02Z
updated_at: 2026-08-09T15:01:02Z
---

Outdenting a block currently moves just that block to sit after its former parent, leaving following siblings behind — so the block visually jumps down past them, and there is no easy gesture to insert a block directly after a subtree.

New behavior (Logseq/Workflowy/org-mode standard): outdent takes the following siblings with it as children.

- outdentBlock: b moves after former parent P (as today); b's former following siblings become children of b, appended after b's existing children, order preserved. Page reads identically top-to-bottom; only depths change.
- If b is collapsed and gains reparented siblings, emit set_collapsed(b,false) first (mirrors indentBlock precedent) so they don't vanish.
- outdentSelection: per sibling run, unselected siblings between the end of that run and the next selected run (or end of list) reparent under the run's LAST block. Split selection [a,b*,c,d*,e] gives b child c and d child e. Top-level run still aborts the whole gesture.
- Indent stays asymmetric; move up/down unchanged; no server/API changes — purely the two Functional Core planners in web/src/outline/edits.ts plus tests.
- Known trade-off (accepted): outdent is no longer the exact inverse of indent; Ctrl-Z still undoes via op history.

## Checklist

- [x] Task 1: outdentBlock adopts trailing siblings (adoptTrailingOps helper)
- [x] Task 2: outdentSelection adopts each run's gap siblings
- [ ] Task 3: keyboard.md docs, full verification, bean completion
