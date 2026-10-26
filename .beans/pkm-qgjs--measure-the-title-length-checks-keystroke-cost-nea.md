---
# pkm-qgjs
title: Measure the title-length check's keystroke cost near the 1M text cap
status: todo
type: task
priority: low
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-10-26T16:13:08Z
parent: pkm-mfd0
---

From the security/batch-server final review (T12 Minor 3). The web admit check for linked-title length adds ~17–50 ms per keystroke near the 1M-character block cap; the frontend perf gate does not type near the cap, so it is unmeasured.

- [ ] Perf scenario or one-off measurement typing in a near-cap block
- [ ] Fix if it is felt on the iPad
