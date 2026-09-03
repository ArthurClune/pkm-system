---
# pkm-r71a
title: Colour page refs by title namespace (AWS/, Claude/, Project/ ...)
status: completed
type: feature
priority: normal
created_at: 2026-09-03T12:23:33Z
updated_at: 2026-09-03T12:36:20Z
---

Inline [[refs]] are all orange (--color-link). Stamp PageLink with data-ns = lowercased prefix before the first '/', and colour four themed groups via CSS tokens: cloud (aws, azure, gcp) teal; ai (claude, llm) blue; work (project, uos) green; reading (paper, book, article) plum. Tags and attribute names unchanged. Adding a namespace later is one CSS line.

- [x] pure pageNamespace() helper + unit test
- [x] PageLink stamps data-ns (render test)
- [x] tokens (light + dark x2) and data-ns rules in styles.css + styles.test.ts
- [x] docs/architecture/styling.md lists the tokens
- [x] pnpm verify green

## Summary of Changes

- web/src/components/pageNamespace.ts: pure helper, lowercased prefix before the first '/' (undefined when absent or empty).
- PageLink stamps it as data-ns on prose links only; tags never get it.
- styles.css: four tokens (--color-link-cloud/-ai/-work/-reading) in :root and both dark blocks; selector-list rules per group; .attribute a.page-link[data-ns] keeps attribute names muted.
- Groups: cloud = aws, azure, gcp; ai = claude, llm; work = project, uos; reading = paper, book, article (rose #c4507a / #eda0c6 after Arthur found the first plum too purple). Adding a tree is one CSS selector.
- styling.md documents the tokens and the stylesheet-only extension rule.
