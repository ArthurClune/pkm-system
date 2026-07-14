# Block Presentation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement persistent numbered subtree views, heading shortcuts/menu controls, and exact-prefix quote rendering for blocks.

**Architecture:** Extend the existing block column/operation pipeline with nullable `view_type`, including importer, server, generated contracts, offline replica, and optimistic in-memory application. Keep quote recognition as a pure presentation helper, and extend the shared block menu plus both tree renderers without changing stored text or structure.

**Tech Stack:** Python 3.12, FastAPI/Pydantic, SQLite, React 19, TypeScript, Vitest/Testing Library, Playwright, pnpm, uv.

## Global Constraints

- Follow FCIS declarations: pure transformations are Functional Core; database, DOM, HTTP, and queue code are Imperative Shell.
- Numbered view follows Roam children-view semantics: a block controls descendant markers, not its own marker.
- Stored view values are `"numbered"`, `"document"`, or `null` for inheritance; page-root inheritance resolves to document.
- Quote recognition matches only the exact leading prefix `> ` and never rewrites stored text.
- Heading controls dispatch the existing `set_heading` operation; view controls dispatch `set_view_type`.
- Generated OpenAPI and base-schema artifacts are regenerated, never hand-edited.
- Every production behavior is introduced by a failing test first.

---

### Task 1: Quote presentation core and renderers

**Files:**
- Create: `web/src/components/blockPresentation.ts`
- Create: `web/src/components/blockPresentation.test.ts`
- Modify: `web/src/components/BlockTree.tsx`
- Modify: `web/src/components/BlockTree.test.tsx`
- Modify: `web/src/components/EditableBlockTree.tsx`
- Modify: `web/src/components/EditableBlockTree.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `quoteContent(text: string): string | null`.
- Consumers: read-only and editable unfocused block renderers.

- [ ] **Step 1: Write failing pure and component tests**

```ts
// blockPresentation.test.ts
expect(quoteContent("> quoted")).toBe("quoted");
expect(quoteContent("x > quoted")).toBeNull();
expect(quoteContent(">quoted")).toBeNull();
expect(quoteContent("> ")).toBe("");

// BlockTree.test.tsx
render(<BlockTree blocks={[block("q", "> hello [[World]]")]} />);
expect(screen.getByText("hello").closest(".quote-block")).not.toBeNull();
expect(screen.getByRole("link", { name: "World" })).toBeInTheDocument();
expect(screen.queryByText("> hello", { exact: false })).toBeNull();
```

Add editable-tree tests that an unfocused quoted block has `.quote-block`, focusing
reveals the textarea value `> hello`, and rerendering after text becomes `hello`
removes the class.

- [ ] **Step 2: Run tests and confirm the missing helper/behavior failures**

Run: `cd web && pnpm vitest run src/components/blockPresentation.test.ts src/components/BlockTree.test.tsx src/components/EditableBlockTree.test.tsx`

Expected: FAIL because `quoteContent` and quote rendering do not exist.

- [ ] **Step 3: Implement the pure helper and shared rendering rule**

```ts
// pattern: Functional Core
export function quoteContent(text: string): string | null {
  return text.startsWith("> ") ? text.slice(2) : null;
}
```

In both block renderers derive `const quoted = quoteContent(node.text)`, add
`quote-block` only when `quoted !== null`, and tokenize `quoted ?? node.text`.
Do not pass transformed text to `BlockInput`.

```css
.block-text.quote-block {
  border-left: 3px solid var(--color-border-strong);
  color: var(--color-text-muted);
  padding-left: 0.75rem;
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && pnpm vitest run src/components/blockPresentation.test.ts src/components/BlockTree.test.tsx src/components/EditableBlockTree.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add web/src/components/blockPresentation.ts web/src/components/blockPresentation.test.ts web/src/components/BlockTree.tsx web/src/components/BlockTree.test.tsx web/src/components/EditableBlockTree.tsx web/src/components/EditableBlockTree.test.tsx web/src/styles.css
git commit -m "feat(web): render exact-prefix quote blocks (pkm-93w9)"
git push
```

---

### Task 2: Persist and import block view metadata

**Files:**
- Modify: `server/src/pkm/schema.py`
- Modify: `server/src/pkm/server/db.py`
- Modify: `server/src/pkm/importer/parse_export.py`
- Modify: `server/src/pkm/importer/rows.py`
- Modify: `server/src/pkm/importer/run.py`
- Modify: `server/tests/test_schema.py`
- Modify: `server/tests/test_server_scaffold.py`
- Modify: `server/tests/test_parse_export.py`
- Modify: `server/tests/test_rows.py`

**Interfaces:**
- Produces: `Block.view_type: Literal["numbered", "document"] | None` and
  `ensure_schema_migrations(con: sqlite3.Connection) -> None`.
- Produces database column: `blocks.view_type TEXT CHECK(view_type IN ('numbered','document'))`.

- [ ] **Step 1: Write failing schema migration and importer tests**

```py
def test_existing_database_gains_view_type(tmp_path):
    path = tmp_path / "old.sqlite3"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE blocks(uid TEXT PRIMARY KEY)")
    con.commit(); con.close()
    init_db(path)
    con = sqlite3.connect(path)
    assert "view_type" in {r[1] for r in con.execute("PRAGMA table_info(blocks)")}

def test_numbered_children_view_is_parsed():
    export = parse_export(numbered_view_fixture())
    assert export.pages[0].children[0].view_type == "numbered"
```

Add row assertions showing `"numbered"` appears in the flattened block tuple,
`:document` maps to `"document"`, and absent/unknown metadata maps to `None`.

- [ ] **Step 2: Run tests and confirm failures**

Run: `cd server && uv run pytest -q tests/test_schema.py tests/test_server_scaffold.py tests/test_parse_export.py tests/test_rows.py`

Expected: FAIL because the column, migration, and parsed field are absent.

- [ ] **Step 3: Implement the column, migration, and import mapping**

Add `view_type` after `heading` in fresh `blocks` DDL. Add an idempotent migration:

```py
def ensure_schema_migrations(con: sqlite3.Connection) -> None:
    columns = {row[1] for row in con.execute("PRAGMA table_info(blocks)")}
    if "view_type" not in columns:
        con.execute(
            "ALTER TABLE blocks ADD COLUMN view_type TEXT "
            "CHECK(view_type IN ('numbered','document'))")
```

Call it from `init_db` after `executescript(DDL)`. Extend importer `Block`, consume
`:children/view-type`, and map only `:numbered`/`:document`:

```py
raw_view = ent.get(":children/view-type")
view_type = ({":numbered": "numbered", ":document": "document"}
             .get(raw_view))
```

Extend row tuples and use an explicit importer INSERT column list rather than
positional `INSERT INTO blocks VALUES (...)`.

- [ ] **Step 4: Run focused tests, lint, and typecheck**

Run: `cd server && uv run pytest -q tests/test_schema.py tests/test_server_scaffold.py tests/test_parse_export.py tests/test_rows.py && uv run ruff check && uv run pyrefly check`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/pkm/schema.py server/src/pkm/server/db.py server/src/pkm/importer/parse_export.py server/src/pkm/importer/rows.py server/src/pkm/importer/run.py server/tests/test_schema.py server/tests/test_server_scaffold.py server/tests/test_parse_export.py server/tests/test_rows.py
git commit -m "feat(import): persist Roam block view metadata (pkm-zyd3)"
git push
```

---

### Task 3: Add the server `set_view_type` operation and read/sync contracts

**Files:**
- Modify: `server/src/pkm/server/ops_core.py`
- Modify: `server/src/pkm/server/ops_apply.py`
- Modify: `server/src/pkm/server/response_models.py`
- Modify: `server/src/pkm/server/routes_pages.py`
- Modify: `server/src/pkm/server/routes_sync.py`
- Modify: `server/src/pkm/server/tree.py`
- Modify: `server/tests/test_ops_core.py`
- Modify: `server/tests/test_ops_apply.py`
- Modify: `server/tests/test_ops_endpoint.py`
- Modify: `server/tests/test_page_endpoint.py`
- Modify: `server/tests/test_sync_endpoints.py`

**Interfaces:**
- Produces: `SetViewTypeOp(op="set_view_type", uid: str, view_type: Literal["numbered", "document"])`.
- Produces: `SetViewType(uid: str, view_type: Literal[...])` effect.
- Extends `BlockNode` and `SyncBlock` with `view_type: Literal[...] | None`.

- [ ] **Step 1: Write failing operation and contract tests**

```py
def test_set_view_type_plans_effect_and_page_touch():
    op = SetViewTypeOp(op="set_view_type", uid="uid_123", view_type="numbered")
    assert plan_op(0, op, OpContext(block=BlockInfo("uid_123", 7, None))) == (
        SetViewType("uid_123", "numbered"), TouchPage(7))

def test_set_view_type_rejects_unknown_value():
    with pytest.raises(ValidationError):
        SetViewTypeOp(op="set_view_type", uid="uid_123", view_type="table")
```

Add endpoint persistence assertions plus page and sync payload assertions for
`view_type`.

- [ ] **Step 2: Run focused server tests and confirm failures**

Run: `cd server && uv run pytest -q tests/test_ops_core.py tests/test_ops_apply.py tests/test_ops_endpoint.py tests/test_page_endpoint.py tests/test_sync_endpoints.py`

Expected: FAIL because the operation/effect and response fields are absent.

- [ ] **Step 3: Implement validation, planning, persistence, and hydration**

```py
ViewType = Literal["numbered", "document"]

class SetViewTypeOp(BaseModel):
    op: Literal["set_view_type"]
    uid: str
    view_type: ViewType

@dataclass(frozen=True)
class SetViewType:
    uid: str
    view_type: ViewType
```

Add the operation to `BlockOp`, plan it like `set_heading`, execute
`UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?`, and include the
field in all page/sync SELECT lists and Pydantic response models. Extend create and
insert payloads with nullable `view_type` so imported/snapshot data round-trips.

- [ ] **Step 4: Run focused tests and server quality gates**

Run: `cd server && uv run pytest -q tests/test_ops_core.py tests/test_ops_apply.py tests/test_ops_endpoint.py tests/test_page_endpoint.py tests/test_sync_endpoints.py && uv run ruff check && uv run pyrefly check`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add server/src/pkm/server server/tests/test_ops_core.py server/tests/test_ops_apply.py server/tests/test_ops_endpoint.py server/tests/test_page_endpoint.py server/tests/test_sync_endpoints.py
git commit -m "feat(server): sync block view types (pkm-zyd3)"
git push
```

---

### Task 4: Regenerate contracts and extend the offline replica

**Files:**
- Modify generated: `web/src/replica/baseSchema.gen.ts`
- Modify generated: `web/src/api/openapi.json`
- Modify generated: `web/src/api/types.d.ts`
- Modify: `web/src/api/ops.ts`
- Modify: `web/src/replica/apply.ts`
- Modify: `web/src/replica/localOps.ts`
- Modify: `web/src/replica/localApi/tree.ts`
- Modify: `web/src/replica/apply.test.ts`
- Modify: `web/src/replica/localOps.test.ts`
- Modify: `web/src/replica/localApi/parity.test.ts`

**Interfaces:**
- Consumes generated `SetViewTypeOp`, `BlockNode.view_type`, and `SyncBlock.view_type`.
- Produces local SQLite and local API parity for view types.

- [ ] **Step 1: Regenerate artifacts**

Run:

```bash
cd server
uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts
uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web
pnpm gen-types
```

- [ ] **Step 2: Write failing replica tests**

```ts
applyLocalOps(t.db, [
  { op: "set_view_type", uid: "uid_r1", view_type: "numbered" },
], 2000);
expect(blockRow("uid_r1").view_type).toBe("numbered");
```

Add snapshot/change tests for upserting `view_type`, and local page tree parity tests
that return it as nullable metadata.

- [ ] **Step 3: Run focused replica tests and confirm failures**

Run: `cd web && pnpm vitest run src/replica/apply.test.ts src/replica/localOps.test.ts src/replica/localApi/parity.test.ts`

Expected: FAIL because replica INSERT/SELECT/update paths omit the field.

- [ ] **Step 4: Implement replica persistence and exports**

Export `SetViewTypeOp` from `api/ops.ts`; extend replica block upserts and create
inserts with `view_type`; add:

```ts
case "set_view_type": {
  const info = requireBlock(db, op.uid);
  db.exec("UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?",
          [op.view_type, nowMs, op.uid]);
  touchPage(db, info.page_id, nowMs);
  return;
}
```

Include `view_type` in local tree row/node interfaces, SELECT columns, and output.

- [ ] **Step 5: Run focused tests, generated-artifact guards, and typecheck**

Run: `cd web && pnpm vitest run src/replica/apply.test.ts src/replica/localOps.test.ts src/replica/localApi/parity.test.ts && pnpm typecheck && cd ../server && uv run pytest -q tests/test_openapi_sync.py tests/test_schema_artifact.py`

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add web/src/replica/baseSchema.gen.ts web/src/api/openapi.json web/src/api/types.d.ts web/src/api/ops.ts web/src/replica server/tests/test_openapi_sync.py server/tests/test_schema_artifact.py
git commit -m "feat(offline): replicate block view types (pkm-zyd3)"
git push
```

---

### Task 5: Add optimistic view-type edits and remote updates

**Files:**
- Modify: `web/src/outline/tree.ts`
- Modify: `web/src/outline/tree.test.ts`
- Modify: `web/src/outline/edits.ts`
- Modify: `web/src/outline/edits.test.ts`
- Modify: `web/src/outline/useOutline.ts`
- Modify: `web/src/outline/useOutline.dnd.test.tsx`
- Modify: `web/src/components/EditableBlockTree.tsx` (handler interface only)
- Modify: `web/src/test-helpers.ts`

**Interfaces:**
- Produces: `setViewType(blocks, pageTitle, uid, viewType): EditResult`.
- Extends `OutlineHandlers` with `onSetViewType(uid, viewType): void`.

- [ ] **Step 1: Write failing functional-core tests**

```ts
test("set_view_type applies locally and remotely without changing content", () => {
  const before = page();
  const out = applyOps(before, [
    { op: "set_view_type", uid: "a", view_type: "numbered" },
  ], "P");
  expect(findNode(out, "a")!.view_type).toBe("numbered");
  expect(findNode(out, "a")!.text).toBe(findNode(before, "a")!.text);
  expect(findNode(out, "a")!.collapsed).toBe(findNode(before, "a")!.collapsed);
});
```

Add an edit test asserting exactly one `set_view_type` op and an optimistic tree;
add a hook test that a subscribed remote batch updates rendered outline state.

- [ ] **Step 2: Run tests and confirm failures**

Run: `cd web && pnpm vitest run src/outline/tree.test.ts src/outline/edits.test.ts src/outline/useOutline.dnd.test.tsx`

Expected: FAIL because tree/edit/handler support is absent.

- [ ] **Step 3: Implement core edit and hook wiring**

```ts
export function setViewType(blocks: BlockNode[], pageTitle: string,
                            uid: string,
                            viewType: "numbered" | "document"): EditResult {
  if (!findNode(blocks, uid)) return done(blocks, pageTitle, [], null);
  const ops: BlockOp[] = [{ op: "set_view_type", uid, view_type: viewType }];
  return done(applyOps(blocks, ops, pageTitle), pageTitle, ops, null);
}
```

Teach `applyOne` to set `found.node.view_type`, add `onSetViewType` to handlers,
and wire it through `useOutline.run`. Extend test helpers with `view_type: null`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && pnpm vitest run src/outline/tree.test.ts src/outline/edits.test.ts src/outline/useOutline.dnd.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add web/src/outline web/src/components/EditableBlockTree.tsx web/src/test-helpers.ts
git commit -m "feat(web): apply block view changes optimistically (pkm-zyd3)"
git push
```

---

### Task 6: Implement heading shortcuts, block-menu controls, and numbered rendering

**Files:**
- Create: `web/src/components/blockView.ts`
- Create: `web/src/components/blockView.test.ts`
- Modify: `web/src/components/BlockMenu.tsx`
- Create or modify: `web/src/components/BlockMenu.test.tsx`
- Modify: `web/src/components/BlockTree.tsx`
- Modify: `web/src/components/BlockTree.test.tsx`
- Modify: `web/src/components/EditableBlockTree.tsx`
- Modify: `web/src/components/EditableBlockTree.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `effectiveChildView(inherited, explicit): BlockViewType`.
- Extends `BlockMenuItem` with `checked`, `disabled`, `group`, and radio semantics.

- [ ] **Step 1: Write failing effective-mode, menu, shortcut, and renderer tests**

```ts
expect(effectiveChildView("document", null)).toBe("document");
expect(effectiveChildView("document", "numbered")).toBe("numbered");
expect(effectiveChildView("numbered", "document")).toBe("document");
```

Add component tests that:

- `Ctrl-Alt-0/1/2/3` each call `onSetHeading(uid, null/1/2/3)` and do not call
  `onDraftChange`.
- Menu clicks call all heading and view actions; current choices have
  `aria-checked="true"`; read-only mutation items are disabled.
- A numbered root leaves its own marker ordinary while its children show `1.`,
  `2.` and nested grandchildren restart at `1.`.
- An explicit document descendant restores bullets below that boundary.
- Selecting document rerenders a numbered subtree without text/order/collapse
  changes.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `cd web && pnpm vitest run src/components/blockView.test.ts src/components/BlockMenu.test.tsx src/components/BlockTree.test.tsx src/components/EditableBlockTree.test.tsx`

Expected: FAIL because the controls and numbered renderer do not exist.

- [ ] **Step 3: Implement pure mode resolution and accessible menu items**

```ts
export type EffectiveBlockView = "numbered" | "document";

export function effectiveChildView(
  inherited: EffectiveBlockView,
  explicit: "numbered" | "document" | null,
): EffectiveBlockView {
  return explicit ?? inherited;
}
```

Render checked choices with `role="menuitemradio"`, `aria-checked`, and native
`disabled`. Group heading and view choices with separators/labels while retaining
the copy item.

- [ ] **Step 4: Implement keyboard and menu action wiring**

In `BlockInput.onKeyDown`, before structural shortcuts:

```ts
if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && /^[0-3]$/.test(e.key)) {
  e.preventDefault();
  handlers.onSetHeading(node.uid, e.key === "0" ? null : Number(e.key));
  return;
}
```

When opening the block menu, retain selected uid plus inherited view context.
Build heading and view radio actions from the live node, calling `onSetHeading` and
`onSetViewType` respectively.

- [ ] **Step 5: Implement recursive numbered rendering and CSS counters**

Pass `inheritedView` through both tree recursion paths. A node renders its marker
using the inherited value, and passes
`effectiveChildView(inheritedView, node.view_type)` to children. Add marker classes:

```css
.block-children.numbered-view,
.block-tree.numbered-view { counter-reset: block-item; }
.numbered-view > .block { counter-increment: block-item; }
.numbered-view > .block > .block-row > .bullet::before {
  content: counter(block-item) ".";
}
```

Scope selectors so nested document boundaries return to the existing bullet and
each child container resets its own counter.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `cd web && pnpm vitest run src/components/blockView.test.ts src/components/BlockMenu.test.tsx src/components/BlockTree.test.tsx src/components/EditableBlockTree.test.tsx && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add web/src/components web/src/styles.css
git commit -m "feat(web): add heading and subtree view controls (pkm-oi5d pkm-zyd3)"
git push
```

---

### Task 7: Full verification, requirement audit, and bean completion

**Files:**
- Modify: `.beans/pkm-zyd3--block-menu-views-numbered-list-and-document.md`
- Modify: `.beans/pkm-oi5d--heading-shortcuts-and-block-menu-controls.md`
- Modify: `.beans/pkm-93w9--render-blocks-beginning-with-as-quote-text.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces completed bean checklists with summaries backed by fresh verification.

- [ ] **Step 1: Run the complete server gate**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`

Expected: all tests pass with enforced coverage; pyrefly and ruff exit 0.

- [ ] **Step 2: Run the complete web gate**

Run: `cd web && pnpm verify`

Expected: typecheck, enforced unit coverage, and Playwright E2E all exit 0.

- [ ] **Step 3: Audit every acceptance criterion against current evidence**

For each checkbox in all three beans, identify a direct test or inspected runtime
path covering it. Do not mark a checkbox whose evidence is indirect. Add a missing
test and rerun the appropriate full gate if any criterion lacks proof.

- [ ] **Step 4: Complete beans with summaries**

Use `beans update` replacements to change every acceptance checkbox to `[x]`, append
a `## Summary of Changes` section to each bean, and set each status to `completed`.

- [ ] **Step 5: Verify diff integrity, commit, and push**

```bash
git diff --check
beans show --json pkm-zyd3 pkm-oi5d pkm-93w9
git add .beans
git commit -m "chore: complete block presentation feature beans"
git push
```

Expected: all three beans report `completed` with no unchecked acceptance items.

## Plan Self-Review

- **Spec coverage:** Tasks 2-5 cover view import/storage/sync/optimism; Task 6 covers
  numbered rendering, document boundaries, menu state, and all heading controls;
  Task 1 covers exact-prefix quotes and inline rendering; Task 7 audits every bean.
- **Placeholder scan:** No deferred implementation placeholders remain.
- **Type consistency:** `view_type` is nullable metadata on block payloads and an
  explicit two-value field on `set_view_type`; `effectiveChildView` consumes those
  exact values; `onSetViewType` uses the generated operation value type end to end.
