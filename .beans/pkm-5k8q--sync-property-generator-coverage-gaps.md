---
# pkm-5k8q
title: Sync property generator coverage gaps
status: completed
type: task
priority: normal
created_at: 2026-10-03T17:03:13Z
updated_at: 2026-10-04T15:44:26Z
parent: pkm-nws9
---

From the pkm-yxcs Task 7 and final reviews (harness quality, not product bugs). (1) Online is drawn far less than Offline (skipped as already-online ~3074 vs 826 runs), so offline periods mostly last until quiesce and short blips are under-explored — raise Online's weight or draw it only for offline clients. (2) In 2-client examples every command naming client C is drawn and skipped (~1/4 of per-client draws; ~10.6 commands run per example vs a cap of 30). (3) Startup always completes before the first connect, so the startup/first-connect interleaving is never explored. (4) After a hang the abandoned example can still call server.* during the next shrink (add a cancelled flag); a rejecting dispose in finally hides the real failure; markInterruptAsFailure reports a slow run like a finding. (5) Small window limits are off until pkm-d3qh is fixed. Changing weights or arbitrary order re-maps recorded replay lines: re-record the F-lines' fixed scenarios rather than relying on seeds.

- [x] Rebalance Online / per-client draws
- [x] Explore startup vs first-connect interleaving
- [x] Harden hang/dispose/interrupt reporting
- [x] Re-calibrate NUM_RUNS

Note 2026-10-04: (5) is done — pkm-d3qh shipped and the property draws window limits 1-5 one example in three again (~1000 of 3200 per run). The harness now also runs the real legacy repair (pkm-91ux). Re-calibrate NUM_RUNS against today's ~3 min run with small windows on.

## Summary of Changes

- Offline carries its return (1, 2, 3 or 5 run commands, or until quiesce); the Online command is gone, so no draw is spent on an already-online client and short blips are explored.
- The property draws a 2-client or a 3-client example (fc.oneof), each with commands only for its own clients (commandsFor). The client count no longer shrinks 3 to 2; an idle C shows in the report (accepted over remapping C onto B, which would make printed commands name the wrong client).
- startClient and Reload take connectAt: half the time the first connect lands 1-7 ticks after the mount begins, often mid-startup, as the app socket can.
- cancel.ts: every finished or abandoned example is cancelled before its clients are disposed; its server handle refuses calls and aborts requests on the wire. Dispose failures no longer hide the real error. Running out of the time budget fails as a budget problem, not a finding.
- NUM_RUNS 3200 -> 2300 (about 3 min). Examples now run about 14.1 commands (was about 10.6) with about 1 skip.
- Docs: property-checks.md command table, interrupt table, tally, cancel.ts row.
- Accepted: the fixed scenario 'poison repair cut off by offline' tallies its manual online() as Online at quiesce.
