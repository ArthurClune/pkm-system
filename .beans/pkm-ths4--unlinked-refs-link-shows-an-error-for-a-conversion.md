---
# pkm-ths4
title: Unlinked refs 'Link' shows an error for a conversion the queue still delivers
status: todo
type: bug
created_at: 2026-11-16T10:51:36Z
updated_at: 2026-11-16T10:51:36Z
---

UnlinkedSection's link conversion awaits ticket.settled and shows the error when it fails, without awaiting ticket.delivered. A settled failure the replica did not reject still retains and delivers the ops (see useCellWrites.send, which waits on delivered for this reason, and docs/architecture/sync-recovery.md § A local write fails). So a conversion that lands on the server reads as failed in the unlinked list. Fix: treat only delivered failing as a failure, as useCellWrites does.
