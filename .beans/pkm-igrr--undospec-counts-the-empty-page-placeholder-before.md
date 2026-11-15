---
# pkm-igrr
title: undo.spec counts the empty-page placeholder before the outline renders
status: todo
type: bug
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-15T22:02:08Z
---

web/e2e/undo.spec.ts reads count() on "Click to start writing…" with no wait, so a slow first render takes the .block-text branch on an empty page and times out. Seen once in a full Playwright run on the tables branch (passed 5/5 alone); the spec is unchanged on that branch. Fix: wait for .block-row or the placeholder before counting.
