---
# pkm-ncwq
title: Assistant turn property's reach floor misses under machine load
status: todo
type: bug
created_at: 2026-11-16T12:48:18Z
updated_at: 2026-11-16T12:48:18Z
---

proptest/check.sh server failed once in tests/props/test_assistant_turn_props.py::test_turn_phase with: 'send after: user stop before_ack: 14 of 1547 examples, under the floor 0.01'. It passed when rerun alone under HYPOTHESIS_PROFILE=merge on the same tree. The machine's 1-min load was about 5 during the failing run, with other suites running. The floors in that file are half the lowest share over 30 unseeded merge runs, and this label's share depends on timing (a user stop landing before the ack), so load moves it below the floor. Fix against the gate: re-derive this label's floor under load, or make the generator reach it by construction (a pytest parameter, as server/tests/hostile.py's merge_floors docstring suggests for chosen categories). Do not just lower it without that evidence.
