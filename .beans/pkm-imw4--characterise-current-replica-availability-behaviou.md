---
# pkm-imw4
title: Characterise current replica-availability behaviour before refactoring
status: completed
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T14:45:06Z
parent: pkm-q2jj
blocking:
    - pkm-za9j
---

Write tests that pass on TODAY's code for every behaviour the refactor must preserve: the pkm-bjae latch, opQueue's retain-vs-desync split, the barrier lift, the exit-1 gate, the replica-unavailable banner, and the no-replica mode transition. This is the regression net for a change that removes three load-bearing things from the path behind pkm-c9hp, pkm-ndcu, pkm-hhbc, pkm-wi25 and pkm-bjae. Any behaviour that CANNOT be pinned against today's code is a behaviour nobody has verified -- record it as a finding rather than quietly preserving it.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md

## Baseline (measured before this task's two new tests)

Per the controller (Task 1 landed after the handover, adding tests): unit
1985/1985 passing, coverage 97.7% statements / 93.11% branches / 95.18%
functions / 97.7% lines, e2e 51/51, 0 jsdom warnings. This supersedes the
handover's 122/1972/97.7%/93.09%/51 -- Task 1 added tests since that number
was taken. No further investigation needed per controller ruling.

After adding the two tests specified in Steps 2 and 4: `pnpm verify` on
web/ gives 123 test files, 1987 unit tests passing (+2), coverage 97.7%
statements / 93.13% branches / 95.18% functions / 97.7% lines, e2e 51/51,
0 jsdom warnings. Minor finding: the plan's Step 7 says to expect '3 more
tests than the baseline', but Steps 2 and 4 specify exactly two new
`test(...)` blocks (one in workerHandlers.test.ts, one in
opQueue.replica.test.ts) and no more were warranted -- the +2 delta is
correct for what the plan actually asks this task to add; the '+3' in
Step 7's prose appears to be stale/wrong and should be corrected before
Task 3 reads it as a checklist item.

## Findings: behaviour that cannot be pinned

1. **Nothing in web/src ever throws an error carrying `quota: true`.** grep shows
   the flag is set only by tests (opQueue.replica.test.ts, rpc.test.ts). So the
   quota -> onQuota -> quotaExhausted -> read-only chain is verifiable only
   synthetically: no real code path produces the input. The mechanism is left
   untouched by pkm-q2jj; whether OPFS/sqlite-wasm can be made to raise it (and
   what it raises instead) is unanswered.
2. **The `probe === "unknown"` branch has no test.** It is reachable only via
   an RpcLifecycleError from init() (dead worker, chunk 404 after a deploy, RPC
   timeout). pkm-q2jj deletes the branch rather than pinning it: it becomes
   `unreachable`, which retains ops and holds the barrier by construction.
3. **A pool-exhausted write on a successfully OPEN database** is retained today
   only because of the isPoolExhausted message match -- it is not an availability
   failure at all. Pinned at opQueue.replica.test.ts:293; the reason it passes
   changes in Task 4 (from message match to "not a rejection").
