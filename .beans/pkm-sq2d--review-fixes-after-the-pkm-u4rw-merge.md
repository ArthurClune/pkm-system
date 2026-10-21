---
# pkm-sq2d
title: Review fixes after the pkm-u4rw merge
status: completed
type: bug
priority: normal
created_at: 2026-10-21T21:13:16Z
updated_at: 2026-10-21T21:29:32Z
parent: pkm-a1xk
---

- [x] SPA fallback uses wholepath, test cold /page/Fo%0Ao
- [x] MainRoutes renders page view under PAGE_ROUTE_PREFIX; U+2028/9 tests
- [x] Reach floors in test_title_routes_props
- [x] Stale title:path comments and docs
- [x] troubleshooting dot row: %2E
- [x] page_keys folds blank spellings to Untitled

## Summary of Changes

- SPA fallback now uses the `wholepath` convertor; a cold `/page/Fo%0Ao` serves index.html.
- `MainRoutes` renders PageView for any pathname under `/page/`, so U+2028/U+2029 titles open; the control-whitespace fold redirect is unchanged. The web title property draws both characters in its gaps.
- `test_title_routes_props.py` tallies its labels and asserts floors (half the lowest rate over 60 seeds); the CLI property forces a flag-only batch fold in a fixed share of flag-on examples.
- Stale `{title:path}` comments fixed; troubleshooting row says to spell `%2E`.
- `page_keys` maps blank spellings to the Untitled key (`UNTITLED_PAGE_TITLE` moved to `contracts/titles.py`).
