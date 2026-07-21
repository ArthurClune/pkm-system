---
# pkm-dwlt
title: Render bare hashtags as tags
status: completed
type: bug
priority: normal
created_at: 2026-07-21T14:53:52Z
updated_at: 2026-07-21T15:06:27Z
---

Bare hashtags such as #Mathematics render with normal page-reference orange styling, while #[[Mathematics]] correctly renders as a tag.

- [x] Reproduce and identify the rendering root cause
- [x] Add a failing regression test
- [x] Implement the minimal fix
- [x] Run focused and full verification
- [x] Commit and push the branch

## Summary of Changes

- Kept tag text on `--color-tag` during hover instead of switching to the orange page-link colour.
- Updated the CSS regression test to enforce stable tag colouring on hover.
- Verified with `pnpm verify` (1,271 unit tests and 17 Playwright tests) plus a live browser comparison of `#Mathematics` and `#[[Mathematics]]`.
