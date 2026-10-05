---
# pkm-f7zv
title: 'Property checks: outline edit commands'
status: completed
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-05T09:17:11Z
parent: pkm-nws9
---

fast-check over web/src/outline/edits.ts, paste.ts, history.ts invertOps: random trees + commands yield valid trees and ops whose application matches the edited tree. Needs its own brainstorm/spec.

Spec: docs/superpowers/specs/2026-10-05-property-checks-outline-edits-design.md
Plan: docs/superpowers/plans/2026-10-05-property-checks-outline-edits.md

- [x] Task 1: shared props env and --file
- [x] Task 2: reading rows and tree validity
- [x] Task 3: arbitraries
- [x] Task 4: sequence runner
- [x] Task 5: model, text/structure/field commands
- [x] Task 6: model, moves/drop/paste
- [x] Task 7: checks
- [x] Task 8: property and budget (findings triaged with Arthur)
- [x] Task 9: teeth
- [x] Task 10: docs
- [x] Gates, final review, merge

## Summary of Changes

- `web/src/props/outline/`: a pure fast-check suite (arbitraries, reading rows, an independent reading-view model, a runner that records history as useOutline/undoManager do, checks, `outline.prop.ts` at NUM_RUNS 319_000 ≈ 45 s in the gate, `teeth.prop.ts` with five mutants each caught by its own property). `web/src/props/env.ts` shared; `proptest/check.sh --file` runs one web suite.
- Findings fixed in product code (each with unit tests and a troubleshooting row):
  - F1 undo/redo replayed recorded order_idx that drift (placement ops only shift keys up): invertOps plans against the tree the undo reaches, and history entries carry anchors re-keyed against the live tree at replay (history.ts, undoManager.ts, useOutline.ts).
  - F2 same-value heading/view type/collapse setters emitted ops (null view type ≡ "document").
  - F3 undo focused a block hidden under a collapsed ancestor: restored focus goes to the nearest visible ancestor via shared `tree.ts hidesChildren` (a collapsed Roam table does not hide its cells).
  - F4 restored caret could exceed the text: clamped.
  - I1 a selection move crossing into a collapsed selected root left the moved run hidden: that root is now expanded.
- Docs: property-checks.md, frontend-editor.md rules, frontend.md, troubleshooting.md, AGENTS.md, spec.
- Follow-ups filed: pkm-jarz (sync property: replica loses a grandchild after a local delete cascade; pre-existing on main), pkm-8ax9 (undo of a released page replays recorded keys), pkm-j3uw (visibleUids/readingRows treat a collapsed Roam table's cells as hidden), pkm-iaa0 (replica tests print SQLite errors to stderr).
- Gates at the final head: server pytest/pyrefly/ruff green; `pnpm verify` green; `perf/check.sh frontend` no change; `proptest/check.sh web`: outline and both teeth suites pass, sync suite red on pkm-jarz (pre-existing, merged by Arthur's ruling).
