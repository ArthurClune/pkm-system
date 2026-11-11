---
# pkm-c6ot
title: 'Sync property: a lost reply then a worker death makes C''s own first batch land as a conflict'
status: todo
type: bug
priority: normal
created_at: 2026-11-11T09:09:26Z
updated_at: 2026-11-11T09:11:19Z
---

proptest/check.sh web --file sync fails deterministically on the conflict-noise invariant, at main 8f954fe9 as well as on fix/reconnect-owed-pull (found while running the gate for pkm-jowv; unrelated to that change, which only touches the reconnect's resync decision).

Counterexample (3 clients, window limit 1, all connect after startup, first bootstraps ok, timesOut, ok):
Edit(C, [update_text #58 ""]), Fault(C, lostReply), Edit(C, [update_text #58 "apple"; set_collapsed #0 false]), WorkerDies(C), Reload(A)
Settle: B's first start retried by the backoff; Reload(C) of a dead worker. Faults fired: lostReply 1, snapshot5xx 1.
Oracle: "batch-C-1 overwrote pt_seed_3 as a conflict (header ...), but only C wrote its text".

Replay: proptest/check.sh web --seed 952743344 --path '1020:6:9:15:15:15:15:15:19:25:25:25:26:25:26:26:26:26:26:26:26:26:26:26:27:27:27:27:27:27' --file sync/sync.prop.ts --replay-path '//W:H'

Needs triage: product bug (fix with the shrunk example as a vitest beside the code) or a wrong property (fix in props/ with the reason).

A second unseeded run hit the same shape within 330 runs (2 clients; Offline(A), edits, Fault(A, lostReply), Edit(A), WorkerDies(A), Edit(A)): "batch-A-1 overwrote pt_seed_2 as a conflict, but only A wrote its text".
Replay: proptest/check.sh web --seed -1669541521 --path '328:10:18:16:14:19:19:19:19:19:19:19:19:19:19:19:26:25:26:26:26:26:26:26:26:26:26:26:26:26:26:26:26' --file sync/sync.prop.ts --replay-path 'CABAFCDA///k:V9'
The first replay fails identically with web/src restored to 8f954fe9.
