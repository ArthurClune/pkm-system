# Hash-guarded delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `delete` whose subtree changed since the deleting device last saw it still wins, and the server's current texts for that subtree land nested under the block's daily-note conflict header.

**Architecture:** `DeleteOp` gains an optional `base_subtree_hash` over the subtree's sorted `(uid, text)` pairs, stamped where `update_text`'s hash is stamped (main thread, worker, and now `pkm batch`). The server's shell reads the subtree rows once, and on a mismatch builds a `DeleteConflictContext` whose planning lands the copies through the existing `conflict_entry_effects` path before deleting. Replicas need nothing new.

**Tech Stack:** Python 3 / FastAPI / Pydantic / SQLite (server, CLI, MCP); TypeScript / React / SQLite-WASM worker (web); pytest, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-hash-guarded-delete-design.md` (Tasks 2-7), and `docs/superpowers/specs/2026-09-30-typed-op-hashes-design.md` (Task 1). Beans: pkm-nny8 and pkm-r5ra (parent epic pkm-a4t2).

## Global Constraints

- Field name and bounds, verbatim: `base_subtree_hash: Sha256Hex | None = Field(default=None, min_length=64, max_length=64)`. No hex pattern at runtime.
- Hashes are minted only by `text_hash` / `subtree_hash` (Python) and `sha256Hex` / `subtreeHash` (web), all returning `Sha256Hex` (Task 1). A test literal standing in for a hash wraps in `Sha256Hex(...)` / `as Sha256Hex`.
- Canonical hash, verbatim: `sha256( "\n".join(f"{uid} {text_hash(text)}" for uid, text in sorted(pairs)) )`. Web sorts by plain code-unit comparison (`<` / `>`), never `localeCompare`.
- Header text, verbatim: `` [[conflict]] {existing_page_label(page_title)} — deleted while edited elsewhere `` (em dash, as in the existing headers).
- A hashless delete behaves exactly as today. A stale stamp may only ever cost an extra conflict copy, never lost text.
- Copies are text only (heading `None`, no collapse, no view type), fresh uids, nested as the subtree was, children renumbered 0..n by `(order_idx, uid)`.
- Every file keeps its `# pattern:` / `// pattern:` header; new files declare one. No bean ids in code or test comments.
- Regenerate after the contract change: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`.
- Parallel executors run only their own e2e spec, each on its own `E2E_PORT` (8981 upward). The orchestrator runs the full suites and perf after merge.
- Perf: a delete-scenario change under 5% is re-recorded with `perf/check.sh backend --bootstrap` and the reason in the commit message; anything larger goes to Arthur with the table.

## Review Focus

1. **Lost enqueue reply.** The worker-filled durable copy and the unfilled fallback-lane copy of one `batch_id` must replay, not 409. Pinned in Task 2 (`test_delete_replay_hash_ignores_base_subtree_hash`).
2. **Overlapping multi-select delete** (child then parent, in one batch). The parent's hash must be taken after the child's removal, or every such delete lands a spurious copy. Pinned in Task 4 (`test_batch_deleting_child_then_parent_lands_no_copy`) and Task 5 (`stamps a parent delete after its child's delete in the same batch`).
3. **Backspace merge** (`update_text` of the previous block, moves of B's children, `delete` B). It must land no copy when nothing else changed. Pinned in Task 5 (`a merge batch stamps the delete against the tree its moves left`).
4. **A same-day second conflict on one block.** The copies append under today's existing header for the uid instead of creating a second header. Pinned in Task 4 (`test_diverged_delete_appends_under_todays_existing_header`).
5. **Blank or unicode texts in the subtree.** They hash identically on both sides, and blank descendants still copy so the shape survives. Pinned by the fixture (Task 2) and Task 3 (`test_descendant_copies_keep_blank_texts`).

---

### Task 1: Typed op hashes (pkm-r5ra)

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`Sha256Hex`, `text_hash` return type, `UpdateTextOp.base_text_hash`)
- Modify: `web/src/replica/sha256.ts` (`Sha256Hex` brand; `sha256Hex` return type)
- Modify: `web/src/api/ops.ts` (narrow `UpdateTextOp.base_text_hash`)
- Modify: the tests whose literal stands in for a hash: `web/src/outline/baseTextHash.test.ts` (`"deadbeef"`, `"h"`), `web/src/replica/queue.test.ts` (`"snapshot-hash"`), and the two `base_text_hash="…"` sites in `server/tests` (`grep -rn 'base_text_hash="' server/tests`)
- Test: `server/tests/test_ops_idempotency.py` (or the contracts test file that already imports `text_hash`), `web/src/replica/sha256.test.ts` (create if absent)

**Interfaces:**
- Produces (Python): `Sha256Hex = NewType("Sha256Hex", str)` in `pkm.contracts.ops`; `text_hash(text: str) -> Sha256Hex`; `UpdateTextOp.base_text_hash: Sha256Hex | None` with the existing `Field(...)` bounds.
- Produces (web): `export type Sha256Hex = string & { readonly __brand: "Sha256Hex" }` and `sha256Hex(text: string): Sha256Hex` from `web/src/replica/sha256.ts`; `UpdateTextOp` in `web/src/api/ops.ts` is `Omit<components["schemas"]["UpdateTextOp"], "base_text_hash"> & { base_text_hash?: Sha256Hex | null }`.

- [ ] **Step 1: Write the negative type checks.**
  - Python, `test_hash_fields_are_sha256hex`: `assert_type(text_hash("x"), Sha256Hex)` (from `typing`, which pyrefly checks statically) and `assert UpdateTextOp.model_fields["base_text_hash"].annotation == Sha256Hex | None` (runtime).
  - Web: add `sha256.test.ts` with `// @ts-expect-error a plain string is not a hash` on `const h: UpdateTextOp["base_text_hash"] = "x" as string;`, plus one runtime assertion that `sha256Hex("")` equals the known empty-string digest `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

- [ ] **Step 2: Run to verify they fail.** Run: `cd server && uv run pyrefly check` and `cd web && pnpm typecheck`. Expected: FAIL (`Sha256Hex` undefined, and the `@ts-expect-error` unused).

- [ ] **Step 3: Implement** the types, the producers' return types and the field types above. Wrap the test literals that stand in for a hash. Leave the `block_rewrites` hashes and `classify_text_edit`'s parameters as `str` (the spec says why).

- [ ] **Step 4: Verify the wire is unchanged.** Run the regen command from Global Constraints, then `git diff --no-ext-diff --exit-code web/src/api/openapi.json web/src/api/types.d.ts`. Expected: exit 0, no diff. Then run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` and `cd web && pnpm typecheck && pnpm test:unit`. Expected: all pass.

- [ ] **Step 5: Docs and commit.** Add one clause where `docs/architecture/sync-and-offline.md` introduces `base_text_hash`: the hash fields are `Sha256Hex`, minted only by `text_hash` / `sha256Hex`. Task 2 adds `subtree_hash` / `subtreeHash` to that clause. Update pkm-r5ra's checklist and mark it completed with a summary. Message: `refactor(pkm-r5ra): Sha256Hex type for op hash fields, wire unchanged`.

---

### Task 2: Contract, canonical hash, shared fixture, idempotency

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`DeleteOp`, add `subtree_hash` beside `text_hash`)
- Modify: `server/src/pkm/server/ops_hash.py` (`_canonical_op`, `_canonical_replay_op`, both docstrings)
- Create: `shared/fixtures/subtree_hash.json`
- Create: `web/src/replica/subtreeHash.ts` (`// pattern: Functional Core`)
- Modify: `web/src/api/ops.ts` (narrow `DeleteOp.base_subtree_hash` to `Sha256Hex`)
- Create: `web/src/replica/subtreeHash.test.ts`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_ops_idempotency.py`, new `server/tests/test_subtree_hash.py`

**Interfaces:**
- Consumes: `Sha256Hex` (Task 1), both sides.
- Produces (Python): `subtree_hash(pairs: Iterable[tuple[str, str]]) -> Sha256Hex` in `pkm.contracts.ops`; `DeleteOp.base_subtree_hash: Sha256Hex | None`.
- Produces (web): `export function subtreeHash(pairs: Iterable<readonly [string, string]>): Sha256Hex` from `web/src/replica/subtreeHash.ts`; the generated `DeleteOp` type gains `base_subtree_hash?: string | null`, which `web/src/api/ops.ts` narrows to `Sha256Hex` the way Task 1 narrows `base_text_hash`.

- [ ] **Step 1: Write the fixture.** `shared/fixtures/subtree_hash.json` is `{"cases": [{"name": str, "pairs": [[uid, text], ...], "hash": str}]}` with at least these cases: `single_block` (one pair), `empty_text` (a pair with `""`), `unicode` (text with `é`, `—`, an emoji and a `\n`), `deep_nesting` (five pairs), and `sort_differs_from_tree_order` (pairs given in an order unlike their uid sort, e.g. `zz_root`, `aa_child`, `Mm_grandchild`, so that upper case sorts before lower case). Fill the `hash` values by running the Python `subtree_hash` from Step 3 once. The web test in Step 5 is the cross-check.

- [ ] **Step 2: Write the failing server tests.**

```python
# server/tests/test_subtree_hash.py
FIXTURE = json.loads((Path(__file__).parents[2] / "shared" / "fixtures"
                      / "subtree_hash.json").read_text(encoding="utf-8"))

@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_subtree_hash_matches_fixture(case):
    assert subtree_hash(tuple(p) for p in case["pairs"]) == case["hash"]

def test_subtree_hash_ignores_input_order():
    pairs = [("b", "two"), ("a", "one")]
    assert subtree_hash(pairs) == subtree_hash(list(reversed(pairs)))
```

```python
# server/tests/test_ops_idempotency.py
def _delete_batch(**fields):
    return OpBatch.model_validate({"client_id": "c", "batch_id": "batch-0001",
        "ops": [{"op": "delete", "uid": "uid_a", **fields}]})

def test_hashless_delete_keeps_its_pre_field_hash():
    # recorded on main before base_subtree_hash existed
    expected = "ae9f719e045c92bc33ebf2cee2e26196b8363f1fc021bdff99050199cf36f1ff"
    assert batch_request_hash(_delete_batch()) == expected
    assert batch_replay_hash(_delete_batch()) == expected

def test_delete_replay_hash_ignores_base_subtree_hash():
    filled = _delete_batch(base_subtree_hash="a" * 64)  # raw JSON: no Sha256Hex needed
    assert batch_replay_hash(filled) == batch_replay_hash(_delete_batch())
    assert batch_request_hash(filled) != batch_request_hash(_delete_batch())
```

Also add a route-level replay test beside the existing lost-reply `update_text` test in the same file: post the filled delete batch, then the unfilled one with the same `batch_id`. Expected: both 200, and the second is the stored ack replayed.

- [ ] **Step 3: Run them to verify they fail.** Run: `cd server && uv run pytest tests/test_subtree_hash.py tests/test_ops_idempotency.py -q`. Expected: FAIL (`subtree_hash` not importable; `base_subtree_hash` rejected as an extra field or not dropped).

- [ ] **Step 4: Implement.** Add `base_subtree_hash` to `DeleteOp`, with a comment in the style of `UpdateTextOp.base_text_hash`'s (what it guards, and that absent means plain delete). Add `subtree_hash` next to `text_hash`. In `_canonical_op`, delete `dump["base_subtree_hash"]` for a `DeleteOp` whose field is `None`. In `_canonical_replay_op`, pop it from a `DeleteOp`. Update both docstrings so they name the new field and why (the worker fills the durable copy, not the lane copy).

- [ ] **Step 5: Write the web fixture test, then `subtreeHash`.** `web/src/replica/subtreeHash.test.ts` imports the fixture JSON the way `EditablePage.draftFlush.test.tsx` does and asserts `subtreeHash(case.pairs) === case.hash` for every case. Implement `subtreeHash` over `sha256Hex` from `./sha256`, and narrow `DeleteOp` in `web/src/api/ops.ts` as Task 1 narrowed `UpdateTextOp`.

- [ ] **Step 6: Regenerate and verify.** Run the regen command from Global Constraints. Then run `cd server && uv run pytest tests/test_subtree_hash.py tests/test_ops_idempotency.py tests/test_openapi_sync.py -q && uv run pyrefly check && uv run ruff check`, then `cd web && pnpm exec vitest run src/replica/subtreeHash.test.ts && pnpm typecheck`. Expected: all pass. `types.d.ts` gains only `base_subtree_hash` on `DeleteOp`.

- [ ] **Step 7: Commit.** `git add` the files above. Message: `feat(pkm-nny8): DeleteOp base_subtree_hash, canonical subtree hash and fixture`.

---

### Task 3: Server core — the diverged-delete plan

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (new dataclasses, `delete_diverged`, `descendant_copy_effects`, `plan_op` branch, `OpContext` union)
- Modify: `server/src/pkm/server/conflict_notes.py` (`deleted_header_text`)
- Test: `server/tests/test_ops_core.py`, `server/tests/test_conflict_notes.py`

**Interfaces:**
- Consumes: `subtree_hash` (Task 2).
- Produces, in `ops_core`:
  ```python
  @dataclass(frozen=True)
  class SubtreeRow:
      uid: str
      parent_uid: str | None
      order_idx: int
      text: str

  @dataclass(frozen=True)
  class DeleteConflictContext:
      """A hashed delete whose subtree diverged: the delete still wins, and
      `rows` (deepest first) land as copies under a header naming
      `page_title`, the block's own page. `landing.entry_uid` is the root's
      copy; `copy_uids` maps every other row's uid to its copy's uid."""
      block: BlockInfo
      rows: tuple[SubtreeRow, ...]
      page_title: str
      landing: ConflictLanding
      copy_uids: Mapping[str, str]

  def delete_diverged(base_subtree_hash: str, rows: Sequence[SubtreeRow]) -> bool
  def descendant_copy_effects(rows: Sequence[SubtreeRow], root_uid: str,
                              root_copy_uid: str, copy_uids: Mapping[str, str],
                              daily_page_id: int) -> tuple[Effect, ...]
  ```
- Produces, in `conflict_notes`: `deleted_header_text(page_title: str) -> str`.

- [ ] **Step 1: Write the failing tests.**

In `test_conflict_notes.py`:
- `test_deleted_header_links_the_page`: `deleted_header_text("Project X") == "[[conflict]] [[Project X]] — deleted while edited elsewhere"`.
- `test_deleted_header_fences_a_title_that_does_not_link_back`: for a title ending in `]`, the label is the inline-code form that `existing_page_label` gives.

In `test_ops_core.py`, build the rows by hand. Root `r` has children `c2` (order_idx 5) and `c1` (order_idx 2); `c1` has child `g` (order_idx 0). Pass them deepest first.
- `test_delete_diverged_compares_the_subtree_hash`: false when the hash is `subtree_hash` of the rows' `(uid, text)`; true after changing one row's text.
- `test_descendant_copies_nest_and_renumber`: the effects are `InsertBlock` + `ReindexRefs` pairs in pre-order, `c1`'s copy, then `g`'s, then `c2`'s. `c1`'s copy is under `root_copy_uid` at 0 and `c2`'s at 1; `g`'s is under `c1`'s copy at 0; all have heading `None` and `daily_page_id`.
- `test_descendant_copies_keep_blank_texts`: a child with `""` still yields an `InsertBlock` with `""`.
- `test_plan_diverged_delete_lands_copies_then_deletes`: `plan_op(0, DeleteOp(op="delete", uid="r", base_subtree_hash=...), DeleteConflictContext(...))` with a `FreshHeader` landing. It equals `conflict_entry_effects("r", root.text, deleted_header_text(title), landing)`, then `descendant_copy_effects(...)`, then `DeleteBlocks(tuple(r.uid for r in rows))`, then `TouchPage(block.page_id)`.
- Extend the existing `SKIPPED_CONTEXTS`/`OpContext` union pin, if it enumerates `OpContext`, to include `DeleteConflictContext`.

- [ ] **Step 2: Run to verify they fail.** Run: `cd server && uv run pytest tests/test_ops_core.py tests/test_conflict_notes.py -q`. Expected: FAIL on the imports.

- [ ] **Step 3: Implement.** Add the dataclasses next to `DeleteContext` and `DeleteConflictContext` to `OpContext`. `descendant_copy_effects` walks from `root_uid` in pre-order, with children taken from `rows` by `parent_uid` and sorted by `(order_idx, uid)`. `deleted_header_text` sits beside `overwritten_header_text`, with a docstring saying why it can't embed `((uid))`. Add the `plan_op` branch before the `DeleteContext` branch, with a comment stating the rule (the delete wins, and the server's texts land first).

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Then run `uv run pyrefly check && uv run ruff check`, which should be clean.

- [ ] **Step 5: Commit.** Message: `feat(pkm-nny8): plan a diverged delete as copies under the conflict header`.

---

### Task 4: Server shell — read, classify, land

**Files:**
- Modify: `server/src/pkm/server/ops_apply.py` (`_subtree_rows`, the `DeleteOp` branch of `_context_for`)
- Test: `server/tests/test_ops_apply.py`, `server/tests/test_ops_endpoint.py`

**Interfaces:**
- Consumes: `SubtreeRow`, `DeleteConflictContext`, `delete_diverged` (Task 3); `subtree_hash` (Task 2).
- Produces: `_subtree_rows(db, uid) -> tuple[SubtreeRow, ...]`, deepest first, with the same recursive CTE and visited-path guard as `_subtree_deepest_first`, also selecting `parent_uid, order_idx, text`.

- [ ] **Step 1: Write the failing route tests** in `test_ops_endpoint.py`, using its `_post` / `_conflicts` helpers. Seed page `P` with root `r` ("root"), children `c1` ("one") and `c2` ("two"), and grandchild `g` ("deep") under `c1`. `H0` is `subtree_hash` of those four pairs.
  - `test_matching_guarded_delete_lands_no_copy`: delete `r` with `H0` → 200, `r`'s subtree gone, `_conflicts(client) == []`.
  - `test_hashless_delete_is_unchanged`: delete `r` without a hash after another client edits `g` → subtree gone, no conflict.
  - `test_diverged_delete_lands_the_subtree_nested` (parametrised over three divergences: another client edits `g`; creates `c3` under `r`; moves an outside block `x` under `c2`): delete `r` with `H0` → subtree gone. Today's daily note has one top-level `[[conflict]] [[P]] — deleted while edited elsewhere` whose child is "root", with "one" (child "deep") and "two" nested as they were. The added `c3` or moved `x` text appears under its parent's copy.
  - `test_reorder_inside_the_subtree_lands_no_copy`: another client moves `c2` before `c1`, or indents `c2` under `c1`, then delete `r` with `H0` → no conflict.
  - `test_batch_deleting_child_then_parent_lands_no_copy`: one batch holding `delete c1` (hash of `c1`, `g`) and then `delete r` (hash of `r`, `c2`) → no conflict.
  - `test_diverged_delete_appends_under_todays_existing_header`: first land an `overwritten by ((r))` conflict on `r` (a stale-hash `update_text`), then a diverged delete of `r` → the copies are under that same header, and the daily note has one header for `r`.
  - `test_diverged_delete_copies_roll_back_with_a_failing_batch`: a batch of a diverged delete of `r` followed by a `create` that 400s (a taken uid) → 400, `r` still present, no daily-note entry.

  In `test_ops_apply.py`, add `test_subtree_rows_is_deepest_first_with_columns`.

- [ ] **Step 2: Run to verify they fail.** Run: `cd server && uv run pytest tests/test_ops_endpoint.py tests/test_ops_apply.py -q -k "delete or subtree_rows"`. Expected: the diverged cases FAIL (no copy lands); the match and hashless cases may already pass.

- [ ] **Step 3: Implement the `DeleteOp` branch of `_context_for`.**
  - No hash → `DeleteContext(block, _subtree_deepest_first(db, op.uid))`, unchanged.
  - Hash → `rows = _subtree_rows(db, op.uid)`. If not diverged → `DeleteContext(block, tuple(r.uid for r in rows))`. If diverged → `DeleteConflictContext` with `_require_page_title(db, block.page_id)`, `_conflict_landing(db, op.uid, now_ms)`, and `copy_uids` minted after the landing, one `_new_uid()` per non-root row in `rows` order. Mint order is header, then root entry, then descendants.
  - Comment the branch with the rule: only a divergence pays for today's daily page.

- [ ] **Step 4: Run to verify they pass.** Run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`. Expected: the full suite passes with coverage enforced, 0 errors, clean.

- [ ] **Step 5: Commit.** Message: `feat(pkm-nny8): a diverged guarded delete keeps the server's texts on the daily note`.

---

### Task 5: Web stamping — main thread and worker

**Files:**
- Modify: `web/src/outline/baseTextHash.ts` (stamp `delete`; header comment)
- Modify: `web/src/replica/queue.ts` (worker fill; header comment)
- Test: `web/src/outline/baseTextHash.test.ts`, `web/src/replica/queue.test.ts`, `web/src/outline/undoManager.test.ts`

**Interfaces:**
- Consumes: `subtreeHash` (Task 2); the generated `DeleteOp.base_subtree_hash`.
- Produces: `stampBaseTextHashes` stamps `delete` ops whose `base_subtree_hash === undefined` (same signature). `nodeSubtreePairs(node: BlockNode): [string, string][]` is exported from `baseTextHash.ts`.

- [ ] **Step 1: Write the failing tests.**

`baseTextHash.test.ts`:
- `stamps a delete with the hash of its subtree`: `[{op:"delete", uid:"r"}]` over a tree `r → c1 → g, c2` → `base_subtree_hash === subtreeHash([["r",…],["c1",…],["g",…],["c2",…]])`.
- `leaves a supplied subtree hash alone`, and `leaves a delete of an unknown node unstamped`.
- `a merge batch stamps the delete against the tree its moves left`: take the ops `edits.ts` produces for merging B (which has children) into its previous sibling, stamp them, and expect the delete's hash to be `subtreeHash([[B.uid, B.text]])`.
- `stamps a parent delete after its child's delete in the same batch`: `[{delete c1}, {delete r}]` → `r`'s hash covers `r` and `c2` only.
- `a child update then a parent delete hashes the updated text`.

`queue.test.ts`:
- `fills a delete's subtree hash from the replica before the optimistic apply`: seed the replica rows, enqueue `{op:"delete", uid:"r"}`, and expect the stored `pending_ops` JSON to carry `subtreeHash` of the seeded pairs.
- `stores a caller-hashed delete as sent`, and `leaves a delete of a block the replica lacks unhashed`.

`undoManager.test.ts`:
- `an undo that deletes is stamped against the tree at replay time`: record a create, change the created block's text in the session, then undo. The dispatched delete's hash covers the changed text.

- [ ] **Step 2: Run to verify they fail.** Run: `cd web && pnpm exec vitest run src/outline/baseTextHash.test.ts src/replica/queue.test.ts src/outline/undoManager.test.ts`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement.**
  - Widen `needsStamp` to `UpdateTextOp | DeleteOp`. A `delete` needs a stamp when `base_subtree_hash === undefined`, and is stamped from `nodeSubtreePairs(findNode(tree, op.uid))`. The existing walk (`applyOps` while a later op still needs a stamp) gives the in-batch ordering for free.
  - In `queue.ts`, add `currentSubtreePairs(db, uid): [string, string][] | null`: a recursive query with the server's visited-path guard; `null` when the uid has no row. Fill before the optimistic apply, as for `update_text`.
  - Update both header comments to name `delete` alongside `update_text`.

- [ ] **Step 4: Run to verify they pass.** Same command, then `pnpm typecheck && pnpm test:unit`. Expected: all pass, coverage enforced.

- [ ] **Step 5: Commit.** Message: `feat(pkm-nny8): stamp deletes with their subtree hash on the main thread and in the worker`.

---

### Task 6: `pkm batch` and MCP — guarded delete

**Files:**
- Modify: `server/src/pkm/batch.py` (`delete_uids`, `_SubtreeModel`, `_BatchCtx`, `_batch_delete`, `plan_batch`, `__all__`)
- Modify: `server/src/pkm/client/workflows.py` (`apply_batch`)
- Modify: CLI help text in `server/src/pkm/cli/main.py`, and the MCP batch tool docstring in `server/src/pkm/mcp/server.py`, only where they say deletes are sent unchecked
- Test: `server/tests/test_planning.py`, `server/tests/test_cli_main_write.py`

**Interfaces:**
- Consumes: `subtree_hash` (Task 2). `BlockPayload.block` from `GET /api/block/{uid}` holds the block's subtree.
- Produces:
  - `delete_uids(commands: Sequence[BatchCommand]) -> list[str]`: the `delete` uids that are not `{{alias}}` specs, first-seen order.
  - `plan_batch(commands, pages, uids, subtrees: Mapping[str, BlockNode | None] | None = None) -> list[BlockOp]`: existing callers are unchanged.
  - `_SubtreeModel`, built from a fetched `BlockNode`. It holds `nodes: dict[str, tuple[str | None, str]]` (uid → parent uid, text), `root: str` and `known: bool`, and has `apply(op: BlockOp) -> None` and `hash() -> str | None`.

`_SubtreeModel.apply` rules, which are the algorithm the tests pin:
- `update_text` of a uid in `nodes`: replace its text.
- `create` whose `parent_uid` is in `nodes`: add it.
- `move` of a non-root uid in `nodes` to a parent outside `nodes`: remove the uid and its descendants.
- `move` of a uid outside `nodes` to a parent inside `nodes`: `known = False` (its subtree is unknown here, so the delete goes hashless, which is today's behaviour).
- `delete` of a uid in `nodes`: remove it and its descendants.
- `hash()` returns `None` when not `known` or when `root` is gone.

- [ ] **Step 1: Write the failing planner tests** (`test_planning.py`):
  - `test_batch_delete_is_stamped_from_its_fetched_subtree`: `subtrees={"r": node r→c1}` → the delete carries `subtree_hash([("r",…),("c1",…)])`.
  - `test_batch_delete_of_an_alias_is_unhashed`, `test_batch_delete_without_a_fetched_subtree_is_unhashed`.
  - `test_batch_update_then_delete_hashes_the_updated_text`.
  - `test_batch_create_under_then_delete_includes_the_created_block`.
  - `test_batch_move_into_the_subtree_leaves_the_delete_unhashed`.
  - `test_delete_uids_skips_aliases`.

- [ ] **Step 2: Write the failing CLI tests** (`test_cli_main_write.py`, against the real server via `pkm_client`):
  - `test_batch_delete_matching_subtree_lands_no_copy`: seed a block with a child, then `run("batch", …delete…)` → exit 0, block gone, no `[[conflict]]` on today's page.
  - `test_batch_delete_stale_fetch_lands_the_copy`: monkeypatch `pkm_client.get_block` to return the subtree with a changed child text → the conflict copy lands under `— deleted while edited elsewhere`.
  - `test_batch_delete_of_a_missing_uid_still_reports_skipped`: exit 1, and the output leads with `warning:` as today.

- [ ] **Step 3: Run to verify they fail.** Run: `cd server && uv run pytest tests/test_planning.py tests/test_cli_main_write.py -q -k "delete"`. Expected: the new cases FAIL.

- [ ] **Step 4: Implement.** `_BatchCtx` gains `subtrees: dict[str, _SubtreeModel]`, and `record()` applies every new op to every model. `_batch_delete` sets `base_subtree_hash` from the model keyed by the resolved uid. `apply_batch` fetches `client.get_block(uid).block` for each of `delete_uids(parsed)`, maps an `ApiError` with `status == 404` to `None`, lets any other error propagate, and passes `subtrees=`. Update the `apply_batch` docstring's fetch sentence.

- [ ] **Step 5: Run to verify they pass.** Run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`. Expected: all pass.

- [ ] **Step 6: Commit.** Message: `feat(pkm-nny8): pkm batch and MCP stamp deletes from a fetched subtree`.

---

### Task 7: End-to-end test and architecture docs

**Files:**
- Modify: `web/e2e/conflict-landing.spec.ts`
- Modify: `docs/architecture/sync-and-offline.md` (§ Conflicts at push time, the `delete` row and one sentence), `docs/architecture/backend.md` (§ Conflicts header table, and replace the "`delete` carries no hash" paragraph), `docs/architecture/cli-and-mcp.md` (the `pkm batch` paragraph)
- Modify: `.beans/pkm-nny8…md` (checklist, summary)

**Interfaces:**
- Consumes: Tasks 1 to 6 merged.

- [ ] **Step 1: Write the e2e test.** Add `test("a delete that raced an edit to its child lands the subtree under a conflict header on today's note", …)` using `withScenario`:
  - Give the stamped page a child under `u1` through `remote`, and open the page.
  - Hold the browser's `POST /api/ops` in a route handler, as the existing tests do, and delete `u1` in the editor.
  - While it's held, `remote` edits the child (hash of its seeded text). Then release.
  - Assert today's daily note has a `[[conflict]] [[<title>]] — deleted while edited elsewhere` header, with `u1`'s text as its child and the remote child text under that.
  - Clean up exactly those entries, as the file's other tests do.

- [ ] **Step 2: Run it.** Run: `cd web && pnpm build && E2E_PORT=8981 node tooling/runPlaywright.mjs e2e/conflict-landing.spec.ts`. Expected: PASS, and the file's existing two tests still pass.

- [ ] **Step 3: Update the docs.** Invoke the `architecture-docs` skill first.
  - `sync-and-offline.md`: the row becomes "`delete` whose subtree another device changed since this one last saw it | The delete wins; the server's texts for the subtree land nested under a `[[conflict]] … — deleted while edited elsewhere` header", plus one sentence naming the canonical hash and `shared/fixtures/subtree_hash.json`.
  - `backend.md`: add the header form row, and replace the "`delete` carries no hash … planned but not built" paragraph with the rule and what the hash covers.
  - `cli-and-mcp.md`: `pkm batch` fetches each deleted uid first and guards the delete, and a missing uid still reports through `skipped`.
  - Add the new fixture to the backend.md generated-artifacts/parity-fixtures table if it lists `draft_flush.json`.
  - Grep the docs for "no hash" / "hash-guarded delete" / "gap is open" and fix every stale mention.

- [ ] **Step 4: Commit.** Message: `test+docs(pkm-nny8): e2e for a raced delete; docs state the landing rule`. It covers the e2e spec, the docs, and the bean checklist.

---

## After the tasks (orchestrator)

- Whole-branch review on the strongest model. Name for the reviewer: Review Focus 1 (replay hash tolerance), 2 and 3 (in-batch stamping order), and the mint order in `_context_for`.
- After the merge to `main` with `--no-ff`: full `cd server && uv run pytest -q`, `pyrefly`, `ruff`; `cd web && pnpm verify`; `perf/check.sh backend` and `perf/check.sh frontend` (name the sides; auto mode finds no diff on main). Apply the Global Constraints perf rule.
- Mark pkm-nny8 completed with a `## Summary of Changes`. Leave the pkm-a4t2 close-out item open until pkm-xwb5 is done or deferred.
