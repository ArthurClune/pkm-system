# Sync subsystem adversarial review, consolidated

**Date:** 2026-09-29
**Reviewed commit:** `2a95e4a868c07e02c39836be336f1c1671e91103`
**Comparison baseline:** `6c56126a404f38d74b25232683ee6442c4be140c` (26 Sep to 29 Sep: pkm-3g4n, 95ss, wy1v, x8e3, foap, 7788, b0zf, fe9b, c2gs, 5ekv, ur2n, h1c6, 1b2w, tf15; e21b scrapped)
**Sources:** this document is a combination of two independent adversarial reviews of the same commit, one by Astra (a Codex session) and one by Fable (a Claude session), plus Astra's own merge of the pair. The three source documents were session artefacts and are not kept; this is the only record. Where the body says "Astra C1" or "Fable C9" it refers to the finding labels those source reviews used.
**Method:** every claim the two reviews make about the same code was compared. Where they agreed, the claim is carried over. Where they disagreed, or where only one review made a claim that bears on the data-loss verdict, the claim was re-verified against the reviewed commit by a read-only code read (no reproductions were re-run). The verdicts and line references below come from that pass, not from either review.
**Status:** recommendations only. No code, tests, docs or beans were changed.

## Verdict

**Data loss.** The two reviews reached opposite conclusions and Astra's stands. Fable wrote "no path was found on either side where the user's text or a queued op is discarded". Four such paths are confirmed at the reviewed commit (F1 to F4 below). Three predate the window; F1 was introduced by pkm-1b2w. Fable's "confirmed sound" list is not wrong on its own terms: its two entries that overlap these findings ("carries rows verbatim before the snapshot", "pending-id guard and ackedSeqs lifecycle") are true statements about ordering and double-application, and say nothing about durability during file replacement or about replaying already-applied batches. They answered a different question from the one the findings ask.

**Correctness of the window's own fixes.** Both reviews agree, and nothing in the verification disturbs it: every foap and fe9b ruling row, every conflict-header form, tombstone-before-live-row ordering, replay-hash tolerance, ack `seq` and `skipped`, and both sides' missing-target skip rule have a code path and a pinning test. The defects below sit beside the fixes, on paths the fixes touched but did not close.

**Docs versus code.** Both are right at different altitudes. Fable checked around 120 named constants, functions, tables, anchors and banner strings and found one wrong (`batch_id` described as optional). Astra checked the guarantees and found three that the code does not make: "one transaction" for the write route, "Recovery never erases intent", and the online-edit diagram's unconditional "refetch visible views" step. A fourth, "its feed tombstones the ghost", was found by Fable. The docs are accurate in detail and overstated at the level of promises.

**Maintainability.** The reviews agree. The server side got cleaner (one classifier, one text-edit predicate, one replay hash, all pure). The web side absorbed each fix as a branch inside an existing closure, and `opQueue.ts` is where a newcomer now needs the bean log to read the code. The web side is one extraction pass behind the server.

**Tests.** The reviews agree. Both suites are green with high coverage and the new tests are real scenario tests. What is missing is composition across the editor, queue, server, feed and recovery boundaries, and every confirmed finding below lives in exactly such a gap. Two existing tests pin the wrong behaviour (F3b, F5), and one existing test would break under the F2 fix.

## How the two reviews relate

| This doc | Astra | Fable | Relationship | Verification |
|---|---|---|---|---|
| F1 | C1 (P1) | "confirmed sound" | Disagreed | Astra confirmed |
| F2 | C2 (P1) | A1 (major, not loss) | Same cause, disputed severity | Astra's severity confirmed for ref-free text |
| F3 | C3 (P1) | not raised; verdict says no loss | Disagreed by omission | Astra confirmed, both modes |
| F4 | C4 (P1) | not raised; "remaining 400s are malformed input" | Disagreed | Astra confirmed |
| F5 | not raised | C9 (major) | Fable only | Confirmed |
| F6 | C5 (P2) | "confirmed sound" | Disagreed | Astra confirmed on the flushing rebase paths |
| F7 | C6 (P2) | not raised | Astra only | Confirmed; mechanism refined |
| F8 | not raised | C1 (major) | Fable only | Partly confirmed; narrower than stated |
| F9 | accepted limitation (pkm-0htf) | C3 (major, documented) | Agreed | Not re-verified |
| D1 to D4 | docs section | D1, C2 (docs), B1 | Mostly complementary | Confirmed, one refined |
| maintainability, tests | agreed | agreed | Agreed | Line counts confirmed |

Both reviews used the label "C1" for different findings. This document renumbers everything as F-numbers and gives each source's label in the heading.

## Correctness findings

P1 is a path where a user's text or a queued edit is discarded. P2 is a convergence or liveness defect that leaves the local model wrong or the session stuck without loss.

### F1 (P1, introduced by pkm-1b2w) Replacing a damaged replica file deletes the only copy of the queue before the new copy is durable

Astra C1. Fable listed the path as sound.

`web/src/replica/workerHandlers.ts`: the rebase reads the durable pending rows into worker memory (line 437), applies the snapshot to the old file, and on SQLITE_CORRUPT calls the replacement path (line 273). That path unlinks the old file and its `-journal` first (line 257, via `worker.ts:70-76`), then opens a new empty file (lines 258-259), installs the schema (line 274), and only then inserts the carried rows in a transaction (lines 275-282). From the unlink until that commit the rows exist only in the `current` array. Nothing backs up the old file and no catch restores it. A failed open, a failed insert (SQLITE_FULL, IOERR) or a terminated worker loses every row. The main thread holds no copy either: the fallback lane drops its copy once enqueue succeeds, and the localStorage poison intent records only the rejected batch, not the valid rows behind it.

The path that matters is the poison repair, which flushes nothing before rebasing (`replicaSync.ts:772`, flush "skip"): the valid rows queued behind the poisoned batch were never posted, so losing them loses user edits. The other rebase entrants flush first, so their rows were already delivered. `SyncProvider.tsx:423` turns the failure into "repair-failed", and a Retry then rebases an already-empty queue, so the loss is silent. iOS suspending the PWA during startup repair is a realistic trigger, and is the scenario pkm-1b2w was filed for.

Tests: `workerHandlers.test.ts:528` covers the success path and `:573` covers a snapshot failure at the step after the rows have committed. No test fails the open, the schema install or the insert. The mock `discardDbFile` is `() => { current = fresh.db; }`, so it never destroys the old database and cannot expose this window.

Docs: `sync-recovery.md § A batch the server rejects` says the valid rows "must stay durable until it is deleted", and `§ Recovery never erases intent` (line 203) is the heading the failure-modes table cites. Both are broken during this window. The comment at `workerHandlers.ts:264-266` ("They commit before the snapshot applies, so a failed apply still leaves them durable") is true only of snapshot failure.

Adjudication: every factual sentence in Astra C1 is right, including its criticism of the `:573` test. Fable's "carries rows verbatim before the snapshot" is true and beside the point. Fable's "no path discards a queued op" is wrong for this path.

Action: keep a durable source until the replacement queue has committed (copy the rows into the new file before unlinking the old one, or write them somewhere durable first), and preserve row and batch identities across the transfer so `ackedSeqs` and the pending-id guard stay valid. Replace the mock with one that discards the old database, and fail the open, the schema install and the insert in turn, plus a terminated worker.

### F2 (P1, pre-existing, widened) The ops route reads a batch's context in autocommit

Astra C2 and Fable A1. Both are right about the cause. Astra's severity is confirmed.

`server/src/pkm/server/db.py:116-121` connects with neither `isolation_level` nor `autocommit` set, so Python's `sqlite3` module (not SQLite, as Astra wrote) issues the implicit `BEGIN` only before the first INSERT, UPDATE or DELETE. `routes_ops.py:22` is `async def post_ops` and issues no `BEGIN`, so the `applied_batches` dedupe SELECT (lines 28-30) and op 0's `_context_for` reads (`ops_apply.py:205`, `:238-242`) run outside any transaction. `delete_page`, `rename_page` and `cleanup_journal` (`routes_pages.py:266`, `:280`, `:493`) are plain `def` routes on the threadpool with their own connections and commit concurrently. The window is every statement before the batch's first write; later ops in the batch run inside the transaction.

Astra's variant: a page deletion commits between the context read and the UPDATE. The clean plan is UpdateText, ReindexRefs, TouchPage (`ops_core.py:701`). The UPDATE never checks rowcount, so it matches zero rows, no journal trigger fires, `TouchPage` matches nothing, and the route stores `{"ok": true}` in `applied_batches` and commits. A retry replays the stored ack (`routes_ops.py:48`). The text is in no block, no conflict entry and no daily note. Had the deletion landed before the context read, `classify_missing_target` (`ops_core.py:343-345`) would have returned `orphan_edit` and landed the text on today's daily page. The race bypasses exactly the edit-versus-delete policy the window installed.

One exception Astra missed: if the text contains a `[[link]]`, `#tag`, `attr::` or `((uid))`, ReindexRefs inserts into `refs` or `block_refs`, whose `src_block_uid` references `blocks(uid)` (`schema.py:45`, `:60`). The FK violation raises `IntegrityError`, escapes as a 500, the transaction is discarded, and the client's retry takes the orphan-edit path. Nothing is lost in that case.

Fable's variant: a rename commits in the window. `_block_rewrites` was read before the rename, so the UPDATE writes the old title and `get_or_create` recreates the old page, with a 200. Real, and not loss.

The pattern already exists: `routes_sidebar.py:40` (`BEGIN IMMEDIATE`), `routes_sync.py:194` and `:248`, `title_migration.py:157` and `:173`.

Tests: no test races a delete or rename between context and execute. `test_ops_idempotency.py:67` commits from a second connection inside `apply_batch` and its comment says this happens "before the loser's write transaction starts". That test depends on the late `BEGIN`; under the fix the injected writer waits out `busy_timeout` and fails with "database is locked". Fable is right that the `IntegrityError` branch at `routes_ops.py:73-81` becomes unreachable. Both need rewriting with the fix.

Adjudication: P1 stands. The window is a few statements long, so the race is rare, but the loss is silent and the stored ack makes it permanent. The likeliest trigger is journal cleanup deleting a recent empty daily page while another client types the first text into it.

Action: `BEGIN IMMEDIATE` before the dedupe SELECT, with contention handling. Tests: a delete committed between context and execute lands the text on the daily page; a rename committed in the same window cannot resurrect the old title. Rewrite `test_ops_idempotency.py:67`.

### F3 (P1, pre-existing) Unflushed editor drafts fall outside the conflict model

Astra C3. Fable did not examine drafts. Both modes are confirmed, and the verification found a third trigger for the second.

**(a) Remote update before flush loses the remote author's text.** A draft keeps only `{ uid, text }` (`useOutline.ts:101`, `:295`), nothing about the text it started from. Remote ops always reach the tree, including the focused block (`useOutline.ts:269-281`, `outlineState.ts:241-245`); the only protection is visual, since `useBlockDraft.ts:130-135` keeps showing the draft while the tree holds the remote text. At flush, `run()` takes `pre = blocksRef.current` (`useOutline.ts:177`), which is the tree that already carries the remote text, and `stampBaseTextHashes` (`:190`, `baseTextHash.ts:65-68`) hashes that. The server's `classify_text_edit` (`ops_core.py:272-277`) sees a matching hash, classifies the edit as clean, and applies plain `base_effects` (`:707-709`). The conflict copy never runs. The code comments call this intended last-writer-wins (`useOutline.ts:270-274`, `useBlockDraft.ts:69-71`), but the outcome depends on arrival order: had the local flush reached the server first, the remote edit would have arrived with the original hash, hit the conflict check, and the local text would have been kept as a conflict copy. The local user never saw the remote text.

**(b) Remote removal before flush drops the local user's text.** `outlineState.ts:348` returns no ops when the block is absent, and `takePendingTextOps` (`useOutline.ts:161-171`) has already cleared the draft, so nothing is enqueued. `outlineState.test.ts:346-349` ("drops a pending draft whose block a remote batch deleted") requires this. The comments at `useOutline.ts:167-168` and `outlineState.ts:337-340` still say flushing "would doom the whole batch". That rationale is superseded: `ops_core.py:344-345` classifies any missing-block `update_text` as `orphan_edit`, hashed or not, and `:591-598` lands its text on today's daily note. The only 400 left (`:637-648`) is a malformed uid, which clients never mint. Sending the draft would preserve it. It is wider than deletion: `tree.ts:253-256` removes a block from this outline when a remote cross-page move takes it, and the draft is then dropped although the block still exists on the server.

Window: `TEXT_DEBOUNCE_MS = 500` (`useOutline.ts:40`), restarted on every keystroke, so the exposed text is everything typed since the last half-second pause. A draft whose caret is inside a `[[` or `#` token has no timer at all (`useOutline.ts:300-305`, pkm-xlah) and flushes only on blur, structural edit, undo, tab hide, navigation or unmount, so it can sit indefinitely.

Not traced: `useOutline.ts:145-156` also clears the draft without flushing when a parent passes a new `initial` that is not the session snapshot. Whether production parents reach that branch was not checked.

Adjudication: Astra is right on both. Fable's "no path discards user text" is wrong for (b). Mode (a) is loss of the other author's text through an order-dependent LWW, not of the local user's.

Action: record the base text (or hash) when the draft is captured and stamp that at flush; keep the draft's text when its block disappears and let the server land it as an orphan edit; invert `outlineState.test.ts:346`; add remote-update, remote-delete and remote-move tests during both debounced and held drafts.

### F4 (P1, pre-existing) A 401 is treated as rejection of the user's edit

Astra C4. Fable's verdict said "the lane discards only on a 4xx, and after foap/fe9b the remaining 400s are malformed input".

`client.ts:155-157`: on 401, `apiFetch` calls `onUnauthorized()` (which sets `location.href = "/login"`), then throws `ApiError(401)`, which reaches the queue. No file in the sync path special-cases 401 or 403. The terminal predicate is `error instanceof ApiError && error.status >= 400 && error.status < 500` at both `opQueue.ts:468` (lane) and `:617` (durable). It is a range, not a list: 401, 404, 408, 409, 413, 422 and 429 are all terminal.

Lane: `deliverLaneHead` (`:470-478`) settles the head as failed and the only copy is gone immediately, whatever navigation does. Durable: `rejectDurableBatch` pauses, writes the poison intent to localStorage synchronously, fails the ticket and awaits `markPoisoned` (`replica/queue.ts:164`). The `/login` page is server-rendered with no service worker, so the navigation needs a network round trip and the localStorage write almost certainly lands first. In the same session the repair's snapshot fetch gets another 401 and fails, so nothing is deleted yet. After login, startup runs `retryPoisonMarks()` (`SyncProvider.tsx:495-505`), discovery finds the row, `rebaseAuthoritative("poison")` now succeeds, and `deleteBatch` (`:405-407`) removes an edit the server never received. The edit survives only if both the localStorage write and the worker mark are lost before unload.

When it happens: sessions last a year, but a secret rotation or a cleared cookie also causes it. No queue, provider or e2e test covers a 401; `client.test.ts:29` checks only that `apiFetch` throws and redirects.

Adjudication: Astra is right. Fable's sentence is true for status 400 on `/api/ops` (the remaining `OpError` reasons are malformed input) and wrong as a statement about the predicate, which also fires for 401 from `require_auth`, 409 for a reused `batch_id` with different ops, 422 from validation, and any 4xx a proxy emits.

Action: exclude 401 (and 403, 408, 429) from the terminal predicate at both sites and treat them as retry-later; a queue test that a valid batch receiving 401 is neither poisoned nor dropped; an e2e that edits, expires the session, logs in and finds the edit on the server.

### F5 (P2, pre-existing) A replica-backed online tab still shows the pkm-c2gs ghost

Fable C9. Astra did not raise it. Confirmed.

The durable drain reads only `seq` from the ack (`opQueue.ts:624-627`); `ackSkipped` is consulted only on the lane and only under `unavailable !== null` (`:489`). Online, views read the server (`SyncProvider.tsx:547` routes to the replica only while `reconnecting`) and refresh only from WS batches (`useOutline.ts:274-281`) or `resyncSeq`. `syncState.ts` bumps resync for mode-ready-check, repair-succeeded, legacy-repair-succeeded, reset-succeeded and ops-skipped-no-replica, none of which fires for a durable skipped ack. The server never broadcasts skipped ops (`ops_apply.py:391-398`) and the tab drops its own echo anyway (`SyncProvider.tsx:588`). Non-ops deletes (journal cleanup at `routes_pages.py:523-524`, page delete) send only a seq nudge, which reaches `replicaSync.onSeq` and no view.

So the replica tombstones the row (`apply.ts:319-321`) while the screen keeps the ghost, and every debounced edit into it lands as another `orphan_edit` child under today's conflict header. It clears on reconnect or navigation. Reachable with two tabs or devices: cleanup deletes an empty past day the other still shows, or a page is deleted elsewhere. `opQueue.replica.test.ts:2046-2068` ("does not refetch (it has a feed to tombstone the ghost)") and `sync-recovery.md:32`, `:383-385` pin the wrong premise: the feed tombstones the replica row, not the view.

Action: bump resync on any ack with a non-empty `skipped`, lane or durable, regardless of the latch (a harmless extra refetch on no-op skips); invert the `:2046` test; add a durable-path test; correct the two doc sites and the c2gs bean.

### F6 (P2, pre-existing) Recovery replays already-applied batches over the snapshot

Astra C5. Fable listed the pending-id guard and `ackedSeqs` lifecycle as sound. Confirmed on the rebase paths that flush first; the "sound" items are about something else.

`replicaSync.ts runRecovery`: pause (line 428), take the lease and fingerprint the rows (432), flush each batch and discard the ack without deleting rows (434, POST at 388), fetch the snapshot (435), commit (436). The worker refuses to commit if the rows changed (`workerHandlers.ts:439`), applies the snapshot, and `reapplyPending` (`apply.ts:94`) replays every non-poisoned row (`:123`) as an unconditional UPDATE (`localOps.ts:203`). Rows are deleted only after resume (468), when the drain re-POSTs the same `batch_id`, the server returns the stored ack with no effects and no new journal row (`routes_ops.py:48`), and `deleteBatch` runs (`opQueue.ts:627`). The hold is intended; the replay of flushed rows is the defect.

Trace: batch B carries `[[Old]] edited`; the server's rename replay stores `[[New]] edited` at seq S; the snapshot (seq at least S) carries `[[New]] edited`; reapply writes `[[Old]] edited` over it. The next pull asks from the snapshot seq, so B's journal row never returns, and own echoes are dropped. The replica stays wrong until someone else writes that block or another snapshot lands. The next local edit to the block carries a stale base hash, so it will probably land as a conflict. The same divergence follows whenever the server's result differs from the wire op: a conflict landing, or another device writing the block between flush and snapshot.

Scope: `recover("rebase")` with flush "preemptible", which covers needs-bootstrap (generation, cursor-ahead, FK, stale title holder) and the window-strikes rebase. Reset drops `pending_ops`, so it is unaffected. The poison rebase flushes nothing, so its replay is correct, except for a preempted normal flush that had posted some rows before aborting.

The pending-id guard (`pendingGuard.ts`, used at `workerHandlers.ts:355-373`) decides whether a feed window fetched against an older pending-id list may still apply after acks deleted rows; `ackedSeqs` is written only by `deleteBatch` (line 314). Neither is read by snapshot application. Fable's items are true and orthogonal.

Tests: `workerHandlers.test.ts:94` replays a row that was never flushed; `replicaSync.test.ts:696` asserts call order against a mocked commit and checks no content. Nothing tests flushed, transformed, then snapshotted.

Action: either delete flushed rows on ack inside the lease (recording the change in the fingerprint), or pass the flushed batch ids into `commitRecovery` so `reapplyPending` skips them. Test with a server response that transforms the op.

### F7 (P2, pre-existing) A reused page id redirects replica references to another page

Astra C6. Fable did not raise it. Confirmed; the mechanism is one step further along than Astra described.

`schema.py:22` declares `id INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so deleting the highest page and inserting another reuses the id. The delete trigger `pages_chg_ad` (`schema.py:162-165`) does write a `('page', old.id, 1)` tombstone row, and the reinsert writes `('page', new.id, 0)`. The loss is downstream: `sync_core.py:61-66 dedupe_window` keys on `(kind, entity_id)` and collapses both rows into one membership entry with no ordering, and `routes_sync.py:203-209` derives tombstones from absence in current state (`present_pages = {p.id for p in pages}`). The id now names a live page, so no tombstone is emitted and `_page_payloads` (`:162-173`) ships the replacement.

On the server, `refs.target_page_id ... ON DELETE CASCADE` (`schema.py:44-49`) silently removes other blocks' refs to the deleted page, and `refs` has no journal trigger. In the replica, `upsertBlock` (`apply.ts:42-49`) clears only the touched block's own outgoing refs, and the cascade in `applyWindow` (`:316-328`, `DELETE FROM pages WHERE id=?` at 323) runs only on a page tombstone, which this window never carries. Stale replica refs to the reused id survive and resolve to the new page. The replica schema is generated from the server's (`baseSchema.gen.ts:27-33`), so it is keyed the same way.

Action: give replicated page identity a non-reuse guarantee (`AUTOINCREMENT`, or a stable uid) or make the feed carry delete-then-recreate for a reused id and refresh dependent refs.

### F8 (P2, pre-existing, narrow) Poison-repair ownership is claimed on a signal and released only on success

Fable C1. Astra did not raise it. Partly confirmed: Path A is real but hard to reach; Path B normally heals itself.

`rejectDurableBatch` pauses and emits `poisonPending` before marking (`opQueue.ts:516-517`); `replicaSync.ts:334` sets `authoritativeRepair = "poison"`. The single release, `completeAuthoritativeRepair`, has one caller (`SyncProvider.tsx:418`) inside the repair that `onPoison` triggers, and `onPoison` fires only for matched intents (`opQueue.ts:438`, `:454`).

Path A, confirmed: `markPoisoned` returns false when no row matches (`replica/queue.ts:162`); `markRetainedPoison` clears the intents, emits nothing and returns `blocked("recovering")`. No problem event, queue paused with no resumer (`runRecovery` skips resume while poison is claimed, `replicaSync.ts:467`), and the early returns at `pullLoop` (610, 613, 656), the deferred rebase (544) and `resetLocalData` (785-786) all take effect. Feed windows still apply and edits pile up in pending; a reload cures it. Reaching it needs the row to vanish between POST and mark, realistically a manual "Reset local data" with discard (flush "skip", `:798`) overlapping an in-flight drain POST the server rejects.

Path B, partly: `discardProblem` (`SyncProvider.tsx:667-679`) does resume without releasing, as Fable said. But the drain then re-POSTs the same unmarked row, the server rejects it again, `markPoisoned` matches, `onPoison` runs the repair, and `:418` releases. The comment at 674-678 intends exactly this. The claim sticks for the session only if the re-POST no longer draws a 4xx (a transient 401 or 429, which is F4's territory) or the replica stays broken.

Action: release ownership when a marking round matches no intents, and from `discardProblem`; one provider test per branch.

### F9 (documented gap) A replica that opens and then fails every write surfaces nothing

Fable C3; Astra lists it as an accepted limitation under pkm-0htf. Agreed by both and not re-verified here. `availabilityOf` returns null for a plain `ReplicaError` (`errors.ts:84-88`), the "only in memory" copy renders only inside `ReplicaUnavailableBanner` (`OfflineIndicator.tsx:53-76`), and the unload guard is desktop-only. `sync-recovery.md:173-176` names it a known gap. Fable proposes rendering the "N unsent changes exist only in memory" copy whenever `unsentInMemory > 0 && status !== "connected"`, independent of the unavailable banner. That proposal reopens a decision: pkm-0htf explicitly limited the protection to the unload guard and dropped a degraded-write banner. It is therefore a policy question for Arthur, listed with the others below, not a scheduled fix. Astra is right that this is a documented decision, not a regression.

## Docs versus code

Confirmed discrepancies, in the order they should be fixed:

| # | Doc site | Says | Code does | Source |
|---|---|---|---|---|
| D1 | `routes_ops.py:2`, `backend.md:227`, `sync-and-offline.md:52` | the write route runs in one transaction | context reads run in autocommit (F2) | both |
| D2 | `sync-recovery.md:203` heading and the failure-table rows at 24-25 | "Recovery never erases intent"; valid rows "must stay durable until deleted" | the replacement window loses them (F1) | Astra |
| D3 | `sync-recovery.md:32`, `:383-385`; `opQueue.replica.test.ts:2046-2068` | "its feed tombstones the ghost" | the feed tombstones the replica row, not the view (F5) | Fable |
| D4 | `sync-and-offline.md:57`, last line of "An online edit, end to end" | feed application ends with "refetch visible views" | views refetch only on a `resyncSeq` bump (`SyncProvider.tsx:4-7`, `reconnectFlow.ts:1-9`, deliberately conditional per pkm-5fak); live views update from WS echoes, as `:66-68` of the same doc says | Astra |
| D5 | `backend.md:208` | `batch_id` optional | `contracts/ops.py:108` requires it (min_length 8, 422 without, since pkm-ri5b) | Fable |
| D6 | `sync-and-offline.md:189-194`, `backend.md:582-592` | "all three change together" | that enumeration names one recursive-walk lineage (`routes_pages._fetch_ancestors`, `localApi/tree.ts`, `localOps.subtreeUids`). pkm-fe9b added a second independently mirrored pair, `localOps.parentChain:121-132` and `ops_apply._parent_chain:98-116`, that neither doc enumerates | Fable, refined |
| D7 | `sync-and-offline.md:249` | "Nothing is discarded: conflict blocks are ordinary blocks, so they reach every..." | true of conflict blocks; F3b and the stale-delete policy below mean the sentence should not be read as a subsystem guarantee | Astra, scope narrowed |

Contract gap, agreed by both: `OpsAck` is not a `response_model` on `/api/ops` (`routes_ops.py:21-24`), so `opQueue.ts:175` and `:189` read `seq` and `skipped` from `unknown` by hand. The comment at `responses.py:443-445` still says the browser "reads only the ops ack's optional `seq`". `opQueue.replica.test.ts:1997` and `:2055` (Astra cited ~1992) use `reason: "missing_target"`, which is not in `SkipReason = Literal["block_not_found", "parent_not_found", "cycle"]` (`ops_core.py:349`, declared again at `responses.py:445`). The fix must keep reading acks stored before it: `seq` may be absent (treated as unknown, so refetch) and a missing `skipped` means empty. Check the serialized wire shape after attaching the model rather than assuming typing alone preserves it.

Carried over from Fable without re-verification and not disputed by Astra: the post-latch ordering inversion (`opQueue.ts:538-557`) exists only in a code comment and needs a failure-table row; `missing_targets.json` pins skip-or-not only, while `sync-recovery.md:31` reads as if the placement table were shared; `frontend.md`'s module map omits `sync/unloadGuard.ts`, `replica/db.ts`, `clientSchema.ts`, `meta.ts`, `daily.ts`, `sha256.ts`; `backend.md § The write path` "Key mechanics" is a long bulleted list whose Conflicts, Missing targets and Concurrent-structure bullets are subsections wearing bullets; the `resyncSeq` exceptions (`sync-and-offline.md:331-342`) have no owning section in the recovery doc; "Seven conditions" / "Three tables" / "Two more" will go stale silently; `sync-recovery.md:81-88` restates `backend.md § Idempotency`; `backend.md:317-318` omits that a diverted subtree loses nesting and heading and that a create+edit of one uid lands both texts; `client/workflows.py:106-108`, `docs/cli.md:124` and `cli/main.py:284` omit `parent_not_found` from their skipped-op wording.

## Maintainability, separation of concerns, FCIS

The reviews agree here and the line counts are confirmed.

| File | Baseline to reviewed commit | Shared assessment |
|---|---:|---|
| `server/src/pkm/server/ops_core.py` | 355 to 742 | Four pure concerns: hashing (33-78), header and label text (81-143), rename replay and text classification (186-278), missing-target family (281-648), then effects and `plan_op` at 651. Healthy churn, but a reader meets 300 lines of skip, label and hash machinery before the planner. Split `conflict_notes.py` and possibly `ops_hash.py`. |
| `server/src/pkm/server/ops_apply.py` | 267 to 399 | Context gathering also creates pages; transaction ownership must be unmistakable (F2). `classify_missing_target` runs three times per op (`:213`, `ops_core.py:663`, `:391-394`) and agreement is by construction, unpinned. Have `plan_op` return the classification and let the shell carry it. |
| `OpContext` (`ops_core.py:377`) | | One 16-field mostly-optional bag for every op kind, guarded by four `raise OpError(index, "conflict context missing")` sites plus asserts. A shell slip there is a 400 that poisons a client queue, the outcome the window worked to remove. Per-kind contexts if the split happens. |
| `web/src/sync/opQueue.ts` | 799 to 870 | Seven concerns in one closure: poison-intent localStorage, listeners, ack parsing, lane ordering, lane delivery, the durable 4xx protocol (F4's predicate lives here twice), `runDrain`, enqueue retention. The 2026-08-17 review said the same at 950 lines. Extract an ordered-outbox core and a typed ack reader; convert the three constructor callbacks to listeners and delete the late-bound refs in `SyncProvider.tsx:258-307`. |
| `web/src/sync/replicaSync.ts` | 800 to 811 | Recovery policies are centralised; acknowledgement ownership (F6) and repair ownership (F8) need an explicit model. Pull `isStallShaped`, `isWindowFailure`, `isFreshCorruption` into a core. |
| `web/src/sync/SyncProvider.tsx` | 735 to 745 | Startup and repair coordination remain hard to reason about independently. |
| `web/src/replica/workerHandlers.ts` | 434 to 486 | The file-transfer protocol needs an explicit durable boundary (F1). Placement rules (keep-vs-reinsert, keep-vs-reshift, follow-the-parent) are inline in `applyOne` while the server keeps its equivalent in the pure planner; that asymmetry is why placement has no shared fixture. |

Vocabulary drift, from Fable: `MissingTargetKind` has six values and `move_cycle` is not a missing target; "skipped" names a kind, an ack list that also holds no-ops and diverted creates, and the CLI wording; `SkipReason` is declared twice with no equality test; `unusable` / `unavailable` / `unreachable` are three words for two values plus a latch; `applied` in the ack counts skipped ops and every reader subtracts.

The six distinctions the confirmed findings turn on (five from Astra's review, the sixth from its combination) are the best statement of what a refactor should make explicit:

- A draft needs its own base identity before it becomes a queued operation (F3).
- A failed delivery attempt is not necessarily a rejected intent (F4).
- An acknowledged operation must be distinguished from one still requiring optimistic replay (F6).
- A replica containing optimistic edits is not a clean copy of server state (F6, F7).
- Holding pending rows in a recovery lease is not the same as keeping them durable (F1).
- Replica convergence and visible-view refresh are separate transitions (F5).

FCIS is respected on both sides: every runtime file declares a pattern, `ops_core.py` imports nothing impure, the web cores contain no I/O, and the checker reports no violations across 191 runtime modules. Passing the checker does not make the shells thin; the pure decisions listed above still live inline in imperative controllers.

Comment convention: the pkm-95ss docs commit applied "comments state the rule, not its history" to two files, and the same window added around 35 bean ids to code comments. AGENTS.md states the no-bean-ids rule for `docs/architecture/` only. Decide the code-side rule in one line, either way.

## Tests

Agreed: both suites green, high coverage, no `.only` or `.skip`, no mocks of the module under test, classification code fully branch-covered on both sides. Also agreed: the coverage is local, and the boundaries are where the defects are. What the confirmed findings say about the suites:

- `workerHandlers.test.ts:573` fails the step after durability is restored; its `discardDbFile` mock cannot expose F1. A test for F1 needs a mock that destroys the old database and fails the open, the schema install and the insert.
- No server test races a delete or rename against a batch through separate connections (F2). `test_ops_idempotency.py:67` depends on the late `BEGIN` and will fail under the fix.
- `outlineState.test.ts:346-349` requires the F3b loss.
- No test anywhere sends a 401 to the queue (F4).
- `opQueue.replica.test.ts:2046-2068` pins F5's wrong premise.
- No test flushes a batch, has the server transform it, and snapshots (F6).
- No test deletes a page and reuses its id across a feed, then compares server and replica refs (F7).
- No test drives an unmatched poison mark or a failed-mark discard and then asserts that delivery, bootstrap recovery and reset can resume (F8).
- No provider test renders `SyncProvider` with a skipped ack and asserts `resyncSeq` moved (F5).
- No shared fixture pins resulting placement state (live-parent landing, stale hint, replay re-page, cross-page) across both sides; `missing_targets.json` pins skip-or-not only.
- No WS-level test asserts that skipped ops are absent from the echo; the server-side exclusion is tested one hop short of the socket.
- No e2e exercises a conflict landing or a skipped op, though four beans in the window exist to make those paths safe. `offline.spec.ts:161` reconnects before reloading and `offline-shell.spec.ts:85` waits for delivery before its offline reload, so neither shows that undelivered edits survive a browser restart.

Shape: `SyncProvider.test.tsx` 2559, `opQueue.replica.test.ts` 2068, `replicaSync.test.ts` 1942, `test_ops_endpoint.py` 1043, `test_ops_core.py` 817 lines, with no `describe` grouping on the web side and `apply.test.ts` groups named by bean id. Stale comments: `opQueue.replica.test.ts:1009-1011`, `:1045-1047` describe the removed count rule; `queue.test.ts:165-169` claims byte-identical lane copies are required, false since pkm-95ss; `test_ops_core.py:218-220` seeds an unneeded `conflict_uid`.

## Accepted limitations and the policy question

Both reviews agree these are decisions, not regressions, and should not be silently converted into tasks:

- pkm-e21b sibling misorder inside the ack window, scrapped with a stated reason. Fable's B3 (a replayed cross-page move keeps the root but not a descendant a window re-shipped at the old page, until the echo) is the same class and deserves a sentence beside it.
- RAM-only fallback edits and the desktop-only unload guard (pkm-0htf limited protection to the guard rather than a degraded-write banner). F9 is its visible face, and Fable's memory-only warning is a proposal to revisit that decision, not an agreed task.
- A diverted subtree keeps its text but loses nesting and heading; create+edit of one uid in a batch lands both texts.
- The post-latch reorder across sessions, safe via hash conflict and missing-target landing.
- Undo of a page no longer mounted, in a session whose replica never opened, ships an unstamped `update_text` (`undoManager.ts:95-107`).
- Conflict day is server-local `date.today()`.

The policy question, from Astra and confirmed against the spec: `docs/superpowers/specs/2026-07-12-offline-editing-design.md:223-225` says structural op kinds including `delete` are "plain LWW, no conflict detection". A stale delete arriving after an unseen edit removes that edit without preservation. Conflict copies protect text edits against text edits, not text against structure. If "no data loss" is meant to cover unseen edits against stale deletes, meeting it is a design change (recoverable deletion or history), not a fix to F1 to F4. Decide this explicitly and record the decision.

Also to record: the handover notes `set_collapsed` on a missing block journals a row (`ops_core.py:580-584`), the one departure from the plain no-op ruling, documented at `backend.md:307`. Fable flags it so the bean table and the ruling agree; both reviews think it is the right call.

## Recommended order of work

1. **Preservation (F1 to F4).** Four small, independent fixes with one composed test each: durable-first file replacement; `BEGIN IMMEDIATE` in `post_ops` (rewrite the idempotency race test); draft base capture and keep-on-disappear (invert the discard test); 401 out of the terminal predicate.
2. **Ghost refetch (F5).** Bump resync on any skipped ack; invert the pinned test; correct D3.
3. **Convergence (F6, F7).** Skip flushed batches in recovery reapply; non-reusable page identity or explicit replacement in the feed.
4. **Ownership release (F8)** and the typed ack: `response_model=OpsAck`, regenerate, replace the two hand readers, single `SkipReason` declaration, fix the two fixture reasons.
5. **Composed tests.** One e2e for the conflict and skip path; a two-connection server race test; a 401 lifecycle test; a pending-edit browser-restart test; interruption at each stage of file replacement; repair-exit release; a WS-level skipped-echo assertion; shared placement-state cases.
6. **Docs.** The guarantee-level corrections travel with the fix that makes them true, in the same branch, as AGENTS.md requires: D1 with F2, D2 with F1, D3 and D4 with F5. D5 to D7 and the carried-over items go in one docs commit; then the shape work under the `architecture-docs` skill.
7. **Policy.** Decide and record separately: the stale-delete question; whether F9's memory-only warning revisits pkm-0htf; the `set_collapsed` tombstone on the foap record; the code-comment bean-id rule.
8. **Web extraction pass** (ordered-outbox core, typed ack reader, listeners for the constructor callbacks, pure `placementFor` with placement cases added to `missing_targets.json`, classifiers out of `replicaSync.ts`), before the next sync feature rather than during one.
9. **Server tidy** (`plan_op` returns the classification; `conflict_notes.py` split; per-kind contexts; `MissingTarget` family rename) and hygiene (regroup the flat test files; the stale comments).

## Where each review was wrong

Recorded so the corrections survive the source reviews, which are not kept.

Astra: Python's `sqlite3` module inserts the implicit `BEGIN`, not SQLite (F2). F2's silent-loss variant does not apply to text carrying refs, tags, attributes or block refs, which 500 and recover on retry. F7's "without the intervening tombstone" is right in effect, but the delete trigger does journal a tombstone; the loss is in `dedupe_window` plus presence-derived tombstones. The fixture with `reason: "missing_target"` is at lines 1997 and 2055, not 1992.

Fable: the data-loss verdict is wrong (F1, F3b, F4 discard user text or queued edits; F2 discards an acknowledged edit). Two "confirmed sound" entries are true statements about a different property from the one at issue (F1, F6). A1's severity is understated because the delete variant was not traced. C1's Path B is narrower than stated, since the designed re-POST normally releases the claim. "The remaining 400s are malformed input" is true of status 400 and misleading about the 4xx predicate.

## Verification and limits

Both reviews ran the same suites at the reviewed commit and got the same numbers:

| Check | Result |
|---|---|
| Server pytest with enforced coverage | 2,109 passed; 97.47% |
| Server pyrefly, ruff | Passed |
| Web unit suite with enforced coverage | 2,736 passed across 175 files; 98.19% statements, 94.10% branches |
| Web typecheck, lint, FCIS check | Passed; 191 runtime modules, no boundary violations |
| Architecture-doc checker | Passed |

Neither review ran Playwright, `perf/check.sh` or real-device iPad verification. Astra's reproductions (sqlite-wasm, two-connection SQLite, mounted `useOutline`) were not re-run for this consolidation; the confirmations above rest on reading the code paths Astra described and finding them as described. Nothing accessed or changed the live database.
