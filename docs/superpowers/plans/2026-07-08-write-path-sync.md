# Write Path + Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The write half of the PKM server: `POST /api/ops` (batched block operations — the only write path), `POST /api/assets` (upload), and `WS /api/ws` (committed-op broadcast to other clients) — plus the hardening items deferred from plan 2's final review.

**Architecture:** Ops are validated and planned by a pure functional-core module (`ops_core`) that turns each op + a small context snapshot into a list of effect values; a thin imperative shell (`ops_apply`) assembles contexts from SQLite and executes effects. A whole batch applies in ONE transaction — any invalid op rolls back everything (400 with the failing op index). `blocks_fts` is maintained by the schema's triggers automatically; `refs` rows are re-derived per changed block inside the same transaction, creating referenced pages implicitly (Roam semantics). After commit, the batch is broadcast on a WebSocket hub; clients ignore batches carrying their own `client_id`. Per-block last-write-wins — no versions, no merge. Spec: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` Section 3. **This is plan 3 of 6** (import ✅ → read API ✅ → write path/sync → frontend read → frontend edit → deployment).

**Tech Stack:** Python ≥3.12, FastAPI (incl. WebSocket support via starlette), Pydantic v2 discriminated unions, sqlite3 (stdlib), `python-multipart` (upload parsing). Dev: pytest, httpx (TestClient).

## Global Constraints

- Python ≥ 3.12 via `uv`; all commands from `server/` via `uv run …`.
- Every runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top.
- `POST /api/ops` is the ONLY write path for pages/blocks/refs (editor, phone composer, future CLI/LLM tooling all go through it). Read routes' daily auto-create is the one sanctioned exception (pre-existing).
- A batch applies atomically: one transaction, all-or-nothing; failure → HTTP 400 `{"detail": {"index": N, "reason": …}}` and NO rows changed. Helpers called inside a batch must never `commit()`.
- Ref re-derivation happens in the same transaction as the block change. Referenced pages are created implicitly on first reference. `blocks_fts`/`pages_fts` are maintained by the DDL's triggers — never write FTS tables directly.
- Block uids: client-generated, `^[a-zA-Z0-9_-]{6,32}$` (imported Roam uids are 9 chars; new ones are nanoids).
- Cross-page `move` is rejected (400). A `move` that would make a block its own ancestor is rejected (400). `delete` removes the whole subtree, children before parents (never rely on FK-cascade to fire FTS triggers).
- All routes and the WebSocket require the session cookie; WS auth failure closes with code 4401 before accepting traffic. Session tokens now expire: max age 365 days, ≤5 min future clock skew.
- Every DB connection sets `PRAGMA foreign_keys=ON` + WAL (handled by `open_db`).
- Server binds `127.0.0.1` only. Never commit `data/` or `sample-data/`.
- Test seed data (conftest, from plan 2): pages 1 "Machine Learning", 2 "AI", 3 "July 7th, 2026", 4 "Paper", 5 "Attention Is All You Need"; blocks `uid_b1`…`uid_b6` (NOT `b1`…`b6`) — `uid_b2` ("Papers", heading 2) has child `uid_b3` on page 1; `uid_b4`/`uid_b5` on page 3; `uid_b6` on page 2.
- Commit after each green test cycle; push after committing. End commit messages with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012dSSoDojiCf8v6VQuQcHFN
```

## File Structure

```
server/src/pkm/server/
  store.py         # IS: fetch_page / get_or_create_page (race-guarded, never commits)  [new]
  auth_core.py     # FC: verify_session gains now_ms + max-age check                    [modify]
  auth.py          # IS: pass now_ms into verify_session                                [modify]
  routes_pages.py  # IS: use store helpers; ancestors CTE depth cap                     [modify]
  ops_core.py      # FC: op Pydantic models, OpError, effect dataclasses, plan_op       [new]
  ops_apply.py     # IS: context assembly + effect execution + ref re-derivation        [new]
  routes_ops.py    # IS: POST /api/ops (transaction + 400 mapping; broadcast in T5)     [new]
  ws.py            # IS: Hub + WS /api/ws (cookie auth, close 4401)                     [new]
  routes_assets.py # IS: add POST /api/assets (content-addressed, atomic write)         [modify]
  app.py           # IS: include ops router (T4), hub + ws router (T5)                  [modify]
server/tests/
  test_hardening.py  test_ops_core.py  test_ops_apply.py
  test_ops_endpoint.py  test_ws.py  test_asset_upload.py
```

---

### Task 1: Hardening carryovers (shared page store, session expiry, CTE depth cap)

Plan 2's final review deferred these to plan 3; the write path depends on the first one (`ops_apply` needs a commit-free `get_or_create_page`).

**Files:**
- Create: `server/src/pkm/server/store.py`
- Modify: `server/src/pkm/server/auth_core.py` (verify_session signature), `server/src/pkm/server/auth.py` (call site), `server/src/pkm/server/routes_pages.py` (use store helpers; depth-cap `_fetch_ancestors`), `server/tests/test_auth.py` (verify_session tests get `now_ms`)
- Test: `server/tests/test_hardening.py`

**Interfaces:**
- Produces:
  - `store.fetch_page(db, title: str) -> sqlite3.Row | None` (columns `id,title,created_at,updated_at`)
  - `store.get_or_create_page(db, title: str, now_ms: int) -> sqlite3.Row` — inserts if missing, guards the check-then-insert race with `except sqlite3.IntegrityError`, NEVER commits (caller owns the transaction)
  - `auth_core.verify_session(secret: bytes, token: str, now_ms: int, max_age_ms: int = YEAR_MS) -> bool` — signature check plus: `parts[1]` must be all digits, `issued <= now_ms + SKEW_MS` (5 min), `now_ms - issued <= max_age_ms`
  - `auth_core.YEAR_MS = 365 * 24 * 3600 * 1000`, `auth_core.SKEW_MS = 5 * 60 * 1000`

- [ ] **Step 1: Write the failing tests**

`server/tests/test_hardening.py`:
```python
import sqlite3

from pkm.schema import DDL
from pkm.server.auth_core import YEAR_MS, sign_session, verify_session
from pkm.server.db import open_db
from pkm.server.store import fetch_page, get_or_create_page

SECRET = b"s" * 32
NOW = 1_700_000_000_000


def test_session_expiry_and_skew():
    token = sign_session(SECRET, NOW)
    assert verify_session(SECRET, token, now_ms=NOW + 1000)
    assert verify_session(SECRET, token, now_ms=NOW + YEAR_MS)          # boundary ok
    assert not verify_session(SECRET, token, now_ms=NOW + YEAR_MS + 1)  # expired
    assert not verify_session(SECRET, token, now_ms=NOW - 6 * 60 * 1000)  # future
    assert verify_session(SECRET, token, now_ms=NOW - 4 * 60 * 1000)      # skew ok
    bad = f"v1.notanumber.{token.split('.')[2]}"
    assert not verify_session(SECRET, bad, now_ms=NOW)


def _db(tmp_path) -> sqlite3.Connection:
    con = open_db(tmp_path / "t.sqlite3")
    con.executescript(DDL)
    return con


def test_get_or_create_page(tmp_path):
    db = _db(tmp_path)
    page = get_or_create_page(db, "New Page", 123)
    assert page["title"] == "New Page" and page["created_at"] == 123
    again = get_or_create_page(db, "New Page", 456)
    assert again["id"] == page["id"] and again["created_at"] == 123
    assert db.in_transaction  # helper must NOT have committed
    db.rollback()
    assert fetch_page(db, "New Page") is None  # rollback undid the create
    db.close()


def test_ancestor_depth_cap_survives_cycle(client, seeded_config):
    # Manufacture a parent cycle directly (ops will forbid these, but reads
    # must not hang if one ever appears).
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("UPDATE blocks SET parent_uid = 'uid_b3' WHERE uid = 'uid_b2'")
    con.commit(); con.close()
    r = client.get("/api/page/Paper")   # backlinks of Paper walk uid_b3's ancestors
    assert r.status_code == 200
```

Also in `server/tests/test_auth.py`, update `test_session_roundtrip_and_tamper` for the new signature — every `verify_session(X, Y)` becomes `verify_session(X, Y, now_ms=1700000000000 + 1000)`:
```python
def test_session_roundtrip_and_tamper():
    token = sign_session(SECRET, 1700000000000)
    now = 1700000000000 + 1000
    assert token.startswith("v1.1700000000000.")
    assert verify_session(SECRET, token, now_ms=now)
    assert not verify_session(SECRET, token[:-1] + ("0" if token[-1] != "0" else "1"), now_ms=now)
    assert not verify_session(b"other" * 8, token, now_ms=now)
    assert not verify_session(SECRET, "garbage", now_ms=now)
    assert not verify_session(SECRET, "v1.123", now_ms=now)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_hardening.py tests/test_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.store'`; auth tests fail on the missing `now_ms` kwarg.

- [ ] **Step 3: Implement**

`server/src/pkm/server/store.py`:
```python
# pattern: Imperative Shell
"""Shared page fetch/create. get_or_create_page never commits: the caller
owns the transaction (read routes commit; the ops batch commits once)."""
from __future__ import annotations

import sqlite3


def fetch_page(db: sqlite3.Connection, title: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
        (title,)).fetchone()


def get_or_create_page(db: sqlite3.Connection, title: str,
                       now_ms: int) -> sqlite3.Row:
    page = fetch_page(db, title)
    if page is not None:
        return page
    try:
        db.execute(
            "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
            (title, now_ms, now_ms))
    except sqlite3.IntegrityError:
        pass  # lost a create race — the row exists now
    return fetch_page(db, title)
```

`server/src/pkm/server/auth_core.py` — replace `verify_session`, add constants:
```python
YEAR_MS = 365 * 24 * 3600 * 1000
SKEW_MS = 5 * 60 * 1000


def verify_session(secret: bytes, token: str, now_ms: int,
                   max_age_ms: int = YEAR_MS) -> bool:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1" or not parts[1].isdigit():
        return False
    payload = f"{parts[0]}.{parts[1]}"
    expected = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts[2]):
        return False
    issued = int(parts[1])
    return issued <= now_ms + SKEW_MS and now_ms - issued <= max_age_ms
```

`server/src/pkm/server/auth.py` — `require_auth` passes the clock (add `import time` if missing; it is already imported):
```python
def require_auth(request: Request, config: Config = Depends(get_config)) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if not token or not verify_session(bytes.fromhex(config.session_secret),
                                       token, now_ms=int(time.time() * 1000)):
        raise HTTPException(status_code=401, detail="not authenticated")
```

`server/src/pkm/server/routes_pages.py`:
1. Add `from pkm.server.store import fetch_page, get_or_create_page` and delete the local `_fetch_page` (replace its uses with `fetch_page`).
2. In `get_page`, replace the auto-create block with:
```python
    page = fetch_page(db, title)
    if page is None:
        if date_for_title(title) is None:
            raise HTTPException(status_code=404, detail="page not found")
        page = get_or_create_page(db, title, int(time.time() * 1000))
        db.commit()
```
3. In `get_journal`, replace the auto-create block with:
```python
        page = fetch_page(db, title)
        if page is None and d == date.today():
            page = get_or_create_page(db, title, int(time.time() * 1000))
            db.commit()
```
4. In `_fetch_ancestors`, add a depth cap to the recursive arm — change the `UNION ALL` select to:
```sql
              SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1
                FROM anc a JOIN blocks b ON b.uid = a.parent_uid
               WHERE a.depth < 100
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_hardening.py tests/test_auth.py tests/test_page_endpoint.py tests/test_journal_assets.py -v`
Expected: all PASS. Full suite: `uv run pytest -q` → all pass.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: shared page store, session expiry, ancestor depth cap" && git push
```

---

### Task 2: Op models + pure op planner (`ops_core`)

**Files:**
- Create: `server/src/pkm/server/ops_core.py`
- Test: `server/tests/test_ops_core.py`

**Interfaces:**
- Produces (Tasks 3–5 and the frontend's generated types consume):
  - Pydantic models: `CreateOp(op="create", uid, page_title, parent_uid=None, order_idx, text, heading=None)`, `UpdateTextOp(op="update_text", uid, text)`, `MoveOp(op="move", uid, parent_uid, order_idx)` (`parent_uid` required-but-nullable), `DeleteOp(op="delete", uid)`, `SetCollapsedOp(op="set_collapsed", uid, collapsed)`; `BlockOp` = discriminated union on `op`; `OpBatch(client_id: str, ops: list[BlockOp])` (1–500 ops)
  - `OpError(ValueError)` with `.index` and `.reason`
  - Context dataclasses: `BlockInfo(uid, page_id, parent_uid)`, `OpContext(block=None, page_id=None, parent=None, parent_chain=(), subtree=())`
  - Effect dataclasses: `ShiftSiblings(page_id, parent_uid, from_idx)`, `InsertBlock(uid, page_id, parent_uid, order_idx, text, heading)`, `UpdateText(uid, text)`, `SetParent(uid, parent_uid, order_idx)`, `DeleteBlocks(uids)`, `SetCollapsed(uid, collapsed)`, `ReindexRefs(uid, text)`, `TouchPage(page_id)`; `Effect` = union of these
  - `plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]` — pure; raises `OpError`
  - `UID_RE` (`^[a-zA-Z0-9_-]{6,32}$`)

- [ ] **Step 1: Write the failing tests**

`server/tests/test_ops_core.py`:
```python
import pytest
from pydantic import TypeAdapter, ValidationError

from pkm.server.ops_core import (BlockInfo, BlockOp, CreateOp, DeleteBlocks,
                                 DeleteOp, InsertBlock, MoveOp, OpBatch,
                                 OpContext, OpError, ReindexRefs,
                                 SetCollapsed, SetCollapsedOp, SetParent,
                                 ShiftSiblings, TouchPage, UpdateText,
                                 UpdateTextOp, plan_op)

B = BlockInfo(uid="uid_b3", page_id=1, parent_uid="uid_b2")


def test_batch_parses_discriminated_ops():
    batch = OpBatch(client_id="c1", ops=[
        {"op": "create", "uid": "newuid1", "page_title": "P",
         "order_idx": 0, "text": "hi"},
        {"op": "delete", "uid": "uid_b3"},
    ])
    assert isinstance(batch.ops[0], CreateOp)
    assert isinstance(batch.ops[1], DeleteOp)


def test_batch_rejects_unknown_op_and_empty():
    with pytest.raises(ValidationError):
        OpBatch(client_id="c1", ops=[{"op": "explode", "uid": "uid_b3"}])
    with pytest.raises(ValidationError):
        OpBatch(client_id="c1", ops=[])


def test_plan_create():
    op = CreateOp(op="create", uid="newuid1", page_title="P",
                  parent_uid="uid_b2", order_idx=1, text="t [[X]]")
    ctx = OpContext(page_id=1, parent=BlockInfo("uid_b2", 1, None))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(1, "uid_b2", 1),
        InsertBlock("newuid1", 1, "uid_b2", 1, "t [[X]]", None),
        ReindexRefs("newuid1", "t [[X]]"),
        TouchPage(1),
    )


def test_plan_create_rejects_bad_uid_dup_and_foreign_parent():
    ctx = OpContext(page_id=1, parent=BlockInfo("uid_b2", 1, None))
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid="a!", page_title="P",
                            order_idx=0, text=""), ctx)
    with pytest.raises(OpError, match="already exists"):
        plan_op(0, CreateOp(op="create", uid="uid_b3", page_title="P",
                            order_idx=0, text=""),
                OpContext(block=B, page_id=1))
    with pytest.raises(OpError, match="different page"):
        plan_op(0, CreateOp(op="create", uid="newuid1", page_title="P",
                            parent_uid="uid_b6", order_idx=0, text=""),
                OpContext(page_id=1, parent=BlockInfo("uid_b6", 2, None)))
    with pytest.raises(OpError, match="parent not found"):
        plan_op(0, CreateOp(op="create", uid="newuid1", page_title="P",
                            parent_uid="ghost99", order_idx=0, text=""),
                OpContext(page_id=1))


def test_plan_update_text():
    effects = plan_op(0, UpdateTextOp(op="update_text", uid="uid_b3",
                                      text="new"), OpContext(block=B))
    assert effects == (UpdateText("uid_b3", "new"),
                       ReindexRefs("uid_b3", "new"), TouchPage(1))
    with pytest.raises(OpError, match="block not found"):
        plan_op(3, UpdateTextOp(op="update_text", uid="ghost99", text="x"),
                OpContext())


def test_plan_move_and_cycle():
    ctx = OpContext(block=B, parent=BlockInfo("uid_b1", 1, None),
                    parent_chain=("uid_b1",))
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid="uid_b1",
                             order_idx=0), ctx) == (
        ShiftSiblings(1, "uid_b1", 0), SetParent("uid_b3", "uid_b1", 0),
        TouchPage(1))
    # to top level
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid=None,
                             order_idx=2), OpContext(block=B)) == (
        ShiftSiblings(1, None, 2), SetParent("uid_b3", None, 2), TouchPage(1))
    # moving under own descendant = cycle: uid appears in the parent chain
    with pytest.raises(OpError, match="cycle"):
        plan_op(0, MoveOp(op="move", uid="uid_b2", parent_uid="uid_b3",
                          order_idx=0),
                OpContext(block=BlockInfo("uid_b2", 1, None),
                          parent=B, parent_chain=("uid_b3", "uid_b2")))
    with pytest.raises(OpError, match="cross-page"):
        plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid="uid_b6",
                          order_idx=0),
                OpContext(block=B, parent=BlockInfo("uid_b6", 2, None),
                          parent_chain=("uid_b6",)))


def test_plan_delete_and_collapse():
    assert plan_op(0, DeleteOp(op="delete", uid="uid_b2"),
                   OpContext(block=BlockInfo("uid_b2", 1, None),
                             subtree=("uid_b3", "uid_b2"))) == (
        DeleteBlocks(("uid_b3", "uid_b2")), TouchPage(1))
    assert plan_op(0, SetCollapsedOp(op="set_collapsed", uid="uid_b2",
                                     collapsed=True),
                   OpContext(block=BlockInfo("uid_b2", 1, None))) == (
        SetCollapsed("uid_b2", True), TouchPage(1))


def test_op_error_carries_index():
    with pytest.raises(OpError) as e:
        plan_op(7, DeleteOp(op="delete", uid="ghost99"), OpContext())
    assert e.value.index == 7 and "not found" in e.value.reason
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_ops_core.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.ops_core'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/ops_core.py`:
```python
# pattern: Functional Core
"""Block-op models and the pure planner that turns each op + a context
snapshot into effect values. The shell (ops_apply) assembles OpContext
from SQLite and executes the effects; planning itself does no I/O."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

UID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,32}$")


class CreateOp(BaseModel):
    op: Literal["create"]
    uid: str
    page_title: str = Field(min_length=1)
    parent_uid: str | None = None
    order_idx: int
    text: str
    heading: int | None = None


class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: str
    text: str


class MoveOp(BaseModel):
    op: Literal["move"]
    uid: str
    parent_uid: str | None   # required but nullable: null = top level
    order_idx: int


class DeleteOp(BaseModel):
    op: Literal["delete"]
    uid: str


class SetCollapsedOp(BaseModel):
    op: Literal["set_collapsed"]
    uid: str
    collapsed: bool


BlockOp = Annotated[Union[CreateOp, UpdateTextOp, MoveOp, DeleteOp,
                          SetCollapsedOp], Field(discriminator="op")]


class OpBatch(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)


class OpError(ValueError):
    def __init__(self, index: int, reason: str):
        super().__init__(f"op {index}: {reason}")
        self.index = index
        self.reason = reason


@dataclass(frozen=True)
class BlockInfo:
    uid: str
    page_id: int
    parent_uid: str | None


@dataclass(frozen=True)
class OpContext:
    block: BlockInfo | None = None        # row for op.uid, if it exists
    page_id: int | None = None            # create: resolved target page
    parent: BlockInfo | None = None       # create/move: target parent row
    parent_chain: tuple[str, ...] = ()    # move: target parent + its ancestors
    subtree: tuple[str, ...] = ()         # delete: op.uid subtree, deepest first


@dataclass(frozen=True)
class ShiftSiblings:
    page_id: int
    parent_uid: str | None
    from_idx: int


@dataclass(frozen=True)
class InsertBlock:
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str
    heading: int | None


@dataclass(frozen=True)
class UpdateText:
    uid: str
    text: str


@dataclass(frozen=True)
class SetParent:
    uid: str
    parent_uid: str | None
    order_idx: int


@dataclass(frozen=True)
class DeleteBlocks:
    uids: tuple[str, ...]  # deepest first: children always before parents


@dataclass(frozen=True)
class SetCollapsed:
    uid: str
    collapsed: bool


@dataclass(frozen=True)
class ReindexRefs:
    uid: str
    text: str


@dataclass(frozen=True)
class TouchPage:
    page_id: int


Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, ReindexRefs, TouchPage]


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    if isinstance(op, CreateOp):
        if not UID_RE.match(op.uid):
            raise OpError(index, f"invalid uid: {op.uid!r}")
        if ctx.block is not None:
            raise OpError(index, f"uid already exists: {op.uid}")
        if ctx.page_id is None:
            raise OpError(index, "page could not be resolved")
        if op.parent_uid is not None:
            if ctx.parent is None:
                raise OpError(index, f"parent not found: {op.parent_uid}")
            if ctx.parent.page_id != ctx.page_id:
                raise OpError(index, "parent is on a different page")
        return (ShiftSiblings(ctx.page_id, op.parent_uid, op.order_idx),
                InsertBlock(op.uid, ctx.page_id, op.parent_uid, op.order_idx,
                            op.text, op.heading),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.page_id))
    if ctx.block is None:
        raise OpError(index, f"block not found: {op.uid}")
    if isinstance(op, UpdateTextOp):
        return (UpdateText(op.uid, op.text),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.block.page_id))
    if isinstance(op, MoveOp):
        if op.parent_uid is not None:
            if ctx.parent is None:
                raise OpError(index, f"parent not found: {op.parent_uid}")
            if ctx.parent.page_id != ctx.block.page_id:
                raise OpError(index, "cross-page move is not supported")
            if op.uid in ctx.parent_chain:
                raise OpError(index, "move would create a cycle")
        return (ShiftSiblings(ctx.block.page_id, op.parent_uid, op.order_idx),
                SetParent(op.uid, op.parent_uid, op.order_idx),
                TouchPage(ctx.block.page_id))
    if isinstance(op, DeleteOp):
        return (DeleteBlocks(ctx.subtree), TouchPage(ctx.block.page_id))
    # SetCollapsedOp (the discriminated union admits nothing else)
    return (SetCollapsed(op.uid, op.collapsed), TouchPage(ctx.block.page_id))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_ops_core.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: block-op models and pure op planner" && git push
```

---

### Task 3: Op application shell (`ops_apply`)

**Files:**
- Create: `server/src/pkm/server/ops_apply.py`
- Test: `server/tests/test_ops_apply.py`

**Interfaces:**
- Consumes: `ops_core` (Task 2), `store.get_or_create_page` (Task 1), `pkm.refs.extract`.
- Produces (Task 4 consumes):
  - `apply_batch(db: sqlite3.Connection, batch: OpBatch, now_ms: int) -> None` — applies every op in order inside the caller's transaction; raises `OpError` on the first invalid op (caller rolls back); never commits.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_ops_apply.py` (uses the `seeded_config` fixture from conftest; opens its own connection):
```python
import pytest

from pkm.server.db import open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpBatch, OpError

NOW = 1_800_000_000_000


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


def _batch(*ops) -> OpBatch:
    return OpBatch(client_id="t", ops=list(ops))


def test_create_inserts_shifts_and_derives_refs(db):
    apply_batch(db, _batch(
        {"op": "create", "uid": "newuid1", "page_title": "Machine Learning",
         "parent_uid": None, "order_idx": 0, "text": "see [[Brand New]] #AI"},
    ), NOW)
    db.commit()
    rows = db.execute(
        "SELECT uid, order_idx FROM blocks WHERE page_id = 1"
        "  AND parent_uid IS NULL ORDER BY order_idx").fetchall()
    assert [(r["uid"], r["order_idx"]) for r in rows] == \
        [("newuid1", 0), ("uid_b1", 1), ("uid_b2", 2)]
    # implicit page creation + refs
    new_page = db.execute(
        "SELECT id FROM pages WHERE title = 'Brand New'").fetchone()
    assert new_page is not None
    kinds = {(r["target_page_id"], r["kind"]) for r in db.execute(
        "SELECT target_page_id, kind FROM refs WHERE src_block_uid='newuid1'")}
    assert kinds == {(new_page["id"], "link"), (2, "tag")}
    # FTS row exists (triggers)
    hit = db.execute("SELECT rowid FROM blocks_fts WHERE blocks_fts"
                     " MATCH '\"Brand\"'").fetchall()
    assert len(hit) == 1
    # page touched
    assert db.execute("SELECT updated_at FROM pages WHERE id=1"
                      ).fetchone()[0] == NOW


def test_update_text_rederives_refs_and_fts(db):
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b4", "text": "now [[Paper]] only"},
    ), NOW)
    db.commit()
    refs = db.execute("SELECT target_page_id, kind FROM refs"
                      " WHERE src_block_uid='uid_b4'").fetchall()
    assert [(r[0], r[1]) for r in refs] == [(4, "link")]  # ML link gone
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH '\"Studying\"'").fetchone()[0] == 0


def test_delete_removes_subtree_and_fts(db):
    apply_batch(db, _batch({"op": "delete", "uid": "uid_b2"}), NOW)
    db.commit()
    left = {r[0] for r in db.execute(
        "SELECT uid FROM blocks WHERE page_id = 1")}
    assert left == {"uid_b1"}          # uid_b2 and child uid_b3 gone
    assert db.execute("SELECT count(*) FROM refs WHERE src_block_uid='uid_b3'"
                      ).fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH '\"Papers\"'").fetchone()[0] == 0


def test_move_reparents_and_shifts(db):
    apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b3", "parent_uid": None, "order_idx": 0},
    ), NOW)
    db.commit()
    row = db.execute("SELECT parent_uid, order_idx FROM blocks"
                     " WHERE uid='uid_b3'").fetchone()
    assert row["parent_uid"] is None and row["order_idx"] == 0
    # uid_b1/uid_b2 shifted to make room
    assert db.execute("SELECT order_idx FROM blocks WHERE uid='uid_b1'"
                      ).fetchone()[0] == 1


def test_move_cycle_against_db_chain(db):
    # child of uid_b2 is uid_b3; moving uid_b2 under uid_b3 must fail
    with pytest.raises(OpError, match="cycle"):
        apply_batch(db, _batch(
            {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
             "order_idx": 0}), NOW)
    db.rollback()


def test_op_error_index_reports_failing_op(db):
    with pytest.raises(OpError) as e:
        apply_batch(db, _batch(
            {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
            {"op": "delete", "uid": "ghost99"},
        ), NOW)
    assert e.value.index == 1
    db.rollback()
    assert db.execute("SELECT collapsed FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] == 0  # rollback undid op 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_ops_apply.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.server.ops_apply'`

- [ ] **Step 3: Implement**

`server/src/pkm/server/ops_apply.py`:
```python
# pattern: Imperative Shell
"""Assemble OpContext snapshots from SQLite and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import sqlite3

from pkm.refs import extract
from pkm.server.ops_core import (BlockInfo, CreateOp, DeleteBlocks, DeleteOp,
                                 Effect, InsertBlock, MoveOp, OpBatch,
                                 OpContext, ReindexRefs, SetCollapsed,
                                 SetParent, ShiftSiblings, TouchPage,
                                 UpdateText, plan_op)
from pkm.server.store import get_or_create_page

_DEPTH_CAP = 100


def _block_info(db: sqlite3.Connection, uid: str) -> BlockInfo | None:
    row = db.execute(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,)).fetchone()
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


def _parent_chain(db: sqlite3.Connection, uid: str) -> tuple[str, ...]:
    rows = db.execute(
        f"""WITH RECURSIVE chain(uid, parent_uid, depth) AS (
              SELECT uid, parent_uid, 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.depth + 1
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE c.depth < {_DEPTH_CAP}
            ) SELECT uid FROM chain""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _subtree_deepest_first(db: sqlite3.Connection,
                           uid: str) -> tuple[str, ...]:
    rows = db.execute(
        f"""WITH RECURSIVE sub(uid, depth) AS (
              SELECT uid, 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE s.depth < {_DEPTH_CAP}
            ) SELECT uid FROM sub ORDER BY depth DESC""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _context_for(db: sqlite3.Connection, op, now_ms: int) -> OpContext:
    block = _block_info(db, op.uid)
    if isinstance(op, CreateOp):
        page = get_or_create_page(db, op.page_title, now_ms)
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        return OpContext(block=block, page_id=page["id"], parent=parent)
    if isinstance(op, MoveOp):
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        chain = _parent_chain(db, op.parent_uid) if op.parent_uid else ()
        return OpContext(block=block, parent=parent, parent_chain=chain)
    if isinstance(op, DeleteOp):
        return OpContext(block=block,
                         subtree=_subtree_deepest_first(db, op.uid))
    return OpContext(block=block)


def _execute(db: sqlite3.Connection, eff: Effect, now_ms: int) -> None:
    if isinstance(eff, ShiftSiblings):
        db.execute(
            "UPDATE blocks SET order_idx = order_idx + 1"
            " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
            (eff.page_id, eff.parent_uid, eff.from_idx))
    elif isinstance(eff, InsertBlock):
        db.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,0,?,?)",
            (eff.uid, eff.page_id, eff.parent_uid, eff.order_idx, eff.text,
             eff.heading, now_ms, now_ms))
    elif isinstance(eff, UpdateText):
        db.execute("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
                   (eff.text, now_ms, eff.uid))
    elif isinstance(eff, SetParent):
        db.execute(
            "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?"
            " WHERE uid = ?",
            (eff.parent_uid, eff.order_idx, now_ms, eff.uid))
    elif isinstance(eff, DeleteBlocks):
        db.executemany("DELETE FROM blocks WHERE uid = ?",
                       [(u,) for u in eff.uids])
    elif isinstance(eff, SetCollapsed):
        db.execute(
            "UPDATE blocks SET collapsed = ?, updated_at = ? WHERE uid = ?",
            (int(eff.collapsed), now_ms, eff.uid))
    elif isinstance(eff, ReindexRefs):
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (eff.uid,))
        for ref in extract(eff.text).refs:
            page = get_or_create_page(db, ref.title, now_ms)
            db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
                       (eff.uid, page["id"], ref.kind))
    else:  # TouchPage
        db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
                   (now_ms, eff.page_id))


def apply_batch(db: sqlite3.Connection, batch: OpBatch, now_ms: int) -> None:
    for index, op in enumerate(batch.ops):
        ctx = _context_for(db, op, now_ms)
        for eff in plan_op(index, op, ctx):
            _execute(db, eff, now_ms)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_ops_apply.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: op application shell with ref re-derivation" && git push
```

---

### Task 4: `POST /api/ops` route (atomic batch endpoint)

**Files:**
- Create: `server/src/pkm/server/routes_ops.py`
- Modify: `server/src/pkm/server/app.py` (include router)
- Test: `server/tests/test_ops_endpoint.py`

**Interfaces:**
- Consumes: `OpBatch`/`OpError` (Task 2), `apply_batch` (Task 3), `require_auth`, `get_db`.
- Produces:
  - `POST /api/ops` with JSON body `OpBatch` → 200 `{"ok": true, "ts": <server ms>, "applied": <op count>}`; invalid op → 400 `{"detail": {"index": N, "reason": …}}` and nothing persisted; malformed body → 422 (FastAPI/Pydantic default)
  - `routes_ops.router` (Task 5 adds the broadcast call to this file)

- [ ] **Step 1: Write the failing tests**

`server/tests/test_ops_endpoint.py`:
```python
def _post(client, *ops, client_id="c1"):
    return client.post("/api/ops",
                       json={"client_id": client_id, "ops": list(ops)})


def test_ops_require_auth(anon_client):
    r = anon_client.post("/api/ops", json={
        "client_id": "c1",
        "ops": [{"op": "delete", "uid": "uid_b1"}]})
    assert r.status_code == 401


def test_create_then_read_back(client):
    r = _post(client, {"op": "create", "uid": "newuid1",
                       "page_title": "Machine Learning", "parent_uid": "uid_b2",
                       "order_idx": 1, "text": "fresh [[Novel Page]]"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["applied"] == 1
    page = client.get("/api/page/Machine Learning").json()
    papers = page["blocks"][1]
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "fresh [[Novel Page]]"]
    # implicit page + backlink
    novel = client.get("/api/page/Novel Page").json()
    [group] = novel["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"


def test_update_text_moves_search_and_backlinks(client):
    r = _post(client, {"op": "update_text", "uid": "uid_b4",
                       "text": "now about [[Paper]] instead"})
    assert r.status_code == 200
    hits = client.get("/api/search", params={"q": "Studying"}).json()
    assert hits["blocks"] == []
    paper = client.get("/api/page/Paper").json()
    uids = {i["uid"] for g in paper["backlinks"]["groups"] for i in g["items"]}
    assert "uid_b4" in uids
    ml = client.get("/api/page/Machine Learning").json()
    assert ml["backlinks"]["groups"] == []  # old link gone


def test_move_and_collapse_roundtrip(client):
    r = _post(client,
              {"op": "move", "uid": "uid_b3", "parent_uid": None,
               "order_idx": 0},
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True})
    assert r.status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "Tags:: #AI", "Papers"]
    assert page["blocks"][2]["collapsed"] is True
    assert page["blocks"][2]["children"] == []


def test_delete_subtree_via_endpoint(client):
    assert _post(client, {"op": "delete", "uid": "uid_b2"}).status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == ["Tags:: #AI"]
    assert client.get("/api/search",
                      params={"q": "Papers"}).json()["blocks"] == []


def test_batch_is_atomic_and_reports_index(client):
    r = _post(client,
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
              {"op": "delete", "uid": "ghost99"})
    assert r.status_code == 400
    assert r.json()["detail"]["index"] == 1
    assert "not found" in r.json()["detail"]["reason"]
    page = client.get("/api/page/Machine Learning").json()
    assert page["blocks"][1]["collapsed"] is False  # op 0 rolled back


def test_cycle_move_rejected(client):
    r = _post(client, {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
                       "order_idx": 0})
    assert r.status_code == 400
    assert "cycle" in r.json()["detail"]["reason"]


def test_malformed_batch_422(client):
    r = client.post("/api/ops", json={"client_id": "c1",
                                      "ops": [{"op": "explode"}]})
    assert r.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py -v`
Expected: FAIL — 404s (`/api/ops` route missing), and `ModuleNotFoundError` if importing routes_ops.

- [ ] **Step 3: Implement**

`server/src/pkm/server/routes_ops.py`:
```python
# pattern: Imperative Shell
"""POST /api/ops — the only write path. One transaction per batch."""
from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpBatch, OpError

router = APIRouter(dependencies=[Depends(require_auth)])


@router.post("/api/ops")
async def post_ops(batch: OpBatch,
                   db: sqlite3.Connection = Depends(get_db)) -> dict:
    now = int(time.time() * 1000)
    try:
        apply_batch(db, batch, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    db.commit()
    return {"ok": True, "ts": now, "applied": len(batch.ops)}
```

In `server/src/pkm/server/app.py`, add:
```python
from pkm.server.routes_ops import router as ops_router
```
and `app.include_router(ops_router)` next to the other routers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: atomic batched block-ops endpoint" && git push
```

---

### Task 5: WebSocket hub + committed-op broadcast

**Files:**
- Create: `server/src/pkm/server/ws.py`
- Modify: `server/src/pkm/server/app.py` (hub on app.state, include ws router), `server/src/pkm/server/routes_ops.py` (broadcast after commit)
- Test: `server/tests/test_ws.py`

**Interfaces:**
- Consumes: `verify_session` (Task 1 signature), `COOKIE_NAME` from `pkm.server.auth`, `routes_ops.post_ops` (Task 4).
- Produces:
  - `ws.Hub` with `async connect(ws)` (accepts + registers), `disconnect(ws)`, `async broadcast(message: dict)` (sends to every connection; drops dead ones)
  - `WS /api/ws` — cookie-authenticated; bad/missing cookie → close code 4401 without accepting; otherwise stays open, ignores inbound text
  - `create_app` sets `app.state.hub = Hub()`
  - After a successful `POST /api/ops` commit, all connected sockets receive `{"client_id": …, "ts": …, "ops": [<op dicts as submitted>]}` (sender included — clients filter by their own `client_id`)

- [ ] **Step 1: Write the failing tests**

`server/tests/test_ws.py`:
```python
import pytest
from starlette.websockets import WebSocketDisconnect


def test_ws_requires_auth(anon_client):
    with pytest.raises(WebSocketDisconnect):
        with anon_client.websocket_connect("/api/ws") as ws:
            ws.receive_text()


def test_ops_broadcast_to_connected_clients(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "ops": [{"op": "set_collapsed", "uid": "uid_b2",
                     "collapsed": True}]})
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["client_id"] == "sender-1"
        assert msg["ts"] == r.json()["ts"]
        assert msg["ops"] == [{"op": "set_collapsed", "uid": "uid_b2",
                               "collapsed": True}]


def test_failed_batch_broadcasts_nothing(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "sender-1",
            "ops": [{"op": "delete", "uid": "ghost99"}]})
        assert r.status_code == 400
        ok = client.post("/api/ops", json={
            "client_id": "sender-2",
            "ops": [{"op": "set_collapsed", "uid": "uid_b1",
                     "collapsed": True}]})
        assert ok.status_code == 200
        # first message received is the SECOND (successful) batch
        assert ws.receive_json()["client_id"] == "sender-2"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_ws.py -v`
Expected: FAIL — WS route missing (connect fails / 403), no broadcast.

- [ ] **Step 3: Implement**

`server/src/pkm/server/ws.py`:
```python
# pattern: Imperative Shell
"""WebSocket hub: committed op batches broadcast to every open client."""
from __future__ import annotations

import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from pkm.server.auth import COOKIE_NAME
from pkm.server.auth_core import verify_session

router = APIRouter()


class Hub:
    def __init__(self) -> None:
        self._conns: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._conns.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._conns.discard(ws)

    async def broadcast(self, message: dict) -> None:
        for ws in list(self._conns):
            try:
                await ws.send_json(message)
            except Exception:
                self._conns.discard(ws)


@router.websocket("/api/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    config = websocket.app.state.config
    token = websocket.cookies.get(COOKIE_NAME)
    if not token or not verify_session(
            bytes.fromhex(config.session_secret), token,
            now_ms=int(time.time() * 1000)):
        await websocket.close(code=4401)
        return
    hub: Hub = websocket.app.state.hub
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # inbound is ignored (keepalive)
    except WebSocketDisconnect:
        hub.disconnect(websocket)
```

In `server/src/pkm/server/app.py`:
```python
from pkm.server.ws import Hub, router as ws_router
```
inside `create_app`, after `app.state.config = config`:
```python
    app.state.hub = Hub()
```
and `app.include_router(ws_router)` next to the other routers.

In `server/src/pkm/server/routes_ops.py`: add `Request` to the fastapi import, add `request: Request` to `post_ops`'s parameters, and after `db.commit()` (before `return`):
```python
    await request.app.state.hub.broadcast({
        "client_id": batch.client_id,
        "ts": now,
        "ops": [op.model_dump() for op in batch.ops],
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_ws.py tests/test_ops_endpoint.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 5: Commit and push**

```bash
git add server/ && git commit -m "feat: websocket hub broadcasting committed op batches" && git push
```

---

### Task 6: Asset upload (`POST /api/assets`)

**Files:**
- Modify: `server/pyproject.toml` (add `python-multipart`), `server/src/pkm/server/routes_assets.py`
- Test: `server/tests/test_asset_upload.py`

**Interfaces:**
- Consumes: `get_db`, `get_config`, existing `GET /assets/{sha256}/{filename}`.
- Produces:
  - `POST /api/assets` (multipart field `file`) → 200 `{"sha256", "filename", "mime", "size", "url"}`; empty file → 400. Content-addressed at `assets_dir/<sha[:2]>/<sha>` written atomically (temp + `os.replace`); duplicate content dedupes to the same sha (first filename/mime win — `INSERT OR IGNORE`).

- [ ] **Step 1: Add the dependency**

In `server/pyproject.toml` add `"python-multipart>=0.0.9"` to `dependencies`. Run: `cd server && uv sync`

- [ ] **Step 2: Write the failing tests**

`server/tests/test_asset_upload.py`:
```python
import hashlib


def _upload(client, content=b"PNGDATA", name="pic.png", mime="image/png"):
    return client.post("/api/assets", files={"file": (name, content, mime)})


def test_upload_roundtrip(client, seeded_config):
    r = _upload(client)
    assert r.status_code == 200
    body = r.json()
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    assert body == {"sha256": sha, "filename": "pic.png",
                    "mime": "image/png", "size": 7,
                    "url": f"/assets/{sha}/pic.png"}
    assert (seeded_config.assets_dir / sha[:2] / sha).read_bytes() == b"PNGDATA"
    fetched = client.get(body["url"])
    assert fetched.status_code == 200
    assert fetched.content == b"PNGDATA"
    assert fetched.headers["content-type"] == "image/png"


def test_upload_requires_auth(anon_client):
    assert _upload(anon_client).status_code == 401


def test_upload_dedupes_by_content(client, seeded_config):
    first = _upload(client, name="a.png").json()
    second = _upload(client, name="b.png").json()
    assert second["sha256"] == first["sha256"]
    assert second["filename"] == "a.png"  # first row wins
    sha = first["sha256"]
    stored = list((seeded_config.assets_dir / sha[:2]).iterdir())
    assert [p.name for p in stored] == [sha]  # one file, no temp leftovers


def test_upload_empty_400(client):
    assert _upload(client, content=b"").status_code == 400
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_upload.py -v`
Expected: FAIL — 405/404 (no POST route).

- [ ] **Step 4: Implement**

In `server/src/pkm/server/routes_assets.py`, extend the imports:
```python
import hashlib
import os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
```
and add below `get_asset`:
```python
@router.post("/api/assets")
async def upload_asset(file: UploadFile,
                       db: sqlite3.Connection = Depends(get_db),
                       config: Config = Depends(get_config)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    sha = hashlib.sha256(data).hexdigest()
    dest = config.assets_dir / sha[:2] / sha
    if not dest.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f"{sha}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    filename = Path(file.filename or "upload").name or "upload"
    mime = file.content_type or "application/octet-stream"
    db.execute("INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?)",
               (sha, filename, mime, len(data), int(time.time() * 1000)))
    db.commit()
    row = db.execute(
        "SELECT filename, mime, size FROM assets WHERE sha256 = ?",
        (sha,)).fetchone()
    return {"sha256": sha, "filename": row["filename"], "mime": row["mime"],
            "size": row["size"], "url": f"/assets/{sha}/{row['filename']}"}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_asset_upload.py tests/test_journal_assets.py -v`
Expected: all PASS. Full suite: `uv run pytest -q`.

- [ ] **Step 6: Commit and push**

```bash
git add server/ && git commit -m "feat: content-addressed asset upload endpoint" && git push
```

---

### Task 7: Real-data smoke test (verification)

**Requires:** the imported database at `data/pkm.sqlite3`. **All writes go to a scratch COPY** made with the SQLite backup API — the real database must not gain or lose a single row.

- [ ] **Step 1: Run the in-process smoke script against a copy**

```bash
cd server && uv run python - <<'EOF'
import hashlib, shutil, sqlite3, time
from datetime import date
from pathlib import Path
from fastapi.testclient import TestClient
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.daily import title_for_date

SRC = Path("../data/pkm.sqlite3")
SCRATCH = Path("../data/smoke-scratch")
if SCRATCH.exists():
    shutil.rmtree(SCRATCH)
(SCRATCH / "assets").mkdir(parents=True)
copy = SCRATCH / "pkm.sqlite3"
with sqlite3.connect(SRC) as s, sqlite3.connect(copy) as d:
    s.backup(d)
pre = sqlite3.connect(SRC).execute(
    "SELECT (SELECT count(*) FROM pages), (SELECT count(*) FROM blocks)"
).fetchone()

salt = bytes.fromhex("00" * 16)
cfg = Config(db_path=copy, assets_dir=SCRATCH / "assets",
             password_salt=salt.hex(),
             password_hash=hash_password("smoke", salt),
             session_secret="cd" * 32, cookie_secure=False)
client = TestClient(create_app(cfg))
assert client.post("/api/login", json={"password": "smoke"}).status_code == 200

def ops(*ops_):
    return client.post("/api/ops", json={"client_id": "smoke", "ops": list(ops_)})

# create on a brand-new page (implicit creation), with a link + tag
t0 = time.time()
r = ops({"op": "create", "uid": "smoketest001", "page_title": "PKM Smoke Test",
         "parent_uid": None, "order_idx": 0,
         "text": "hello [[PKM Smoke Link]] #smoketag"})
assert r.status_code == 200, r.text
print(f"create batch: {(time.time()-t0)*1000:.0f}ms")
page = client.get("/api/page/PKM Smoke Test").json()
assert page["blocks"][0]["uid"] == "smoketest001"
link = client.get("/api/page/PKM Smoke Link").json()
assert link["backlinks"]["groups"][0]["page_title"] == "PKM Smoke Test"
assert any(b["uid"] == "smoketest001" for b in
           client.get("/api/search", params={"q": "smoketag"}).json()["blocks"])

# update_text re-derives refs + FTS
assert ops({"op": "update_text", "uid": "smoketest001",
            "text": "edited smokebody, link removed"}).status_code == 200
assert client.get("/api/search", params={"q": "smoketag"}).json()["blocks"] == []
assert client.get("/api/page/PKM Smoke Link").json()["backlinks"]["groups"] == []

# child + move + collapse + ws broadcast
with client.websocket_connect("/api/ws") as ws:
    r = ops({"op": "create", "uid": "smoketest002",
             "page_title": "PKM Smoke Test", "parent_uid": "smoketest001",
             "order_idx": 0, "text": "child"},
            {"op": "move", "uid": "smoketest002", "parent_uid": None,
             "order_idx": 0},
            {"op": "set_collapsed", "uid": "smoketest001", "collapsed": True})
    assert r.status_code == 200
    msg = ws.receive_json()
    assert msg["client_id"] == "smoke" and len(msg["ops"]) == 3
page = client.get("/api/page/PKM Smoke Test").json()
assert [b["uid"] for b in page["blocks"]] == ["smoketest002", "smoketest001"]

# delete subtree
assert ops({"op": "delete", "uid": "smoketest001"},
           {"op": "delete", "uid": "smoketest002"}).status_code == 200
assert client.get("/api/page/PKM Smoke Test").json()["blocks"] == []

# ops on a REAL heavy page: append + remove a block on today's daily page
today = title_for_date(date.today())
r = ops({"op": "create", "uid": "smoketest003", "page_title": today,
         "parent_uid": None, "order_idx": 999, "text": "smoke entry [[Paper]]"})
assert r.status_code == 200
paper = client.get("/api/page/Paper").json()
assert any(i["uid"] == "smoketest003"
           for g in paper["backlinks"]["groups"] for i in g["items"])
assert ops({"op": "delete", "uid": "smoketest003"}).status_code == 200

# invalid batch is atomic against real data
r = ops({"op": "set_collapsed", "uid": "smoketest001", "collapsed": True})
assert r.status_code == 400  # already deleted

# asset upload roundtrip
data = b"smoke-asset-bytes"
r = client.post("/api/assets", files={"file": ("s.bin", data,
                                               "application/octet-stream")})
assert r.status_code == 200
assert client.get(r.json()["url"]).content == data

post = sqlite3.connect(SRC).execute(
    "SELECT (SELECT count(*) FROM pages), (SELECT count(*) FROM blocks)"
).fetchone()
assert tuple(pre) == tuple(post), f"REAL DB CHANGED: {pre} -> {post}"
shutil.rmtree(SCRATCH)
print(f"real db untouched: {post[0]} pages / {post[1]} blocks")
print("SMOKE OK")
EOF
```

Expected output ends with `SMOKE OK`. If any assertion fails, STOP and investigate before touching anything else; the scratch dir can be inspected (re-run without the final `rmtree` if needed).

- [ ] **Step 2: Record findings**

Append a `### Write-path smoke findings (plan 3)` subsection to `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md` (after the plan-2 findings): op latency on the real graph, WS behaviour, anything surprising. Note explicitly that the real DB was verified byte-count-identical before/after.

- [ ] **Step 3: Commit and push**

```bash
git add docs/ && git commit -m "docs: record write-path smoke findings" && git push
```

---

## Self-review notes (completed)

- **Spec coverage (plan-3 scope):** `POST /api/ops` with create/update_text/move/delete/set_collapsed, refs + FTS re-derived in-transaction ✓ (T2–T4; FTS via existing DDL triggers, refs re-derived explicitly); ops as the only write path ✓; implicit page creation on first reference ✓ (T3 ReindexRefs); `POST /api/assets` ✓ (T6); `WS /api/ws` broadcast of committed batches, auth-gated ✓ (T5); per-block LWW (no versioning) ✓; Pydantic models feed the authed OpenAPI schema for plan-4 type generation ✓ (T2 models on the T4 route). Plan-2 deferrals: race guard + helper dedup ✓, session expiry ✓, cycle/depth guard ✓ (T1 + move-cycle rejection in T2). Out of scope by design: `((block-ref))` *creation*, embeds (count 0), offline editing, `:page/sidebar` import (plan 4, with the left nav), `total` vs `total_pages` naming normalization (plan 4, when the client consumes both).
- **Type consistency:** `OpBatch`/`OpError`/`apply_batch` names match across T2/T3/T4; `verify_session(secret, token, now_ms, max_age_ms)` matches T1/T5 call sites; `store.get_or_create_page(db, title, now_ms)` matches T1/T3; effect dataclass fields in T2 match `_execute` in T3; seed uids `uid_b1`…`uid_b6` used consistently in all new tests.
- **Placeholder scan:** clean — every code step contains complete code and exact commands; no TBDs, no "similar to Task N" references.
