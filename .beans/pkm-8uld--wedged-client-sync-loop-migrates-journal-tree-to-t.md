---
# pkm-8uld
title: Wedged client sync loop migrates journal tree to today and replays stale ops
status: in-progress
type: bug
priority: high
created_at: 2026-07-22T09:51:25Z
updated_at: 2026-07-22T10:02:59Z
---

Found investigating "daily notes vanished apart from today" (2026-07-22).

## Symptom

Since ~2026-07-08, every morning the entire daily-note content tree (single top-level "Todos" block, ~24 descendants) is moved from yesterday's daily page to today's by one cross-page MoveOp. The vacated page is left empty and (post pkm-c3kz) deleted by /api/journal/cleanup, so all past dailies look "vanished" — content is actually piled on today's page. No data loss (verified against nightly backups: only completely-empty pages were deleted; July 14/9/7/4/2 with non-tree content survived).

## Forensics (2026-07-22, server.out.log + applied_batches + changes feed)

- Three clients simultaneously in bad sync states:
  - 100.127.205.66 (Arthur's Mac, since cleared+reloaded → healthy): pull cursor stuck at GET /api/sync/changes?since=3911 forever; doom loop POST /api/ops -> GET /api/page/AI%20in%20Research -> pull, each iteration RE-APPLYING old edits to page 66 blocks (changes feed seq 11305-11388 show the same ~5 uids churning repeatedly). Also re-issued DELETE /api/page/July%2011th,%202026 three times (200 each — page auto-recreated by daily-title GETs in between).
  - 100.104.173.117: cursor stuck at since=5604, tight loop GET /api/journal?days=5 + pull.
  - 100.113.95.109: looped move/reorder ops against July 21st page (seq 10896-10992), then issued the big move at 08:59:40 UTC (seq 10993-11020: one MoveOp of cbDqmNw6h, SetPageId over all 24 uids, TouchPage 4355+4358). Cleanup deleted page 4355 at seq 11049.
- Replayed batches re-apply: either batch_id is absent (legacy path applies unconditionally) or the client regenerates batch_id per retry. applied_batches rows exist only for first-applies; changes feed proves re-application.
- Clearing browser data + reload fixed the Mac ⇒ wedge lives in persisted client state (SW bundle and/or replica DB + durable op queue).

## Root-cause questions

- [ ] Why does the pull cursor stop advancing (poison change entry? apply error swallowed without cursor advance)?
- [ ] Why do op-queue retries re-apply instead of dedup'ing on batch_id?
- [ ] What generates a fresh top-level MoveOp with page_title = current today each morning (only DnD stamps page_title on moves — durable intent replay? outline replay regeneration)?
- [ ] Server hardening: cleanup deleted the emptied husks, making the damage invisible — consider tombstones/telemetry or requiring batch_id.

## Recovery notes

Nightly backups in ~/.config/pkm/backups/sqlite/ hold each day's state. GET /api/page/<daily title> auto-creates pages (separate bean).

## Investigation update (2026-07-22 late morning)

Confirmed with Arthur:
- The daily Todos-tree move IS his deliberate morning drag (yesterday → today). So the "migration" itself is user intent; the damage was (a) all journal content having become nested under that one root, (b) cleanup deleting the emptied husks, (c) wedged clients misrepresenting state.
- Mac (100.127.205.66) fixed by clearing browser data + reload.
- **iPad still reproduces**: "once I load that, the daily notes page resets" — live wedged client available for evidence capture. Baseline before iPad load: changes seq 11394, server.out.log line 16820.

Code root causes identified so far:
- `web/src/sync/replicaSync.ts:187` — `pullLoop().catch(() => undefined)`: any persistent applyChanges failure silently freezes the cursor forever (stuck since=3911 signature). Also `pending-changed → continue` (line 163) can starve the pull if the pending set churns continuously.
- `web/src/sync/opQueue.ts:447` (quota fallback) and legacy queue `postOps(batch)` (line 580) — both POST /api/ops WITHOUT batch_id → server applies unconditionally on every retry/replay. Pre-offline stale-SW bundles also post without batch_id by design. This is the re-application vector.
- Pre-cleanup husk deletions were manual; GET auto-create (pkm-fy52) resurrected deleted dailies as zombies (July 11th deleted 3x).

- [x] Capture iPad replay live — iPad load produced ZERO op mutations. The visible "daily notes reset" on loading the iPad was: journal-mount POST /api/journal/cleanup deleting empty daily pages (incl. the three zombies the CLI reads created, seq 11392-11394) + the ws-nudged resync remounting the other device's journal view. Not a replay; cleanup + resync working as designed on top of already-emptied days.
- [x] Root-cause established (see Root cause summary below); per-device wedge triggers no longer observable (all devices cleared). Prime suspects for the original applyChanges/recovery failures: storage quota during 15MB snapshot re-bootstrap after the Jul 19/20 deploy generation flips, all swallowed by replicaSync's silent catch.
- [ ] Fix: pull wedge must surface/recover instead of silent catch
- [ ] Fix/harden: no-batch_id ops path (reject or version-gate stale clients; SW update strategy)
- [ ] Decide cleanup guard (e.g. don't delete a daily emptied by a cross-page move, or tombstone)

## Root cause summary (final)

Layered failure, no single bug:

1. **User workflow**: Arthur drags the "Todos" root forward to today daily; over weeks ALL journal content became nested under that root, so the drag empties the whole previous day.
2. **Cleanup (pkm-c3kz, by design)** then deletes the emptied husk on next journal mount → history "vanishes" (content is all on today's page). Pre-July-19 husks were deleted manually; GET auto-create resurrected them as zombies (pkm-fy52).
3. **Wedged clients (real defects)**:
   - `replicaSync.ts` pullLoop: `.catch(() => undefined)` + `recover()` returning false silently → any persistent applyChanges/recovery failure (e.g. quota during full-snapshot re-bootstrap) freezes the cursor forever with no surfaced state beyond the offline banner. Observed: Mac stuck at since=3911, iPad-era client at since=5604.
   - `opQueue.ts`: legacy queue and quota fallback POST /api/ops WITHOUT batch_id → server re-applies on every retry. Observed as repeated re-application churn on "AI in Research" (page 66) and Todos-children reorders.
   - Stale service-worker bundles keep pre-fix clients alive indefinitely.

All three devices have now been cleared/re-bootstrapped and sync is healthy (cursors advancing past 11394).
