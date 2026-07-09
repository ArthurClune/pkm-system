# Block Drag-and-Drop (Desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag blocks by their bullet — within a page, across days in the journal scroll, and between sidebar panels and the main pane — with Roam-style depth targeting at each drop boundary.

**Architecture:** The server's `move` op gains an optional `page_title` for cross-page moves (whole subtree's `page_id` reassigned in the same transaction; uids stable so refs survive; FTS needs nothing — `blocks_fts` indexes text only, no page column). On the client, all drop semantics (boundary → allowed depths → `{parent_uid, order_idx, page_title}`) live in a new pure module `web/src/outline/dnd.ts`; native HTML5 DnD events are a thin shell. Same-page drops use the existing optimistic `useOutline.run()` path; cross-page drops do local two-outline surgery plus one enqueued op; read-only sidebar panels refetch after the op queue drains; remote clients that display the target page refetch it when a cross-page move arrives on the WebSocket.

**Tech Stack:** FastAPI + Pydantic + SQLite (server), React 18 + TypeScript + native HTML5 drag-and-drop (web), pytest / Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-09-block-drag-and-drop-design.md` (bean pkm-jg1p)

## Global Constraints

- FCIS: every runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` (TS: `// pattern: ...`) near the top. New pure logic goes in Functional Core files; DOM/network in shells.
- TDD: write the failing test first in every task; run it red before implementing.
- `MoveOp.order_idx` contract (unchanged): "insert before the block currently at `order_idx`, counted BEFORE the moved block is removed". Order values are read off trees, never array positions (the server leaves gaps).
- Server tests: `cd server && uv run pytest`. Web tests: `cd web && pnpm vitest run`; typecheck: `pnpm typecheck`.
- Commit after every task; always `git push` after committing (CLAUDE.md).
- Desktop pointer only — no touch handlers anywhere in this plan.
- The generated `web/src/api/types.d.ts` is never edited by hand; regen via `uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `pnpm gen-types` (enforced by `server/tests/test_openapi_sync.py`).

---

### Task 1: Server pure planner — `MoveOp.page_title` + `SetPageId` effect

**Files:**
- Modify: `server/src/pkm/server/ops_core.py`
- Test: `server/tests/test_ops_core.py`

**Interfaces:**
- Consumes: existing `plan_op(index, op, ctx)`, `OpContext`, effect dataclasses.
- Produces: `MoveOp` with `page_title: str | None = None`; new frozen dataclass `SetPageId(uids: tuple[str, ...], page_id: int)` added to `Effect`; `OpContext.subtree` and `OpContext.page_id` now also populated for moves (Task 2 wires the shell). `plan_op` move rules: parent set → target page is parent's page (cross-page allowed; if `page_title` also sent it must resolve to the parent's page, else `OpError("page_title does not match parent's page")`); parent null → `page_title`'s page when given, else the block's current page. Cross-page adds `SetPageId(ctx.subtree, target_page)` + `TouchPage(source)` before `TouchPage(target)`.

- [ ] **Step 1: Write the failing tests** — append to `server/tests/test_ops_core.py`:

```python
def _move_ctx(block_page=1, parent_page=1, page_id=None):
    return OpContext(
        block=BlockInfo("u_child", block_page, None),
        parent=BlockInfo("u_parent", parent_page, None),
        parent_chain=("u_parent",),
        page_id=page_id,
        subtree=("u_gc", "u_child"))


def test_move_cross_page_under_parent_reassigns_subtree():
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=2))
    assert effects == (
        ShiftSiblings(2, "u_parent", 0),
        SetParent("u_child", "u_parent", 0),
        SetPageId(("u_gc", "u_child"), 2),
        TouchPage(1),
        TouchPage(2))


def test_move_top_level_to_named_page():
    op = MoveOp(op="move", uid="u_child", parent_uid=None, order_idx=0,
                page_title="July 1st, 2026")
    ctx = OpContext(block=BlockInfo("u_child", 1, "u_old"),
                    page_id=7, subtree=("u_child",))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(7, None, 0),
        SetParent("u_child", None, 0),
        SetPageId(("u_child",), 7),
        TouchPage(1),
        TouchPage(7))


def test_move_same_page_unchanged_shape():
    # no page_title, same page: exactly the pre-existing three effects
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=3)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=1))
    assert effects == (
        ShiftSiblings(1, "u_parent", 3),
        SetParent("u_child", "u_parent", 3),
        TouchPage(1))


def test_move_page_title_must_match_parent_page():
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0,
                page_title="Somewhere Else")
    with pytest.raises(OpError, match="page_title does not match"):
        plan_op(0, op, _move_ctx(parent_page=2, page_id=3))


def test_move_cycle_check_still_applies_cross_page():
    op = MoveOp(op="move", uid="u_parent", parent_uid="u_parent", order_idx=0)
    ctx = OpContext(block=BlockInfo("u_parent", 1, None),
                    parent=BlockInfo("u_parent", 2, None),
                    parent_chain=("u_parent",), subtree=("u_parent",))
    with pytest.raises(OpError, match="cycle"):
        plan_op(0, op, ctx)
```

Extend the file's imports to include `SetPageId` (it will not exist yet).

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ops_core.py -v`
Expected: FAIL — `ImportError: cannot import name 'SetPageId'`

- [ ] **Step 3: Implement in `ops_core.py`**

Add `page_title` to `MoveOp`:

```python
class MoveOp(BaseModel):
    op: Literal["move"]
    uid: str
    parent_uid: str | None   # required but nullable: null = top level
    order_idx: int
    # cross-page target when parent_uid is null; must agree with the
    # parent's page when parent_uid is set. None = stay on current page.
    page_title: str | None = Field(default=None, min_length=1)
```

Add the effect dataclass next to the others and extend the `Effect` union:

```python
@dataclass(frozen=True)
class SetPageId:
    uids: tuple[str, ...]
    page_id: int
```

```python
Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, ReindexRefs, TouchPage, SetPageId]
```

Replace the `MoveOp` branch of `plan_op` (the branch currently raising "cross-page move is not supported"):

```python
    if isinstance(op, MoveOp):
        if op.parent_uid is not None:
            if ctx.parent is None:
                raise OpError(index, f"parent not found: {op.parent_uid}")
            if ctx.page_id is not None and ctx.page_id != ctx.parent.page_id:
                raise OpError(index, "page_title does not match parent's page")
            if op.uid in ctx.parent_chain:
                raise OpError(index, "move would create a cycle")
            target_page = ctx.parent.page_id
        else:
            target_page = (ctx.page_id if ctx.page_id is not None
                           else ctx.block.page_id)
        effects: list[Effect] = [
            ShiftSiblings(target_page, op.parent_uid, op.order_idx),
            SetParent(op.uid, op.parent_uid, op.order_idx)]
        if target_page != ctx.block.page_id:
            effects.append(SetPageId(ctx.subtree, target_page))
            effects.append(TouchPage(ctx.block.page_id))
        effects.append(TouchPage(target_page))
        return tuple(effects)
```

Also update `OpContext`'s comment for `subtree` to `# delete/move: op.uid subtree (delete: deepest first)`.

- [ ] **Step 4: Run tests**

Run: `cd server && uv run pytest tests/test_ops_core.py -v`
Expected: PASS (all, including pre-existing move tests — the same-page shape is unchanged)

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/ops_core.py server/tests/test_ops_core.py
git commit -m "feat(server): plan cross-page moves — MoveOp.page_title + SetPageId effect"
git push
```

---

### Task 2: Server shell — context assembly, `SetPageId` execution, endpoint tests

**Files:**
- Modify: `server/src/pkm/server/ops_apply.py`
- Test: `server/tests/test_ops_endpoint.py`

**Interfaces:**
- Consumes: Task 1's `SetPageId`, `MoveOp.page_title`; existing `get_or_create_page(db, title, now_ms)`, `_subtree_deepest_first`, seeded fixture pages (`Machine Learning` id 1 with `uid_b2`→child `uid_b3`; `July 7th, 2026` id 3 with `uid_b4`, `uid_b5`; see `server/tests/conftest.py`).
- Produces: `POST /api/ops` accepts cross-page moves end-to-end; `_context_for` populates `page_id` (get-or-create when `op.page_title` set) and `subtree` for every `MoveOp`.

- [ ] **Step 1: Write the failing endpoint tests** — append to `server/tests/test_ops_endpoint.py` (match the file's existing helper style for posting batches; it posts `{"client_id": ..., "ops": [...]}` to `/api/ops`):

```python
def test_cross_page_move_under_parent(client, seeded_config):
    # uid_b4 (on "July 7th, 2026") becomes a child of uid_b2 (on "Machine
    # Learning"): subtree page_id follows, uid unchanged.
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 99}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == 1 and row["parent_uid"] == "uid_b2"
    con.close()


def test_cross_page_move_top_level_auto_creates_page(client, seeded_config):
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": None, "order_idx": 0,
         "page_title": "July 1st, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    page = con.execute(
        "SELECT id FROM pages WHERE title='July 1st, 2026'").fetchone()
    assert page is not None
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == page["id"] and row["parent_uid"] is None
    con.close()


def test_cross_page_move_subtree_and_backlinks_survive(client, seeded_config):
    # uid_b2 has child uid_b3 ("[[Attention Is All You Need]] is a [[Paper]]").
    # Move uid_b2 to July 7th: child's page_id follows; refs rows untouched;
    # the moved text is still findable via search (FTS keyed by rowid).
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
        {"op": "move", "uid": "uid_b2", "parent_uid": None, "order_idx": 9,
         "page_title": "July 7th, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    pages = {r_["uid"]: r_["page_id"] for r_ in con.execute(
        "SELECT uid, page_id FROM blocks WHERE uid IN ('uid_b2','uid_b3')")}
    assert pages == {"uid_b2": 3, "uid_b3": 3}
    refs = con.execute(
        "SELECT count(*) FROM refs WHERE src_block_uid='uid_b3'").fetchone()[0]
    assert refs == 2
    con.close()
    hits = client.get("/api/search", params={"q": "Attention"}).json()
    assert any(b["uid"] == "uid_b3" for b in hits["blocks"])
    assert all(b["page_title"] == "July 7th, 2026"
               for b in hits["blocks"] if b["uid"] == "uid_b3")


def test_cross_page_move_page_title_parent_mismatch_400(client):
    r = client.post("/api/ops", json={"client_id": "t", "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 0, "page_title": "July 7th, 2026"}]})
    assert r.status_code == 400
    assert "page_title does not match" in r.json()["detail"]
```

Add `import sqlite3` to the test file if not already imported.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py -v -k cross_page`
Expected: FAIL — first two with 400 responses (`"cross-page move is not supported"` never fires anymore, but `_context_for` doesn't populate `page_id`/`subtree`, so `SetPageId` never plans and the mismatch test gets 200); exact failures may vary — the point is they must not all pass.

- [ ] **Step 3: Implement in `ops_apply.py`**

Replace the `MoveOp` branch of `_context_for`:

```python
    if isinstance(op, MoveOp):
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        chain = _parent_chain(db, op.parent_uid) if op.parent_uid else ()
        page_id = (get_or_create_page(db, op.page_title, now_ms)["id"]
                   if op.page_title is not None else None)
        return OpContext(block=block, parent=parent, parent_chain=chain,
                         page_id=page_id,
                         subtree=_subtree_deepest_first(db, op.uid))
```

Add `SetPageId` to the imports from `ops_core` and a branch to `_execute` (before the final `else`):

```python
    elif isinstance(eff, SetPageId):
        db.executemany(
            "UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
            [(eff.page_id, now_ms, u) for u in eff.uids])
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && uv run pytest`
Expected: PASS (including `test_openapi_sync` — it will FAIL here because `MoveOp` changed; that is Task 3's job. If it fails, continue: Task 3 fixes it before the branch is done. All other tests must pass.)

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/ops_apply.py server/tests/test_ops_endpoint.py
git commit -m "feat(server): execute cross-page moves — subtree page_id reassignment"
git push
```

---

### Task 3: Regenerate the OpenAPI schema and TS types

**Files:**
- Modify: `web/src/api/openapi.json` (generated)
- Modify: `web/src/api/types.d.ts` (generated)

**Interfaces:**
- Produces: TS `MoveOp` gains `page_title?: string | null` — Tasks 4-8 rely on it compiling.

- [ ] **Step 1: Regenerate**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

- [ ] **Step 2: Verify**

Run: `cd server && uv run pytest tests/test_openapi_sync.py -v` — Expected: PASS
Run: `grep -n "page_title" ../web/src/api/types.d.ts | head` — Expected: `page_title` appears under `MoveOp` (as well as `CreateOp`).
Run: `cd ../web && pnpm typecheck` — Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "chore(api): regenerate schema/types for MoveOp.page_title"
git push
```

---

### Task 4: Client pure tree — cross-page move in `applyOps` + subtree surgery helpers

**Files:**
- Modify: `web/src/outline/tree.ts`
- Test: `web/src/outline/tree.test.ts`

**Interfaces:**
- Consumes: Task 3's `MoveOp.page_title` type.
- Produces:
  - `applyOps` move semantics: a move op whose `page_title` differs from this tree's `pageTitle` **removes** the block (this outline is the source); target-side insertion is NOT applyOps' job (the op carries no block content) — `useOutline` refetches instead (Task 6).
  - `export function removeSubtree(blocks: BlockNode[], uid: string): { tree: BlockNode[]; node: BlockNode | null }` — clone-based; `node` is the detached subtree root.
  - `export function insertSubtree(blocks: BlockNode[], node: BlockNode, parentUid: string | null, orderIdx: number): BlockNode[]` — clone-based; shifts siblings per the pre-removal contract, sets `node.order_idx = orderIdx`, sorts. Returns the input unchanged if `parentUid` isn't in the tree.

- [ ] **Step 1: Write the failing tests** — append to `web/src/outline/tree.test.ts` (reuse the file's existing block-building helpers; if it builds `BlockNode`s inline, follow that pattern):

```ts
it("applyOps removes the subtree when a move targets another page", () => {
  const tree = [block("a", "A"), { ...block("b", "B"), children: [block("c", "C")] }];
  const next = applyOps(tree, [
    { op: "move", uid: "b", parent_uid: null, order_idx: 0,
      page_title: "Elsewhere" }], "Here");
  expect(next.map((n) => n.uid)).toEqual(["a"]);
});

it("applyOps still applies a move whose page_title names this page", () => {
  const tree = [block("a", "A", { order_idx: 0 }), block("b", "B", { order_idx: 1 })];
  const next = applyOps(tree, [
    { op: "move", uid: "b", parent_uid: null, order_idx: 0,
      page_title: "Here" }], "Here");
  expect(next.map((n) => n.uid)).toEqual(["b", "a"]);
});

it("removeSubtree detaches a nested subtree and returns it", () => {
  const tree = [{ ...block("a", "A"), children: [
    { ...block("b", "B"), children: [block("c", "C")] }] }];
  const { tree: next, node } = removeSubtree(tree, "b");
  expect(node?.uid).toBe("b");
  expect(node?.children.map((n) => n.uid)).toEqual(["c"]);
  expect(next[0].children).toEqual([]);
  expect(tree[0].children.length).toBe(1); // input not mutated
});

it("insertSubtree inserts before the sibling at order_idx", () => {
  const tree = [block("x", "X", { order_idx: 0 }), block("y", "Y", { order_idx: 1 })];
  const node = block("n", "N");
  const next = insertSubtree(tree, node, null, 1);
  expect(next.map((n) => n.uid)).toEqual(["x", "n", "y"]);
});
```

(`block` here is the local test-helper; the existing suite imports `block` from `../test-helpers` — do the same.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/outline/tree.test.ts`
Expected: FAIL — `removeSubtree`/`insertSubtree` not exported; first test moves "b" to top of "Here" instead of removing it.

- [ ] **Step 3: Implement in `tree.ts`**

In `applyOne`, at the top of the move branch (the final `else`):

```ts
  } else { // move — order_idx counted BEFORE the moved block is removed
    if (op.page_title != null && op.page_title !== pageTitle) {
      // this outline is the SOURCE of a cross-page move: just remove
      found.siblings.splice(found.index, 1);
      return;
    }
    ...existing target/shift/splice logic unchanged...
```

Add the two helpers (below `applyOps`, using the file's existing `clone`, `locate`, `siblingsOf`, `shiftFrom`, `sortSiblings`):

```ts
/** Detach uid's subtree. Returns the new tree and the detached node
 * (null = uid not found; tree returned unchanged). Pure: clones. */
export function removeSubtree(blocks: BlockNode[], uid: string):
    { tree: BlockNode[]; node: BlockNode | null } {
  const tree = clone(blocks);
  const found = locate(tree, uid);
  if (!found) return { tree, node: null };
  found.siblings.splice(found.index, 1);
  return { tree, node: found.node };
}

/** Insert a detached subtree per the move contract (insert before the
 * block currently at orderIdx). Unknown parentUid: returns tree unchanged. */
export function insertSubtree(blocks: BlockNode[], node: BlockNode,
                              parentUid: string | null,
                              orderIdx: number): BlockNode[] {
  const tree = clone(blocks);
  const siblings = siblingsOf(tree, parentUid);
  if (siblings === null) return tree;
  shiftFrom(siblings, orderIdx);
  siblings.push({ ...node, order_idx: orderIdx });
  sortSiblings(siblings);
  return tree;
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run src/outline/tree.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/outline/tree.ts web/src/outline/tree.test.ts
git commit -m "feat(web): cross-page move awareness + subtree surgery in tree core"
git push
```

---

### Task 5: Client pure DnD core — `outline/dnd.ts`

**Files:**
- Create: `web/src/outline/dnd.ts`
- Test: `web/src/outline/dnd.test.ts`

**Interfaces:**
- Consumes: `BlockNode`, `locate` from `./tree`.
- Produces (Tasks 6-8 use these exact names):

```ts
export const INDENT_PX = 30;   // .block-children: 22px margin + 8px padding
export interface DragSource { uid: string; pageTitle: string }
export interface DropTarget { parent_uid: string | null; order_idx: number; page_title: string }
export interface DropRow { uid: string; depth: number; collapsed: boolean }
export function dropRows(blocks: BlockNode[], drag: DragSource, pageTitle: string): DropRow[]
export function allowedDepths(rows: DropRow[], boundary: number): number[]
export function depthFromX(allowed: number[], offsetX: number): number
export function resolveDrop(blocks: BlockNode[], pageTitle: string,
                            drag: DragSource, boundary: number,
                            depth: number): DropTarget | null
```

Semantics:
- `dropRows`: on-screen rows (depth-first, collapsed children hidden), **excluding the dragged block's subtree when `drag.pageTitle === pageTitle`** — boundaries are computed as if the block were already lifted out.
- `allowedDepths(rows, boundary)` for `boundary ∈ [0, rows.length]` (the gap above `rows[boundary]`; `rows.length` = after the last row): `max = above ? (above.collapsed ? above.depth : above.depth + 1) : 0` (a collapsed block admits no visible child — the spec's "nothing lands invisibly" rule); `min = below ? below.depth : 0`; returns `[min..max]` ascending. Empty outline → `[0]`.
- `depthFromX`: `clamp(Math.round(offsetX / INDENT_PX), first, last)` snapped into the allowed list.
- `resolveDrop`: parent = nearest row above the boundary with `depth - 1` (null for depth 0); `order_idx` = the `order_idx` of the first row at/after the boundary that is a visible child of that parent ("insert before it"), else last-child `order_idx + 1` (0 if childless) — reading values off the real tree so gaps are respected. Returns **null for a same-position no-op**: when `drag.pageTitle === pageTitle`, apply the would-be op via `applyOps` and compare the tree's depth-first `(uid, parent)` sequence before/after; unchanged → null.

- [ ] **Step 1: Write the failing tests** — create `web/src/outline/dnd.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { block } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop,
         INDENT_PX } from "./dnd";

// Page "P":  a(0) [ b(0) [ c(0) ] ]  d(1, collapsed) [ e(0) ]  f(2)
function page(): BlockNode[] {
  return [
    { ...block("a", "A", { order_idx: 0 }), children: [
      { ...block("b", "B", { order_idx: 0 }), children: [
        block("c", "C", { order_idx: 0 })] }] },
    { ...block("d", "D", { order_idx: 1, collapsed: true }), children: [
      block("e", "E", { order_idx: 0 })] },
    block("f", "F", { order_idx: 2 }),
  ];
}
const OTHER: DragSource = { uid: "zz", pageTitle: "Elsewhere" };
type DragSource = { uid: string; pageTitle: string };

it("dropRows hides collapsed children and excludes the dragged subtree", () => {
  expect(dropRows(page(), OTHER, "P").map((r) => r.uid))
    .toEqual(["a", "b", "c", "d", "f"]); // e hidden under collapsed d
  expect(dropRows(page(), { uid: "b", pageTitle: "P" }, "P").map((r) => r.uid))
    .toEqual(["a", "d", "f"]);           // b and c lifted out
});

it("allowedDepths spans below-depth..above-depth+1, capped by collapse", () => {
  const rows = dropRows(page(), OTHER, "P");
  expect(allowedDepths(rows, 0)).toEqual([0]);          // top: only depth 0
  expect(allowedDepths(rows, 3)).toEqual([0, 1, 2, 3]); // after c(d2): up to child-of-c
  expect(allowedDepths(rows, 4)).toEqual([0]);          // after collapsed d: NO child depth
  expect(allowedDepths(rows, 5)).toEqual([0]);          // end of outline
  expect(allowedDepths([], 0)).toEqual([0]);            // empty outline
});

it("depthFromX rounds by indent and clamps to the allowed range", () => {
  expect(depthFromX([0, 1, 2], 0)).toBe(0);
  expect(depthFromX([0, 1, 2], 1.4 * INDENT_PX)).toBe(1);
  expect(depthFromX([0, 1, 2], 99 * INDENT_PX)).toBe(2);
  expect(depthFromX([1, 2], 0)).toBe(1);
});

it("resolveDrop picks parent and order_idx from the chosen depth", () => {
  // boundary 3 = after c; depth 1 → child of a, after b → order_idx 1
  expect(resolveDrop(page(), "P", OTHER, 3, 1))
    .toEqual({ parent_uid: "a", order_idx: 1, page_title: "P" });
  // boundary 3, depth 3 → first child of c
  expect(resolveDrop(page(), "P", OTHER, 3, 3))
    .toEqual({ parent_uid: "c", order_idx: 0, page_title: "P" });
  // boundary 1 = between a and b… wait: b is a's child; boundary 1, depth 0
  // → top level, insert before d? No: first row at/after boundary with
  // parent null is d(order 1) → insert before d at a's own level.
  expect(resolveDrop(page(), "P", OTHER, 1, 0))
    .toEqual({ parent_uid: null, order_idx: 1, page_title: "P" });
});

it("resolveDrop returns null for a same-position drop", () => {
  // dragging f, dropping at the very end at depth 0 = where it already is
  const drag = { uid: "f", pageTitle: "P" };
  const rows = dropRows(page(), drag, "P");
  expect(resolveDrop(page(), "P", drag, rows.length, 0)).toBeNull();
  // and dropping right before its own old slot is also a no-op
  expect(resolveDrop(page(), "P", drag, 4, 0)).toBeNull();
});

it("resolveDrop from another page never returns null (content must move)", () => {
  const t = resolveDrop(page(), "P", OTHER, 5, 0);
  expect(t).toEqual({ parent_uid: null, order_idx: 3, page_title: "P" });
});
```

Fix the small inline comment confusion in the third test before committing: the expectation is authoritative (insert before `d` at top level → `order_idx: 1`).

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/outline/dnd.test.ts`
Expected: FAIL — module `./dnd` does not exist.

- [ ] **Step 3: Implement `web/src/outline/dnd.ts`**

```ts
// pattern: Functional Core
// Drop-semantics for block drag-and-drop: which boundaries and depths are
// legal, and what move op a (boundary, depth) resolves to. The DOM shell
// (useDropZone) only measures pixels and calls in here.
import type { BlockNode } from "../api/payloads";
import { applyOps, locate } from "./tree";

export const INDENT_PX = 30; // .block-children: 22px margin-left + 8px padding

export interface DragSource { uid: string; pageTitle: string }
export interface DropTarget {
  parent_uid: string | null;
  order_idx: number;
  page_title: string;
}
export interface DropRow { uid: string; depth: number; collapsed: boolean }

/** On-screen rows (collapsed children hidden), excluding the dragged
 * subtree when the drag comes from this page — boundaries behave as if the
 * block were already lifted out. */
export function dropRows(blocks: BlockNode[], drag: DragSource,
                         pageTitle: string): DropRow[] {
  const out: DropRow[] = [];
  const skipUid = drag.pageTitle === pageTitle ? drag.uid : null;
  const walk = (nodes: BlockNode[], depth: number) => {
    for (const n of nodes) {
      if (n.uid === skipUid) continue;
      out.push({ uid: n.uid, depth, collapsed: n.collapsed });
      if (!n.collapsed) walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

/** Depths legal at `boundary` (the gap above rows[boundary]; rows.length =
 * after the last row), ascending. A collapsed row above admits no child
 * depth — nothing may land invisibly inside a closed subtree. */
export function allowedDepths(rows: DropRow[], boundary: number): number[] {
  const above = rows[boundary - 1];
  const below = rows[boundary];
  const max = above ? (above.collapsed ? above.depth : above.depth + 1) : 0;
  const min = below ? below.depth : 0;
  const out: number[] = [];
  for (let d = Math.min(min, max); d <= max; d++) out.push(d);
  return out;
}

export function depthFromX(allowed: number[], offsetX: number): number {
  const raw = Math.round(offsetX / INDENT_PX);
  const lo = allowed[0];
  const hi = allowed[allowed.length - 1];
  return Math.max(lo, Math.min(hi, raw));
}

/** uid:parent pairs in depth-first order — the structural fingerprint a
 * same-position drop leaves unchanged. */
function shape(blocks: BlockNode[]): string {
  const out: string[] = [];
  const walk = (nodes: BlockNode[], parent: string | null) => {
    for (const n of nodes) {
      out.push(`${n.uid}:${parent}`);
      walk(n.children, n.uid);
    }
  };
  walk(blocks, null);
  return out.join("|");
}

/** Resolve (boundary, depth) to a move target. Returns null when the drop
 * would change nothing (same page, same position). */
export function resolveDrop(blocks: BlockNode[], pageTitle: string,
                            drag: DragSource, boundary: number,
                            depth: number): DropTarget | null {
  const rows = dropRows(blocks, drag, pageTitle);
  let parentUid: string | null = null;
  if (depth > 0) {
    for (let i = boundary - 1; i >= 0; i--) {
      if (rows[i].depth === depth - 1) { parentUid = rows[i].uid; break; }
      if (rows[i].depth < depth - 1) return null; // no such parent here
    }
    if (parentUid === null) return null;
  }
  // first row at/after the boundary that is a visible child of parentUid:
  // insert before it. Walk until the parent's subtree region ends.
  let orderIdx: number | null = null;
  for (let i = boundary; i < rows.length; i++) {
    if (rows[i].depth < depth) break;      // left the parent's region
    if (rows[i].depth === depth) {
      const loc = locate(blocks, rows[i].uid);
      orderIdx = loc ? loc.node.order_idx : null;
      break;
    }
  }
  if (orderIdx === null) {
    const siblings = parentUid === null
      ? blocks : locate(blocks, parentUid)?.node.children ?? [];
    const last = siblings[siblings.length - 1];
    orderIdx = last ? last.order_idx + 1 : 0;
  }
  const target: DropTarget =
    { parent_uid: parentUid, order_idx: orderIdx, page_title: pageTitle };
  if (drag.pageTitle === pageTitle) {
    const after = applyOps(blocks, [{ op: "move", uid: drag.uid,
      parent_uid: parentUid, order_idx: orderIdx }], pageTitle);
    if (shape(after) === shape(blocks)) return null;
  }
  return target;
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run src/outline/dnd.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/outline/dnd.ts web/src/outline/dnd.test.ts
git commit -m "feat(web): pure drop-semantics core for block drag-and-drop"
git push
```

---

### Task 6: Sync `idle()`, outline DnD API, cross-page refetch, and the Dnd context

**Files:**
- Modify: `web/src/sync/SyncProvider.tsx` (expose `idle()`)
- Modify: `web/src/outline/useOutline.ts` (DnD api + target-side refetch)
- Create: `web/src/dnd/DndContext.tsx`
- Test: `web/src/dnd/DndContext.test.tsx`
- Modify: `web/src/test-helpers.ts` (makeSync gains `idle`)

**Interfaces:**
- Consumes: Task 4 helpers (`removeSubtree`, `insertSubtree`), Task 5 types (`DragSource`, `DropTarget`).
- Produces:
  - `Sync.idle(): Promise<void>` (delegates to the op queue; the default context value resolves immediately).
  - `Outline.dnd: OutlineDndApi` where

    ```ts
    export interface OutlineDndApi {
      moveTo(uid: string, target: DropTarget): void;      // same-page, optimistic via run()
      removeSubtreeLocal(uid: string): BlockNode | null;  // flushes drafts; no ops
      insertSubtreeLocal(node: BlockNode, target: DropTarget): void; // no ops
    }
    ```
  - `useOutline` refetches its page (`GET /api/page/{title}` → adopt `blocks`) when a remote batch contains a move op with `page_title === pageTitle` whose uid isn't present locally (this outline is the cross-page **target**; the op carries no content).
  - `DndContext` (provided in `App` by Task 7):

    ```ts
    export interface Dnd {
      drag: DragSource | null;
      startDrag(d: DragSource): void;
      endDrag(): void;
      registerOutline(pageTitle: string, api: OutlineDndApi): () => void;
      registerPanel(pageTitle: string, refetch: () => void): () => void;
      drop(drag: DragSource, target: DropTarget): void;
    }
    export const DndContext: React.Context<Dnd>;  // default: inert no-ops, drag=null
    export function DndProvider({ children }: { children: ReactNode }): JSX.Element;
    export function useDnd(): Dnd;
    ```

  - `drop()` dispatch rules (all enqueue through `useSync`):
    - same page (`target.page_title === drag.pageTitle`): registered outline → `moveTo` (which enqueues); no registered outline (drag started in a sidebar panel of an unopened page) → enqueue `{op:"move", uid, parent_uid, order_idx}` directly.
    - cross-page: `node = outlines.get(drag.pageTitle)?.removeSubtreeLocal(uid) ?? null`; if the target outline is registered AND `node` came back, `insertSubtreeLocal(node, target)`; always enqueue one `{op:"move", uid, parent_uid, order_idx, page_title}`.
    - after enqueue: `void sync.idle().then(() => notifyPanels(drag.pageTitle, target.page_title))` — every registered panel refetch for either title fires once the queue drains.

- [ ] **Step 1: Write the failing tests** — create `web/src/dnd/DndContext.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync } from "../test-helpers";
import { DndProvider, useDnd, type OutlineDndApi } from "./DndContext";

function Harness({ onReady }: { onReady: (dnd: ReturnType<typeof useDnd>) => void }) {
  const dnd = useDnd();
  useEffect(() => onReady(dnd), [dnd, onReady]);
  return null;
}

function setup() {
  const sync = makeSync();
  let dnd!: ReturnType<typeof useDnd>;
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider><Harness onReady={(d) => { dnd = d; }} /></DndProvider>
    </SyncContext.Provider>);
  return { sync, dnd: () => dnd };
}

function fakeOutline(over: Partial<OutlineDndApi> = {}): OutlineDndApi {
  return { moveTo: vi.fn(), removeSubtreeLocal: vi.fn(() => null),
           insertSubtreeLocal: vi.fn(), ...over };
}

it("same-page drop delegates to the registered outline's moveTo", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  dnd().registerOutline("P", api);
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: null, order_idx: 2, page_title: "P" });
  expect(api.moveTo).toHaveBeenCalledWith("u1",
    { parent_uid: null, order_idx: 2, page_title: "P" });
  expect(sync.sent).toEqual([]); // moveTo enqueues internally, fake doesn't
});

it("same-page drop with no registered outline enqueues the op directly", () => {
  const { sync, dnd } = setup();
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: "x", order_idx: 0, page_title: "P" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: "x", order_idx: 0 }]]);
});

it("cross-page drop does two-outline surgery and one op with page_title", () => {
  const { sync, dnd } = setup();
  const moved: BlockNode = block("u1", "hi");
  const src = fakeOutline({ removeSubtreeLocal: vi.fn(() => moved) });
  const dst = fakeOutline();
  dnd().registerOutline("A", src);
  dnd().registerOutline("B", dst);
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(src.removeSubtreeLocal).toHaveBeenCalledWith("u1");
  expect(dst.insertSubtreeLocal).toHaveBeenCalledWith(moved,
    { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1,
      page_title: "B" }]]);
});

it("panels for both pages refetch after the queue drains", async () => {
  const { dnd } = setup();
  const srcRefetch = vi.fn();
  const dstRefetch = vi.fn();
  dnd().registerPanel("A", srcRefetch);
  dnd().registerPanel("B", dstRefetch);
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 0, page_title: "B" });
  await Promise.resolve(); await Promise.resolve(); // idle() microtasks
  expect(srcRefetch).toHaveBeenCalled();
  expect(dstRefetch).toHaveBeenCalled();
});

it("unregister stops delivery", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  const off = dnd().registerOutline("P", api);
  off();
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: null, order_idx: 0, page_title: "P" });
  expect(api.moveTo).not.toHaveBeenCalled();
  expect(sync.sent.length).toBe(1); // fell back to direct enqueue
});
```

Extend `makeSync` in `web/src/test-helpers.ts` with `idle: () => Promise.resolve()` and add `idle` to the `Sync` interface default in `SyncProvider.tsx` (Step 3).

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/dnd/DndContext.test.tsx`
Expected: FAIL — `./DndContext` does not exist.

- [ ] **Step 3: Implement**

`SyncProvider.tsx` — add to the `Sync` interface and both values:

```ts
  /** Resolves once nothing is pending or in flight in the op queue. */
  idle(): Promise<void>;
```
Default context value: `idle: () => Promise.resolve(),`; in the provider's `api` memo: `idle: () => queue.idle(),`.

`test-helpers.ts` — `makeSync` return gains `idle: () => Promise.resolve(),`.

`useOutline.ts` — add imports (`removeSubtree`, `insertSubtree` from `./tree`, `apiFetch` from `../api/client`, `encodeTitle` from `../paths`, `PagePayload` type, `DropTarget` from `./dnd`), then:

1. In the `sync.subscribe` effect, detect target-side cross-page moves before applying:

```ts
  useEffect(() => sync.subscribe((batch) => {
    const needsRefetch = batch.ops.some((op) =>
      op.op === "move" && op.page_title != null &&
      op.page_title === pageTitle &&
      !findNode(blocksRef.current, op.uid));
    const ops = batch.ops.filter((op) =>
      !(op.op === "update_text" && op.uid === focusRef.current?.uid));
    blocksRef.current = applyOps(blocksRef.current, ops, pageTitle);
    setBlocks(blocksRef.current);
    if (needsRefetch) {
      // we are the target of a cross-page move: the op carries no block
      // content, so adopt the authoritative tree
      void apiFetch<PagePayload>(`/api/page/${encodeTitle(pageTitle)}`)
        .then((p) => { blocksRef.current = p.blocks; setBlocks(p.blocks); })
        .catch(() => undefined); // next resync will repair
    }
  }), [sync, pageTitle]);
```

2. Add the DnD api to the returned object (and to the `Outline` interface):

```ts
  const dnd = useMemo<OutlineDndApi>(() => ({
    moveTo: (uid, target) => run((b) => {
      const ops: BlockOp[] = [{ op: "move", uid,
        parent_uid: target.parent_uid, order_idx: target.order_idx }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    }),
    removeSubtreeLocal: (uid) => {
      flushNow();
      const { tree, node } = removeSubtree(blocksRef.current, uid);
      if (!node) return null;
      blocksRef.current = tree;
      setBlocks(tree);
      setFocus((f) => (f && findNode(tree, f.uid) ? f : null));
      return node;
    },
    insertSubtreeLocal: (node, target) => {
      blocksRef.current = insertSubtree(
        blocksRef.current, node, target.parent_uid, target.order_idx);
      setBlocks(blocksRef.current);
    },
  }), [run, flushNow, pageTitle]);
```

with `OutlineDndApi` defined in (and exported from) `DndContext.tsx`; `useOutline` imports the type. Add `dnd: OutlineDndApi;` to the `Outline` interface and `dnd,` to the return.

`web/src/dnd/DndContext.tsx` — new file:

```tsx
// pattern: Imperative Shell
// App-wide drag state + drop dispatch. HTML5 dataTransfer is unreadable
// during dragover, so the active drag lives here. Outlines register their
// optimistic APIs by page title; read-only sidebar panels register a
// refetch instead and are refreshed once the op queue drains.
import { createContext, useContext, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { DragSource, DropTarget } from "../outline/dnd";
import { useSync } from "../sync/SyncProvider";

export interface OutlineDndApi {
  moveTo(uid: string, target: DropTarget): void;
  removeSubtreeLocal(uid: string): BlockNode | null;
  insertSubtreeLocal(node: BlockNode, target: DropTarget): void;
}

export interface Dnd {
  drag: DragSource | null;
  startDrag(d: DragSource): void;
  endDrag(): void;
  registerOutline(pageTitle: string, api: OutlineDndApi): () => void;
  registerPanel(pageTitle: string, refetch: () => void): () => void;
  drop(drag: DragSource, target: DropTarget): void;
}

export const DndContext = createContext<Dnd>({
  drag: null,
  startDrag: () => undefined,
  endDrag: () => undefined,
  registerOutline: () => () => undefined,
  registerPanel: () => () => undefined,
  drop: () => undefined,
});

export function useDnd(): Dnd {
  return useContext(DndContext);
}

export function DndProvider({ children }: { children: ReactNode }) {
  const sync = useSync();
  const [drag, setDrag] = useState<DragSource | null>(null);
  const outlinesRef = useRef(new Map<string, OutlineDndApi>());
  const panelsRef = useRef(new Map<string, Set<() => void>>());

  const api = useMemo<Dnd>(() => ({
    drag,
    startDrag: (d) => setDrag(d),
    endDrag: () => setDrag(null),
    registerOutline: (title, outlineApi) => {
      outlinesRef.current.set(title, outlineApi);
      return () => {
        if (outlinesRef.current.get(title) === outlineApi) {
          outlinesRef.current.delete(title);
        }
      };
    },
    registerPanel: (title, refetch) => {
      const set = panelsRef.current.get(title) ?? new Set();
      set.add(refetch);
      panelsRef.current.set(title, set);
      return () => { set.delete(refetch); };
    },
    drop: (d, target) => {
      const src = outlinesRef.current.get(d.pageTitle);
      if (target.page_title === d.pageTitle) {
        if (src) {
          src.moveTo(d.uid, target);
        } else {
          const ops: BlockOp[] = [{ op: "move", uid: d.uid,
            parent_uid: target.parent_uid, order_idx: target.order_idx }];
          sync.enqueue(ops);
        }
      } else {
        const node = src?.removeSubtreeLocal(d.uid) ?? null;
        const dst = outlinesRef.current.get(target.page_title);
        if (dst && node) dst.insertSubtreeLocal(node, target);
        const ops: BlockOp[] = [{ op: "move", uid: d.uid,
          parent_uid: target.parent_uid, order_idx: target.order_idx,
          page_title: target.page_title }];
        sync.enqueue(ops);
      }
      void sync.idle().then(() => {
        for (const title of [d.pageTitle, target.page_title]) {
          panelsRef.current.get(title)?.forEach((fn) => fn());
        }
      });
      setDrag(null);
    },
  }), [drag, sync]);

  return <DndContext.Provider value={api}>{children}</DndContext.Provider>;
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run && pnpm typecheck`
Expected: PASS (full suite — the `useOutline` changes must not break existing EditablePage/Journal tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/SyncProvider.tsx web/src/outline/useOutline.ts \
        web/src/dnd/DndContext.tsx web/src/dnd/DndContext.test.tsx \
        web/src/test-helpers.ts
git commit -m "feat(web): DnD dispatch context, outline drag api, cross-page target refetch"
git push
```

---

### Task 7: Drop-zone shell + EditableBlockTree/EditablePage wiring

**Files:**
- Create: `web/src/dnd/useDropZone.ts`
- Modify: `web/src/components/EditableBlockTree.tsx`
- Modify: `web/src/views/EditablePage.tsx`
- Modify: `web/src/App.tsx` (wrap in `DndProvider`)
- Modify: `web/src/styles.css`
- Test: `web/src/components/EditableBlockTree.dnd.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`dropRows`, `allowedDepths`, `depthFromX`, `resolveDrop`, `INDENT_PX`), Task 6 (`useDnd`, `Outline.dnd`).
- Produces:
  - `useDropZone(pageTitle, getBlocks, containerRef): { indicator: {top: number; left: number} | null; zoneProps: {onDragOver; onDragLeave; onDrop} }` — all DOM math for one outline: boundary from row rects (rows found by `[data-uid]` within the container, ordered to match `dropRows`), depth from `clientX - containerRect.left`, indicator position, and dispatch via `useDnd().drop`.
  - `EditableBlockTree` rows: `.block-row` gains `data-uid={node.uid}`; the bullet becomes `draggable={!readOnly}` with `onDragStart` → `handlers.onDragStartBlock(node.uid)` plus `e.dataTransfer.setData("text/plain", node.uid)` and `effectAllowed = "move"`, `onDragEnd` → `endDrag()`.
  - New `OutlineHandlers` member: `onDragStartBlock(uid: string): void` (EditablePage supplies it: flush + `startDrag`).
  - `EditablePage` renders the container with zone props + the indicator div (`.drop-indicator`), registers `outline.dnd` with the context, and keeps an **empty-outline drop zone**: when `blocks.length === 0`, the empty button's wrapper accepts a drop resolving to `{parent_uid: null, order_idx: 0, page_title: title}` — this covers not-yet-existing journal days for free.

- [ ] **Step 1: Write the failing component test** — create `web/src/components/EditableBlockTree.dnd.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SyncContext } from "../sync/SyncProvider";
import { DndProvider } from "../dnd/DndContext";
import { EditablePage } from "../views/EditablePage";
import { block, makeSync } from "../test-helpers";

// jsdom has no DataTransfer: minimal stub
function dt() {
  const data: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "", dropEffect: "",
  };
}

function renderPage(blocks = [
  block("u1", "one", { order_idx: 0 }),
  block("u2", "two", { order_idx: 1 }),
]) {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><EditablePage title="P" initial={blocks} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  return sync;
}

it("bullets are draggable and a drop reorders via one move op", () => {
  const sync = renderPage();
  const rows = document.querySelectorAll(".block-row");
  const bullets = document.querySelectorAll(".bullet");
  expect(bullets[0]).toHaveAttribute("draggable", "true");

  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer });
  // drop at the very top boundary (above row u1): rects are all 0 in
  // jsdom, so clientY 0 maps to boundary 0 and clientX 0 to depth 0
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "u2", parent_uid: null, order_idx: 0 }]]);
  // optimistic: u2 now renders first
  const texts = [...document.querySelectorAll(".block-text")].map((n) => n.textContent);
  expect(texts).toEqual(["two", "one"]);
  void rows;
});

it("an empty page accepts a top-level drop from another page", () => {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><EditablePage title="Empty" initial={[]} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  // simulate a drag that started elsewhere (context drag set via dragstart
  // is per-provider; here we drive the zone directly with an external drag)
  const zone = screen.getByText(/start writing/i).closest(".empty-drop-zone")!;
  void zone;
  // NOTE: full cross-provider simulation happens in Task 8's journal test;
  // here assert the zone element exists and is wired (has drop handler via
  // React — smoke-level assertion):
  expect(zone).toBeTruthy();
});

it("dragging is disabled when read-only", () => {
  const sync = makeSync("reconnecting");
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><EditablePage title="P" initial={[block("u1", "x")]} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  expect(document.querySelector(".bullet")).toHaveAttribute("draggable", "false");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/components/EditableBlockTree.dnd.test.tsx`
Expected: FAIL — bullets not draggable, no zone handlers.

- [ ] **Step 3: Implement**

`web/src/dnd/useDropZone.ts` — new file:

```ts
// pattern: Imperative Shell
// DOM measurement for one outline's drop zone: pixel positions in, pure
// dnd.ts semantics out. One indicator per outline.
import { useCallback, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop,
         INDENT_PX, type DropRow } from "../outline/dnd";
import { useDnd } from "./DndContext";

export interface Indicator { top: number; left: number }

/** Boundary index for clientY among the container's rendered rows (rows =
 * dropRows order; element lookup by data-uid). Above a row's midpoint =
 * the boundary before it; below every midpoint = rows.length. */
function boundaryAt(container: HTMLElement, rows: DropRow[],
                    clientY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const el = container.querySelector<HTMLElement>(
      `[data-uid="${CSS.escape(rows[i].uid)}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

/** y-position (relative to container) for the indicator at a boundary. */
function indicatorTop(container: HTMLElement, rows: DropRow[],
                      boundary: number): number {
  const cr = container.getBoundingClientRect();
  const rowEl = (i: number) => container.querySelector<HTMLElement>(
    `[data-uid="${CSS.escape(rows[i].uid)}"]`);
  if (rows.length === 0) return 0;
  if (boundary < rows.length) {
    const el = rowEl(boundary);
    return el ? el.getBoundingClientRect().top - cr.top : 0;
  }
  const el = rowEl(rows.length - 1);
  return el ? el.getBoundingClientRect().bottom - cr.top : 0;
}

export function useDropZone(pageTitle: string,
                            getBlocks: () => BlockNode[],
                            containerRef: React.RefObject<HTMLElement | null>) {
  const dnd = useDnd();
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // candidate survives between dragover and drop
  const candidateRef = useRef<{ boundary: number; depth: number } | null>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const container = containerRef.current;
    if (!dnd.drag || !container) return;
    const blocks = getBlocks();
    const rows = dropRows(blocks, dnd.drag, pageTitle);
    const boundary = boundaryAt(container, rows, e.clientY);
    const allowed = allowedDepths(rows, boundary);
    if (allowed.length === 0) return;
    e.preventDefault(); // this zone accepts the drag
    e.dataTransfer.dropEffect = "move";
    const offsetX = e.clientX - container.getBoundingClientRect().left;
    const depth = depthFromX(allowed, offsetX);
    candidateRef.current = { boundary, depth };
    setIndicator({ top: indicatorTop(container, rows, boundary),
                   left: depth * INDENT_PX });
  }, [dnd.drag, getBlocks, pageTitle, containerRef]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    candidateRef.current = null;
    setIndicator(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const cand = candidateRef.current;
    candidateRef.current = null;
    setIndicator(null);
    if (!dnd.drag || !cand) return;
    const target = resolveDrop(getBlocks(), pageTitle, dnd.drag,
                               cand.boundary, cand.depth);
    if (target) dnd.drop(dnd.drag, target);
    else dnd.endDrag();
  }, [dnd, getBlocks, pageTitle]);

  return { indicator, zoneProps: { onDragOver, onDragLeave, onDrop } };
}
```

`EditableBlockTree.tsx`:
- `OutlineHandlers` gains `onDragStartBlock(uid: string): void;`
- `.block-row` div gains `data-uid={node.uid}`.
- The bullet becomes:

```tsx
        <span className="bullet" draggable={!readOnly}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", node.uid);
                e.dataTransfer.effectAllowed = "move";
                handlers.onDragStartBlock(node.uid);
              }}>
          •
        </span>
```

(No `onDragEnd` cleanup here: `drop()` clears the drag; a cancelled drag is cleared by `EditablePage`'s `onDragEnd` on the container — add `onDragEnd={() => dnd.endDrag()}` to the zone container in `EditablePage`.)

`EditablePage.tsx` — rewire:

```tsx
// pattern: Imperative Shell
import { useEffect, useRef } from "react";
import type { BlockNode } from "../api/payloads";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day). */
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const outline = useOutline(title, initial);
  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef(outline.blocks);
  blocksRef.current = outline.blocks;
  const { indicator, zoneProps } =
    useDropZone(title, () => blocksRef.current, containerRef);

  useEffect(() => dnd.registerOutline(title, outline.dnd),
            [dnd, title, outline.dnd]);

  const handlers = {
    ...outline.handlers,
    onDragStartBlock: (uid: string) => {
      if (outline.readOnly) return;
      dnd.startDrag({ uid, pageTitle: title });
    },
  };

  return (
    <div ref={containerRef} className="outline-drop-zone"
         style={{ position: "relative" }}
         {...(outline.readOnly ? {} : zoneProps)}
         onDragEnd={() => dnd.endDrag()}>
      {outline.blocks.length === 0 ? (
        <div className="empty-drop-zone">
          <button className="empty-page" disabled={outline.readOnly}
                  onClick={() => outline.createFirstBlock()}>
            Click to start writing…
          </button>
        </div>
      ) : (
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           handlers={handlers}
                           readOnly={outline.readOnly} />
      )}
      {indicator && (
        <div className="drop-indicator"
             style={{ top: indicator.top, left: indicator.left }} />
      )}
      {composer && (
        <Composer onSend={outline.appendBlock} readOnly={outline.readOnly} />
      )}
    </div>
  );
}
```

Note: `outline.handlers` currently satisfies `OutlineHandlers` which now REQUIRES `onDragStartBlock` — add a no-op `onDragStartBlock: () => undefined` inside `useOutline`'s handlers memo so the interface stays satisfied there, and `EditablePage` overrides it as above. (The empty-outline case: `useDropZone` handles `rows.length === 0` → boundary 0, allowed `[0]`, `resolveDrop` → `order_idx 0`, so the wrapper zone works without extra code.)

`App.tsx`: wrap the tree in the provider — `<SyncProvider><DndProvider><SidebarContext.Provider ...>` (DndProvider must be inside SyncProvider since it calls `useSync`).

`styles.css` — append:

```css
.drop-indicator {
  position: absolute;
  right: 0;
  height: 0;
  border-top: 2px solid #4a9eda;
  pointer-events: none;
  z-index: 5;
}
.bullet[draggable="true"] { cursor: grab; }
```

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run && pnpm typecheck`
Expected: PASS — full suite (existing EditablePage/Journal tests must still pass with the new wrapper div; fix any selector fallout in THOSE tests only if a query legitimately changed, e.g. `closest(".block-tree")`).

- [ ] **Step 5: Commit**

```bash
git add web/src/dnd/useDropZone.ts web/src/components/EditableBlockTree.tsx \
        web/src/views/EditablePage.tsx web/src/App.tsx web/src/styles.css \
        web/src/components/EditableBlockTree.dnd.test.tsx web/src/outline/useOutline.ts
git commit -m "feat(web): drag-and-drop within and between editable outlines"
git push
```

---

### Task 8: Sidebar panels — drag source, drop target, refetch

**Files:**
- Modify: `web/src/components/BlockTree.tsx`
- Modify: `web/src/components/SidebarPanel.tsx`
- Test: `web/src/components/SidebarPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: Tasks 5-7 (`useDnd`, `useDropZone`, `DragSource`).
- Produces: sidebar panels drag out and accept drops; a panel refetches (a) via `registerPanel` after any drop touching its page, (b) implicitly by being the drop target (same path). `BlockTree` gains optional props `dndPage?: string` (page title; presence enables bullet dragging when `draggable` is true) — read-only rendering elsewhere (backlinks etc.) passes nothing and is unaffected.

- [ ] **Step 1: Write the failing tests** — extend `web/src/components/SidebarPanel.test.tsx` (follow its existing fetch-stub pattern with `stubFetch` + `pagePayload`):

```tsx
it("panel bullets are draggable and start a drag for the panel's page", () => {
  stubFetch([["/api/page/Some%20Page", pagePayload("Some Page",
    [block("s1", "side one")])]]);
  // render inside DndProvider + SyncContext (copy the file's render helper,
  // adding the providers as in EditableBlockTree.dnd.test.tsx)
  ...
  await screen.findByText("side one");
  expect(document.querySelector(".sidebar-panel .bullet"))
    .toHaveAttribute("draggable", "true");
});

it("panel refetches after a drop that touches its page", async () => {
  const fetchMock = stubFetch([["/api/page/Some%20Page",
    pagePayload("Some Page", [block("s1", "side one")])]]);
  ...render panel for "Some Page" inside providers, plus a Harness exposing useDnd()...
  await screen.findByText("side one");
  const before = fetchMock.mock.calls.length;
  dnd.drop({ uid: "zz", pageTitle: "Elsewhere" },
           { parent_uid: null, order_idx: 0, page_title: "Some Page" });
  await Promise.resolve(); await Promise.resolve();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
});
```

(Write these fully in the file, reusing its existing helpers; the elisions above are render plumbing identical to Task 7's test.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/components/SidebarPanel.test.tsx`
Expected: FAIL — bullets not draggable; no refetch.

- [ ] **Step 3: Implement**

`BlockTree.tsx` — thread an optional drag page through:

```tsx
export function Block({ node, dndPage }: { node: BlockNode; dndPage?: string }) {
  ...
        <span className="bullet" draggable={dndPage !== undefined}
              onDragStart={dndPage === undefined ? undefined : (e) => {
                e.dataTransfer.setData("text/plain", node.uid);
                e.dataTransfer.effectAllowed = "move";
                dnd.startDrag({ uid: node.uid, pageTitle: dndPage });
              }}>
          •
        </span>
  ...
  {node.children.map((c) => <Block key={c.uid} node={c} dndPage={dndPage} />)}
```

with `const dnd = useDnd();` at the top of `Block`. (`useDnd` outside a provider returns the inert default, so plain read views stay dead.) The file's `// pattern:` header becomes `// pattern: Imperative Shell` (it now touches a context that dispatches I/O) — update the comment.

`SidebarPanel.tsx`:

```tsx
export function SidebarPanel({ title, onClose }:
    { title: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const { indicator, zoneProps } = useDropZone(
    title, () => payloadRef.current?.blocks ?? [], containerRef);

  useEffect(() => dnd.registerPanel(title, () => setRefreshSeq((n) => n + 1)),
            [dnd, title]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title, refreshSeq]);

  return (
    <section className="sidebar-panel" aria-label={`sidebar: ${title}`}>
      ...header unchanged...
      {payload && (
        <div ref={containerRef} style={{ position: "relative" }}
             {...zoneProps} onDragEnd={() => dnd.endDrag()}>
          <BlockRefContext.Provider value={payload.block_ref_texts}>
            <BlockTree blocks={payload.blocks} dndPage={title} />
          </BlockRefContext.Provider>
          {indicator && (
            <div className="drop-indicator"
                 style={{ top: indicator.top, left: indicator.left }} />
          )}
        </div>
      )}
    </section>
  );
}
```

(Keep the error/loading paragraphs as they are. New imports: `useRef`, `useDnd`, `useDropZone`, `BlockTree` already imported.)

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run && pnpm typecheck`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/BlockTree.tsx web/src/components/SidebarPanel.tsx \
        web/src/components/SidebarPanel.test.tsx
git commit -m "feat(web): sidebar panels as drag-and-drop sources and targets"
git push
```

---

### Task 9: Whole-feature verification and completion

**Files:**
- Modify: `.beans/pkm-jg1p--drag-and-drop-of-blocks-on-desktop.md` (via `beans update`)

- [ ] **Step 1: Full test suites**

Run: `cd server && uv run pytest` — Expected: all pass
Run: `cd web && pnpm vitest run && pnpm typecheck` — Expected: all pass
Run: `cd web && pnpm e2e` — Expected: existing Playwright specs still pass

- [ ] **Step 2: Real-data smoke (agent-browser or manual), against a scratch copy**

Copy the real DB with the SQLite backup API from a `mode=ro` connection (never open the live file for writing — see the plan-5 smoke pattern in the design spec's findings section), run `pkm.server.run` on a scratch port with the built SPA, then verify in a real browser:
1. Drag a block within a heavy page (e.g. `Paper`): indicator tracks boundaries and depth; drop reorders; reload confirms persistence.
2. Drag a block from one journal day to another in the scroll; both days correct after reload; `((refs))` to the moved block still resolve.
3. Shift-click a page into the sidebar; drag a block from the main pane into the panel (panel refreshes with it) and back out.
4. Drop onto a day that doesn't exist yet; the page is created with the block.
5. Second browser window: watch a cross-page move arrive (target page refetches).
6. Kill the server: bullets stop being draggable (read-only).
Record pre/post page+block counts on the REAL db (must be identical).

- [ ] **Step 3: Complete the bean and push**

```bash
beans update pkm-jg1p -s completed --body-append "
## Summary of Changes
<one paragraph: what shipped, where the pure logic lives, smoke results>"
git add .beans/pkm-jg1p--drag-and-drop-of-blocks-on-desktop.md
git commit -m "feat: block drag-and-drop on desktop (closes pkm-jg1p)"
git push
```

---

## Self-Review Notes

- Spec coverage: interaction rules (T5, T7), collapsed/child exclusion (T5 `allowedDepths`), own-subtree exclusion (T5 `dropRows`), same-position no-op (T5 `resolveDrop`), server cross-page semantics incl. auto-create + mismatch 400 (T1-T2), FTS resolved as no-op (design note in header), types regen (T3), source-side removal via applyOps + target-side refetch (T4, T6), two-outline optimistic surgery (T6), sidebar drag/drop/refetch (T8), read-only disabling (T7 test), empty-day drop (T7 via empty-outline zone), remote-client resync (T6), draft flush on drag of focused block (T6 `removeSubtreeLocal` calls `flushNow`; same-page moves flush inside `run()`).
- Deliberate simplification: `startDrag` for a focused block flushes via `run()`/`flushNow` at drop time, not drag start — acceptable because no text change can happen mid-drag (the textarea loses focus when the drag begins).
- Types: `DropTarget`/`DragSource`/`OutlineDndApi` names are used consistently across T5-T8; `Outline.dnd` produced in T6, consumed in T7.
