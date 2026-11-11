---
# pkm-rlxc
title: parity_corpus loops forever when asked for more distinct texts than its draw can produce
status: todo
type: bug
created_at: 2026-11-11T04:05:06Z
updated_at: 2026-11-11T04:05:06Z
parent: pkm-4gda
---

pkm/parity_corpus.py's parity_corpus keeps drawing until it has count distinct texts. If the draw function cannot produce that many, it never returns (the three loops it replaced behaved the same). Today's seeds and counts are far from the limit. Bound the attempts and raise with the seed and counts.
