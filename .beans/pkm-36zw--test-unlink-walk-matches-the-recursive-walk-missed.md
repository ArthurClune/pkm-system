---
# pkm-36zw
title: test_unlink_walk_matches_the_recursive_walk missed its 'alias dropped a span' floor once
status: completed
type: bug
priority: low
created_at: 2026-10-24T21:48:15Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

Seen 2026-10-24 in a full server pytest run on security/ak4e (after merging main): the random-draw floor 'alias dropped a span' was reached 7 of 500 draws, below its floor. Passed alone twice and in the full rerun; the branch does not touch the unlink walk. Same family as pkm-v4uc (lower the floor per with_floors' rule, or make the generator reach the case deterministically).

- [x] Reproduce the floor's draw rate distribution (many seeds) and pick a floor per with_floors' rule, or steer the generator -- 60 unseeded runs of the unlink walk, no run failed; the alias case is steered (a one-in-four `[x #key]([[key]])` prefix over tag keys): its lowest share went from 0.024 to 0.200; floors set at half the lowest share (0.107, 0.201, 0.038, 0.199, 0.1, 0.118)
- [x] troubleshooting.md row if the rule changes -- docs/troubleshooting.md gains a Property checks section covering the rule

## Summary of Changes

- `server/tests/test_bracket_walk_equivalence.py`: `_unlink_cases` gains `_TAG_KEYS` and a one-in-four alias prefix `[x #key]([[key]])` over tag keys, so the alias case is drawn deliberately. The lowest share of `alias dropped a span` went from 0.024 (7 of 500 draws) to 0.200.
- Floors re-set from 60 unseeded runs (none failed), at half the lowest share: run holding runs 0.107 (lowest 0.214), nested run 0.201 (0.402), tag in an opened run 0.038 (0.076), aliased run 0.199 (0.398), alias dropped a span 0.1 (0.200), nested 20 or deeper 0.118 (0.236).
- `docs/troubleshooting.md`: a Property checks section states the rule (floor = half the lowest share over at least 30 unseeded runs).

Rulings:
- The first 30-run floors were promoted into a fix round and re-set from 60 runs (the tag floor went 0.044 to 0.038), because 30-run floors defeat the batch's purpose; the troubleshooting row now says "every floor set for this".
- Minor deferred: none left open.
