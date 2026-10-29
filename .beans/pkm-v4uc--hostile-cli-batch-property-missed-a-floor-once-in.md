---
# pkm-v4uc
title: Hostile CLI batch property missed a floor once in a full run
status: completed
type: bug
priority: low
created_at: 2026-10-23T19:51:50Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

2026-10-23, security/batch-1 full pytest run: tests/test_no_500_request_props.py::test_a_hostile_cli_batch_is_applied_or_refused[False] failed once, then passed in 15 isolated runs and 3 full runs. The failure output was not kept. A failure inside the property would have been saved to .hypothesis and replayed first; none replayed, so the likely cause is a with_floors share check (hostile.py) on an unlucky unseeded draw, which nothing replays.

- [x] Make with_floors report the failing label/count in a way that survives (the assert message does; keep it in the gate log) -- with_floors the share assert now names the label, count, total and floor, so a gate log keeps a miss's numbers. `PKM_FLOOR_LOG` logs each floored label's count per run, for re-measuring
- [x] Re-measure the floors for this property over 30 unseeded runs (per with_floors' rule) and lower or drop the one that misses -- floors re-set in test_no_500_request_props.py (blank removed; 0.057, 0.053 and 0.11) and test_no_500_upstream_props.py (0.036, 0.02, 0.23, 0.09, 0.032) from the logged shares
- [x] Check it is not a real 5xx: run the property 200x with -p no:randomly and keep logs -- settled by the earlier 60-run reproduction in this bean: no 5xx, the failure was the blank floor's share check

## Reproduced (2026-10-23, batch-1 whole-branch review)

60 runs (120 cases) with hostile.TALLY recorded: one failure, AssertionError: ('batch input: blank', 4, 92), share 0.043 against the 0.058 floor. Share over 120 cases (min / p5 / median): blank 0.043 / 0.129 / 0.302; lone surrogate 0.130 / 0.172 / 0.341; applied 0.133 / 0.170 / 0.276; refused by the planner 0.247 / 0.352 / 0.494. No 5xx. pytest-randomly is not installed, so the -p no:randomly item is moot. Fix: lower the blank floor per with_floors' rule (half the lowest share over 30 unseeded runs).

## Summary of Changes

- `server/tests/hostile.py`: `with_floors` logs each floored label's count per run as a JSON line when `PKM_FLOOR_LOG` is set, and its share assert names the label, count, total and floor, so a gate log keeps a miss's numbers. The docstring describes unseeded runs as the gate makes them.
- `server/tests/test_no_500_request_props.py` (hostile CLI batch): the `batch input: blank` floor is dropped (lowest count 1 of 86 over 60 runs, under `with_floors`' five-event bar, so it stays an `event`; blank input keeps its floor on the route properties). `NUL` and `very long` carry no floor for the same reason. Floors: lone surrogate 0.057, applied 0.053, refused by the planner 0.11.
- `server/tests/test_no_500_upstream_props.py`: floors re-set from 60 unseeded runs at the pre-branch commit (see pkm-76sh).
- `docs/troubleshooting.md`: the Property checks section's symptom cell quotes the new assert form and keeps the old tuple.
- No run of the 60 produced a 5xx; the one failure was the blank floor's share check.

Rulings:
- The `batch input: blank` floor is dropped, not steered (plan "For Arthur" 3).
- Floors set to half the lowest share, rounded down, so the final-review wave replaced the first 0.05 / 0.05 with exact values.
- Task 1 minors parked (inline log block in `with_floors.run`, a dropped sentence), later folded into the final-review docstring fix.
- Parked residual: the troubleshooting example label `batch input: blank` is no longer floored (it is the historical failure the row is keyed on).
