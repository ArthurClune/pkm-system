# A reused page id reaches the feed as delete-then-create — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a page or sidebar id is deleted and reused inside one changes window, `/api/sync/changes` ships a tombstone for it as well as the live row, so the replica's page cascade removes the stale refs that would otherwise resolve to the new page.

**Architecture:** `sync_core.dedupe_window` (Functional Core) takes the journal's `deleted` column and records which entities had a delete row in the window; a new pure `tombstone_entities` states the rule (absent from current state, or deleted in the window for the id-keyed kinds `page` and `sidebar`). `routes_sync.sync_changes` (Imperative Shell) selects `deleted`, builds tombstones through that rule, and, for a page it tombstones and ships live, also ships every current block on that page or with a ref to it, so the replica's cascade removes nothing the same window does not restore. The replica's `applyWindow` is unchanged in code (tombstones already lead); its ordering comment, which currently promises "never both", is rewritten.

**Tech Stack:** Python 3 / FastAPI / stdlib sqlite3 / pytest; TypeScript / vitest / Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F7 A reused page id reaches the feed as delete-then-create, § Shared rules, § Verification per branch. Background: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F7. Bean: `pkm-8uc9`.

## Global Constraints

- TDD: every fix's failing test goes red, for the stated reason, before the fix. Task 4's replica tests are characterisation tests of behaviour the fix relies on and pass on arrival; say so in the commit message.
- Every runtime file declares its FCIS pattern (`// pattern: Functional Core` / `// pattern: Imperative Shell`, `#` in Python). Pure predicates, classifiers and transforms live in Functional Core files. `pnpm check:fcis` forbids a Core file importing a value from a Shell module. `sync_core.py` is Core, `routes_sync.py` and `apply.ts` are Shell; both already declare it.
- Code and test comments state the rule and carry NO bean id (existing ids in `sync_core.py`'s docstring and `apply.ts` stay; add none). Commit messages may carry `pkm-8uc9`.
- Docs land in this branch: the `sync-and-offline.md` § The changes feed tombstone rule, and one row in `docs/troubleshooting.md` § Sync and offline (symptom, cause, owning section, `pkm-8uc9`). Any `docs/architecture/` edit goes through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- No route signature, response model or route docstring changes: `sync_changes` has no docstring and must not gain one (put any explanation in `#` comments). So no openapi/gen-types regen; `server/tests/test_openapi_sync.py` in the full pytest run confirms it. If an executor does change a docstring on a route, regen with `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `cd web && pnpm gen-types`.
- `backend.md`'s API row for `/api/sync/changes` (line ~543) does not describe tombstones; leave it.
- The spec's composed test across the boundary (server feed into a real browser replica) is Task 5, its own task.
- Never write the two-word phrase that starts "load" and ends "bearing".
- Shared files with sibling wave-2 beans: `docs/troubleshooting.md` and `docs/architecture/sync-and-offline.md` (every sibling adds rows/notes there; F5 edits the online-edit diagram in `sync-and-offline.md`), and `web/src/replica/apply.ts` (comment only here; check F6 pkm-yvka's plan before merge). Keep edits to the lines named below so merges stay textual.
- Final task runs: server `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`; web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`; the new e2e spec alone on the port the executor is given. Do NOT run the full Playwright suite or `perf/check.sh`; the orchestrator does after merge.

## Review Focus

- A window cut right after the delete row (the replacement's create row falls in the next window): the page is present in current state, so the window must still ship both the tombstone and the live page — Task 2, `test_window_cut_after_the_delete_row_ships_tombstone_and_live_page`.
- Blocks on the new page (or with refs to it) that an earlier window already delivered, whose own journal rows fall after this window: without the dependents closure the tombstone's cascade would drop them until a later window — Task 3.
- The id reused under the same title (delete "AI", create "AI" again): the tombstone must still clear stale refs and the upsert must not trip UNIQUE — Task 4, `a same-title recreate still drops the stale refs`.
- Sidebar ids are reused the same way (`sidebar_entries.id INTEGER PRIMARY KEY`) — Task 2, `test_reused_sidebar_id_ships_tombstone_and_new_entry`.
- A block uid deleted and recreated (undo) keeps the presence rule: no tombstone, so its subtree is not cascaded away by a spurious block tombstone — Task 1, `test_tombstone_entities_block_keeps_presence_rule`.

---

### Task 1: The tombstone flag and rule in `sync_core`

**Files:**
- Modify: `server/src/pkm/server/sync_core.py` (`Window` at :46-49, `dedupe_window` at :61-67, module docstring)
- Test: `server/tests/test_sync_core.py`

**Interfaces:**
- Produces:
  - `REUSABLE_ID_KINDS: frozenset[str] = frozenset({"page", "sidebar"})`
  - `Window(next_since: int, entities: tuple[tuple[str, str], ...], tombstoned: frozenset[tuple[str, str]])` — `tombstoned` holds every `(kind, entity_id)` with at least one `deleted` row in the window, any kind.
  - `dedupe_window(rows: Sequence[tuple[int, str, str, int]]) -> Window` — rows are `(seq, kind, entity_id, deleted)`.
  - `tombstone_entities(win: Window, present: Mapping[str, AbstractSet[str]]) -> list[tuple[str, str]]` — in `win.entities` order; an entity is tombstoned when its id is not in `present[kind]` (a missing kind counts as empty), or when `kind in REUSABLE_ID_KINDS` and it is in `win.tombstoned`.
  - `tombstoned_ids(win: Window, kind: str) -> list[str]` — ids of `kind` in `win.tombstoned`, in `win.entities` order.

- [ ] **Step 1: Write the failing tests.** Convert the four existing `dedupe_window` tests to 4-tuples with `deleted=0`; `test_empty_window` also asserts `win.tombstoned == frozenset()`. Add:

```python
def test_dedupe_window_flags_an_entity_with_a_delete_row():
    win = dedupe_window([(1, "page", "7", 1), (2, "page", "7", 0),
                         (3, "block", "A", 0)])
    assert win.entities == (("page", "7"), ("block", "A"))
    assert win.tombstoned == frozenset({("page", "7")})

def test_dedupe_window_flag_ignores_row_order():
    win = dedupe_window([(1, "page", "7", 0), (2, "page", "7", 1)])
    assert win.tombstoned == frozenset({("page", "7")})

def test_tombstone_entities_absent_entity():
    win = dedupe_window([(1, "block", "A", 0), (2, "page", "7", 0)])
    assert tombstone_entities(win, {"block": set(), "page": {"7"}}) == [("block", "A")]

def test_tombstone_entities_reused_page_and_sidebar_even_when_present():
    win = dedupe_window([(1, "page", "7", 1), (2, "page", "7", 0),
                         (3, "sidebar", "3", 1), (4, "sidebar", "3", 0)])
    present = {"block": set(), "page": {"7"}, "sidebar": {"3"}}
    assert tombstone_entities(win, present) == [("page", "7"), ("sidebar", "3")]

def test_tombstone_entities_block_keeps_presence_rule():
    # block uids are never reused by the database; one recreated under its
    # old uid is the same block and ships as a live row only
    win = dedupe_window([(1, "block", "A", 1), (2, "block", "A", 0)])
    assert tombstone_entities(win, {"block": {"A"}}) == []

def test_tombstoned_ids_by_kind_in_window_order():
    win = dedupe_window([(1, "page", "9", 1), (2, "sidebar", "9", 1),
                         (3, "page", "4", 1), (4, "page", "5", 0)])
    assert tombstoned_ids(win, "page") == ["9", "4"]
```

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_sync_core.py -q`. Expected: FAIL at import (`tombstone_entities`, `tombstoned_ids` not defined).

- [ ] **Step 3: Implement** the Interfaces above in `sync_core.py`. `dedupe_window` keeps its insertion-ordered set and adds the key to a `tombstoned` set when `deleted` is truthy. Add one docstring paragraph: a page or sidebar id can be reused after a delete (`INTEGER PRIMARY KEY` without `AUTOINCREMENT`), so presence in current state does not prove the row is the same entity; a delete row in the window does. Blocks keep the presence rule.

- [ ] **Step 4: Run** the same command. Expected: PASS. `routes_sync.py` still passes 3-tuples, so do not run the full suite yet; Task 2 fixes the caller in the same commit.

- [ ] **Step 5: No commit yet**: Tasks 1 and 2 commit together (Task 2 Step 6), so no commit has a caller passing the wrong tuple shape.

### Task 2: `routes_sync` tombstones a reused id and ships the live row

**Files:**
- Modify: `server/src/pkm/server/routes_sync.py` (`sync_changes` :214-234)
- Create: `server/tests/test_sync_reused_ids.py`

**Interfaces:**
- Consumes: `dedupe_window`, `tombstone_entities` from Task 1.

- [ ] **Step 1: Write the failing tests** in the new file, using the `client` fixture and a local `_drain(client, since=0, limit=1000)` like `test_sync_endpoints.py`'s. Shared setup `_reuse_page_id(client) -> tuple[int, int]`: `POST /api/pages {"title": "Doomed"}` (id `doomed`), `start = _drain(client)["latest_seq"]`, `DELETE /api/page/Doomed`, `POST /api/pages {"title": "Reborn"}` (id `reborn`), `assert reborn == doomed` (precondition: Doomed was the highest id), return `(start, reborn)`.

  - `test_reused_page_id_ships_tombstone_and_new_page`: `feed = _drain(client, since=start)`; `("page", str(pid)) in {(t["kind"], t["entity_id"]) for t in feed["tombstones"]}`; `{p["id"]: p["title"] for p in feed["pages"]}[pid] == "Reborn"`.
  - `test_window_cut_after_the_delete_row_ships_tombstone_and_live_page`: `feed = _drain(client, since=start, limit=1)` (Doomed has no blocks and no sidebar entry, so the first row after `start` is the page delete); assert `feed["next_since"] < feed["latest_seq"]`, the tombstone is present, and page `pid` ships with title `"Reborn"`.
  - `test_reused_sidebar_id_ships_tombstone_and_new_entry`: `POST /api/sidebar {"title": "SbDoomed"}` → `sid`; `start`; `DELETE /api/sidebar/{sid}`; `POST /api/sidebar {"title": "SbReborn"}` → assert same id; the feed from `start` carries `("sidebar", str(sid))` in tombstones and `{s["id"]: s["title"] for s in feed["sidebar"]}[sid] == "SbReborn"`.

- [ ] **Step 2: Adapt the call site only.** Select `seq, kind, entity_id, deleted` and pass 4-tuples to `dedupe_window`; leave the presence-derived tombstone list as it is.

- [ ] **Step 3: Run** `cd server && uv run pytest tests/test_sync_reused_ids.py -q`. Expected: all three FAIL on the tombstone assertion (the id is present in current state, so no tombstone ships).

- [ ] **Step 4: Implement.** Build `present = {"block": {b.uid ...}, "page": {str(p.id) ...}, "sidebar": {str(s.id) ...}}` and `tombstones = [SyncTombstone(kind=k, entity_id=e) for k, e in tombstone_entities(win, present)]`. Pages, blocks and sidebar payloads are unchanged, so a reused id ships both.

- [ ] **Step 5: Run** `cd server && uv run pytest tests/test_sync_core.py tests/test_sync_reused_ids.py tests/test_sync_endpoints.py tests/test_sync_journal.py tests/test_sync_query_batching.py tests/test_sync_window_parents.py -q`. Expected: PASS.

- [ ] **Step 6: Commit** `sync_core.py`, `routes_sync.py`, both test files: `fix(pkm-8uc9): the changes feed tombstones a page or sidebar id deleted in the window`.

### Task 3: A reused page's window ships its dependent blocks

Beyond the spec's text, and required by it: `applyWindow`'s comment (`web/src/replica/apply.ts` :305-316) says the tombstones-first order is safe only because a page is never shipped as both tombstone and live row; "were a page ever shipped as both, this order would let the cascade eat blocks the window does not re-ship". Task 2 makes that happen. A block an earlier window hydrated onto the new page (its current row, shipped for an older journal row), or with a ref to it, would be cascaded away and return only with a later window. This task makes such a window self-contained.

**Files:**
- Modify: `server/src/pkm/server/routes_sync.py`
- Test: `server/tests/test_sync_reused_ids.py`

**Interfaces:**
- Consumes: `tombstoned_ids` from Task 1.
- Produces: `_reused_page_dependents(db: sqlite3.Connection, page_ids: list[int]) -> list[str]` — uids of blocks with `page_id` in `page_ids`, then uids of blocks with a `refs` row whose `target_page_id` is in `page_ids`; each query chunked with `chunk_ids`, `ORDER BY` uid; deduped, first occurrence kept.

- [ ] **Step 1: Write the failing test** `test_reused_page_window_ships_blocks_on_and_referencing_the_page`: `start, pid = _reuse_page_id(client)`; then `POST /api/ops` (`client_id "c1"`, `batch_id "reuse_dependents1"`) with `{"op": "create", "uid": "uid_reborn_kid", "page_title": "Reborn", "parent_uid": None, "order_idx": 0, "text": "on the new page"}` and `{"op": "update_text", "uid": "uid_b6", "text": "links [[Reborn]]"}`; `feed = _drain(client, since=start, limit=2)` (the page delete row and the page create row only); assert `feed["next_since"] < feed["latest_seq"]`, `{"uid_reborn_kid", "uid_b6"} <= {b["uid"] for b in feed["blocks"]}`, and uid_b6's `refs` contain `{"target_page_id": pid, "kind": "link"}`.

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_sync_reused_ids.py -q`. Expected: the new test FAILS on the blocks assertion (the window's blocks list is empty).

- [ ] **Step 3: Implement.** In `sync_changes`, `reused = [int(e) for e in tombstoned_ids(win, "page")]`; only when non-empty (a window with no page delete must run no extra query; `test_sync_query_batching.py` bounds the count), extend `block_uids` with `_reused_page_dependents(db, reused)` minus uids already listed, window uids first. An absent (not reused) page has no rows left on the server, so the query returns nothing for it. `#` comment on the call: a page shipped as both tombstone and live row carries every current block on it or referencing it, because the replica's cascade removes those rows before the upserts.

- [ ] **Step 4: Run** the Task 2 Step 5 command. Expected: PASS.

- [ ] **Step 5: Commit** `routes_sync.py` and the test: `fix(pkm-8uc9): a reused page's window ships the blocks on and referencing it`.

### Task 4: Replica apply pins delete-then-create for one id; `applyWindow` comment

**Files:**
- Modify: `web/src/replica/apply.ts` (comment block above `applyWindow`, :305-316; no code change)
- Test: `web/src/replica/apply.test.ts` (new `describe` after "applyChanges: a title moving between ids inside one window")

These pass on arrival: they pin what the server change relies on.

- [ ] **Step 1: Write the tests** in `describe("applyChanges: a page id deleted and reused inside one window", ...)`, using the file's `SNAP` (page 2 "AI", `uid_b1` on page 1 refs page 2), `emptyFeed`, `block`, `page`, `count`:
  - `"the tombstone clears the old page's blocks and other blocks' refs before the new page lands"`: first `applyChanges` a feed (`next_since: 11`) carrying `block("uid_on_ai", 2)`; then a feed (`next_since: 12`) with `tombstones: [{ kind: "page", entity_id: "2" }]`, `pages: [page(2, "Reborn")]`. Expect status `applied`; `SELECT id, title FROM pages WHERE id = 2` → `[{ id: 2, title: "Reborn" }]`; `uid_on_ai` count 0; `refs WHERE target_page_id = 2` count 0; `uid_b1` count 1.
  - `"blocks the window ships for the reused page survive the tombstone"`: one feed with the same tombstone and page plus `blocks: [block("uid_new", 2), block("uid_b1", 1, { text: "links [[Reborn]]", refs: [{ target_page_id: 2, kind: "link" }] })]`. Expect `uid_new` present on page 2 and `SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_b1'` → `[{ target_page_id: 2 }]`.
  - `"a same-title recreate still drops the stale refs"`: tombstone page 2 with `pages: [page(2, "AI")]`. Expect status `applied`, page 2 titled `"AI"`, `refs WHERE target_page_id = 2` count 0.

- [ ] **Step 2: Run** `cd web && pnpm test:unit src/replica/apply.test.ts`. Expected: PASS (if any fails, stop: the spec's "the replica needs nothing new" is wrong and the orchestrator must hear it).

- [ ] **Step 3: Rewrite the comment** above `applyWindow`. Replace the "That relies on the server's `dedupe_window` … never both. Were a page ever shipped as both …" sentences with the rule as it now is: a page id the server deleted and reused inside the window arrives as both a tombstone and a live row; the tombstone's cascade clears the old page's blocks and every ref to the id, and the server ships every current block on or referencing that page in the same window, so the cascade removes nothing the window does not restore.

- [ ] **Step 4: Commit** `apply.ts` and `apply.test.ts`: `test(pkm-8uc9): pin a page id deleted and reused in one window` (message notes the tests pass on arrival).

### Task 5: Composed test — a reused id reaches a browser replica

**Files:**
- Create: `web/e2e/reused-page-id.spec.ts`

User-visible symptom on main: the new page's Linked references, read from the replica while offline, list a block that linked to the deleted page.

- [ ] **Step 1: Write the spec** `test("a page id reused while this tab is offline leaves no stale linked references", ...)`, following `offline.spec.ts` for login, `routeWebSocket` steering (`offline` flag, `live` routes) and `context.setOffline`. Server writes go through a separate API context unaffected by the browser's offline state: `const api = await playwright.request.newContext({ baseURL, storageState: await context.storageState() })`, taking `playwright` and `baseURL` from the test's fixture arguments (create it after login so the session cookie is in the storage state). With `stamp = Date.now()`, titles `ReuseSrc${stamp}`, `ReuseTgt${stamp}`, `ReuseNew${stamp}`, uids sliced to 32 like `block-ref-indicator.spec.ts`:
  1. Log in; await the snapshot and first changes responses.
  2. `api`: POST `/api/pages` Source, then Target (keep `targetId` from the response). Arm `page.waitForResponse` for a `/api/sync/changes` response whose JSON `blocks` include `srcUid`, then POST `/api/ops` creating `srcUid` on Source with text `see [[ReuseTgt${stamp}]]`; await the response.
  3. Go offline (flag, `setOffline(true)`, close live sockets, banner shows "Offline"). Search for the Target title, click its `.search-result`; `h1.page-title` is Target and `.backlinks` contains `"Linked references (1)"` (control: backlinks come from the replica and it holds the ref).
  4. `api`: DELETE `/api/page/<Target>`; POST `/api/pages` New → `expect(id).toBe(targetId)`; POST `/api/ops` creating `markerUid` on New with text `"reused marker"`.
  5. Arm a `waitForResponse` for a changes response whose `pages` contain `{ id: targetId, title: New }` (present with and without the fix, so the wait never hangs on main); reconnect (flag, `setOffline(false)`); banner count 0 within 20 s; await the response.
  6. Go offline again. Search for New, click its result; `h1.page-title` is New; `.block-text` with text `"reused marker"` is visible; `expect(page.locator(".backlink-text")).toHaveCount(0)`.
  7. `finally`: `api` DELETEs Source and New (ignore 404), `api.dispose()`.

- [ ] **Step 2: Red check against the unfixed server.** `cd /Users/arthur/code/llm/pkm && base=$(git merge-base HEAD main) && git checkout "$base" -- server/src/pkm/server/sync_core.py server/src/pkm/server/routes_sync.py`, then `cd web && pnpm build && E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/reused-page-id.spec.ts`. Expected: FAIL at step 6's `.backlink-text` count (1: `see [[ReuseTgt…]]`). A failure anywhere else is not the stated reason; fix the spec. Restore with `git checkout HEAD -- server/src/pkm/server/sync_core.py server/src/pkm/server/routes_sync.py` and confirm `git status -sb` shows only the new spec.

- [ ] **Step 3: Run** the same e2e command on the fixed tree. Expected: PASS.

- [ ] **Step 4: Commit** the spec: `test(pkm-8uc9): composed e2e for a page id reused across one feed window`.

### Task 6: Docs, bean, final verification

**Files:**
- Modify: `docs/architecture/sync-and-offline.md` § The changes feed (the bullet ending "Entities that no longer exist ship as tombstones; a dependency block that no longer exists is absent instead.", ~:79-84)
- Modify: `docs/troubleshooting.md` § Sync and offline table
- Modify: `.beans/pkm-8uc9*.md`

- [ ] **Step 1: Docs, under the `architecture-docs` skill.** In the feed bullet, the tombstone rule becomes: an entity ships as a tombstone when it is absent from current state or, for the id-keyed kinds `page` and `sidebar`, when the window holds a delete row for it, since SQLite reuses those ids; a reused id ships as tombstone plus live row, and a reused page's window also ships every current block on or referencing it. Blocks keep the presence rule. Also add the id-reuse case to the `applyWindow` bullet's "tombstones lead" reason only if it reads naturally in one clause. Run `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-and-offline.md`; expected: exits 0 with nothing flagged in the lines you changed.

- [ ] **Step 2: Troubleshooting row** (Sync and offline table): Symptom: "A page's Linked references, on a replica, list blocks that linked to a different page deleted earlier; the server shows none". Cause: "`pages.id` is reused after deleting the highest page; the feed deduped the delete and create rows into one entity and tombstoned only absent ids, so the replica kept refs the server's cascade had removed. A delete row in the window now tombstones a page or sidebar id even when a live row holds it". Where: `[sync-and-offline.md § The changes feed](architecture/sync-and-offline.md#the-changes-feed)`. Ref: `pkm-8uc9`.

- [ ] **Step 3: Verify.** Server: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` — all pass, coverage gate included. Web: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build` — all pass. E2E: `E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/reused-page-id.spec.ts` — PASS.

- [ ] **Step 4: Bean.** Tick the checklist items for tests, the flag/rule, docs, and verify (leave perf and merge to the orchestrator). On the undo item write: "A block uid recreated by undo is the same block: everything a server block delete cascades (its subtree, its refs and block_refs) is journalled per row or re-derived by `upsertBlock`, so the presence rule loses nothing; no change". Add `## Summary of Changes` (flag and rule in `sync_core`, tombstone plus live row in `routes_sync`, dependents closure for a reused page, `applyWindow` comment, e2e, docs). Mark completed with `beans`.

- [ ] **Step 5: Commit** docs and bean: `docs(pkm-8uc9): feed tombstone rule covers reused ids; troubleshooting row` (says what was added and what was corrected: the "entities that no longer exist" rule).
