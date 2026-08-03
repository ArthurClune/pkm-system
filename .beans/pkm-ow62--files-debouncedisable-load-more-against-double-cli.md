---
# pkm-ow62
title: 'Files: debounce/disable Load more against double-click duplicates'
status: completed
type: bug
priority: low
created_at: 2026-08-01T18:05:52Z
updated_at: 2026-08-02T17:30:09Z
parent: pkm-6phf
---

Found during pkm-3622 review (pre-existing, out of that bean's scope): the Load more button (web/src/views/Files.tsx:340-343) has no disabled/busy guard, so two rapid clicks before the first fetchPage resolves both capture the same generation and offset — both responses pass isStale and duplicate items get appended.

- [x] Guard Load more against concurrent invocations (busy flag like Select all)
- [x] Add a double-click regression test

## Summary of Changes

Load more now uses a synchronous ref lock plus disabled UI state, releases the lock in finally, and retains the existing generation/error policy. A same-render double-click regression proves only one page request and one append occur. Documented the single-flight invariant.
