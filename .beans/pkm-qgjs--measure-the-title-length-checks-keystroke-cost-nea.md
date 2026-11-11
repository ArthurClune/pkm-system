---
# pkm-qgjs
title: Measure the title-length check's keystroke cost near the 1M text cap
status: scrapped
type: task
priority: deferred
created_at: 2026-10-26T16:13:08Z
updated_at: 2026-11-11T13:34:37Z
---

From the security/batch-server final review (T12 Minor 3). The web admit check for linked-title length adds ~17–50 ms per keystroke near the 1M-character block cap; the frontend perf gate does not type near the cap, so it is unmeasured.

- [ ] Perf scenario or one-off measurement typing in a near-cap block
- [ ] Fix if it is felt on the iPad


## Deferred (2026-10-27)

Arthur's ruling: prod's largest block is 258k characters, a quarter of the cap where the cost was measured. Reopen if typing in a large block feels slow on the iPad. Removed from the security epic.


## Reasons for Scrapping

Prod's largest block is 258k characters, a quarter of the cap where the cost was measured. If typing in a large block ever feels slow on the iPad, that is a new bug, filed from the symptom. (Arthur, 2026-11-11.)
