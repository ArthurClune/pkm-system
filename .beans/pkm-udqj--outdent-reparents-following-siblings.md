---
# pkm-udqj
title: Outdent reparents following siblings
status: completed
type: feature
priority: normal
created_at: 2026-08-09T15:01:02Z
updated_at: 2026-08-09T15:19:13Z
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
- [x] Task 3: keyboard.md docs, full verification, bean completion

## Summary of Changes

Outdent (`Tab`/`Shift+Tab`) now reparents the outdented block's former
following siblings as its own children instead of leaving them behind:

- `outdentBlock` (web/src/outline/edits.ts): after moving block `b` to sit
  after its former parent, `b`'s former following siblings are appended as
  `b`'s children (after any existing children, order preserved), via a new
  `adoptTrailingOps` helper. If `b` was collapsed, a `set_collapsed(b,false)`
  op is emitted first so the newly adopted children aren't hidden.
- `outdentSelection` (web/src/outline/edits.ts): for each contiguous
  selected-sibling run, the unselected siblings in the gap before the next
  selected run (or end of list) reparent under that run's last block, using
  the same `adoptTrailingOps` helper. A top-level run still aborts the whole
  gesture, matching prior behavior.
- Tests: `web/src/outline/edits.test.ts` covers both planners' adoption
  behavior (including the collapsed-parent uncollapse case and multi-run
  selection splits).
- Docs: `docs/keyboard.md` — both outdent rows (single-block and
  block-selection tables) now note that outdent takes trailing/following
  siblings along as children.

Verification: `cd web && CI=true pnpm verify` — typecheck clean, lint clean,
FCIS boundary check clean (151 modules, no violations), unit tests 2046/2046
passed across 127 files with enforced coverage thresholds met, and
Playwright e2e 52/52 passed (33.9s). No server files touched.
