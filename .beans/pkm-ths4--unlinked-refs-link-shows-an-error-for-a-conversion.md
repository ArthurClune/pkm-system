---
# pkm-ths4
title: Unlinked refs 'Link' shows an error for a conversion the queue still delivers
status: completed
type: bug
priority: normal
created_at: 2026-11-16T10:51:36Z
updated_at: 2026-11-16T14:05:19Z
---

UnlinkedSection's link conversion awaits ticket.settled and shows the error when it fails, without awaiting ticket.delivered. A settled failure the replica did not reject still retains and delivers the ops (see useCellWrites.send, which waits on delivered for this reason, and docs/architecture/sync-recovery.md § A local write fails). So a conversion that lands on the server reads as failed in the unlinked list. Fix: treat only delivered failing as a failure, as useCellWrites does.


## Summary of Changes

Symptom: clicking Link in Unlinked references while the local replica could
not store the write (an `SQLITE_CANTOPEN`, a full disk, a dead worker) showed
that error under the block, e.g. `Error: SQLITE_CANTOPEN`, and re-enabled
Link, although the queue still delivered the conversion; a second click
would then queue a second conversion of the already-linked text.

Cause: `linkItem` treated `ticket.settled` failing as final. That outcome only
says whether local storage took the write; unless the replica rejected the op,
the queue keeps it in the in-memory lane and delivers it, and a rejected op
fails `delivered` too.

Fix: `linkItem` waits for `settled` only as the moment the queue holds the
write, whatever its outcome, and shows an error only when `delivered` fails.
The list's own status for that moment is renamed from `settled` to `queued`
(`unlinkedStatus.ts`, and the property suite's model, labels and mutants in
`props/backlinks/`), so it no longer reads as the ticket's settle outcome:
a queued block is hidden and counted out of the total and next offset, and a
failed delivery moves it to an error and lists it again, as before.
`sections.test.tsx`'s test that asserted the old error is rewritten to the
new rule. No other `web/src` reader of `ticket.settled` exists.

The rule: the `WriteTicket.settled` doc comment in `sync/opQueue.ts`, and
docs/architecture/sync-recovery.md § A local write fails.
