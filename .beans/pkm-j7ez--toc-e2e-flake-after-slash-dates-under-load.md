---
# pkm-j7ez
title: toc e2e flake after slash-dates under load
status: completed
type: bug
priority: normal
created_at: 2026-09-24T09:42:30Z
updated_at: 2026-09-26T17:25:50Z
---

web/e2e/toc.spec.ts fails when it runs right after slash-dates.spec.ts under load: the /h1 block's "Intro" text and heading never reach the block tree, so the toc renders "no headings". Passes alone.

Reproduced 2 of 5 on an exported copy of main before GoodLinks, 6 of 9 on the GoodLinks feature tree. Looks like a race in the /toc feature (pkm-mzks) or its spec. Found 2026-09-23.

## Summary of Changes

**Root cause: a product race, not a spec race, and not specific to /toc or to
running after slash-dates.** It reproduced with toc.spec.ts alone (2 of 3) and
in the pair (3 of 4) at ambient machine load. Logging `/api/ops` showed no
text edit was dropped. The client sent `update_text "Intro"` and then
`create <new> order_idx 0`: the Enter split ran with the caret at **0**, so
the new empty block went above and focus stayed on the "Intro" heading block.
`/toc` then overwrote "Intro" with `{{toc}}`, so the page held an empty block
and a heading-1 block whose text was the macro ("no headings").

The caret got to 0 because `useBlockDraft.replace` restored the selection in a
`requestAnimationFrame` using the offsets captured at replace time. `/h1` does
`replace("", 0, 0)`. Playwright's `fill("Intro")` landed 4 ms later, before the
next frame, and then the stale frame moved the caret back to 0. A real user
typing quickly on a loaded main thread hits the same race after any slash
pick, auto-paired bracket, Cmd-B/Cmd-K toggle or /date insertion: their
characters land in the wrong place. The phone `Composer` had the same rAF
restore after a completion pick.

Fix:
- `web/src/outline/useBlockDraft.ts`: `replace` stores the selection in
  `pendingSelectionRef`, which the existing post-commit `useLayoutEffect`
  applies (shared with remote-text adoption). A selection-only edit (skipping
  an auto-inserted closer, text unchanged) sets the selection immediately,
  since no re-render follows. There is no rAF left.
- `web/src/components/Composer.tsx`: the same layout-effect restore for picks.
- Unit regressions (frames held back entirely): BlockInput "typing right after
  a /h1 pick keeps the caret" (red: caret [0,0], Enter split at 0), auto-pair
  caret inside the pair, skip-over caret move; Composer mid-text completion.
- Removed the `afterPaint` rAF waits from edit/ref-open/offline specs. They
  worked around this race and their comments described the old behaviour.
- Docs: frontend-editor.md § Autocomplete states the layout-effect invariant
  (which replaced a false "rAF, don't call resolve from keyup" sentence);
  one Editor row in troubleshooting.md.

Repro ratios (toc.spec failing, runs):
- Before, pre-fix build: pair at ambient load 3/4, toc alone 2/3, pair + 4 `yes`
  1/8. With an amplifier that holds rAF callbacks until the next `input` event,
  4/5.
- After: pair at ambient 0/10, pair + 4 `yes` 0/10, amplified 0/10 + 0/5 under
  load, toc alone 0/5. edit+ref-open+offline specs without afterPaint, + 4
  `yes`: 4/4 runs green (48 tests).
