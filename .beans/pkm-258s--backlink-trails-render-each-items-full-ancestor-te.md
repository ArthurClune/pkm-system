---
# pkm-258s
title: Backlink trails render each item's full ancestor text
status: scrapped
type: feature
priority: low
created_at: 2026-10-25T12:58:44Z
updated_at: 2026-10-25T17:22:55Z
parent: pkm-mfd0
---

From the pkm-0on4 review (2026-10-25). The server/replica response no longer amplifies breadcrumb text, but the browser still renders each backlink item's full trail, so the pathological 100-deep chain of 20,000-character blocks shows ~99 million characters on screen (Chromium rendered it in 375 ms headless). Bounding it needs a visible clip of crumb text, which is a product question (Arthur's rule: no silent truncation — a visible ellipsis with the full text reachable by navigation may be fine).

- [x] Arthur: clip breadcrumb display text visibly (e.g. first N characters + …), or leave as is — Arthur 2026-10-25: no
- [ ] If clipped: CSS/JS clip with the full text reachable (title attribute or navigation)

## Reasons for Scrapping

Arthur, 2026-10-25: don't clip. If very long breadcrumb text occurs in practice, look again.
