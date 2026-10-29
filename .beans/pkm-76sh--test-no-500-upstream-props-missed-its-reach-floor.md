---
# pkm-76sh
title: test_no_500_upstream_props missed its reach floor once in a full run
status: in-progress
type: bug
priority: low
created_at: 2026-10-26T17:44:43Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

During the security/batch-server final fix wave, a full server pytest run failed test_no_500_upstream_props on its reach floor; the same file passed 3/3 alone, and nothing it covers changed (it also failed once in Task 13 fix round 1). Lower the floor per with_floors' rule or steer the generator, as for pkm-36zw and pkm-v4uc.

- [x] Reproduce at the pre-branch commit with the failing seed if logged -- no failing seed was logged; PKM_FLOOR_LOG now records every label's share per run, so a future miss leaves its numbers
- [x] Lower the floor or steer the generator -- floors for test_no_500_upstream_props re-set to 0.036, 0.02, 0.23, 0.09, 0.032 (half the lowest measured share)
