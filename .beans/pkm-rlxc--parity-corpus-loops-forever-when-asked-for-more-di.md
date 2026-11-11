---
# pkm-rlxc
title: parity_corpus loops forever when asked for more distinct texts than its draw can produce
status: scrapped
type: bug
priority: normal
created_at: 2026-11-11T04:05:06Z
updated_at: 2026-11-11T13:24:11Z
parent: pkm-4gda
---

pkm/parity_corpus.py's parity_corpus keeps drawing until it has count distinct texts. If the draw function cannot produce that many, it never returns (the three loops it replaced behaved the same). Today's seeds and counts are far from the limit. Bound the attempts and raise with the seed and counts.


## Reasons for Scrapping

Today's seeds and counts are far from the limit, and the failure would be an obviously hanging test, not a wrong result. Not worth a branch on its own. (Arthur, 2026-11-11.)
