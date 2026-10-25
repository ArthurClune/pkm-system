---
# pkm-258s
title: Backlink trails render each item's full ancestor text
status: draft
type: feature
priority: low
created_at: 2026-10-25T12:58:44Z
updated_at: 2026-10-25T12:58:44Z
parent: pkm-mfd0
---

From the pkm-0on4 review (2026-10-25). The server/replica response no longer amplifies breadcrumb text, but the browser still renders each backlink item's full trail, so the pathological 100-deep chain of 20,000-character blocks shows ~99 million characters on screen (Chromium rendered it in 375 ms headless). Bounding it needs a visible clip of crumb text, which is a product question (Arthur's rule: no silent truncation — a visible ellipsis with the full text reachable by navigation may be fine).

- [ ] Arthur: clip breadcrumb display text visibly (e.g. first N characters + …), or leave as is
- [ ] If clipped: CSS/JS clip with the full text reachable (title attribute or navigation)
