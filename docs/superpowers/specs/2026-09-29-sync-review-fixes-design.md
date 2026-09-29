# Sync review follow-ups: preservation and convergence fixes — design

Epic: pkm-a4t2. Source:
`docs/2026-09-29-sync-subsystem-review-consolidated.md` (findings F1 to F9,
the contract gap, and the policy questions). Structure, mechanisms and the
three policy decisions approved in conversation 2026-09-29.

| Section | Bean | | Section | Bean |
|---|---|---|---|---|
| F1 | pkm-9xg0 | | F6 | pkm-yvka |
| F2 | pkm-gwwu | | F7 | pkm-8uc9 |
| F3 | pkm-impk | | F8 | pkm-i35e |
| F4 | pkm-jyx1 | | Typed ack | pkm-jk1d |
| F5 | pkm-6xza | | F9 | pkm-l3cr |

## Why

The consolidated review confirmed four paths that discard a user's text or a
queued edit (F1 to F4), four defects that leave the local model wrong or the
session stuck without loss (F5 to F8), an untyped ack contract, and one
documented UI gap (F9). Each has a small, independent fix. The defects sit
beside the window's own fixes, on paths those fixes touched but did not close,
and every one lives in a gap between the editor, the queue, the server, the
feed and recovery that no existing test composes. So each fix ships with one
composed test across that boundary and with the doc correction that becomes
true with it.

Non-goals: who wins a conflict (incoming still wins, last-writer-wins); the web
extraction pass and the server tidy (their own beans, designed when picked up);
the hash-guarded delete (a draft feature, brainstormed separately).

## Shared rules

- A fix, its composed test and its doc correction land in one branch.
- Comments in code these fixes touch state the rule and carry no bean id
  (decision below).
- A route or contract change regenerates `openapi.json` and the web types
  before the branch is reviewed.
- Order: F1 to F4 first, independent of each other. F6 after F1, since both
  rewrite the rebase commit path. F5 before the typed ack, which then replaces
  the reader F5 extends.

## F1 Durable-first file replacement

**Problem.** `rebaseOrReplaceFile` (`web/src/replica/workerHandlers.ts`)
unlinks the damaged replica file and its journal, opens a fresh one, installs
the schema and only then inserts the carried pending rows. From the unlink to
that commit the rows exist only in worker memory. The poison repair flushes
nothing first, so those rows are edits the server has never seen.

**Mechanism: a carry database.** The rows are committed to a second, small
SQLite file in the same OPFS pool before the damaged file is touched, and the
fresh file imports them from there.

| Step | Action | If the worker dies here |
|---|---|---|
| 1 | Open `/pkm-replica-carry.sqlite3` in the pool, create `pending_ops` with the replica's columns, insert every row verbatim (`id`, `batch_id`, `ops_json`, `poisoned`, `error`), commit, close | both files hold the rows; the next rebase rewrites the carry |
| 2 | Discard the damaged file and its journal (existing `discardDbFile`) | only the carry holds them; adopt-on-open restores them |
| 3 | Open the fresh replica file, install the schema, `INSERT OR IGNORE` the carry's rows by `id`, commit | same |
| 4 | Apply the snapshot, which reapplies pending as now | both hold them; the ignore-by-id import is a no-op |
| 5 | Unlink the carry file and its journal | done |

As shipped, the order differs from this table: the carry is discarded straight
after the import, and every handler adopts a leftover carry on entry, not only
`init`. See Deviations in `docs/superpowers/plans/2026-09-29-pkm-9xg0-durable-first-file-replacement.md`.

**Adopt-on-open.** The handlers' `init`, once the schema check has run and
before any other handler is served, asks the carry store whether a carry file
exists. A leftover one is imported into `pending_ops` with the same
ignore-by-id insert and then discarded. Because `poisoned` and `error` travel
with the rows, startup's poison discovery sees the same state it would have
seen before the replacement.

**Boundaries.** `buildHandlers` receives a carry store `{ exists(),
write(rows), read(), discard() }` beside `discardDbFile`; `worker.ts`
implements it over a second pool database and the pool's file listing, so the
handler logic stays testable with fakes. `MIN_POOL_CAPACITY` (6) covers the
replica file, its journal, the carry and its journal; the plan confirms that
arithmetic against the pool's accounting.

**Not chosen.** Building the new replica under another name and switching to
it: the pool has no rename, so the active file name would need its own
durable pointer.

**Tests** (`workerHandlers.test.ts`). The fake `discardDbFile` replaces the
database with an empty one, so the old rows are really gone. Fail the open,
the schema install and the insert in turn and assert the rows are in the
carry. Simulate a dead worker by running steps 1 and 2, building fresh
handlers over the same fakes, and asserting adopt-on-open restores the rows
with their ids. The existing snapshot-failure test stays.

**Docs.** `sync-recovery.md § Recovery never erases intent` and the two
failure-table rows the review cites become true; `§ Reset, rebase and file
replacement` gains the carry step. The handler comment that says the rows
"commit before the snapshot applies" is rewritten to state the durable
boundary.

## F2 The ops route owns one transaction

**Problem.** `open_db` sets neither `isolation_level` nor `autocommit`, so
Python's `sqlite3` module begins the implicit transaction at the first write.
In `post_ops` the `applied_batches` read and op 0's context reads run in
autocommit, and `delete_page`, `rename_page` and `cleanup_journal` commit
concurrently from the threadpool. A delete landing between the context read
and the `UPDATE` matches zero rows, stores an `ok` ack, and the text is
nowhere.

**Mechanism.** `post_ops` issues `BEGIN IMMEDIATE` as its first statement,
before the dedupe read, following `routes_sidebar.py`. Every exit ends the
transaction: the replay path and the error paths roll back, the success path
commits as now. A lock the busy timeout could not take
(`sqlite3.OperationalError`, "database is locked") returns 503 with
`Retry-After`, which the client's predicate already treats as retry-later.
The `IntegrityError` branch in `routes_ops.py` goes: with context and effects
in one transaction the concurrent delete it caught cannot interleave.

**Tests.** `test_ops_idempotency.py`'s injected commit "before the loser's
write transaction starts" depends on the late `BEGIN`; it is rewritten so the
second connection (with a short busy timeout) is shown to block and the batch
is unaffected. New tests through `POST /api/ops` with a second connection: a
page deleted before the route lands the text on today's daily page; a rename
before the route cannot resurrect the old title.

**Docs.** D1: the `routes_ops.py` docstring (a docstring edit stales
`openapi.json`), `backend.md § The write path`, and the `sync-and-offline.md`
line that says the route runs in one transaction all become true.

## F3 A draft carries its own base identity

**Problem.** A draft is `{ uid, text }`. Remote ops reach the tree under it,
and at flush `stampBaseTextHashes` hashes the tree, which already holds the
remote text, so the server sees a clean edit and the remote author's text is
overwritten with no conflict copy. When a remote batch removes the block (a
delete, or a cross-page move), `pendingTextOps` returns nothing and the local
text is dropped, although the server would land it on the daily note.

**Mechanism.**

- The draft records `base`: the tree node's text at the moment the draft is
  created (the first `onDraftChange` while no draft is pending). Later
  keystrokes keep it. The draft becomes `{ uid, text, base }`.
- `pendingTextOps(pending, blocks, pageTitle)` returns nothing when there is
  no draft, when `text === base` (nothing typed), or when the block is present
  with `node.text === text` (a remote edit already made this change, so
  sending it would only fork a duplicate conflict copy). Otherwise it returns
  the op stamped with `base_text_hash = sha256Hex(base)` and `page_title`,
  whether or not the block is still in the tree. `stampBaseTextHashes`
  already leaves a stamped op alone.
- Nothing else changes: `applyOps` skips an op for a uid it cannot find, the
  replica's local apply already skips an `update_text` on a missing block
  (`shared/fixtures/missing_targets.json`), and the server lands it on today's
  daily note, from where the feed brings it back.
- The `initial`-change effect in `useOutline.ts` clears a draft without
  flushing. The bean traces whether a production parent reaches it with a live
  draft and, if one does, flushes the draft first. The outcome is recorded on
  the bean either way.

With the base captured, the text-versus-text outcome no longer depends on
arrival order: the local flush carries the hash of the text the user saw, so
the server keeps the remote text as a conflict copy on the daily note.

**Tests.** `outlineState.test.ts` "drops a pending draft whose block a remote
batch deleted" is inverted: the draft is flushed, stamped with its base hash.
New: a remote update during a debounced draft flushes with the pre-remote
hash; a remote delete and a remote cross-page move during a debounced and a
held draft both flush; `text === base` and identical-remote-edit both
suppress.

**Docs.** `frontend-editor.md § Drafts and commit points` (the draft's
shape and base), `sync-and-offline.md` conflict section (order independence),
and D7's sentence about nothing being discarded is scoped to what it covers.

## F4 An authentication failure is not a rejection

**Problem.** The terminal predicate at both delivery sites is "any `ApiError`
in 400 to 499". A 401 from `require_auth` (expired session, rotated secret,
cleared cookie) therefore poisons a durable batch and drops a lane entry, and
after login the poison repair deletes an edit the server never received.

**Mechanism.** One Functional Core predicate, `isTerminalRejection(error)` in
`web/src/sync/rejection.ts`: an `ApiError` with a 4xx status is terminal
unless the status is 401, 403, 408 or 429. Those take the network-failure
path: backoff, head retained, nothing poisoned, nothing written to
localStorage. Both sites in `opQueue.ts` call it.

`apiFetch` still navigates to `/login` on a 401. Durable rows survive that
navigation. Lane entries die with the tab unless the desktop unload guard
holds; that is the gap F9 narrows, recorded here rather than fixed.

**Tests.** `opQueue` tests, lane and durable: a 401 and a 429 leave the batch
retained and unpoisoned with no poison intent, and it delivers on the next
kick that returns 200; 400, 409 and 422 stay terminal. E2E: edit a test page,
clear the session cookie, let the drain hit 401 and redirect, log in, and find
the edit on the server.

**Docs.** `sync-recovery.md` failure-modes table: a new row for these
statuses; every "4xx" in `sync-recovery.md` and `sync-and-offline.md` that
means "rejected" is qualified.

## F5 A skipped ack refetches the view in every tab

**Problem.** Only the lane, and only under the no-replica latch, reads the
ack's `skipped` list. A replica-backed online tab tombstones the row in the
replica and keeps the ghost on screen, and every debounced edit into it lands
another orphan-edit child on today's daily note. The feed tombstones the
replica row, not the view.

**Mechanism.** Both delivery paths consult `ackSkipped`. Any ack naming a
skipped op emits the queue's callback (renamed from `onSkippedNoReplica` to
`onSkipped`) regardless of `unavailable`, and the sync event (renamed from
`ops-skipped-no-replica` to `ops-skipped`) bumps resync. Cost: one extra
view refetch per skipped ack in a tab whose feed would also have converged.

**Tests.** Invert the `opQueue.replica.test.ts` test "does not refetch (it
has a feed to tombstone the ghost)"; add the durable-path case; rename the
`syncState` case; render `SyncProvider`, deliver a skipped ack, assert
`resyncSeq` moved.

**Docs.** D3: `sync-recovery.md § Ops on blocks the server no longer has`
and the failure row say the feed tombstones the row and the ack refetches the
view. D4: the last step of the online-edit diagram in `sync-and-offline.md`
reads "refetch visible views only when the catch-up moved local data or an
ack skipped an op". A correction is appended to the pkm-c2gs bean's summary.

## F6 Recovery never replays an acknowledged batch

**Problem.** A rebase flushes every leased batch, discards the acks, fetches
the snapshot and commits; `reapplyPending` then replays every non-poisoned
row over the snapshot as an unconditional `UPDATE`. When the server's result
differs from the wire op (rename replay, a conflict landing, another device's
write), the replica ends with the wire text and stays wrong until something
else writes that block.

**Mechanism.** `flushBatches` records `{ id, batch_id, seq }` for every
batch the server acknowledged, including a replayed stored ack (`seq` may be
null). `runRecovery` passes that list as `acked` in `commitRecovery(token,
{ kind, snapshot, acked })`. In the worker's commit, after the fingerprint
check passes, each acked row is deleted with the same bookkeeping as
`deleteBatch` (`ackedSeqs` set when `seq` is a number, cleared otherwise), and
only the remaining rows are carried (F1) and replayed. A `reset` drops
pending anyway. The poison rebase flushes nothing, so its list is empty; a
preempted flush passes what it acked before it stopped.

The fingerprint stays as it is: taken at prepare, compared before the
deletes, so a row enqueued during recovery still aborts the commit.

**Not chosen.** Deleting on ack inside the flush: it would race the lease's
fingerprint and the worker gate, and would keep the post-resume re-POST that
the stored ack answers.

**Tests.** `replicaSync.test.ts`: the acked list reaches `commitRecovery`.
`workerHandlers.test.ts`: a commit with acked rows deletes them and replays
only the rest. A content test: a row carrying `[[Old]] edited` is flushed, the
fake server acks it, the snapshot carries `[[New]] edited`, and after the
commit the replica reads `[[New]] edited` and the row is gone.

**Docs.** `sync-recovery.md § runRecovery` (flush, acked list, commit deletes
them) and `§ Windows and the pending queue` where it describes what
`deleteBatch` records.

## F7 A reused page id reaches the feed as delete-then-create

**Problem.** `pages.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so
deleting the highest page and creating another reuses the id. The delete
trigger journals a tombstone, but `dedupe_window` collapses both rows to one
entry and `routes_sync` derives tombstones from absence in current state, so
the live replacement is shipped with no tombstone. Replica refs to the old
page survive and resolve to the new one.

**Mechanism.** The window query selects `deleted` as well. `dedupe_window`
takes `(seq, kind, entity_id, deleted)` and returns each entity with a
`tombstoned` flag, true when any row for it in the window is a delete.
`routes_sync` emits a tombstone for an entity that is absent from current
state, as now, or flagged; the live payload is still shipped when present.
The replica needs nothing new: tombstones already lead the window, so the page
delete cascades the old page's blocks and refs before the upserts land the new
page. The flag applies to the id-keyed kinds, `page` and `sidebar`. Blocks
keep the presence rule: their uids are never reused. Whether the same shape
matters for a uid that undo recreates is outside this finding and noted on the
bean.

**Not chosen.** `AUTOINCREMENT`: SQLite cannot add it to an existing table,
so the live `pages` table, referenced by three others, would need a rebuild,
and DDL is the only migration mechanism. A stable page uid is a larger change
for the same effect.

**Tests.** `sync_core`: the flag. `routes_sync`: create two pages, delete the
higher, create a third that takes its id, pull from before the delete, and
find both the tombstone and the new page. Replica apply: a window carrying a
tombstone and a live page for one id leaves the old page's blocks and the
other blocks' refs to that id gone and the new page present.

**Docs.** `sync-and-offline.md` feed section: the tombstone rule is "absent
from current state or deleted within the window". The changes-route row in
`backend.md`'s API table, if it describes tombstones.

## F8 Repair ownership is released on every exit

**Problem.** `rejectDurableBatch` claims the recovery barrier and emits
`poisonPending` before marking; `replicaSync` sets `authoritativeRepair =
"poison"`. The one release runs inside the repair that a matched intent
triggers. A marking round that matches no row (the row vanished between POST
and mark) leaves the claim held with no resumer, and `discardProblem` resumes
the queue without releasing.

**Mechanism.** `markRetainedPoison` reports a round in which intents were
present and none matched; `replicaSync`, as the owner of the claim, releases
it and resumes the queue. `discardProblem` releases before it resumes; the
designed re-POST then re-enters `rejectDurableBatch` and claims again if the
server rejects again.

**Tests.** One test per branch: an unmatched round releases the claim, resumes
delivery and lets a later bootstrap recovery run; `discardProblem` releases
and the re-POST path still repairs.

**Docs.** `sync-recovery.md § A batch the server rejects`: the ownership
lifecycle in one table (claimed on rejection; released on repair success, on
an unmatched marking round, or on discard).

## Typed ack

**Problem.** `OpsAck` is not the route's `response_model`, so the web reads
`seq` and `skipped` from `unknown` by hand, `SkipReason` is declared twice,
and two fixtures use a reason that does not exist.

**Mechanism.**

- `@router.post("/api/ops", response_model=OpsAck)`. The stored-ack replay
  passes through the model: `seq` becomes `null` when the stored ack predates
  it, `skipped` defaults to empty. The wire shape is checked after attaching
  the model: `seq: null` must stay on the wire, since the client reads null
  as "unknown, so refetch".
- `SkipReason` is declared once, in `contracts/responses.py` (contracts do
  not import server modules), and `ops_core.py` imports it.
- `openapi.json` and the web types are regenerated. `opQueue.ts` reads the
  generated `OpsAck` through one reader that tolerates a missing `seq` or
  `skipped`, replacing `ackSeq` and `ackSkipped`.
- The two fixtures with `reason: "missing_target"` become `block_not_found`.
  The `responses.py` comment that says the browser reads only an optional
  `seq` is updated. `client/workflows.py`, `docs/cli.md` and `cli/main.py`
  add `parent_not_found` to their skipped-op wording.

**Tests.** Server: a replayed stored ack without `seq` serializes `seq: null`
and `skipped: []`. Web: the reader over an ack missing either field.

**Docs.** `backend.md` API table: response model for the route, and D5
(`batch_id` is required, minimum length 8, 422 without).

## F9 Memory-only edits are named while offline

**Problem.** A replica that opens and then fails every write keeps edits in
the in-memory lane. The "exist only in memory" sentence renders only inside
the replica-unavailable banner, so this state looks like healthy offline
queueing, and the unload guard is desktop-only.

**Decision.** Show the sentence whenever the lane is non-empty and the
socket is down. This narrows pkm-0htf's decision rather than reversing it:
the degraded-write banner it dropped needed a failure counter and a threshold;
this is a display rule over `unsentInMemory`, which pkm-0htf built.

**Mechanism.** `OfflineIndicator` reads `unsentInMemory` from the sync
context. The offline `ConnectivityBanner` appends the existing memory-only
sentence when `unsentInMemory > 0` and `status !== "connected"`; the
sentence's helper is generalised so both banners use it. Online, the lane
drains within a drain cycle, so the sentence never shows in a healthy session.

**Tests.** `OfflineIndicator`: renders offline with lane entries; not when
connected; not offline with only durable rows pending.

**Docs.** `sync-recovery.md § What the UI shows` and the F9 failure row.

## Policy decisions

| Question | Decision (2026-09-29) | Recorded |
|---|---|---|
| A stale `delete` arriving after an edit it never saw removes that edit with no conflict copy | Close it with a hash-guarded delete: the op carries the subtree's base hash, the delete still wins, and on divergence the server's texts land under the block's daily-note conflict header. A draft feature bean under the epic, brainstormed after F1 to F4. Until it ships the docs state the limit as open, not accepted. | this spec; the draft bean; `sync-and-offline.md` conflict section |
| F9's memory-only warning versus pkm-0htf | Yes, as above; the degraded-write banner stays dropped | F9 section; `sync-recovery.md` |
| Bean ids in code comments | Banned, as in `docs/architecture/`. A comment states the rule; history lives in git, the beans and `troubleshooting.md`. One line in AGENTS.md. Existing ids (about 620 in runtime code, 440 in tests) are removed by a separate low-priority sweep that rewrites each comment to state its rule | AGENTS.md; the sweep bean |
| `set_collapsed` on a missing block journals a row, the one departure from the plain no-op ruling | Right call, as both reviews said. Recorded on the pkm-foap bean so the ruling table and the code agree; `backend.md` already says it | pkm-foap bean |
| pkm-e21b's class of accepted ack-window misorder | A replayed cross-page move keeping the root but not a descendant a window re-shipped at the old page, until the echo, is the same class; one sentence beside it | docs bean |

## Tracked without design here

These are beans under the same epic. None needs a mechanism decided now.

- **Composed tests** that belong to no fix: an e2e for a conflict landing and
  a skipped op; an e2e that edits, goes offline, restarts the browser and
  finds the edit delivered; a WS-level assertion that skipped ops are absent
  from the echo; placement-state cases (live-parent landing, stale hint,
  replay re-page, cross-page) added to `missing_targets.json` and pinned on
  both sides.
- **Docs commit**: D6 (the second mirrored pair, `parentChain` and
  `_parent_chain`), D7's scope, the carried-over items in the review's docs
  section, the pkm-e21b sentence, the `set_collapsed` record, then the shape
  work under the `architecture-docs` skill.
- **Bean-id sweep** in code comments, per the decision above.
- **Web extraction pass**: ordered-outbox core and typed ack reader out of
  `opQueue.ts`, listeners for the three constructor callbacks, a pure
  `placementFor`, the classifiers out of `replicaSync.ts`. Architectural; its
  own spec when picked up, before the next sync feature.
- **Server tidy**: `plan_op` returns the classification; `conflict_notes.py`
  split; per-kind contexts; `MissingTarget` family rename; the stale test
  comments and flat test files the review lists.

## Verification per branch

Server: `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`.
Web: `pnpm verify`. Route or contract changes: the regen checklist.
`perf/check.sh` once per completed fix, before merge. The epic's final review
runs the whole set on the merged tree.
