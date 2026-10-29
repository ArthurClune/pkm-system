---
# pkm-36zw
title: test_unlink_walk_matches_the_recursive_walk missed its 'alias dropped a span' floor once
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T21:48:15Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

Seen 2026-10-24 in a full server pytest run on security/ak4e (after merging main): the random-draw floor 'alias dropped a span' was reached 7 of 500 draws, below its floor. Passed alone twice and in the full rerun; the branch does not touch the unlink walk. Same family as pkm-v4uc (lower the floor per with_floors' rule, or make the generator reach the case deterministically).

- [x] Reproduce the floor's draw rate distribution (many seeds) and pick a floor per with_floors' rule, or steer the generator -- 60 unseeded runs of the unlink walk, no run failed; the generator is also steered (tag-key and one-in-four alias prefix) so every floor sits well above 0.03; floors set at half the lowest share (0.107, 0.201, 0.038, 0.199, 0.1, 0.118)
- [x] troubleshooting.md row if the rule changes -- docs/troubleshooting.md gains a Property checks section covering the rule
