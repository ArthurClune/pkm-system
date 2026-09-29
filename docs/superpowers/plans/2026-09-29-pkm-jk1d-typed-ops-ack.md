# Typed ops ack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/ops` declares `response_model=OpsAck`, `SkipReason` is declared once, and every web caller reads the ack through one typed reader over the generated `OpsAck`.

**Architecture:** The server declares `SkipReason` in `contracts/responses.py` (contracts never import server modules) and `ops_core.py` imports it. The route gets `response_model=OpsAck`, so both fresh and replayed stored acks pass through the model: `seq` is `null` for an ack stored before it existed, and `skipped` is always a list. A new hand-maintained fixture, `shared/fixtures/ops_acks.json`, pins the stored-to-wire mapping and the `SkipReason` values: the server replays it through the real route, and the web replays its `wire` acks through the reader and the real queue. On the web, `readOpsAck` in `web/src/sync/opsAck.ts` (Functional Core) replaces `ackSeq` and `ackSkipped`, and serves `opQueue.ts` (lane and drain) and `replicaSync.ts` (the recovery flush).

**Tech Stack:** FastAPI 0.139 / Pydantic 2.13 (server), TypeScript + Vitest (web), openapi-typescript.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § Typed ack (plus § Shared rules, § Verification per branch). Review: `docs/2026-09-29-sync-subsystem-review-consolidated.md`, the "Contract gap" paragraph under § Docs versus code (D5 is in that section's table).

## Preconditions and sibling branches

- **F8 (pkm-i35e) is already on main** (merge `dbd842dd`). Its `opQueue.ts`/`replicaSync.ts`/`SyncProvider.tsx` edits are the base this plan cites.
- **F6 (pkm-yvka) must be merged into main before Task 2 starts.** This plan is written against its shape: it creates `web/src/sync/opsAck.ts` (Functional Core, exporting `ackSeq(ack: unknown): number | undefined`) plus `opsAck.test.ts`, removes `ackSeq` from `opQueue.ts` (which imports it from `./opsAck`), and adds a second caller in `replicaSync.ts` `flushBatches`: `heldAcks.push({ id: b.id, batch_id: b.batch_id, seq: ackSeq(ack) ?? null })`, where `ack` is the result of `fetchJson("/api/ops", …)` (typed `unknown`). Before starting, check `git log --oneline main | grep pkm-yvka` shows the merge and `grep -n "export function ackSeq" web/src/sync/opsAck.ts` matches. If either fails, stop and report; do not recreate F6's file.
- Your worktree may be based on origin/main: run `git reset --hard main` in the worktree first so it contains F6 and F8, then check `git status -sb` before every commit.
- Files this plan shares with other wave-2 beans: `web/src/sync/opQueue.ts`, `web/src/sync/replicaSync.ts`, `web/src/sync/opsAck.ts` (F6), `web/src/sync/opQueue.replica.test.ts`, `web/src/sync/SyncProvider.test.tsx` (F5/F8), `docs/architecture/backend.md`, `docs/architecture/frontend.md`. After a merge, run the regen again on the merged tree (Task 1 step 7) to prove `openapi.json`/`types.d.ts` byte-identical.

## Global Constraints

- TDD: every fix's failing test goes red, for the stated reason, before the fix.
- Every runtime file declares its FCIS pattern (`// pattern: Functional Core` / `// pattern: Imperative Shell`, `#` in Python); pure predicates, classifiers and transforms live in Functional Core files. `pnpm check:fcis` forbids a Core file importing a value from a Shell module (a `import type` is fine).
- Code and test comments state the rule and carry NO bean id. Commit messages may carry the id.
- Docs land in the same branch: the doc correction the spec section names. This bean fixes a contract gap, not a user-visible failure, so it adds **no** `docs/troubleshooting.md` row. Any `docs/architecture/` edit goes through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- A route or docstring change regenerates openapi.json and the web types before review: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd web && pnpm gen-types`. `server/tests/test_openapi_sync.py` enforces it.
- The wire change is additive only. No field is dropped or renamed: every stored ack in prod is `{ok,ts,applied}` (18253 rows in the 2026-09-29 backup) or `{ok,ts,applied,seq}` (430), and none holds `skipped`. What changes: a clean ack gains `"skipped":[]` (13 bytes), and a replayed ack stored before `seq` existed gains `"seq":null,"skipped":[]`. Every deployed reader already accepts both. The browser's `ackSeq` reads `null` as unknown and `ackSkipped` reads `[]` as nothing skipped. The CLI/MCP `OpsAck` model takes `seq: int | None` and a list, and `render_ops_ack` checks `if not ack.skipped`. Do not add `response_model_exclude_none`, `exclude_unset` or `exclude_defaults`: the spec requires `seq: null` on the wire, since the client reads null as "unknown, so refetch".
- Final task: server `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`; web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`. Do NOT run the full Playwright suite or `perf/check.sh`: the orchestrator runs both after merge. (No e2e spec changes in this plan.) Then tick the bean checklist, add `## Summary of Changes`, complete the bean, and commit it with the code.
- Never write the two-word phrase that starts "load" and ends "bearing".

## Review Focus

1. **A stored ack that fails `OpsAck` validation.** A reason outside `SkipReason`, or a `skipped` entry missing `note_page`, would make the replay a 500 (ResponseValidationError; probed with FastAPI 0.139). The queue would retry it forever. Every historical `skip_report` emitted `note_page` and an in-set reason, and prod holds no stored `skipped` yet. The fixture case `stored-with-every-reason` replays with 200 (Task 1).
2. **`seq: null` silently dropped** by a later serializer option. The Task 1 replay test compares the whole dict exactly and also asserts `"seq" in body`.
3. **Tabs still running the old bundle after deploy** see `skipped: []` and `seq: null` on every ack. They accept both (see Global Constraints). No new test is needed: the old readers' behaviour on these values is already pinned by F6's `ackSeq` test (`{seq: null}` → undefined) and F5's `skipped: []` lane test.
4. **A malformed ack** (a mock, a proxy page, `skipped: "nope"`, `seq: NaN`). The reader reads no skip and an unknown seq, and never throws (Task 2 tests; F5's `"a malformed skipped field (not an array) parses as no skip"` queue test stays green).
5. **The recovery flush reading an old stored ack.** `replicaSync` records `seq: null` for an ack without `seq` (F6's partial `{ ok: true }` mocks exercise it; Task 3 exercises the fixture's `stored-before-seq` wire through the queue).

---

### Task 1: Server — one `SkipReason`, `response_model=OpsAck`, the shared ack fixture, regen

**Files:**
- Create: `shared/fixtures/ops_acks.json`
- Modify: `server/src/pkm/contracts/responses.py` (the "Write acks" comment block at `:440-450`, `SkippedOp.reason` at `:459`, a new `SkipReason` above `SkippedOp`)
- Modify: `server/src/pkm/server/ops_core.py:349` (delete the local `SkipReason`, import it from `pkm.contracts.responses`)
- Modify: `server/src/pkm/server/routes_ops.py:21` (decorator), `:77-83` (response dict + comment)
- Modify: `server/src/pkm/render.py:218` (`_SKIP_REASON_TEXT: dict[SkipReason, str]`)
- Modify: `web/src/api/openapi.json`, `web/src/api/types.d.ts` (regenerated, never hand-edited)
- Test: `server/tests/test_ops_idempotency.py`, `server/tests/test_client_contracts.py`, `server/tests/test_ops_endpoint.py`, `server/tests/test_openapi_sync.py`

**Interfaces:**
- Produces: `pkm.contracts.responses.SkipReason = Literal["block_not_found", "parent_not_found", "cycle"]` (same order); `OpsAck` as the 200 schema of `POST /api/ops`, so `components["schemas"]["OpsAck"]` and `components["schemas"]["SkippedOp"]` exist in `web/src/api/types.d.ts`, with `seq?: number | null` and `skipped?: components["schemas"]["SkippedOp"][]` (both optional, since both have defaults) and `SkippedOp.reason: "block_not_found" | "parent_not_found" | "cycle"`.
- Produces: `shared/fixtures/ops_acks.json` with this exact shape (Tasks 2 and 3 read it):

```json
{
  "skip_reasons": ["block_not_found", "parent_not_found", "cycle"],
  "cases": [
    {"name": "stored-before-seq",
     "stored": {"ok": true, "ts": 1, "applied": 2},
     "wire": {"ok": true, "ts": 1, "applied": 2, "seq": null, "skipped": []}},
    {"name": "stored-before-skipped",
     "stored": {"ok": true, "ts": 1, "applied": 2, "seq": 7},
     "wire": {"ok": true, "ts": 1, "applied": 2, "seq": 7, "skipped": []}},
    {"name": "stored-with-every-reason",
     "stored": {"ok": true, "ts": 1, "applied": 3, "seq": 9, "skipped": [
       {"index": 0, "op": "update_text", "uid": "uid_gone01", "reason": "block_not_found", "note_page": "September 29th, 2026"},
       {"index": 1, "op": "create", "uid": "uid_new01", "reason": "parent_not_found", "note_page": "September 29th, 2026"},
       {"index": 2, "op": "move", "uid": "uid_b1", "reason": "cycle", "note_page": null}]},
     "wire": {"ok": true, "ts": 1, "applied": 3, "seq": 9, "skipped": [
       {"index": 0, "op": "update_text", "uid": "uid_gone01", "reason": "block_not_found", "note_page": "September 29th, 2026"},
       {"index": 1, "op": "create", "uid": "uid_new01", "reason": "parent_not_found", "note_page": "September 29th, 2026"},
       {"index": 2, "op": "move", "uid": "uid_b1", "reason": "cycle", "note_page": null}]}}
  ]
}
```

- [ ] **Step 1: Create the fixture and write the failing server tests**

`test_ops_idempotency.py`: add a test parametrized as `@pytest.mark.parametrize("i,case", list(enumerate(CASES)), ids=[c["name"] for c in CASES])`, where `CASES` is loaded at module level from `Path(__file__).parents[2] / "shared" / "fixtures" / "ops_acks.json"`. It seeds `applied_batches` directly with `case["stored"]` under `batch_id = f"ack-fixture-{i:04d}"`, stored with `batch_replay_hash(OpBatch.model_validate(batch))`. Follow the insert pattern of `test_pre_deploy_strict_hash_row_still_replays_and_still_409s` (`open_db(client.app.state.config.db_path)`, `INSERT INTO applied_batches VALUES (?,?,?,?)`, commit, close). The batch is `{"client_id": "c1", "batch_id": …, "ops": [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]}`. Then POST the same batch:

```python
def test_stored_ack_replays_through_the_model_as_the_fixture_wire(client, i, case):
    ...
    r = client.post("/api/ops", json=batch)
    assert r.status_code == 200
    assert r.json() == case["wire"]
    assert "seq" in r.json()   # null stays on the wire: the client reads it as unknown
```

In the same file, update `test_pre_deploy_strict_hash_row_still_replays_and_still_409s`: `assert r_same.json() == {**ack, "skipped": []}`.

`test_client_contracts.py`: add

```python
def test_skip_reason_is_declared_once_and_pinned_by_the_shared_fixture():
    from typing import get_args
    from pkm import render
    from pkm.contracts.responses import SkipReason, SkippedOp
    from pkm.server import ops_core
    fixture = json.loads((ROOT / "shared" / "fixtures" / "ops_acks.json").read_text())
    assert ops_core.SkipReason is SkipReason
    assert list(get_args(SkipReason)) == fixture["skip_reasons"]
    assert SkippedOp.model_fields["reason"].annotation == SkipReason
    assert set(render._SKIP_REASON_TEXT) == set(get_args(SkipReason))
```

(ROOT is `Path(__file__).parents[2]`; add the `json`/`Path` imports if the file lacks them.) Rewrite the docstring of `test_ops_ack_is_exactly_what_the_ops_route_returns`: the model is now the route's `response_model`, and this test pins the client's parse of a live ack, clean and skipping.

`test_ops_endpoint.py`: rename `test_clean_batch_ack_omits_skipped` → `test_clean_batch_ack_carries_an_empty_skipped_list`, asserting `r.json()["skipped"] == []` and `isinstance(r.json()["seq"], int)`, with its comment rewritten to say why (the response model always serializes the list). At the two other sites (`:890`, `:924`), replace `assert "skipped" not in r.json()` with `assert r.json()["skipped"] == []`.

`test_openapi_sync.py`: add `("/api/ops", "post")` to `CHECKED_NON_GET`. Update the comment above it: the upload response and the ops ack are the non-GET payloads the web reads as generated types.

- [ ] **Step 2: Run them to verify they fail for the right reason**

Run: `cd server && uv run pytest -q tests/test_ops_idempotency.py tests/test_client_contracts.py tests/test_ops_endpoint.py tests/test_openapi_sync.py`
Expected failures:
- `stored-before-seq` and `stored-before-skipped`: the body lacks `seq`/`skipped`, because it is the stored ack verbatim.
- The strict-hash replay test and the three `["skipped"] == []` sites: KeyError on `skipped`.
- The SkipReason test: ImportError, since there is no `SkipReason` in `pkm.contracts.responses`.
- `test_read_routes_declare_response_models`: `POST /api/ops` flagged.

`stored-with-every-reason` passes already, since it is replayed verbatim.

- [ ] **Step 3: Implement**

- `responses.py`: declare `SkipReason` directly above `SkippedOp`, and set `SkippedOp.reason: SkipReason`. Rewrite the "Write acks" comment so it describes the code as it is now. `OpsAck` IS the `response_model` of `POST /api/ops`: the web reads its `seq` and `skipped` through the generated type, and a replayed stored ack passes through it, so an ack stored before `seq` existed reaches the wire as `seq: null` (read as unknown). `AssetDeleteAck` still is not a response model: no generated client reads it, and the comment keeps its existing reason. `OpsAck`'s two defaults are the one exception to the module docstring's "keep every field required" rule, because acks stored before those fields existed have to validate. The generated TypeScript therefore marks them optional, and the web reader tolerates their absence.
- `ops_core.py`: `from pkm.contracts.responses import SkipReason`. Delete the local declaration.
- `routes_ops.py`: `@router.post("/api/ops", response_model=OpsAck)`, keeping `-> dict`, which is the repo's pattern (`routes_goodlinks.py:62`). Always build `"skipped": result.skipped` into `response`, so a new stored row equals its wire ack. Replace the comment at `:78-82` ("sent only when non-empty … byte-for-byte") with the rule: `skipped` lists every op whose target no longer exists, and is empty for a clean batch. Update the replay comment at `:57`: the stored ack is replayed through `OpsAck`, so older rows gain `seq: null` / `skipped: []`. Leave the docstring alone. (Editing it is allowed, but it changes openapi.json; step 6 regenerates either way.)
- `render.py`: annotate `_SKIP_REASON_TEXT: dict[SkipReason, str]`, importing `SkipReason` from `pkm.contracts.responses`.

- [ ] **Step 4: Run the tests again**

Run: the command from step 2, excluding `test_openapi_sync.py::test_committed_openapi_matches_live_schema`.
Expected: PASS. The committed-schema test still fails until step 6.

- [ ] **Step 5: Type-check and lint the server**

Run: `cd server && uv run pyrefly check && uv run ruff check`
Expected: no errors.

- [ ] **Step 6: Regenerate the schema and web types**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`
Then: `cd server && uv run pytest -q tests/test_openapi_sync.py`. Expected: PASS.
Check: `grep -n '"OpsAck"\|"SkippedOp"' web/src/api/openapi.json` matches. `web/src/api/types.d.ts` has `OpsAck: {` with `seq?: number | null;` and `skipped?: components["schemas"]["SkippedOp"][];`, and the `/api/ops` `post` 200 content is `components["schemas"]["OpsAck"]`.
Then `cd web && pnpm typecheck`. Expected: PASS, since `postOps` is still annotated `Promise<unknown>`, which accepts the now-typed `apiPost`, and the test fixtures are untyped until Task 2.

- [ ] **Step 7: Commit**

```bash
git add shared/fixtures/ops_acks.json server/src/pkm/contracts/responses.py server/src/pkm/server/ops_core.py server/src/pkm/server/routes_ops.py server/src/pkm/render.py server/tests/test_ops_idempotency.py server/tests/test_client_contracts.py server/tests/test_ops_endpoint.py server/tests/test_openapi_sync.py web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(pkm-jk1d): POST /api/ops declares OpsAck; SkipReason declared once"
```

---

### Task 2: Web — one typed reader for every ack caller

**Files:**
- Modify: `web/src/api/payloads.ts` (add `OpsAck`, `SkippedOp` aliases; its header comment says it covers read-API shapes, so widen it to "response shapes")
- Modify: `web/src/sync/opsAck.ts` (F6's file: replace `ackSeq` with `readOpsAck`)
- Modify: `web/src/sync/opsAck.test.ts` (replace F6's `ackSeq` test)
- Modify: `web/src/sync/opQueue.ts`: `postOps` (`:169`); delete `ackSkipped` (`:185-197`) and the `ackSeq` import; the lane's `let ack` and read (`:474`, `:497`); the drain's `let ack` and reads (`:621`, `:633`, `:641`). The line numbers are main's, before F6: re-locate them.
- Modify: `web/src/sync/replicaSync.ts` (F6's `flushBatches` `heldAcks.push` line and its `ackSeq` import)
- Modify: `web/src/sync/opQueue.replica.test.ts` (`:2151`, `:2210`, `:2231` fixtures; the test title at `:2200-2202`), `web/src/sync/SyncProvider.test.tsx` (`:775` fixture)

**Interfaces:**
- Consumes: `components["schemas"]["OpsAck"]` / `["SkippedOp"]` from Task 1's regenerated `types.d.ts`; `shared/fixtures/ops_acks.json`.
- Produces, in `web/src/sync/opsAck.ts` (`// pattern: Functional Core`, type-only imports):

```ts
export type SkipReason = SkippedOp["reason"];
export interface OpsAckReading {
  /** The journal seq of the batch's commit; undefined when the ack names none
   * (null, absent, or not a finite number). */
  seq: number | undefined;
  /** Every op the server skipped; empty when absent or not an array. */
  skipped: readonly SkippedOp[];
}
export function readOpsAck(ack: OpsAck): OpsAckReading;
```

The parameter is the generated type, but the body still guards at runtime (`Number.isFinite`, `Array.isArray`): the value is parsed network JSON, and the type states what the server sends without checking it. `ackSeq` is removed, with no alias left behind.

- In `payloads.ts`: `export type OpsAck = Schemas["OpsAck"]; export type SkippedOp = Schemas["SkippedOp"];`.

- [ ] **Step 1: Write the failing reader tests** (`opsAck.test.ts`, replacing the `ackSeq` test)

```ts
import fixture from "../../../shared/fixtures/ops_acks.json";
import type { OpsAck } from "../api/payloads";
import { readOpsAck, type SkipReason } from "./opsAck";

test.each(fixture.cases)("reads the $name wire ack", ({ wire }) => {
  const ack = wire as OpsAck;
  expect(readOpsAck(ack)).toEqual({ seq: ack.seq ?? undefined, skipped: ack.skipped });
});
test("an ack missing seq names no seq and no skips", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 2 })).toEqual({ seq: undefined, skipped: [] });
});
test("an ack missing skipped keeps its seq and names no skips", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 2, seq: 7 })).toEqual({ seq: 7, skipped: [] });
});
test("a null or non-finite seq is unknown", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, seq: null }).seq).toBeUndefined();
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, seq: Number.NaN }).seq).toBeUndefined();
});
test("a malformed skipped field reads as no skips", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, skipped: "nope" } as unknown as OpsAck).skipped)
    .toEqual([]);
});
test("SkipReason is exactly the shared fixture's reasons", () => {
  // A reason added to or removed from the server's SkipReason changes the
  // generated union, and this record then fails to type-check.
  const reasons: Record<SkipReason, true> = { block_not_found: true, parent_not_found: true, cycle: true };
  expect(Object.keys(reasons)).toEqual(fixture.skip_reasons);
});
```

(The JSON import types `reason` as `string`. If tsc rejects `wire as OpsAck` as a non-overlapping conversion, use `wire as unknown as OpsAck`.)

Fix the fixtures with the compiler: annotate each of the four `"missing_target"` ack literals with `satisfies OpsAck` (`import type { OpsAck } from "../api/payloads"`). In `opQueue.replica.test.ts` that is the object passed to `jsonResponse(...)`; in `SyncProvider.test.tsx` it is the `/api/ops` tuple's body.

- [ ] **Step 2: Verify red**

Run: `cd web && pnpm vitest run src/sync/opsAck.test.ts && pnpm typecheck`
Expected: vitest fails because `readOpsAck` is not exported by `./opsAck`. Typecheck reports `"missing_target"` not assignable to `"block_not_found" | "parent_not_found" | "cycle"` at the four fixture sites.

- [ ] **Step 3: Implement**

- Change the four fixtures to `reason: "block_not_found"`.
- Rename the test `"…still refetches (both paths consult ackSkipped, not only the no-replica latch)"` so it no longer names the removed function: `"…(both paths read the ack's skipped list, not only the no-replica latch)"`.
- `opsAck.ts`: implement `readOpsAck`, and replace the file comment's "read by hand" wording with the rule. The reader serves the drain, the lane and the recovery flush, and an ack stored before `seq` or `skipped` existed reads as unknown seq / no skips.
- `opQueue.ts`: `postOps(...): Promise<OpsAck>`; `let ack: OpsAck;` at both sites. Both skip checks become `readOpsAck(ack).skipped.length > 0`, and the drain's delete becomes `replica.deleteBatch(batch.id, readOpsAck(ack).seq)` (read once into a `const`). Delete `ackSkipped`, its comment and the `ackSeq` import. Keep the F5 comments at the two `onSkipped` sites.
- `replicaSync.ts`: `const ack = (await fetchJson("/api/ops", …)) as OpsAck;`, following the file's existing `as Snapshot` cast for a loosely typed `fetchJson`. Then `seq: readOpsAck(ack).seq ?? null`. Swap the import.

- [ ] **Step 4: Verify green**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm vitest run src/sync/`
Expected: all pass, including F5's lane/drain skipped tests and F6's replicaSync acked-list tests, unchanged apart from the fixture reasons and the one title. `grep -rn "ackSeq\|ackSkipped" web/src` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/api/payloads.ts web/src/sync/opsAck.ts web/src/sync/opsAck.test.ts web/src/sync/opQueue.ts web/src/sync/replicaSync.ts web/src/sync/opQueue.replica.test.ts web/src/sync/SyncProvider.test.tsx
git commit -m "feat(pkm-jk1d): one typed reader over the generated OpsAck for every ack caller"
```

---

### Task 3: Composed test — the route's wire acks through the real queue

The server test (Task 1) proves `ops_acks.json`'s `wire` values are exactly what the route emits for each stored shape. This task feeds those same values through the real `createOpQueue` drain, so the two halves compose on one fixture.

**Files:**
- Create: `web/src/sync/opsAck.composed.test.ts`

**Interfaces:**
- Consumes: `readOpsAck`-backed `createOpQueue(replica, onDesync, onDrain, onSkipped)` from `./opQueue`; `memReplica` from `./memReplica`; `jsonResponse` from `../test-helpers`. For the fetch stub, copy the `fetchSeq` pattern from `opQueue.replica.test.ts:24-35` (it is file-local there; do not export it from a test file).

- [ ] **Step 1: Write the test**

```ts
test.each(fixture.cases)("the $name ack the route replays drives the drain", async ({ wire }) => {
  fetchSeq([() => jsonResponse(wire)]);
  const replica = memReplica();
  const base = replica.deleteBatch;
  const deletes: Array<number | undefined> = [];
  replica.deleteBatch = async (id, ackedSeq) => { deletes.push(ackedSeq); return base(id); };
  const skips: void[] = [];
  const q = createOpQueue(replica, () => undefined, () => undefined, () => skips.push(undefined));
  const ticket = q.enqueue([{ op: "delete", uid: "u1" }]);
  await q.settled();
  await q.drain();
  expect(deletes).toEqual([wire.seq ?? undefined]);
  expect(skips).toHaveLength(wire.skipped.length > 0 ? 1 : 0);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});
```

Add `beforeEach(() => { localStorage.clear(); })` as the sibling queue test file does.

- [ ] **Step 2: Prove it can fail**

Temporarily change the drain's delete to `replica.deleteBatch(batch.id)`, dropping the seq. Run `cd web && pnpm vitest run src/sync/opsAck.composed.test.ts`: expected FAIL on `stored-before-skipped` and `stored-with-every-reason` (`[undefined]` received). Revert, and check that `git diff web/src/sync/opQueue.ts` is empty.

- [ ] **Step 3: Run it green**

Run: `cd web && pnpm vitest run src/sync/opsAck.composed.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add web/src/sync/opsAck.composed.test.ts
git commit -m "test(pkm-jk1d): the route's replayed acks drive the queue through the shared fixture"
```

---

### Task 4: Wording and docs

**Files:**
- Modify: `server/src/pkm/client/workflows.py:104-109` (`apply_batch` docstring), `server/src/pkm/cli/main.py:284-286` (`pkm batch` help), `server/src/pkm/mcp/server.py:135-136` (MCP `batch` tool description), `docs/cli.md:123-125`
- Modify: `docs/architecture/backend.md`: `:207-209` (OpBatch sentence, D5), `:517` (`/api/ops` API-table row), the Generated-artifacts table (`:610-620`, new row)
- Modify: `docs/architecture/frontend.md`: F6's module-map row `opsAck.ts … Reads the /api/ops ack's seq`

- [ ] **Step 1: Skipped-op wording** (no test pins these strings; `grep -rn "no longer exists" server/src docs/cli.md` lists the four sites)

At each site, add the parent case to the list of what is skipped. The pattern: "An update, move or delete whose uid no longer exists, a create or move whose parent no longer exists, or a move under the block itself or one of its descendants, is skipped…". Keep each site's own surrounding sentence. In `workflows.py` the docstring's list becomes "names ops whose uid no longer exists, creates and moves whose parent no longer exists, and moves that would make a cycle". The MCP description is not part of openapi.json, so no regen follows from it.

- [ ] **Step 2: Architecture docs** (invoke the `architecture-docs` skill first)

- `backend.md:207-209` (D5): `OpBatch` is `client_id`, a required `batch_id` (8–64 characters; a batch without one is a 422), and 1–500 ops. Verify against `contracts/ops.py:108` and `tests/test_ops_idempotency.py::test_batch_without_batch_id_is_rejected`.
- `backend.md:517`: the row names the response model and the always-present fields. Ack `OpsAck` (response model): `{ok, ts, applied, seq, skipped}`. `applied` counts every op processed, skipped ones included. `seq` is the journal max read inside the batch's transaction. `skipped` is always a list (empty for a clean batch) of `{index, op, uid, reason, note_page}`, where `reason` is a `SkipReason`: `block_not_found`, `parent_not_found` or `cycle`. A replayed `batch_id` returns its stored ack through the model, so an ack stored before `seq` existed replays `seq: null`, which clients read as unknown, and one stored before `skipped` replays `skipped: []`. Drop the old "present only when non-empty" and "lacks them" wording.
- Generated-artifacts table: new row, `shared/fixtures/ops_acks.json` | hand-maintained cases | `tests/test_ops_idempotency.py`, `tests/test_client_contracts.py` | Pins the stored-ack-to-wire mapping of `POST /api/ops` and the `SkipReason` values; the web's `readOpsAck` and queue replay the wire acks (`web/src/sync/opsAck.test.ts`, `opsAck.composed.test.ts`).
- `frontend.md` module map: `opsAck.ts  Core  Reads the /api/ops ack (seq, skipped) through the generated OpsAck`.
- Grep for stale claims: `grep -rn "by hand\|present only when non-empty\|reads only the ops ack" docs/ server/src web/src` returns nothing that describes the ack.

- [ ] **Step 3: Check the docs**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/backend.md docs/architecture/frontend.md`
Expected: no findings.

- [ ] **Step 4: Commit**

```bash
git add server/src/pkm/client/workflows.py server/src/pkm/cli/main.py server/src/pkm/mcp/server.py docs/cli.md docs/architecture/backend.md docs/architecture/frontend.md
git commit -m "docs(pkm-jk1d): OpsAck response model, batch_id required, parent_not_found in skipped-op wording"
```

---

### Task 5: Verify and close the bean

- [ ] **Step 1: Server**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all pass with enforced coverage met.

- [ ] **Step 2: Web**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: all pass.

- [ ] **Step 3: Regen proof on the final tree**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types && git status --porcelain src/api`
Expected: empty output (both files byte-identical to what is committed).

- [ ] **Step 4: Bean**

Tick every checklist item in `.beans/` for pkm-jk1d except "verify, perf, merge" (the orchestrator owns perf and merge). Add `## Summary of Changes` covering:
- the additive wire change (clean acks +13 bytes, `"skipped":[]`);
- a note for the orchestrator: `perf/check.sh backend` will report `bytes` +13 on every clean `ops/*` scenario (`ops/edit-1`, `ops/edit-hashed-*`, `ops/edit-rename-replay`, `ops/move-subtree`, `ops/paste-50`), while the skipping scenarios are unchanged. That is this wire change, not a regression to fix. Under AGENTS.md it needs Arthur's acceptance, then `perf/check.sh backend --bootstrap`, with the reason in the commit message;
- the four `"missing_target"` fixtures (the review counted two);
- the new `ops_acks.json` fixture.

Mark the bean completed.

```bash
git add .beans/
git commit -m "chore(pkm-jk1d): complete bean"
```
