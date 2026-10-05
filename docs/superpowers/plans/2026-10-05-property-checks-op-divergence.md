# Op divergence property (pkm-j3ui) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A property in `proptest/check.sh web` that runs the same op batches through the server, the replica's optimistic apply and replay, and the in-memory outline tree, and fails on any difference outside a fixed list of documented exclusions.

**Architecture:** A fast-check async property (`web/src/props/ops/ops.prop.ts`) against the harness server on port 8978. Each example seeds a drawn multi-page state through the real ops route, then runs raw-batch steps (optionally with another device's batch and a real feed window between enqueue and POST) or f7zv outline-command steps, and checks echo → tree (1), command → server (2), replica → server (3), replay = first apply (R) and rejection agreement after every step. Pure parts (arbitraries, resolution, comparison) are Functional Core; the example runner and the property are Imperative Shell.

**Tech Stack:** TypeScript, fast-check, vitest (`vitest.props.config.ts`), sqlite-wasm in node (`replica/testDb.ts`); Python/FastAPI for the harness server (`server/tooling/proptest/sync_server.py`), pytest.

**Spec:** `docs/superpowers/specs/2026-10-05-property-checks-op-divergence-design.md`

## Global Constraints

- Every new file with runtime behaviour carries `// pattern: Functional Core` or `// pattern: Imperative Shell` (`#` for Python); tests are exempt.
- No bean ids in code or test comments.
- The harness routes live in `sync_server.py` only, never in `pkm.server.app`.
- Port 8978 is the harness server; check `lsof -iTCP:8978 -sTCP:LISTEN` before a gate run. Give `pnpm verify` its own `E2E_PORT` (8981).
- Suite page titles: `Outline Props`, `Ops Two`, `Ops Three`; title pool adds `Ops Four`, which never exists at the start (no seed text may reference it).
- Uids: pool `opsb00`…`opsb29`; raw creates `opsc<n>`; command-minted `opsn<n>`; all match `[a-zA-Z0-9_-]{6,32}`.
- Budget: about 60 s of `proptest/check.sh web`; property time limit 120 s.
- Comparisons ignore timestamps; tree form compares `order_idx` exactly.
- Commit messages end with `Co-Authored-By: Claude …` only; never a `Claude-Session:` trailer or claude.ai URL.

## Review Focus

1. A batch that commits no broadcast (a 400, a replayed batch id) must read "no echo", never the previous batch's echo — pinned in Task 1 (`take` clears).
2. A window that is not at the journal head must never be checked by R — pinned in Task 6 (the runner throws a harness error if `next_since !== latest_seq`).
3. A page set aside for an authoritative reload takes the server's tree for later steps, as the reload would — pinned in Task 6's fixed scenario.
4. Seed text referencing a pool title would mint `Ops Four` at the start — pinned in Task 5 (`startStateArb` test: no seed text references `Ops Four`).
5. Batch ids must be unique within an example across B, O and seed batches, or the server answers 409 reuse — pinned in Task 6 (ids from one per-example counter; a test asserts a 409 is reported as a harness error, not a finding).

## Rulings made while planning (bring to Arthur with the plan)

- **Check 3 on an O step uses R's key rule.** When the window re-shipped a row the pending batches touched, `reapplyPending` legitimately shifts keys (keepSlot's clash rule), so exact keys against the server would fail by design; check 3 then compares structurally (sibling rank), and exactly otherwise.
- **The runner gains two things** (props code only): a uid prefix for minted uids, because `n0` fails the server's `UID_RE`, and the list of wire batches the editor would have sent (`useOutline.run`'s flush + command batch, stamped as it stamps them; undo/redo stamped as `undoManager` stamps them).

---

### Task 1: Harness echo route and teeth mode

**Files:**
- Modify: `server/tooling/proptest/sync_server.py` (in `build_app`, beside the other `/__proptest/*` routes; `reset` clears echo state)
- Modify: `web/src/props/sync/serverControl.ts` (three methods)
- Test: `server/tests/test_proptest_sync_server.py`

**Interfaces:**
- Produces (HTTP, auth required like the others):
  - `POST /__proptest/echo/take` → `{"ops": [...]} | {"ops": null}`: the `ops` of the last broadcast frame carrying `ops` since the previous take or reset, then clears it.
  - `POST /__proptest/echo/teeth` body `{"drop_cross_page_title": bool}`: while true, recorded echoes have `page_title` set to `null` on every `move` op whose `page_title` is not null. Reset sets it false.
- Produces (TS, on `ServerControl`): `takeEcho(): Promise<BlockOp[] | null>`, `setEchoTeeth(on: boolean): Promise<void>`, `changes(since: SyncSeq): Promise<Changes>` (GET `/api/sync/changes?since=`).

- [ ] **Step 1: Write failing tests** in `test_proptest_sync_server.py`:
  - `test_echo_take_returns_the_last_batch_ops_then_none`: POST a batch with one `create_page` and one `create`; `take` returns two ops with the stored `page_title`; a second `take` returns `{"ops": None}`.
  - `test_echo_take_is_none_after_a_rejected_batch`: commit a batch, take; POST a 400 batch (create of a live uid); `take` returns None.
  - `test_echo_is_cleared_by_reset`.
  - `test_echo_teeth_drops_cross_page_move_titles`: arm teeth, POST a move of a seeded block to the `Second` page's top level with `page_title: "Second"`; the taken op has `page_title is None`; after reset a same batch keeps it.
  - `test_echo_routes_need_auth` (401 for both, as `test_renames_route_needs_auth`).
- [ ] **Step 2:** `cd server && uv run pytest tests/test_proptest_sync_server.py -q` → the five fail.
- [ ] **Step 3: Implement.** Wrap `app.state.hub.broadcast` in `build_app` with an async function that records `message["ops"]` (rewritten when teeth are armed) into a closure-held state and then awaits the original. Add the three `ServerControl` methods.
- [ ] **Step 4:** Same pytest → pass; `uv run pyrefly check`, `uv run ruff check`; `cd web && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(proptest): echo take and teeth control routes`.

### Task 2: The authoritative-reload predicate moves to `tree.ts`

**Files:**
- Modify: `web/src/outline/tree.ts` (new export), `web/src/outline/outlineSessions.ts:636-639` (call it)
- Test: `web/src/outline/tree.test.ts`

**Interfaces:**
- Produces: `export function needsAuthoritativeReload(blocks: BlockNode[], ops: readonly BlockOp[], pageTitle: string): boolean` — true when some op is a `move` whose `page_title` is non-null, equals `pageTitle`, and whose uid `findNode(blocks, uid)` misses. Exactly the expression `applyRemote` has today, no behaviour change.

- [ ] **Step 1: Failing tests** `describe("needsAuthoritativeReload")`: true for a move into this page of an absent uid; false when the uid is present; false for `page_title` null; false for a move naming another page; false for non-move ops on absent uids.
- [ ] **Step 2:** `cd web && pnpm exec vitest run src/outline/tree.test.ts` → fail (not exported).
- [ ] **Step 3:** Implement; `applyRemote` computes `needsAuthoritative` by calling it with `session.snapshot.blocks`.
- [ ] **Step 4:** `pnpm exec vitest run src/outline/tree.test.ts src/outline/outlineSessions.test.ts` → pass; `pnpm typecheck`.
- [ ] **Step 5: Commit** `refactor(outline): name the remote-batch authoritative reload rule`.

### Task 3: Runner — minted uid prefix and wire batches

**Files:**
- Modify: `web/src/props/outline/run.ts`
- Test: `web/src/props/outline/run.test.ts`

**Interfaces:**
- Produces:
  - `export interface RunOptions { seam?: Seam; mintPrefix?: string }`; `runSequence(start, commands, seamOrOptions: Seam | RunOptions = REAL): Run` stays source-compatible for the outline suite and teeth (a `Seam` argument still works). Default prefix `"n"`.
  - `export interface WireBatch { pre: BlockNode[]; ops: BlockOp[]; after: BlockNode[] }` and `Run.batches: WireBatch[]`, in send order.
  - In `run()`: when `textOps.length + result.ops.length > 0`, push `{ pre, ops: stampBaseTextHashes(pre, PAGE_TITLE, [...textOps, ...result.ops]), after: next }` (useOutline.run's shape). In `replay()` with an entry: push `{ pre: base, ops: stampBaseTextHashes(base, PAGE_TITLE, replayed.ops), after: tree }` (undoManager's shape). The final `flushNow()` pushes through `run()`.

- [ ] **Step 1: Failing tests:**
  - `mintPrefix` → a `split` yields a fresh uid `opsn0`.
  - `type` then `indent` on the same row → one batch whose ops are `[update_text (with base_text_hash), move]`.
  - `type` alone → one batch at the end (the final flush).
  - `moveDown` then `undo` → two batches; the second's `after` equals the start tree structurally.
  - a command emitting nothing → no batch.
  - For every batch, `applyOps(pre, ops, PAGE_TITLE)` is `blocksEqual` to `after` (property-style over 200 `sequenceArb` samples with `fc.assert`).
- [ ] **Step 2:** `pnpm exec vitest run src/props/outline/run.test.ts` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → pass; `proptest/check.sh web --file outline/` is not needed here, but run `pnpm exec vitest run --config vitest.props.config.ts outline/` (no server) → outline and teeth still pass.
- [ ] **Step 5: Commit** `test(props): the outline runner reports its wire batches`.

### Task 4: Comparison forms (`ops/compare.ts`)

**Files:**
- Create: `web/src/props/ops/compare.ts` (Functional Core)
- Test: `web/src/props/ops/compare.test.ts`

**Interfaces:**
- Consumes: `NormalGraph`, `NormalBlock`, `diffGraphs` from `props/sync/normalise.ts`; `Snapshot` from `replica/apply.ts`.
- Produces:
  - `treesFromSnapshot(s: Snapshot, titles: readonly string[]): Map<string, BlockNode[]>` — one entry per title (empty array for an absent page), children sorted by `order_idx`, `created_at`/`updated_at` null.
  - `pruneTree(tree: BlockNode[], known: ReadonlySet<string>): BlockNode[]` — drops every node whose uid is not in `known`, with its subtree.
  - `diffTrees(a: BlockNode[], b: BlockNode[], names: [string, string]): string[]` — one line per difference (missing/extra uid, parent, position among siblings, `order_idx`, text, heading, view type, collapsed); `[]` means equal. Lines name the uid.
  - `pruneGraph(g: NormalGraph, known: ReadonlySet<string>, keepPages: ReadonlySet<string>): NormalGraph` — drops blocks whose uid is not in `known`; then drops pages not in `keepPages` that no kept block lives on and no kept block's refs name.
  - `rankOrder(g: NormalGraph): NormalGraph` — each block's `order_idx` replaced by its 0-based rank among blocks sharing `(page, parent_uid)`.

- [ ] **Step 1: Failing tests:** a snapshot with two pages and a gapped nested group → trees in key order with exact keys, and an empty tree for a third title; `diffTrees` reports a key difference that keeps order, and a swap; `pruneTree` drops a minted header with its children; `pruneGraph` drops a minted header, the daily page and the `conflict` page but keeps a page created by `create_page` (in `keepPages`) with no blocks; `rankOrder` maps keys `[0, 3, 7]` to `[0, 1, 2]` per group.
- [ ] **Step 2:** `pnpm exec vitest run src/props/ops/compare.test.ts` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → pass. **Step 5: Commit** `test(props): comparison forms for the ops property`.

### Task 5: Arbitraries and draft resolution (`ops/arbitraries.ts`)

**Files:**
- Create: `web/src/props/ops/arbitraries.ts` (Functional Core)
- Test: `web/src/props/ops/arbitraries.test.ts`

**Interfaces:**
- Consumes: `commandArb`, `Command` from `props/outline/arbitraries.ts`; `NormalGraph` from `props/sync/normalise.ts`; `BlockOp` from `api/ops`.
- Produces:
  - `OPS_PAGES = ["Outline Props", "Ops Two", "Ops Three"] as const`, `TITLE_POOL = [...OPS_PAGES, "Ops Four"] as const`, `UID_POOL` (`opsb00`…`opsb29`).
  - `interface StartState { pages: Record<(typeof OPS_PAGES)[number], BlockNode[]> }`; `startStateArb` — 0 to 10 blocks per page (uids drawn without replacement from `UID_POOL` across pages), depth ≤ 3, gapped keys as f7zv's `treeArb` (gap 0 weight 3, 1–4 weight 1; first key 0–3), f7zv's text/heading/view type/collapsed draws plus texts with `[[Outline Props]]`, `[[Ops Two]]`, `#[[Ops Three]]` and `((opsbNN))` refs.
  - `seedOps(s: StartState): BlockOp[]` — `create_page` per page, then creates parent-first in ascending key order (heading and view type on the create), then `set_collapsed: true` where drawn.
  - `type RawDraft` (choosers as naturals, resolved at run time) and `rawBatchArb: fc.Arbitrary<RawDraft[]>` (1 to 6) with the spec's variation table and rates: about 1 in 4 batches names one block twice (append a second draft that reuses the first's target chooser with kind `move`); about 1 in 30 carries a forbidden title (`a [[b` style text or `page_title` containing `#`).
  - `resolveRaw(drafts: readonly RawDraft[], g: NormalGraph, mint: () => string): BlockOp[]` — pure; resolves each chooser against the live blocks of `g` and the uids the batch has created so far (in order). Cycle moves pick a descendant from `g`. Stale hashes are `sha256Hex` of the text plus `"~"`; matching hashes use the live text (and `subtreeHash` of live pairs for deletes).
  - `type Example = { start: StartState; kind: "raw"; steps: { batch: RawDraft[]; other: RawDraft[] | null }[] } | { start: StartState; kind: "command"; commands: Command[] }`; `exampleArb` — raw weight 3, command weight 2; raw 1 to 3 steps, `other` non-null half the time; command 1 to 5 commands from `commandArb`.

- [ ] **Step 1: Failing tests:** every `startStateArb` sample (200) has unique uids matching the uid regex, well-formed trees, and no text naming `Ops Four`; `seedOps` applied with `applyOps` per page reproduces each start tree exactly (keys included); `resolveRaw` against a fixed graph resolves a cycle draft to a move under the block's own child, a missing-parent draft to a uid outside the graph, a double-named draft pair to two ops on one uid, and a stale-hash draft to a hash differing from the live text's; over 2000 `rawBatchArb` samples the double-named share is within 0.15–0.35 and the forbidden-title share is between 0.01 and 0.07.
- [ ] **Step 2:** `pnpm exec vitest run src/props/ops/arbitraries.test.ts` → fail.
- [ ] **Step 3:** Implement. **Step 4:** → pass. **Step 5: Commit** `test(props): start states and raw batches for the ops property`.

### Task 6: The example runner (`ops/example.ts`) and the property

**Files:**
- Create: `web/src/props/ops/example.ts` (Imperative Shell), `web/src/props/ops/ops.prop.ts` (Imperative Shell)

**Interfaces:**
- Consumes: Tasks 1–5; `enqueueBatch`, `allBatches` (`replica/queue.ts`); `applySnapshot`, `applyChanges` (`replica/apply.ts`); `openTestDb` (`replica/testDb.ts`); `fromReplica`, `fromSnapshot`, `diffGraphs` (`props/sync/normalise.ts`); `applyOpsWithChange`, `needsAuthoritativeReload` (`outline/tree.ts`); `runSequence` (Task 3); `connectServer`, `ServerControl`.
- Produces:
  - `interface OpsSeam { applyEcho(tree: BlockNode[], ops: BlockOp[], title: string): BlockNode[]; enqueue(db: ReplicaDb, ops: BlockOp[], nowMs: number, batchId: BatchId): void; applyWindow(db: ReplicaDb, feed: Changes, nowMs: number): ApplyResult }` and `REAL_OPS: OpsSeam` (`applyOpsWithChange(...).blocks`, `enqueueBatch`, `applyChanges`).
  - `runExample(server: ServerControl, ex: Example, opts?: { seam?: OpsSeam; tally?: Tally; afterSeed?: () => Promise<void> }): Promise<string[]>` (`afterSeed` runs after the seed's echo is cleared; the echo teeth arm there) — problems at the first failing step, each line prefixed `check 1:`, `check 2:`, `check 3:`, `check R:` or `rejection:`, plus a step header. A harness fault (unexpected HTTP status other than 200/400, a 409, a non-head window, a POST that throws) throws `Error("harness: …")` instead.
  - `interface Tally` and `newTally()`, `showTally(t: Tally): string`. Counters: examples by kind; resolved op kinds; variations reached (cycle, missing parent, cross-page create/move, stale text hash, stale subtree hash, block named twice, forbidden title); O steps whose window did / did not re-ship touched rows, and O batches rejected; skipped ops by the ack's reason; pages set aside for an authoritative reload (`reloads`); 400s by cause (title syntax, other).

The flow per example is the spec's ("One raw step", "One command step"), with these decisions:
- **Seed:** `reset`, POST `seedOps(start)` (must be 200 with no skips, else harness error), `snapshot` → S0, `applySnapshot` into the replica, trees via `treesFromSnapshot(S0, TITLE_POOL)`, `takeEcho()` to clear.
- **Known uids** = S0's uids ∪ every uid any step's resolved ops create. Minted = everything else.
- **Batch ids** from one per-example counter (`ops-<example>-<n>`); B's client id `ops-device`, O's `ops-other`.
- **B is sent** as `{ batch_id, client_id, ops }` where `ops` is the pending row's stored ops (read back with `allBatches`).
- **O step:** resolve O against the server's current graph, POST it (a 400 O is tallied and the step proceeds without a window), apply its echo to the trees (Check 1 for O's echo too), then `changes(cursor)` from the replica's `cursor` meta; harness error unless `next_since === latest_seq`; touched = uids in `effect_ledger` for pending batch ids ∪ uids the pending ops name, read before the window; reshipped = window blocks' and tombstones' uids; apply via `seam.applyWindow`. Check R: a fresh `openTestDb` + `applySnapshot(snapshot())` + `REAL_OPS.enqueue` of every pending batch's stored ops (same batch ids); `diffGraphs(fromReplica(replica), fromReplica(fresh))`, both through `rankOrder` unless `touched ∩ reshipped` is empty.
- **After B's POST:** echo via `takeEcho()`; 200 → S1 = `snapshot()`; Check 1 for each title (`needsAuthoritativeReload(T_p, echo, p)` → tally, set `T_p = tree_p(S1)` pruned, skip); Check 3: `pruneGraph(fromReplica(replica), known, keep)` vs `pruneGraph(fromSnapshot(S1), known, keep)` with `keep` = S0's titles ∪ titles named by any op; through `rankOrder` when the O step's window touched pending rows, exactly otherwise.
- **400:** rejection agreement — `enqueue` threw `LocalOpError` ⇔ the 400's detail names title syntax; any other 400 is tallied, and the example stops there (the replica holds an optimistic batch the poison path would repair).
- **Command example:** `runSequence(start.pages["Outline Props"], commands, { mintPrefix: "opsn" })`; each `WireBatch` is enqueued and POSTed as a step; Check 2 = `diffTrees(batch.after, pruneTree(tree_OP(S1), known))`, plus "server rejected or skipped a command batch" when the status is 400 or `skipped` is non-empty; Check 1 on the other titles; Check 3.

`ops.prop.ts`: `fc.asyncProperty(exampleArb, …)` over `connectServer()`, `NUM_RUNS` (placeholder 1500 until Task 8 calibrates), `PROPERTY_LIMIT_MS = 120_000`, the report shape of `outline.prop.ts` (name `ops property`, `--file ops/ops.prop.ts`; counterexample printed as each page's tree via a `showTree` like outline's, then each step's drafts), the budget-overrun branch, and an `afterAll` that prints `showTally`. Two fixed scenarios as plain `test`s before the property, run through `runExample`:
  - **authoritative reload:** `Ops Two` holds `opsb01`; B moves `opsb01` to `Outline Props`'s top level with `page_title: "Outline Props"`. Expect no problems and `tally.reloads === 1`, and a second step updating `opsb01`'s text passes Check 1 (the reloaded tree holds it).
  - **409 is a harness error:** a step whose B reuses the seed's batch id rejects with `harness:`.

- [ ] **Step 1:** Write `example.ts` and `ops.prop.ts` with the two fixed scenarios.
- [ ] **Step 2:** `lsof -iTCP:8978 -sTCP:LISTEN` (empty), then `proptest/check.sh web --file ops/ops.prop.ts > $SCRATCH/ops-first.log 2>&1`. The fixed scenarios pass. The property may fail: **a failure here is a finding, not a task failure.** Record the report verbatim in the task report; do not change checks or exclusions to get a clean run.
- [ ] **Step 3:** `pnpm typecheck`; `pnpm test:unit` (the `ops/*.test.ts` run there).
- [ ] **Step 4: Commit** `test(props): client/server op divergence property`.

### Task 7: Teeth (`ops/teeth.prop.ts`)

**Files:**
- Create: `web/src/props/ops/teeth.prop.ts` (Imperative Shell)

**Interfaces:**
- Consumes: `runExample`, `OpsSeam`, `REAL_OPS`, `exampleArb`, `ServerControl.setEchoTeeth`.

Four mutants, each run with `fc.check` at most 400 examples under a 20 s limit, counting only a failure whose problems include the named prefix (a `harness:` error or another check failing alone is not a catch):

| Mutant | Built as | Must report |
|---|---|---|
| no shift exemption | `applyEcho` = a local copy of the move branch of `applyOpInPlace` that shifts the moved block too | `check 1:` |
| move one slot late | `enqueue` = `enqueueBatch`, then `UPDATE blocks SET order_idx = order_idx + 1 WHERE uid = ?` for each `move` op's uid | `check 3:` |
| replay always shifts | `applyWindow` = `applyChanges`, then for each pending `move` op, `UPDATE blocks SET order_idx = order_idx + 1 WHERE page_id/parent_uid match AND order_idx >= that block's AND uid != ?` | `check R:` |
| echo drops cross-page title | `setEchoTeeth(true)` in `afterSeed` (reset clears it) | `check 1:` |

A clean run (`REAL_OPS`, 100 examples) must pass, unless Task 6 recorded open findings; in that case the clean run is skipped with a message naming them until Task 9 clears them.

- [ ] **Step 1:** Write it. **Step 2:** `proptest/check.sh web --file ops/teeth.prop.ts > $SCRATCH/ops-teeth.log 2>&1` → all four caught. **Step 3: Commit** `test(props): teeth for the ops property`.

### Task 8: Calibration and docs

**Files:**
- Modify: `web/src/props/ops/ops.prop.ts` (`NUM_RUNS` and its comment), `docs/architecture/property-checks.md`, `AGENTS.md` (Testing: property-check budgets), `docs/architecture/backend.md` (parity fixture section, one line)

- [ ] **Step 1:** On a quiet machine, run `proptest/check.sh web` in full; read the ops tally and examples per second; set `NUM_RUNS` to about 60 s, with the measured rate in its comment (outline's comment is the pattern).
- [ ] **Step 2:** Docs, through the `architecture-docs` skill: in `property-checks.md`, the suite row in the opening table, "What the ops property checks" (steps, checks table, exclusions table, head-window rule), modules table rows, the two control routes in the route table, calibration row, reading-a-failure note (`--file ops/ops.prop.ts`). Grep for "two suites", "sync about 3 minutes", "about 4 minutes" and update counts. `AGENTS.md`: web side about 5 minutes (sync about 3 minutes, outline about 45 seconds, ops about 60 seconds). `backend.md`: one line that the ops property checks the server, replica and in-memory implementations against each other.
- [ ] **Step 3: Commit** `docs(pkm-j3ui): the ops property` (message says what was added).

### Task 9: Findings

Every failure Task 6, 7 or 8 surfaced, and any the full gate surfaces later, goes through this loop, one finding at a time. pkm-sj5l is expected among them (a raw batch moving one block twice, with an O on another page).

- [ ] **Step 1:** Classify: product bug, wrong property, or unclear. Unclear → Arthur rules.
- [ ] **Step 2:** Product bug: write the shrunk example as a failing unit test beside the code (`web/src/replica/*.test.ts`, `web/src/outline/*.test.ts`, or `server/tests/` if the server is wrong); present a short fix design to Arthur in chat and wait for approval (bounded path).
- [ ] **Step 3:** Fix; unit test passes; replay line passes; one `docs/troubleshooting.md` row; a rule in the owning architecture doc if the fix installs an invariant; record the finding in the bean.
- [ ] **Step 4:** Wrong property: fix in `props/ops/`, the reason in the commit message.
- [ ] **Step 5:** Commit per finding.

### Task 10: Gates and finish

- [ ] `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
- [ ] `cd web && E2E_PORT=8981 pnpm verify > $SCRATCH/verify.log 2>&1`
- [ ] `proptest/check.sh web > $SCRATCH/proptest-web.log 2>&1` (full, all suites) and `proptest/check.sh server` if server code changed in Task 9
- [ ] `perf/check.sh frontend` (Task 2 and any Task 9 fix touch product code); re-run after any final-review fix to product code
- [ ] Final whole-branch review (Opus), then bean summary, handoff, merge per the finishing procedure.
