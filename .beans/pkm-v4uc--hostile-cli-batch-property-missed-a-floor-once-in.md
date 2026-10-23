---
# pkm-v4uc
title: Hostile CLI batch property missed a floor once in a full run
status: todo
type: bug
priority: low
created_at: 2026-10-23T19:51:50Z
updated_at: 2026-10-23T19:51:50Z
---

2026-10-23, security/batch-1 full pytest run: tests/test_no_500_request_props.py::test_a_hostile_cli_batch_is_applied_or_refused[False] failed once, then passed in 15 isolated runs and 3 full runs. The failure output was not kept. A failure inside the property would have been saved to .hypothesis and replayed first; none replayed, so the likely cause is a with_floors share check (hostile.py) on an unlucky unseeded draw, which nothing replays.

- [ ] Make with_floors report the failing label/count in a way that survives (the assert message does; keep it in the gate log)
- [ ] Re-measure the floors for this property over 30 unseeded runs (per with_floors' rule) and lower or drop the one that misses
- [ ] Check it is not a real 5xx: run the property 200x with -p no:randomly and keep logs
