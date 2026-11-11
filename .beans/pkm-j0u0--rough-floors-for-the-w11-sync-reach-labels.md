---
# pkm-j0u0
title: Rough floors for the W11 sync reach labels
status: completed
type: task
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:39:40Z
parent: pkm-4gda
---

The sync property suite tallies eight labels W11 added with no floor: Fault slowSnapshot armed/fired, Fault stalledSnapshot armed/fired, Recovery renewed, Recovery committed past its first deadline, Recovery abandoned on a stall, and the edit-while-paced label. A label with no floor can silently stop being drawn. Arthur (2026-11-11): a rough floor beats none; no full measurement campaign. Set floors in props/sync/sync.prop.ts from a handful of unseeded runs on a quiet machine (proptest/check.sh web --file sync, about 4.5 min each), well under the lowest count seen. Seen so far, two runs: slowSnapshot fired 21/25; stalledSnapshot fired 44/28; renewed 53/46; committed past first deadline 15/20; abandoned on a stall 38/26; edit while paced 11/6 (report-w11-t7.md). Also carry to W19's table the T7 mutants not run: a second seed for 'renewal moves nothing' and 'never renew'; 'runRecovery ignores a refused renewal' and 'commitRecovery skips the fingerprint check' (both expected to survive: reach facts).

- [ ] Run the suite a few times unseeded on a quiet machine
- [x] Set floors for the eight labels (bite and confirming runs skipped by Arthur: the six runs were consistent)
- [x] Add the unrun mutants to the W19 table (pkm-ygyx)


## Summary of Changes

Floors in `REACH` (`web/src/props/sync/sync.prop.ts`), from six unseeded runs of 2100 examples each (four on 2026-11-11, plus T7's two):

| Label | Counts over the six runs | Floor | Requires |
|---|---|---|---|
| Fault slowSnapshot | 116 114 118 118 120 115 | 0.013 | > 27 |
| Fault slowSnapshot fired | 21 31 24 23 21 25 | 0.002 | > 4 |
| Fault stalledSnapshot | 186 161 184 167 179 177 | 0.019 | > 39 |
| Fault stalledSnapshot fired | 28 32 38 38 44 28 | 0.003 | > 6 |
| Recovery renewed | 37 45 46 47 53 46 | 0.0004 | >= 1 |
| Recovery committed past its first deadline | 17 24 16 17 15 20 | 0.0004 | >= 1 |
| Recovery abandoned on a stall | 20 21 30 30 38 26 | 0.0004 | >= 1 |
| Edit while a snapshot is paced | 10 8 5 9 11 6 | none | under ten in some run |

Rough by Arthur's choice, not the 30-run recipe in `with_floors`: the drawn faults get a quarter of the lowest share; the Recovery labels, which the harness lease's real timers decide, get only "at least one event". Arthur waived the bite run and the confirming runs because the six runs were consistent.
