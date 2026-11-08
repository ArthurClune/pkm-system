---
# pkm-ewnz
title: 'Sync: a reconnect that joins a running completion pulls nothing for its own gap'
status: completed
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:43:19Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding sync F4. Verdict: HOLDS-NARROWER.

## Symptom
Connect 1's completion is past its last feed fetch (cursor 100) and still
applying. The socket flaps; another device writes 101-110 meanwhile.
Connect 2 joins `finishRun` (`reconnectFlow.ts` `finish`: `intent = false;
if (finishRun) return finishRun;`), so there is no second pull and no
resync for 101-110. The server sends no seq frame on connect, so views stay
stale until navigation or the next reconnect that moves data.

`reconnectFlow.test.ts` "overlapping reconnects share one completion and
leave no stale intent" pins the hole as intended (trace with no second
`start`).

## Fix
- [x] Rewrite that test to expect a trailing pass when the join lands after the first run's pull
- [x] A joining connect requests a trailing pass (a `rerun` flag checked before the resync decision, or `replicaSync.start()` which sets `again`)

## Summary of Changes

- `reconnectFlow.ts`: a connect that joins a running completion sets `trailing`; the completion loops start()/idle() until no join is left, then decides the resync from the version before its first pull. A trailing pull that moved data resyncs a run that found nothing.
- `reconnectFlow.test.ts`: the overlap test now expects the trailing pull; a second test pins the resync from a trailing pull.
- Docs: sync-and-offline.md § The reconnect drain; a troubleshooting row.
