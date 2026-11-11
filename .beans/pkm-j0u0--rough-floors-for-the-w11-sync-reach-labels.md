---
# pkm-j0u0
title: Rough floors for the W11 sync reach labels
status: in-progress
type: task
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:57Z
parent: pkm-4gda
---

The sync property suite tallies eight labels W11 added with no floor: Fault slowSnapshot armed/fired, Fault stalledSnapshot armed/fired, Recovery renewed, Recovery committed past its first deadline, Recovery abandoned on a stall, and the edit-while-paced label. A label with no floor can silently stop being drawn. Arthur (2026-11-11): a rough floor beats none; no full measurement campaign. Set floors in props/sync/sync.prop.ts from a handful of unseeded runs on a quiet machine (proptest/check.sh web --file sync, about 4.5 min each), well under the lowest count seen. Seen so far, two runs: slowSnapshot fired 21/25; stalledSnapshot fired 44/28; renewed 53/46; committed past first deadline 15/20; abandoned on a stall 38/26; edit while paced 11/6 (report-w11-t7.md). Also carry to W19's table the T7 mutants not run: a second seed for 'renewal moves nothing' and 'never renew'; 'runRecovery ignores a refused renewal' and 'commitRecovery skips the fingerprint check' (both expected to survive: reach facts).

- [ ] Run the suite a few times unseeded on a quiet machine
- [ ] Set floors for the eight labels; show each reaches and fails when broken
- [x] Add the unrun mutants to the W19 table (pkm-ygyx)
