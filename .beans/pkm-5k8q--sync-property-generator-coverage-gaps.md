---
# pkm-5k8q
title: Sync property generator coverage gaps
status: todo
type: task
created_at: 2026-10-03T17:03:13Z
updated_at: 2026-10-03T17:03:13Z
parent: pkm-nws9
---

From the pkm-yxcs Task 7 and final reviews (harness quality, not product bugs). (1) Online is drawn far less than Offline (skipped as already-online ~3074 vs 826 runs), so offline periods mostly last until quiesce and short blips are under-explored — raise Online's weight or draw it only for offline clients. (2) In 2-client examples every command naming client C is drawn and skipped (~1/4 of per-client draws; ~10.6 commands run per example vs a cap of 30). (3) Startup always completes before the first connect, so the startup/first-connect interleaving is never explored. (4) After a hang the abandoned example can still call server.* during the next shrink (add a cancelled flag); a rejecting dispose in finally hides the real failure; markInterruptAsFailure reports a slow run like a finding. (5) Small window limits are off until pkm-d3qh is fixed. Changing weights or arbitrary order re-maps recorded replay lines: re-record the F-lines' fixed scenarios rather than relying on seeds.

- [ ] Rebalance Online / per-client draws
- [ ] Explore startup vs first-connect interleaving
- [ ] Harden hang/dispose/interrupt reporting
- [ ] Re-calibrate NUM_RUNS
