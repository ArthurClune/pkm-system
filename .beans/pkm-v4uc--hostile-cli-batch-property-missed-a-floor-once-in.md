---
# pkm-v4uc
title: Hostile CLI batch property missed a floor once in a full run
status: in-progress
type: bug
priority: low
created_at: 2026-10-23T19:51:50Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

2026-10-23, security/batch-1 full pytest run: tests/test_no_500_request_props.py::test_a_hostile_cli_batch_is_applied_or_refused[False] failed once, then passed in 15 isolated runs and 3 full runs. The failure output was not kept. A failure inside the property would have been saved to .hypothesis and replayed first; none replayed, so the likely cause is a with_floors share check (hostile.py) on an unlucky unseeded draw, which nothing replays.

- [x] Make with_floors report the failing label/count in a way that survives (the assert message does; keep it in the gate log) -- with_floors now logs every label's share as a JSON line when PKM_FLOOR_LOG is set, and its share message names the label, count and total
- [x] Re-measure the floors for this property over 30 unseeded runs (per with_floors' rule) and lower or drop the one that misses -- floors re-set in test_no_500_request_props.py (blank removed; 0.05 and 0.05) and test_no_500_upstream_props.py (0.036, 0.02, 0.23, 0.09, 0.032) from the logged shares
- [x] Check it is not a real 5xx: run the property 200x with -p no:randomly and keep logs -- settled by the earlier 60-run reproduction in this bean: no 5xx, the failure was the blank floor's share check

## Reproduced (2026-10-23, batch-1 whole-branch review)

60 runs (120 cases) with hostile.TALLY recorded: one failure, AssertionError: ('batch input: blank', 4, 92), share 0.043 against the 0.058 floor. Share over 120 cases (min / p5 / median): blank 0.043 / 0.129 / 0.302; lone surrogate 0.130 / 0.172 / 0.341; applied 0.133 / 0.170 / 0.276; refused by the planner 0.247 / 0.352 / 0.494. No 5xx. pytest-randomly is not installed, so the -p no:randomly item is moot. Fix: lower the blank floor per with_floors' rule (half the lowest share over 30 unseeded runs).
