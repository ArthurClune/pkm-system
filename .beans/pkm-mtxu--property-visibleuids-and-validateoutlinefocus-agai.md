---
# pkm-mtxu
title: 'Property: visibleUids and validateOutlineFocus against a model'
status: completed
type: task
priority: normal
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T15:55:13Z
parent: pkm-a1xk
---

Pure outline helpers whose outputs no property compares with a model. Past bugs: `visibleUids` skipped the cell rows of a collapsed Roam table (`pkm-j3uw`); undo restored focus to a block hidden under a collapsed ancestor, and a caret past the end of the restored text (`validateOutlineFocus`).

## Checklist

- [x] `outline/tree.ts` `visibleUids`: for generated trees (collapsed blocks, Roam tables, view modes, headings), it equals the block rows actually rendered, in order. Model it from the render rules in `docs/architecture/frontend-editor.md`, or render `EditableBlockTree` and read the row order.
- [x] `outline/outlineState.ts` `validateOutlineFocus`: for any tree, focus and text, the result names a block in `visibleUids` (or no focus) with the caret and selection inside the text.
- [x] Optional: `popoverPosition.ts` clamps any measured rect into any viewport it fits in, and pins to the start edge when it does not.
- [x] Coordinate with `pkm-b524` (outline gate's model ignores Roam tables) so the two models agree.
- [x] Mutants: skip collapsed children everywhere (the old table bug); drop the caret clamp.

## Ground rules (shared by this epic)

- Ordinary unit suites unless the bean says otherwise: Hypothesis in `server/tests/`, fast-check beside the code in `web/src/` (`*.props.test.ts`). The `pkm-e7z9` files (`test_local_index_props.py`, `localLinkArbs.ts`, `localLinksParity.test.ts`) are the pattern to copy.
- Time budget: Arthur has OK'd a bigger budget than the default 100 examples where it buys real coverage. Keep `pytest -q` / `pnpm verify` reasonable; a property that needs minutes goes into the `proptest/check.sh` gate with its own budget instead (see `docs/architecture/property-checks.md`).
- A property is not covered until it is shown to reach (Hypothesis `event()`, or fast-check tallies asserted in the test so it cannot go vacuous) and to fail under a mutant. Record the rates and mutants in the commit message.
- Fix what the properties find, with the shrunk example kept as an ordinary unit test; never xfail or carve it out. A cross-language fixture gets a row in `backend.md` § Generated artifacts and parity fixtures.

## Summary of Changes

- `web/src/props/outline/visibleTree.ts`: tree arbitraries (collapsed blocks, valid and forked Roam tables, headings, view modes, surrogate-pair texts) and an independent model of which rows render.
- `web/src/outline/visibleUids.props.test.tsx`: visibleUids, selectableUids and the rendered `EditableBlockTree` rows against the model, with tallies.
- `web/src/outline/validateOutlineFocus.props.test.ts`: result is null or a visible block, caret inside the text, hidden focus lands on the outermost hider.
- `web/src/popoverPosition.props.test.ts`: clamp inside margins or pin to start.
- No product bug found. Mutants (collapsed tables skipped; caret clamp dropped; popover clamp order swapped) each fail.
- pkm-b524 gains a note that the model can be adopted by the outline gate.
