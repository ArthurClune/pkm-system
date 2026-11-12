---
# pkm-dr4j
title: 'Banner model: check a poison problem beside a stalled replica'
status: in-progress
type: task
priority: normal
created_at: 2026-11-12T15:48:52Z
updated_at: 2026-11-12T17:29:30Z
---

`web/src/props/sync/bannerModel.ts` `expectedBanner` returns `{ unmodelled: "a stall report beside a poison problem" }` for any life holding both, so the row pkm-k2lf added to contracts/sync-recovery.md § What the UI shows (a poison problem ranks over `replica-stalled` while the replica is there, `repaired` included) is stated but never checked by the sync property suite.

Model the combination from that row, not from `transitionSync`. Do it with or after pkm-3kwx, whose fix changes what shows once the poison problem ends. This changes model behaviour: `pnpm verify` and `proptest/check.sh web`, and show the new path is reached (a labelled event with a floor) and can fail (a mutant), per docs/architecture/checks.md § Property gate.

- [x] bannerModel.ts predicts the banner for poison beside a stall
- [x] reach + teeth shown (reach by a fixed scenario, not a floor: the property draws a poison problem beside a live stall a few times a run at most, and the stalled-again path never; see the comment over the sync property's floors)
- [x] pnpm verify; proptest/check.sh web
