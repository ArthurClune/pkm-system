---
# pkm-e3tv
title: Fix query display
status: completed
type: bug
priority: normal
created_at: 2026-07-14T19:41:16Z
updated_at: 2026-07-14T19:58:19Z
---

Query blocks render incorrectly. See ~/Desktop/good.png and ~/Desktop/bad.png for a good and bad example - good from Roam, bad from our code


## Checklist

- [x] Compare good/bad screenshots
- [x] Locate query rendering path
- [x] Reproduce with a failing test or fixture
- [x] Identify root cause
- [x] Implement focused fix
- [x] Run verification
- [x] Summarize changes

## Summary of Changes

- Added a regression test proving /api/query excludes Roam query source blocks from its results.
- Updated /api/query total and row selection to filter blocks beginning with {{[[query]]: or {{query:.
- Verified with server pytest coverage, pyrefly, and ruff.
