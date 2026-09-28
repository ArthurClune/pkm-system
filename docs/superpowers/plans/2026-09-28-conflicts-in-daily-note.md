# Conflicts in the Daily Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every text conflict lands on today's daily page as a `[[conflict]] [[Page]] — …` header with the lost texts as children, one header per block per day.

**Architecture:** `UpdateTextOp` gains an optional `page_title` hint, stamped by the web client and the CLI. The server's pure planner (`ops_core.plan_op`) decides header vs append and the texts; the shell (`ops_apply._context_for` / `_execute`) looks up and records headers in a new server-only `conflict_headers` table.

**Tech Stack:** Python 3 / FastAPI / sqlite3 (server, pytest, pyrefly, ruff); TypeScript / React / sqlite-wasm (web, vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-09-28-conflicts-in-daily-note-design.md`

Bean: pkm-3g4n. Worktree: `.claude/worktrees/conflicts-in-daily-note` (branch `worktree-conflicts-in-daily-note`). Run `git status -sb` before every commit.

## Global Constraints

- Header copy, exact (em dash `—`, U+2014):
  - live block: `[[conflict]] [[{page}]] — overwritten by (({uid}))`
  - missing block, hint usable: `[[conflict]] [[{page}]] — edit to a block the server no longer has`
  - missing block, no usable hint: `[[conflict]] (page unknown) — edit to a block the server no longer has`
- Children are the lost text verbatim, no `[[conflict]]` prefix.
- `update_text.page_title` only labels; it never changes where/whether the edit applies, and it is NEVER added to `find_op_title_violation` (server) or `findOpTitleViolation` (web). An unusable hint (`None`, blank after strip, or `title_syntax_reason(...) is not None`) renders as `(page unknown)`. A hint can never make an op fail — titles never 422/400.
- Live-block case names the server's own page title, not the hint.
- `conflict_headers` goes in `SERVER_DDL` (never `BASE_DDL`), idempotent `CREATE TABLE IF NOT EXISTS`.
- Day key = `title_for_date(date.today())` (server-local), same as today's orphan landing.
- Unchanged: incoming wins; `replay_title_rewrites` first; hashless `update_text` = plain LWW; hashless on a missing block still 400s.
- Any contract/docstring change: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `cd web && pnpm gen-types` (enforced by `test_openapi_sync.py`).
- Every new/changed file keeps its `# pattern:` header; `ops_core.py` stays Functional Core.
- Commit messages: no Claude session URLs; end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. The user deleted today's header, then another conflict for the same block arrives → a fresh header, not a child of a vanished uid (FK failure / 500). Pinned in Task 2.
2. Yesterday's row exists for the block → today gets a new header on today's page, and yesterday's row is pruned. Pinned in Task 2 (monkeypatched `date`).
3. A hint that is blank or has illegal title syntax (`[[`, newline) → op still 200, header says `(page unknown)`. Pinned in Task 1 (planner) and Task 2 (endpoint).
4. Two conflicting `update_text` ops for the same block in ONE batch → one header, two children in order. Pinned in Task 2.
5. Replaying the same `batch_id` → no second header or child (`applied_batches` replay). Pinned in Task 2.

---

### Task 1: Contract field and pure conflict planning

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`UpdateTextOp`)
- Modify: `server/src/pkm/server/ops_core.py` (`OpContext`, texts, new effect, `plan_op` check 1 and check 5)
- Test: `server/tests/test_ops_core.py`

**Interfaces:**
- Produces:
  - `UpdateTextOp.page_title: str | None = None` (doc comment: conflict label only).
  - `OpContext` new fields: `conflict_child_uid: str | None`, `daily_title: str | None`, `conflict_header_uid: str | None` (today's live header for `op.uid`, if any), `conflict_header_next_idx: int | None` (next child `order_idx` under it), `page_title: str | None` (the live block's page title; unused for missing blocks). Existing `conflict_uid` becomes the header uid when a header is created; `daily_page_id` / `daily_append_idx` now populated for both branches.
  - `@dataclass(frozen=True) class RecordConflictHeader: target_uid: str; day: str; header_uid: str` — added to `Effect`.
  - `conflict_label(page_title: str | None) -> str` — `[[{t}]]` for a usable title, else `(page unknown)`; usable per Global Constraints.
  - `overwritten_header_text(page_title: str, uid: str) -> str`, `orphan_header_text(page_title: str | None) -> str` — exact copy above. Delete `conflict_copy_text` / `orphan_conflict_text` (grep callers).
  - `conflict_entry_effects(target_uid: str, lost_text: str, header_text: str, ctx: OpContext) -> tuple[Effect, ...]` — append when `ctx.conflict_header_uid` is set: `InsertBlock(ctx.conflict_child_uid, ctx.daily_page_id, ctx.conflict_header_uid, ctx.conflict_header_next_idx, lost_text, None)`, `ReindexRefs`, `TouchPage(daily)`. Otherwise create: header `InsertBlock(ctx.conflict_uid, daily, None, ctx.daily_append_idx, header_text, None)` + `ReindexRefs`, child `InsertBlock(ctx.conflict_child_uid, daily, ctx.conflict_uid, 0, lost_text, None)` + `ReindexRefs`, `RecordConflictHeader(target_uid, ctx.daily_title, ctx.conflict_uid)`, `TouchPage(daily)`.

- [ ] **Step 1: Write failing tests** in `test_ops_core.py`, replacing `test_check_1_missing_block_lands_on_daily_page` and `test_check_5_stale_hash_wins_and_preserves_loser_as_sibling`. Build contexts with `daily_page_id=9, daily_append_idx=4, daily_title="September 28th, 2026", conflict_uid="uid_hd1", conflict_child_uid="uid_ch1"`.
  - `test_missing_block_creates_daily_header_naming_the_hint`: op `page_title="AI Agent Security"`, no header → header InsertBlock `(uid_hd1, 9, None, 4)` text `"[[conflict]] [[AI Agent Security]] — edit to a block the server no longer has"`; child `(uid_ch1, 9, "uid_hd1", 0)` text `"new text"`; `RecordConflictHeader("uid_t1", "September 28th, 2026", "uid_hd1")` present.
  - `test_missing_block_without_usable_hint_says_page_unknown`: parametrize `page_title` over `None`, `"  "`, `"a[[b"` → header text `"[[conflict]] (page unknown) — edit to a block the server no longer has"`.
  - `test_missing_block_appends_under_todays_header`: `conflict_header_uid="uid_old", conflict_header_next_idx=3` → exactly one InsertBlock `(uid_ch1, 9, "uid_old", 3, "new text")`, no `RecordConflictHeader`.
  - `test_check_5_incoming_wins_and_loser_goes_to_daily_header`: `_ctx(current="server text meanwhile")` plus daily fields and `page_title="Machine Learning"` → `UpdateText("uid_t1", "new text")` present; no `ShiftSiblings`; header text `"[[conflict]] [[Machine Learning]] — overwritten by ((uid_t1))"`; child text `"server text meanwhile"`; no InsertBlock on `_BLK.page_id`.
  - `test_check_5_appends_under_todays_header`: header present → one child InsertBlock under it, `UpdateText` still present.
  - Keep checks 2/3/4 tests; they must still pass unchanged.

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_ops_core.py -q` — Expected: new tests FAIL (unknown fields / old texts).

- [ ] **Step 3: Implement** the Interfaces above. In `plan_op`: check 1 requires `conflict_uid`, `conflict_child_uid`, `daily_page_id`, `daily_append_idx`, `daily_title` (else `OpError(index, "conflict context missing")`) and returns `conflict_entry_effects(op.uid, op.text, orphan_header_text(op.page_title), ctx)`. Check 5 returns `(*conflict_entry_effects(op.uid, ctx.current_text, overwritten_header_text(ctx.page_title, op.uid), ctx), *base_effects)` with the same context guard plus `page_title`. Use `title_syntax_reason` (already imported for `find_op_title_violation`) in `conflict_label`.

- [ ] **Step 4: Run** `uv run pytest tests/test_ops_core.py -q && uv run pyrefly check && uv run ruff check` — Expected: PASS (endpoint tests will fail until Task 2; don't run the full suite yet).

- [ ] **Step 5: Commit** `feat(pkm-3g4n): plan conflicts as daily-note headers with page labels`.

### Task 2: Shell — header table, context, executor, endpoint

**Files:**
- Modify: `server/src/pkm/schema.py` (`SERVER_DDL`: `conflict_headers` per spec, with a comment saying why it is server-only and pruned to today)
- Modify: `server/src/pkm/server/ops_apply.py` (`_context_for` update_text branch, `_execute`)
- Modify: `web/src/api/openapi.json`, `web/src/api/types.d.ts` (regen)
- Test: `server/tests/test_ops_endpoint.py`, `server/tests/test_ops_apply.py`

**Interfaces:**
- Consumes: Task 1's `OpContext` fields and `RecordConflictHeader`.
- Produces: `_conflict_header(db, target_uid: str, day: str, daily_page_id: int) -> tuple[str, int] | None` — `(header_uid, next_child_idx)` when a `conflict_headers` row exists for `(target_uid, day)` AND that uid is still a block with `page_id = daily_page_id` (next idx = `COALESCE(MAX(order_idx)+1, 0)` of its children); else `None`.

- [ ] **Step 1: Write failing endpoint tests** in `test_ops_endpoint.py`, replacing `test_conflict_copy_lands_next_to_target` and `test_orphaned_edit_lands_on_todays_daily_page`. Helper: fetch today's daily page (`title_for_date(date.today())`) and return its top-level blocks with children.
  - `test_live_conflict_goes_to_daily_note_not_the_page`: stale-hash edit to `uid_b1` → Machine Learning page has `"offline edit"` and no `[[conflict]]` block; daily has header `"[[conflict]] [[Machine Learning]] — overwritten by ((uid_b1))"` with one child `"Tags:: #AI"`.
  - `test_orphan_conflict_names_hinted_page`: delete `uid_b6`, then hashed edit with `page_title: "Machine Learning"` → daily header `"[[conflict]] [[Machine Learning]] — edit to a block the server no longer has"`, child `"edited after delete"`.
  - `test_repeated_orphan_edits_group_under_one_header`: three batches of hashed edits to never-existing `uid_zz1` (texts `"O"`, `"Op"`, `"Ope"`) → one header, children in order `["O", "Op", "Ope"]`.
  - `test_two_conflicts_in_one_batch_group`: one batch, two hashed edits to `uid_zz2` → one header, two children.
  - `test_deleted_header_starts_a_fresh_one`: conflict, delete the header via a `delete` op, conflict again → exactly one header on the daily page, one child.
  - `test_new_day_starts_a_fresh_header_and_prunes`: monkeypatch `pkm.server.ops_apply.date` with a stub whose `today()` returns 2026-09-27, conflict; then 2026-09-28, conflict → a header on each day's page; `SELECT day FROM conflict_headers` returns only the 28th's title.
  - `test_unusable_hint_is_labelled_not_rejected`: `page_title: "bad[[title"` → 200, header says `(page unknown)`.
  - `test_replayed_conflict_batch_adds_nothing`: post the same `batch_id` twice → one header, one child.
  - Keep `test_hashless_update_on_missing_block_still_400s`.
  - In `test_ops_apply.py`, update `test_conflict_sibling_uid_retries_until_alphanumeric_first_char` to find the conflict child (`text = 'Tags:: #AI'` on the daily page) and header; both uids must satisfy the same first-char rule.

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_ops_endpoint.py tests/test_ops_apply.py -q` — Expected: FAIL.

- [ ] **Step 3: Implement.** `_context_for` hashed-update branch: always `get_or_create_page(db, daily_title, now_ms)`, compute `daily_append_idx` as today, mint `conflict_uid` and `conflict_child_uid` with `_new_uid()`, fill header via `_conflict_header`. Live block: also `page_title` = the block's page title (join `pages`). `_execute(RecordConflictHeader)`: `DELETE FROM conflict_headers WHERE day <> ?` then `INSERT OR REPLACE INTO conflict_headers(target_uid, day, header_uid) VALUES (?,?,?)`.

- [ ] **Step 4: Regen contract** per Global Constraints, then run `uv run pytest -q && uv run pyrefly check && uv run ruff check` — Expected: PASS, including `test_openapi_sync.py` and `test_shim_parity_fixture.py` (if shim parity fails, run `uv run python -m pkm.server.shim_parity_dump` and commit the fixture).

- [ ] **Step 5: Commit** `feat(pkm-3g4n): record conflict headers per block per day on the daily page` (include regenerated `openapi.json` / `types.d.ts`).

### Task 3: CLI/MCP send the page hint

**Files:**
- Modify: `server/src/pkm/planning.py` (`plan_update`, `plan_mark`)
- Modify: `server/src/pkm/client/workflows.py` (`edit_block`)
- Test: `server/tests/test_planning.py`, `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `UpdateTextOp.page_title` (Task 1).
- Produces: `plan_update(uid, text, base_text=None, current_heading=_NOT_GIVEN, page_title: str | None = None)` and `plan_mark(uid, current_text, mark, page_title: str | None = None)` put `page_title` on the `UpdateTextOp`. `edit_block` passes `client.get_block(uid).page.title`. `batch.py`'s call stays hintless (it is unguarded; no conflict path).

- [ ] **Step 1: Failing tests:** `test_plan_update_carries_page_title_hint` (`plan_update("uid_a1", "x", "y", None, page_title="AI")[0].page_title == "AI"`), `test_plan_mark_carries_page_title_hint`, and in `test_mcp_server.py` `test_update_block_sends_page_hint`: delete the block out from under a fetched `update_block` (patch `client.get_block` to return the pre-delete payload, or spy on `post_ops`, whichever the file's existing fixtures support) and assert the op carries `page_title` equal to the block's page. Also fix the `plan_update` docstring sentence that says the rescue lands "as a `[[conflict]]` sibling" — it now lands under a daily-note header.
- [ ] **Step 2: Run** `uv run pytest tests/test_planning.py tests/test_mcp_server.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `uv run pytest -q && uv run pyrefly check && uv run ruff check`; regen contract if any docstring feeding OpenAPI changed. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pkm-3g4n): CLI and MCP updates send the page hint`.

### Task 4: Web client stamps the page hint

**Files:**
- Modify: `web/src/outline/baseTextHash.ts` (`stampBaseTextHashes`)
- Modify: `web/src/replica/queue.ts` (`enqueueBatch`)
- Test: `web/src/outline/baseTextHash.test.ts`, `web/src/outline/useOutline.undo.test.tsx`, `web/src/replica/queue.test.ts`

**Interfaces:**
- Consumes: regenerated `UpdateTextOp` type with `page_title?: string | null` (Task 2).
- Produces: `stampBaseTextHashes(blocks, pageTitle, ops)` also sets `page_title: pageTitle` on each `update_text` whose node it finds in the tree and whose `page_title` is undefined (independently of whether the hash was already set). `enqueueBatch` sets `page_title` from `SELECT p.title FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.uid = ?` when undefined and the block is known.

- [ ] **Step 1: Failing tests:**
  - `baseTextHash.test.ts`: `stamps the planning page's title on update_text ops it finds` → `{op:"update_text", uid, text, base_text_hash, page_title: "AI"}`; `leaves page_title off ops for blocks the tree does not know`; `keeps a caller-supplied page_title`.
  - `useOutline.undo.test.tsx`: the op enqueued by an undo carries `page_title` of the undone page (history still stores unstamped ops — assert the recorded entry has no `page_title`).
  - `queue.test.ts`: `enqueueBatch fills page_title from the replica when absent`, and leaves an unknown block's op without it.
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/outline/baseTextHash.test.ts src/outline/useOutline.undo.test.tsx src/replica/queue.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; update the `baseTextHash.ts` header comment (it now stamps two fields; the `[[conflict]] sibling` wording becomes the daily-note header).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test:unit` — Expected: PASS with coverage thresholds met.
- [ ] **Step 5: Commit** `feat(pkm-3g4n): web client stamps page_title on update_text`.

### Task 5: Docs, full verification, perf

**Files:**
- Modify: `docs/architecture/backend.md`, `docs/architecture/sync-and-offline.md`, `docs/architecture/overview.md`, `docs/design.md`, `server/src/pkm/cli/main.py` (help text at the `[[conflict]]` mention), MCP tool descriptions in `server/src/pkm/mcp/server.py` if they describe conflicts
- Modify: `.beans/pkm-3g4n--*.md` (checklist, summary, completed)

- [ ] **Step 1:** `grep -rn "conflict\]\]\|original block deleted\|conflict sibling\|conflict copy" docs/architecture docs/design.md server/src web/src` and update every description of placement to the daily-note header rule (invoke the `architecture-docs` skill; a table for the three header cases in `backend.md`'s write-path conflict section; `conflict_headers` added where `SERVER_DDL` tables are listed). Docstring edits → regen contract.
- [ ] **Step 2:** `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/backend.md docs/architecture/sync-and-offline.md docs/architecture/overview.md` — Expected: no failures.
- [ ] **Step 3:** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && CI=true pnpm verify` — Expected: all PASS.
- [ ] **Step 4:** `perf/check.sh` — Expected: no regression (a backend count change on the conflict path is expected only if a perf scenario exercises conflicts; investigate any regression per AGENTS.md before re-recording).
- [ ] **Step 5: Commit** docs + bean completion (`docs(pkm-3g4n): …`, say what was corrected vs added).
