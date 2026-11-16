---
# pkm-igrr
title: undo.spec counts the empty-page placeholder before the outline renders
status: completed
type: bug
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-16T14:18:29Z
---

web/e2e/undo.spec.ts reads count() on "Click to start writing…" with no wait, so a slow first render takes the .block-text branch on an empty page and times out. Seen once in a full Playwright run on the tables branch (passed 5/5 alone); the spec is unchanged on that branch. Fix: wait for .block-row or the placeholder before counting.

## Summary of Changes

Symptom: undo.spec failed with "Test timeout of 30000ms exceeded" at `locator.click` waiting for `main .block-text` (first), once in a full run, passing alone.

Cause: `count()` on the "Click to start writing…" placeholder (and the baseline `.block-row` count) ran before the outline rendered, so an empty page took the `.block-text` branch.

Fix: the spec waits for `.block-row` or the placeholder to be visible before counting. Reproduced by delaying the page API responses by 1.5s: the old spec fails with the error above, the fixed one passes.
