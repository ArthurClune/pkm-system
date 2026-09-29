# Recovery never replays an acknowledged batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rebase that flushed a batch and got its ack deletes that batch's row before the snapshot's replay, so the replica ends with the server's result (a rename replay, a conflict, another device's write) instead of the wire text.

**Architecture:** `replicaSync.flushBatches` holds `{ id, batch_id, seq }` for every ack it receives. The next `commitRecovery` takes that list, and a `rebase` commit passes it as `acked`. In the worker, after the fingerprint check, `rebaseOrReplaceFile` deletes the rows that match an ack by id and batch id, inside the same transaction as the snapshot apply, so `reapplyPending` replays only the rest. On the F1 replacement path the carry receives only the unmatched rows.

**Tech Stack:** TypeScript, sqlite-wasm (in-memory in Node for tests), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F6 Recovery never replays an acknowledged batch, § Shared rules, § Verification per branch. Source finding: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F6. Bean: pkm-yvka (epic pkm-a4t2). F1's shipped mechanism is described in `docs/superpowers/plans/2026-09-29-pkm-9xg0-durable-first-file-replacement.md` (read its "Deviations" section) and `docs/architecture/sync-recovery.md` § Reset, rebase and file replacement.

## Global Constraints

- Work in the worktree you were given. Paths below are relative to its root. Run `git status -sb` before every commit, because worktree agents drift into the main checkout. Use `git diff --no-ext-diff`.
- TDD: each fix's failing test is run and seen red, for the reason stated, before the fix is written.
- Every runtime file declares `// pattern: Functional Core` or `// pattern: Imperative Shell` near the top. Pure predicates, classifiers and transforms go in Functional Core files. `pnpm check:fcis` forbids a Core file importing a value (types are fine) from a Shell module.
- Code and test comments state the rule and carry no bean id. A comment block this branch edits loses any bean ids it had. Commit messages may carry `pkm-yvka`.
- An acked entry matches a row only when **both** `id` and `batch_id` are equal. An entry that matches no row is ignored. That makes an entry held past a failed or preempted run safe, and an id reused after a rebuild safe too.
- The acked-row deletes and the snapshot apply run in **one** transaction (`ReplicaDb.transaction`; nested calls join the outer one, `db.ts`). If the snapshot fails, the deletes roll back with it.
- A `reset` commit carries no `acked` list and the worker ignores acks for a reset, because it drops `pending_ops` anyway. The existing reset assertions (`replicaSync.test.ts` "schema recovery follows the queue/lease/flush/snapshot/commit trace", "resetLocalData flushes, resets and bootstraps", "resetLocalData follows the shared queue/lease/flush/snapshot/commit trace", the corruption-escalation test near `:1606`) stay exactly `{ kind: "reset", snapshot }` and pin that rule.
- F1's guarantees must still hold, and all of its tests must pass unchanged apart from the `acked: []` input edits listed in Task 2. The rows are committed to the carry before the unlink. Every queue handler adopts a leftover carry through `queueDb()`. No acked or deleted batch comes back from a carry. The F1 tests that must stay green are, in `web/src/replica/workerHandlers.test.ts`: "a rebase over a damaged file carries every durable row into a new file", "a rebase keeps the carried rows even if the snapshot then fails on the new file", "a rebase whose new file will not open leaves every row in the carry", "a rebase whose schema install fails on the new file leaves every row in the carry", "a rebase whose row import fails leaves every row in the carry", "a carry write failure leaves the damaged file and its rows in place", "a rebase without a carry store keeps the damaged file", "a snapshot failure after the import leaves no carry to resurrect drained rows", "a worker that dies between discard and import hands its rows to the next worker", "an enqueue served before init on a restarted worker keeps the carried ids", "a failed open leaves the carry for the open after close", "a Retry in the same worker rebases the carried rows", "a deleteBatch served first by a restarted worker adopts the carry", "a nextBatch served first by a restarted worker drains the carried rows", "a local-API write served first by a restarted worker keeps the carried ids", "diagnostics neither adopts a carry nor fails on one", "a replacement at adoption keeps the rows the replica still held beside an empty carry", "a replacement at adoption over a replica it cannot read imports the carry's rows", "a failed carry write leaves no carry behind", "a replacement that fails after the old file is discarded keeps the union in the carry". Also `web/src/sync/replicaSync.fileReplacement.test.ts`, and `carryStore.test.ts`, `carryMerge.test.ts`, `queue.test.ts`, `poolCapacity.test.ts`.
- No route, contract or docstring on the server changes, so no `openapi.json` or web-type regeneration is needed. If one does change, regenerate both before review.
- Docs land in this branch: the spec § F6 Docs correction, plus one row in `docs/troubleshooting.md` (symptom, cause, owning section, `pkm-yvka`). Every edit under `docs/architecture/` is made under the `architecture-docs` skill, and `node .claude/skills/architecture-docs/check-docs.mjs <files>` passes.
- Web unit coverage thresholds in `web/vite.config.ts` still pass.
- Never write the two-word phrase that starts "load" and ends "bearing".
- Shared files. Other wave-2 beans touch some of the same files:
  - `web/src/sync/opQueue.ts` is also touched by pkm-6xza (F5, `ackSkipped`) and pkm-jk1d (typed ack, which replaces `ackSeq`). This plan moves `ackSeq` into `web/src/sync/opsAck.ts`, and pkm-jk1d's single reader should replace it there, keeping `replicaSync.flushBatches` as a caller.
  - `web/src/sync/replicaSync.ts` and `docs/architecture/sync-recovery.md` are also touched by pkm-i35e (F8, repair-ownership release).
  - `sync-recovery.md` is also touched by pkm-6xza (§ Ops on blocks the server no longer has).

## Decisions made here (spec gaps found in the code)

1. **Acks outlive a run that ends before its commit.** The spec says "a preempted flush passes what it acked before it stopped". In the code, though, a preempted flush throws `poisonPreempted`, and `runRecovery` aborts the lease without ever calling `commitRecovery`. So the acks are held in the `createReplicaSync` closure (`heldAcks`), and the **next** `commitRecovery` call takes them, whatever its kind. In the preempted case, the next call is the poison rebase, and it deletes the rows the preempted flush got acks for. In that case the poison rebase's list is therefore not empty, contrary to the spec's "its list is empty". The review names this exact case as the one where the poison replay is wrong. The id-and-batch_id match makes a held entry harmless if the drain has since deleted its row.
2. **The deletes share the snapshot's transaction.** The spec orders them "after the fingerprint check", which still holds. A separate DELETE, though, would commit the deletes even when the snapshot then fails. On a damaged file, that separate DELETE would itself be the first statement to fail. Inside one transaction, a failed snapshot keeps every row. The corruption case then falls into F1's replacement, which carries only the unmatched rows, because the server already holds the matched ones.
3. **`ackedSeqs` is recorded only when the in-place commit succeeds.** On the replacement path, `rebuildSchema` clears `ackedSeqs`. The fresh file's AUTOINCREMENT counter restarts from the highest carried id, so an acked id above it can be reused, and recording it would vouch for a different batch.
4. **`acked` is required on the `rebase` variant of `RecoveryCommit` only.** Typecheck then catches any rebase call site that omits it.

## Review Focus

- A normal rebase whose flush is preempted by a poison repair after one ack: the poison rebase's commit deletes that row, and the snapshot is not overwritten by its wire text. Test in Task 3.
- The snapshot apply fails after the acks were matched (not corruption): no row is deleted, and the drain's later re-POST gets the stored ack, as it does today. Test in Task 2.
- A damaged file during a rebase with acks: the carry holds only the unacked rows, and after a restart no acked row comes back. Test in Task 2.
- A held ack whose row the drain already deleted, or whose id was reused by another batch: it deletes nothing. Test in Task 2 (worker) and Task 1's `splitAckedRows` tests.
- A row enqueued during recovery, alongside acks: the fingerprint still refuses the commit and nothing is deleted. Test in Task 2.

Known consequence, not a defect: a delivery ticket for a batch the commit deleted settles when the drain next sees the durable queue empty (`finishAllDeliveries`, `opQueue.ts`), which is the path `opQueue` already documents for "a batch flushed out-of-band (a recovery lease...)". Normally the rebase flushed every non-poisoned row, so the first drain after resume finds the queue empty.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/sync/replicaSync.ackedReplay.test.ts` | create | The composed test: real `replicaSync` → `Replica` facade → real handlers, with a fake server whose ack transforms the op |
| `web/src/replica/client.ts` | modify | `AckedBatch`; `RecoveryCommit` rebase variant gains `acked`; `deleteBatch` doc comment |
| `web/src/replica/ackedRows.ts` (+ `.test.ts`) | create (Functional Core) | Which lease rows an ack list settles, and which remain |
| `web/src/replica/workerHandlers.ts` | modify | `noteAck`; the rebase commit deletes the settled rows in the snapshot's transaction; the carry gets the remainder |
| `web/src/replica/apply.ts` | modify (comment only) | `reapplyPending`'s "Re-applying is safe" premise |
| `web/src/replica/workerHandlers.test.ts` | modify | New commit tests; `acked: []` on existing rebase inputs; helper `commit` takes acks |
| `web/src/sync/opsAck.ts` (+ `.test.ts`) | create (Functional Core) | `ackSeq`, moved unchanged from `opQueue.ts` |
| `web/src/sync/opQueue.ts` | modify | Imports `ackSeq` from `./opsAck` |
| `web/src/sync/replicaSync.ts` | modify | `heldAcks`; `flushBatches` records acks; `runRecovery` passes them |
| `web/src/sync/replicaSync.test.ts` | modify | Three new tests; the strikes-rebase expectation gains `acked: []` |
| `docs/architecture/sync-recovery.md`, `docs/architecture/frontend.md`, `docs/troubleshooting.md` | modify | Spec § F6 Docs, module map, one troubleshooting row |

---

### Task 1: The composed test across the recovery boundary

This test drives a feed rebase through the real `replicaSync`, the real `Replica` facade and RPC port, and real handlers over an in-memory database. The fake server's ack stands for a rename replay. The test is committed as `test.fails` and flipped in Task 3, so every commit stays green.

**Files:**
- Create: `web/src/sync/replicaSync.ackedReplay.test.ts` (`// @vitest-environment node`)

**Interfaces:**
- Consumes: `buildHandlers`, `serveRpc`, `toPortLike`, `createReplica`, `createReplicaSync`, `openRawTestDb`. Model the harness on `web/src/sync/replicaSync.fileReplacement.test.ts`, without the damage or the carry: `openDb: async () => t.db`, `nowMs: () => 10`.

Fixtures:
- `BEFORE`: the fileReplacement test's `SNAP` (generation `"gen-1"`, seq 5, `uid_b1` text `"hello"`).
- `AFTER`: `{ ...BEFORE, generation: "gen-2", seq: 7, blocks: [{ ...BEFORE.blocks[0], text: "[[New]] edited" }] }`.
- The fake `fetchJson`:
  - `/api/ops` records the body's `batch_id` and returns `{ ok: true, ts: 1, applied: 1, seq: 7, skipped: [] }`.
  - `/api/sync/snapshot` returns `AFTER`.
  - A path starting `/api/sync/changes` returns a feed with `reset: false, generation: "gen-2", plain_space_title_canonicalization: false, next_since: 7, latest_seq: 7` and empty `pages`, `blocks`, `sidebar` and `tombstones`. Its generation differs from the replica's `"gen-1"`, so the first pull answers `needs-bootstrap`, and that runs `recover("rebase")` with flush `"preemptible"`.
  - Anything else throws.

- [ ] **Step 1: Write the test**

`test.fails("a batch the recovery flush got an ack for is not replayed over the snapshot", ...)`:
- `replica.init()`, then `replica.applySnapshot(BEFORE)`, then `replica.enqueue([{ op: "update_text", uid: "uid_b1", text: "[[Old]] edited" }], "b-rename")`.
- `await sync.start()`.
- `posted` equals `["b-rename"]`.
- `t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'")` equals `[{ text: "[[New]] edited" }]`.
- `await replica.pendingBatches()` equals `[]`.
- `await sync.start()` a second time, which runs one more pull. The last `/api/sync/changes` path fetched is `"/api/sync/changes?since=7"`, because the pull resumes from the snapshot's seq, and `uid_b1` still reads `"[[New]] edited"`.

- [ ] **Step 2: Confirm the plain `test` form is red for the right reason**

Temporarily write it as `test(...)` and run `cd web && pnpm vitest run src/sync/replicaSync.ackedReplay.test.ts`.
Expected: FAIL at the text assertion, with `"[[Old]] edited"` received. Any other failure means the harness is wrong, so fix it before going on. Then restore `test.fails` and confirm the file passes.

- [ ] **Step 3: Commit**

```bash
git status -sb
git add web/src/sync/replicaSync.ackedReplay.test.ts
git commit -m "test(pkm-yvka): composed rebase over an acked, transformed batch (expected to fail)"
```

---

### Task 2: The worker's rebase commit deletes the acked rows

**Files:**
- Modify: `web/src/replica/client.ts:49-51` (`RecoveryCommit`) and `:92-96` (`deleteBatch` doc comment)
- Create: `web/src/replica/ackedRows.ts`, `web/src/replica/ackedRows.test.ts`
- Modify: `web/src/replica/workerHandlers.ts`: `ackedSeqs` at `:242-246`, the `deleteBatch` handler at `:406-420`, `rebaseOrReplaceFile` and its doc comment at `:346-385`, the `commitRecovery` call at `:545`
- Modify: `web/src/replica/apply.ts:97-121` (the `reapplyPending` doc comment only)
- Test: `web/src/replica/workerHandlers.test.ts`

**Interfaces:**
- Produces, in `client.ts`:
  - `export interface AckedBatch { id: number; batch_id: string; seq: number | null }`. `seq` is the journal seq the ack named, or null for a stored ack that predates the field.
  - `RecoveryCommit` becomes `{ kind: "reset"; snapshot: Snapshot } | { kind: "rebase"; snapshot: Snapshot; acked: readonly AckedBatch[] }`.
- Produces, in `ackedRows.ts` (`// pattern: Functional Core`; type-only imports of `DurablePendingRow` from `./queue` and `AckedBatch` from `./client`):
  - `export function splitAckedRows(rows: readonly DurablePendingRow[], acked: readonly AckedBatch[]): { settled: AckedBatch[]; remaining: DurablePendingRow[] }`
  - `settled` holds one entry per row whose `id` and `batch_id` both equal an entry's, in row order. On duplicates, the first matching entry wins.
  - `remaining` holds every other row, in order and unchanged.
- Produces, inside `buildHandlers`:
  - `noteAck(id: number, seq: number | null | undefined): void`. It sets `ackedSeqs` when `seq` is a finite number, and deletes the entry otherwise. The `deleteBatch` handler uses it in place of its inline branch.
  - `rebaseOrReplaceFile(snapshot: Snapshot, rows: readonly DurablePendingRow[], acked: readonly AckedBatch[]): Promise<void>`:
    - It first calls `splitAckedRows(rows, acked)`.
    - The `try` block opens `d = await db()`. In `d.transaction(() => { ... })` it runs `deleteBatch(d, a.id)` for each settled entry, then `applySnapshotToDb(d, snapshot, nowMs())`. After the transaction commits, it calls `noteAck(a.id, a.seq)` for each settled entry.
    - The `catch` block is F1's, unchanged, except that `carry.write` receives `remaining` in place of `rows`, and it records no ack (see Decision 3).
  - `commitRecovery`'s rebase branch calls `rebaseOrReplaceFile(input.snapshot, current, input.acked)`.

The doc comment on `rebaseOrReplaceFile` gains this rule: the rows an ack covers are deleted in the snapshot's own transaction, before its replay, so the replica keeps the server's result for them. Only the rest are replayed and, on the replacement path, carried. Replace "`rows` move across verbatim" with "the rows no ack covers move across verbatim". Keep the rest of F1's durable-boundary paragraph.

Replace `reapplyPending`'s sentence "Re-applying is safe: batches flush to the server unchanged." with the rule: a replayed batch is one the server has not acknowledged, since a rebase commit deletes the batches its flush got acks for before the snapshot applies. Only those still flush to the server unchanged.

The `client.ts` `deleteBatch` comment's parenthesis loses "recovery flush" and its bean id. It says that deletes that are not an ack (a rebase settle, a poison discard) omit `ackedSeq`, and that a rebase commit deletes the rows its flush got acks for itself, recording their seqs the same way.

Test fixture edits (existing tests keep their assertions):
- Add `acked: []` to the rebase inputs at `workerHandlers.test.ts:130`, `:192`, `:620` and `:765`.
- `poisonedQueueOverDamagedFile`'s `commit` becomes `commit(acked: AckedBatch[] = [])`, passing `input: { kind: "rebase", snapshot: SNAP, acked }`.

- [ ] **Step 1: Write the failing tests**

`ackedRows.test.ts`, over rows `r1 = { id: 1, batch_id: "a", ... }` and `r2 = { id: 2, batch_id: "b", ... }`:
- `"an ack matching a row by id and batch id settles it and the rest remain"`: `acked [{ id: 1, batch_id: "a", seq: 7 }]` gives `settled` equal to that entry and `remaining` equal to `[r2]`.
- `"an ack whose batch id differs from its row's settles nothing"`: `[{ id: 1, batch_id: "other", seq: 7 }]` gives `settled` equal to `[]` and `remaining` equal to `[r1, r2]`.
- `"an ack for an id no row holds is dropped"`: `[{ id: 9, batch_id: "a", seq: 7 }]` gives `settled` equal to `[]`.
- `"two acks for one row settle it once"`: `[{ id: 2, batch_id: "b", seq: 8 }, { id: 2, batch_id: "b", seq: null }]` gives `settled` equal to `[{ id: 2, batch_id: "b", seq: 8 }]`.

`workerHandlers.test.ts`, using a local two-block snapshot `TWO` (`SNAP` plus `uid_b2` text `"b2"` at `order_idx 1`). The setup:
- `init`, `applySnapshot(TWO)`.
- Enqueue `"acked"` = `[{ op: "update_text", uid: "uid_b1", text: "[[Old]] edited" }]` (row 1).
- Enqueue `"open"` = `[{ op: "update_text", uid: "uid_b2", text: "local pending" }]` (row 2).
- `prepareRecovery`.
- `SERVER` = `{ ...TWO, seq: 7, blocks: [b1 with "[[New]] edited", b2 with "server b2"] }`.

The tests:
- `"a rebase commit deletes the acked rows and replays only the rest"`: commit `{ kind: "rebase", snapshot: SERVER, acked: [{ id: 1, batch_id: "acked", seq: 7 }] }` resolves. `uid_b1` reads `"[[New]] edited"` and `uid_b2` reads `"local pending"`. `SELECT batch_id FROM pending_ops ORDER BY id` equals `[{ batch_id: "open" }]`.
- `"a rebase commit records an acked row's seq as deleteBatch does"`: the same commit, then `applyChanges({ feed: <gen-1 feed, next_since 7, latest_seq 7, empty>, expectedPendingIds: [1, 2] })` resolves to `{ status: "applied", cursor: 7 }`.
- `"an acked row without a seq vouches for no window"`: the same, with `seq: null`, gives `{ status: "pending-changed" }`.
- `"an ack that matches no row by id and batch id deletes nothing"`: `acked [{ id: 1, batch_id: "open", seq: 7 }, { id: 9, batch_id: "acked", seq: 7 }]`. Both rows remain, and `uid_b1` reads `"[[Old]] edited"` (it is replayed as before).
- `"a rebase commit whose snapshot fails keeps the acked rows"`: an injected `applySnapshot` dep that throws `new Error("snapshot apply failed")` once a flag is set after the setup. The commit rejects with that message, and `pending_ops` batch ids are still `["acked", "open"]`. This passes before the fix. It is the guard that fails if the deletes commit outside the snapshot's transaction.
- `"a commit with acked rows still refuses changed durable rows and deletes nothing"`: after `prepareRecovery`, insert a bypass row as in the test at `:23`. The commit with `acked [{ id: 1, batch_id: "acked", seq: 7 }]` rejects with `"pending rows changed during recovery"`, and row 1 is still present. This also passes before the fix, as a guard.
- `"a rebase that replaces the file carries only the rows no ack covers"`: `poisonedQueueOverDamagedFile()`, then `commit([{ id: 2, batch_id: "valid", seq: 7 }])` resolves. The assertions:
  - `carriedAtDiscard()` equals `[rowsBefore[0]]`.
  - `fresh.db` `DURABLE_ROWS` equals `[rowsBefore[0]]`.
  - `uid_b1` reads `"hello"` (the snapshot's text, with the acked `"edited"` not replayed).
  - `carry.exists()` is false.
  - After `handlers.close()` and `handlers.init()`, `pendingBatches` ids equal `[1]` (nothing resurrected).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/replica/ackedRows.test.ts src/replica/workerHandlers.test.ts`
Expected: `ackedRows.test.ts` fails (module not found). "deletes the acked rows" fails, with `"[[Old]] edited"` received and both rows present. "without a seq vouches for no window" fails, with `applied` received (nothing was deleted, so the pending set is unchanged). "carries only the rows no ack covers" fails, with the carry holding both rows. These pass before the fix: "records an acked row's seq" (it is the guard that fails if the delete lands without its seq), the two other guards, "matches no row", and every existing test.

- [ ] **Step 3: Implement `AckedBatch`, `RecoveryCommit`, `splitAckedRows`, `noteAck` and the `rebaseOrReplaceFile` change, and edit the three comments**

The new `RecoveryCommit` no longer accepts `replicaSync.runRecovery`'s `{ kind, snapshot }`. Build the input there by kind, `{ kind: "reset", snapshot }` or `{ kind: "rebase", snapshot, acked: [] }`. Task 3 replaces the `[]`. Update "a window that fails identically WINDOW_STRIKES times rebases before the stall banner" in `replicaSync.test.ts` to expect `{ kind: "rebase", snapshot: SNAP, acked: [] }`.

- [ ] **Step 4: Run the replica suite, the composed tests, typecheck and FCIS**

Run: `cd web && pnpm vitest run src/replica src/sync/replicaSync.fileReplacement.test.ts src/sync/replicaSync.ackedReplay.test.ts && pnpm typecheck && pnpm check:fcis`
Also run `pnpm vitest run src/sync/replicaSync.test.ts`.
Expected: PASS. The Task 1 test still passes as `test.fails`, because replicaSync passes no acks yet.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add web/src/replica/client.ts web/src/replica/ackedRows.ts web/src/replica/ackedRows.test.ts web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts web/src/replica/apply.ts web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts
git commit -m "fix(pkm-yvka): a rebase commit deletes the rows its flush got acks for before the replay"
```

---

### Task 3: The recovery flush holds its acks and the commit takes them

**Files:**
- Create: `web/src/sync/opsAck.ts`, `web/src/sync/opsAck.test.ts`
- Modify: `web/src/sync/opQueue.ts:170-178`. Delete `ackSeq` and its comment, and import it from `./opsAck`. The call at `:627` is unchanged.
- Modify: `web/src/sync/replicaSync.ts`: the closure state near `:268-274`, `flushBatches` at `:373-396`, and `runRecovery`'s commit at `:436-437`
- Test: `web/src/sync/replicaSync.test.ts`
- Modify: `web/src/sync/replicaSync.ackedReplay.test.ts` (`test.fails` becomes `test`)

**Interfaces:**
- Consumes: `AckedBatch` and `RecoveryCommit` (Task 2).
- Produces, in `opsAck.ts` (`// pattern: Functional Core`):
  - `export function ackSeq(ack: unknown): number | undefined`. It is moved unchanged with its doc comment. Add one sentence to that comment saying both delivery paths read it: the drain and the recovery flush.
- Produces, inside `createReplicaSync`:
  - `let heldAcks: AckedBatch[] = []`. Its comment states the rule: these are acks the server gave for leased batches whose rows are still queued. The next commit takes them, so a rebase deletes those rows before its replay, and a run that ends before its commit (a preempted flush) leaves them for the one that follows.
  - `flushBatches`: after each `/api/ops` POST resolves, it pushes `{ id: b.id, batch_id: b.batch_id, seq: ackSeq(ack) ?? null }`.
  - `runRecovery`: right before `commitRecovery`, it takes the list (`const acked = heldAcks; heldAcks = []`). The rebase input built in Task 2 passes `acked` in place of `[]`, and a reset still passes `{ kind: "reset", snapshot }`.

- [ ] **Step 1: Write the failing tests**

`opsAck.test.ts`:
- `"ackSeq reads a finite seq and nothing else"`:
  - `ackSeq({ seq: 7 })` is 7.
  - `ackSeq({ ok: true })`, `ackSeq({ seq: null })`, `ackSeq({ seq: Number.NaN })` and `ackSeq(null)` are each `undefined`.

`replicaSync.test.ts`. The trigger is a `fakeReplica` whose `applyChanges` is `vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" })`, as in "feed rebootstrap uses the same recovery coordinator trace".
- `"the recovery flush hands each ack to the rebase commit, a stored ack without seq as null"`:
  - The lease holds `b-1` (id 1), `b-2` (id 2, `poisoned: true`) and `b-3` (id 3).
  - `/api/ops` returns `{ ok: true, ts: 1, applied: 1, seq: 11 }` for `b-1`, and `{ ok: true, ts: 1, applied: 1 }` for `b-3`.
  - `commitRecovery` is called with `("lease-1", { kind: "rebase", snapshot: SNAP, acked: [{ id: 1, batch_id: "b-1", seq: 11 }, { id: 3, batch_id: "b-3", seq: null }] })`.
- `"a flush preempted by a poison repair hands the acks it got to the poison rebase's commit"`, modelled on "poison preempts a normal recovery lease before its stale flush starts":
  - `prepareRecovery` resolves `{ token: "normal-lease", batches: [b-1 id 1, b-2 id 2] }`, then `{ token: "poison-lease", batches: <same> }`.
  - `/api/ops` for `b-1` calls the captured `onPoisonPending` listener and returns `{ ok: true, ts: 1, applied: 1, seq: 8 }`.
  - `await sync.start()`, then `await sync.rebaseAuthoritative("poison")`.
  - Posted equals `["b-1"]`, and `abortRecovery` was called with `"normal-lease"`.
  - `commitRecovery` was called once, with `("poison-lease", { kind: "rebase", snapshot: SNAP, acked: [{ id: 1, batch_id: "b-1", seq: 8 }] })`.
- `"a commit takes the held acks, so a later rebase passes none of them"`:
  - A normal rebase flushes `b-1` (ack seq 8).
  - Then `await sync.rebaseAuthoritative("poison")`, with a lease of `[]`.
  - `commitRecovery.mock.calls.map(([, input]) => (input as { acked?: unknown }).acked)` equals `[[{ id: 1, batch_id: "b-1", seq: 8 }], []]`.

Flip `replicaSync.ackedReplay.test.ts` to `test(...)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/sync/opsAck.test.ts src/sync/replicaSync.test.ts src/sync/replicaSync.ackedReplay.test.ts`
Expected: `opsAck.test.ts` fails (module not found). The three new replicaSync tests fail with `acked: []` received. The composed test fails with `"[[Old]] edited"` received.

- [ ] **Step 3: Implement `opsAck.ts`, `heldAcks`, the flush's recording and the commit's hand-off**

- [ ] **Step 4: Run the web unit suite, typecheck, lint and FCIS**

Run: `cd web && pnpm test:unit && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: PASS, including every test named in Global Constraints for F1, `opQueue.replica.test.ts`, `SyncProvider.test.tsx` and the composed test.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add web/src/sync/opsAck.ts web/src/sync/opsAck.test.ts web/src/sync/opQueue.ts web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts web/src/sync/replicaSync.ackedReplay.test.ts
git commit -m "fix(pkm-yvka): the recovery flush holds its acks and the next commit takes them"
```

---

### Task 4: Docs

Invoke the `architecture-docs` skill before editing anything under `docs/architecture/`. Verify every claim against the code as shipped in Tasks 2 and 3, not against this plan.

**Files:**
- Modify: `docs/architecture/sync-recovery.md`:
  - § runRecovery: the flowchart near `:309-326`, and prose after the options table
  - § Windows and the pending queue: its last paragraph near `:204-206`
  - § Recovery never erases intent: the guard table near `:211-220`
  - § Reset, rebase and file replacement: near `:355-368`
- Modify: `docs/architecture/frontend.md`, the module map near `:130-151`
- Modify: `docs/troubleshooting.md`, the sync table after the pkm-9xg0 row near `:123`

- [ ] **Step 1: `sync-recovery.md`**
  - § runRecovery flowchart:
    - The `F` node reads `flushLease: skip · preemptible · blocking<br/>each ack held as { id, batch_id, seq }`.
    - The `RS` node reads `rebaseOrReplaceFile<br/>acked rows deleted in the snapshot's transaction`.
  - § runRecovery, below the options table: a short note, or a two-row table, saying:
    - The next `commitRecovery` takes the held acks, whatever its kind.
    - A run that ends before its commit (a preempted flush) leaves them for the one that follows, which is the poison rebase.
    - A rebase commit deletes each row matching an ack by id and `batch_id`, then applies the snapshot, and `reapplyPending` replays only the rest.
    - A reset carries no list.
    - The reason, in one sentence: the server's result can differ from the wire op (a rename replay, a conflict, another device's write), and the next pull starts at the snapshot's seq, so that batch's journal row never returns.
  - § Windows and the pending queue: the `ackedSeqs` paragraph says the entries are written by `deleteBatch` and by a rebase commit that deletes acked rows. It adds that they are not written after a file replacement, whose rebuild clears them.
  - § Recovery never erases intent: add one guard row. Guard: "A rebase commit deletes the rows its flush got acks for, in the snapshot's transaction, before the replay". Where: `replicaSync.ts::flushBatches`, `workerHandlers.ts`, `replica/ackedRows.ts`. What it stops: "Recovery replaying a batch's wire text over the server's result".
  - § Reset, rebase and file replacement: "The queue is committed to the carry database" becomes "The rows no ack covers are committed to the carry database", and step 1's action reads `carry.write(remaining)`.
- [ ] **Step 2: `frontend.md` module map**
  - Under `replica/`: `ackedRows.ts  Core  Which lease rows a recovery commit's acks settle`.
  - Under `sync/`: `opsAck.ts  Core  Reads the /api/ops ack's seq`.
- [ ] **Step 3: `docs/troubleshooting.md`**
  - Symptom: "After a resync, a block shows the text you sent rather than what the server saved (for example `[[Old]]` after the page was renamed to New), until someone edits it again, and the next edit lands as a conflict".
  - Cause: "Recovery flushed each queued batch, discarded the acks, then replayed every row over the snapshot as an unconditional update. The flush now holds each ack, and the rebase commit deletes those rows before the replay".
  - Where: `[sync-recovery.md § runRecovery](architecture/sync-recovery.md#runrecovery)`.
  - Ref: `pkm-yvka`.
- [ ] **Step 4: Check**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/architecture/frontend.md docs/troubleshooting.md`
Expected: no findings. Then run `grep -n "discard.*ack\|replays every\|move across verbatim" docs/architecture/*.md` and fix any claim this change made stale.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add docs/architecture/sync-recovery.md docs/architecture/frontend.md docs/troubleshooting.md
git commit -m "docs(pkm-yvka): recovery deletes acked rows before the replay

Corrected: the carry holds the rows no ack covers; ackedSeqs are also written by a rebase commit.
Added: the held-ack hand-off in runRecovery, a guard row, module map entries, troubleshooting row."
```

---

### Task 5: Verification and bean

- [ ] **Step 1: Web verification**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: all pass, with coverage thresholds met. No e2e spec is added or changed, so no Playwright run is needed here. The orchestrator runs the full Playwright suite and `perf/check.sh frontend` after merge, so do not run either.

- [ ] **Step 2: Bean**
  - Tick the first three todos: `beans update pkm-yvka --body-replace-old "- [ ] <item>" --body-replace-new "- [x] <item>"`.
  - Replace `- [ ] verify, perf, merge` with `- [x] verify (typecheck, lint, check:fcis, test:coverage, build)` and `- [ ] perf, merge (orchestrator)`.
  - Append `## Summary of Changes` with `--body-append`. Cover the held-ack list and its hand-off, the id-and-batch_id match, the deletes sharing the snapshot's transaction, and the carry receiving the remainder. Include the four decisions above and why, the docs touched, and the test counts.
  - Then run `beans update pkm-yvka -s completed`.
- [ ] **Step 3: Commit**

```bash
git status -sb
git add .beans/
git commit -m "chore(pkm-yvka): bean checklist and summary"
```
