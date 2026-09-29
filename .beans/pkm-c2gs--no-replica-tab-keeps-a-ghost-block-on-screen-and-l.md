---
# pkm-c2gs
title: No-replica tab keeps a ghost block on screen and lands a note per flush
status: completed
type: bug
priority: normal
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-29T09:59:25Z
---

Found in the pkm-foap review (M2). A tab with no usable replica delivers through the in-memory fallback lane and has no changes feed, and it drops its own WS echoes (SyncProvider.tsx). If it shows a block the server no longer has (e.g. a stale Journal view after /api/journal/cleanup), every debounced flush of text into it now lands another child under that block's daily-note conflict header instead of the old 400 + discard + refetch. Text is kept, but the note fills up and the ghost never leaves the screen.

Option: when an ack's `skipped` list (added in pkm-foap) is non-empty, or a skipped op targets a block on a visible view, refetch that view.

## Summary of Changes

- `web/src/sync/opQueue.ts`: added `ackSkipped(ack)`, read by hand like the
  existing `ackSeq` (the ack is typed as a bare object — `OpsAck` is not a
  `response_model`, so schema regen cannot type this field either). Wired a
  new `onSkippedNoReplica` callback through `createOpQueue`/
  `createReplicaQueue`. `deliverLaneHead` (the fallback lane's POST) now
  calls it whenever the ack names a skipped op **and** `unavailable !== null`
  — i.e. only for a tab this session has genuinely latched as having no
  replica. A lane delivery that happens for ordering reasons only
  (`unavailable === null`, pkm-5ekv) never fires it: that tab has a working
  replica and its own changes feed will tombstone the same ghost, so a bump
  there would be redundant.
- `web/src/sync/syncState.ts`: added a `"ops-skipped-no-replica"` event that
  bumps resync without touching `problem` — never a "problem" banner, since
  the batch committed fine.
- `web/src/sync/SyncProvider.tsx`: wires the queue's new callback to
  `applySync({ type: "ops-skipped-no-replica" })` via a ref (mirroring
  `repairLegacyRef`, since the queue is memoised with an empty dependency
  array and must stay one stable instance).

This reuses the existing `resyncSeq`/`useResync` mechanism (Journal, PageView,
CurrentWork) rather than inventing a new refetch path or invoking the heavier
outline repair epoch (`repairActiveOutlineSessions`) that `onDesync` runs for
a replica-rejected op — that repair wipes the active outline to server state
and can detach the editor mid-keystroke, which is unnecessary here since the
batch was accepted. The guarded authoritative read behind `useResync` merges
with pending local edits instead of overwriting them, so unsent text
elsewhere on the page survives.

Tests (`web/src/sync/opQueue.replica.test.ts`, `web/src/sync/syncState.test.ts`):
red-then-green. New tests cover: a non-empty `skipped` on a genuinely
no-replica lane delivery triggers the callback; an absent, empty, or
malformed (`skipped` not an array) field does not; a `skipped` ack delivered
by the lane while the replica is otherwise fine (ordering-only delivery)
does not trigger it either. `syncState.test.ts` covers the new event bumping
resync without disturbing an unrelated `problem`.

No server changes (the ack shape was already correct from pkm-foap); no
route/docstring change, so no openapi regen. No troubleshooting.md row —
this was found in review, not observed in the field. Docs:
`docs/architecture/sync-recovery.md` § "Ops on blocks the server no longer
has" and its failure-modes table gained the no-replica case; verified with
`check-docs.mjs`.

No e2e spec was added — the fix is exercised at the unit level where the
decision is made (opQueue's ack handling and the syncState transition); the
scenario itself (a genuinely dead replica in a real browser, `/api/journal/
cleanup` removing a shown block, watching the ghost disappear) is not
practically driveable through Playwright's stubs, so none is proposed.

**Correction (pkm-6xza, 2026-09-29):** The `unavailable !== null` guard on
`deliverLaneHead`'s callback, described above as narrowing the refetch to a
genuinely no-replica session, was wrong: it also skipped every durable
(replica-backed, online) delivery. A replica-backed tab's feed tombstones
the replica row but never bumps `resyncSeq` by itself, so the view kept the
ghost. Both delivery paths now consult `ackSkipped` unconditionally; see
pkm-6xza.
