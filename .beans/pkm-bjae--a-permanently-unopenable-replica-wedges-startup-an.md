---
# pkm-bjae
title: A permanently unopenable replica wedges startup and strands edits in memory
status: in-progress
type: bug
priority: normal
created_at: 2026-08-04T10:46:28Z
updated_at: 2026-08-04T11:18:45Z
---

Found while fixing pkm-wi25.

If the replica's OPFS SAH pool can never be opened (a second live tab holding the handles, an OS-level OPFS lock -- anything the bounded retry in openRetry.ts cannot outlast), SyncProvider's mount effect never lifts its startup gate: it calls queue.setOnline(false) + queue.pause("recovery") and then awaits queue.retryPoisonMarks() and replica.poisonedBatches(), both replica RPCs. On failure it dispatches poison-discovery-failed and returns, so the queue is never resumed and never set online.

Observed consequence (measured in the e2e harness before the pkm-wi25 fix, by holding the pool contended): the editor still accepts edits and renders them, the op queue retains them in the ordered in-memory fallback lane, and NOTHING is ever POSTed -- for at least 60 s, indefinitely in practice. The only signal is the banner "Checking rejected changes failed: <error>" with a Retry button, which does not say that unsaved work is at stake. A reload or a closed tab loses those edits silently and permanently.

pkm-wi25 removed the common trigger (sqlite-wasm's memoised install rejection defeating the retry), so this is no longer reachable from a transient navigation race. It is still reachable whenever the holder is persistent.

Worth deciding between:
- letting the fallback lane drain while the startup gate is up (the poison check protects against posting AHEAD of an unrepaired rejected batch -- with no openable replica there are no such rows to protect, so the barrier may be vacuous in this state)
- making the state visibly unsafe instead: say that changes are not being saved, and/or go read-only rather than accept edits that cannot be delivered
- a beforeunload guard while the lane is non-empty

## Checklist

[ ] Decide the policy (drain-anyway vs refuse-edits vs warn-on-unload)
[ ] Reproduce deterministically in a unit test against SyncProvider with a replica whose open always rejects
[ ] Implement and cover
[ ] Update docs/architecture/sync-and-offline.md (the paragraph pkm-wi25 added about this hazard)
