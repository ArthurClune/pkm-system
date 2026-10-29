---
# pkm-76sh
title: test_no_500_upstream_props missed its reach floor once in a full run
status: completed
type: bug
priority: low
created_at: 2026-10-26T17:44:43Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

During the security/batch-server final fix wave, a full server pytest run failed test_no_500_upstream_props on its reach floor; the same file passed 3/3 alone, and nothing it covers changed (it also failed once in Task 13 fix round 1). Lower the floor per with_floors' rule or steer the generator, as for pkm-36zw and pkm-v4uc.

- [x] Reproduce at the pre-branch commit with the failing seed if logged -- no failing seed was logged, and 60 runs at d1da2a39 did not reproduce the miss; the share assert names the label, count, total and floor, so a gate log keeps a miss's numbers. `PKM_FLOOR_LOG` logs each floored label's count per run, for re-measuring
- [x] Lower the floor or steer the generator -- floors for test_no_500_upstream_props re-set to 0.036, 0.02, 0.23, 0.09, 0.032 (half the lowest measured share)

## Summary of Changes

- Pre-branch behaviour: 60 unseeded runs at d1da2a39 did not reproduce the miss; no failing seed had been logged.
- `server/tests/hostile.py`: the share assert names label, count, total and floor; `PKM_FLOOR_LOG` logs each floored label's count per run (see pkm-v4uc).
- `server/tests/test_no_500_upstream_props.py`: floors re-set at half the lowest share over 60 runs, rounded down: `GET check -> 503` 0.036, `POST resolve -> 200` 0.02, `describe: DescribeError` 0.232, `describe: description` 0.09, `upstream: 4xx` 0.032.

Rulings:
- Floors set to exact half-lowest values in the final-review wave (0.232 replaced a rounded 0.23).
