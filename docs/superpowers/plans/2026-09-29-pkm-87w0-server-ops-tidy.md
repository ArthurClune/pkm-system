# Server ops tidy (pkm-87w0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/api/ops` planner easier to read and harder to break without changing a single byte of what it does: split the pure hashing and note-text concerns out of `ops_core.py`, classify each op once, replace the 16-field `OpContext` bag with per-kind contexts, rename the `MissingTarget` family, and clean the test hygiene items the review named.

**Architecture:** `ops_apply._context_for` (Shell) already classifies every op, by calling the Core classifiers, to decide what to read. It now hands that classification to the planner inside a per-kind context value (one frozen dataclass per op shape, every field required), so `plan_op` never re-classifies and `apply_batch` reads the skip off the context for `skip_report`. `ops_hash.py` and `conflict_notes.py` become new Functional Core modules. Web changes touch test files only.

**Tech Stack:** Python 3.12, FastAPI, SQLite, pytest, pyrefly, ruff; vitest + TypeScript for the web tests.

**Spec:** none (bean pkm-87w0: "Bounded refactors; no spec"). Inputs: `beans show pkm-87w0`; `docs/2026-09-29-sync-subsystem-review-consolidated.md` § Maintainability and § Tests.

## Global Constraints

- NO wire or behaviour change. The ack shape, `SkipReason` values, error bodies (`{"index", "reason"}` text), conflict-note text, journal rows, WS broadcasts, query count and order per op, and `web/src/api/openapi.json` stay byte-identical. Proven by (a) `uv run python -m pkm.server.openapi_dump` diffed against the committed `web/src/api/openapi.json`, and (b) the golden battery `scratchpad/87w0/golden.py` (70 cases: every `missing_targets.json` case and placement case, conflicts, orphans, skips, cycles, every 400/409 path) diffed against `golden-before.json` recorded on main. Run both at the end of every server task.
- Docstrings of pydantic models in `pkm/contracts/` and of route functions feed `openapi.json`: do not edit them. `SkippedOp`'s docstring names `ops_core.skip_report`, so `skip_report` keeps its name and module.
- Pure logic moved out of `ops_core.py` goes to Functional Core files that declare `# pattern: Functional Core`.
- The rename is internal names only: no wire string (`SkipReason` values, `skipped` ack field, note text) changes.
- Do NOT change (record as report findings instead): `applied` counting skipped ops; the `unusable`/`unavailable`/`unreachable` vocabulary.
- TDD for a refactor: each task's new or restructured tests go red first (import error on the new name or module), then green.
- Code and test comments state the rule and carry NO bean id; commit messages may.
- Never write the two-word phrase that starts "load" and ends "bearing".
- No web runtime file is touched (sibling agents are editing web/src runtime comments). Test files only. No general bean-id sweep of test files.
- Docs under `docs/architecture/` go through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- Do not run `perf/check.sh` or the full Playwright suite; the orchestrator does after merge. Hot paths touched: `ops_apply._context_for`, `_skip_context` (was `_missing_target_context`), `_conflict_landing` (was `_with_conflict_landing`), `apply_batch`, `ops_core.plan_op`; SQL unchanged except the unused `b.order_idx` column dropped from the hashed-edit SELECT.

## Review Focus

1. A create with an invalid or already-taken uid under a missing parent: today the invalid-uid / uid-exists 400 wins over the diversion. Pinned by golden cases `err_invalid_uid_missing_parent`, `err_dup_uid_missing_parent`.
2. A second conflict on the same block the same day reuses the header and mints only the entry uid, header uid minted before entry uid when both are needed (tests monkeypatch `secrets.token_urlsafe` with a sequence). Pinned by `test_ops_apply.py::test_conflict_uids_retry_until_alphanumeric_first_char`, `test_second_conflict_same_day_reuses_header_and_mints_no_stray_conflict_uid`, golden `conflict_twice`.
3. A follow-on op in the same batch on a diverted create's uid sees it missing. Golden `create_under_missing`.
4. A shell/planner op-kind mismatch (a context type that does not fit the op) must fail as a programmer error (AssertionError, 500, retried by clients), never as a 400 that poisons a queue. Pinned by one new core test per task 4.
5. `note_page` in the ack is the daily title exactly when something landed. Pinned by the rewritten `test_skip_report_names_the_op_and_where_its_note_landed`.

---

### Task 1: `ops_hash.py`

**Files:**
- Create: `server/src/pkm/server/ops_hash.py`
- Modify: `server/src/pkm/server/ops_core.py` (remove lines 34-79 and the `hashlib`/`json` imports), `server/src/pkm/server/routes_ops.py:17`
- Test: `server/tests/test_ops_idempotency.py` (five imports switch module; nothing else)

**Interfaces:**
- Produces: `pkm.server.ops_hash.batch_request_hash(batch: OpBatch) -> str`, `batch_replay_hash(batch: OpBatch) -> str` (bodies and private `_canonical_op` / `_canonical_replay_op` moved verbatim, docstrings kept).

- [ ] Step 1: switch the five `from pkm.server.ops_core import batch_...` lines in `test_ops_idempotency.py` to `pkm.server.ops_hash`; run `uv run pytest tests/test_ops_idempotency.py -q` -> FAIL (ModuleNotFoundError).
- [ ] Step 2: create `ops_hash.py` (`# pattern: Functional Core`, module docstring: the batch-id binding hashes `applied_batches` keeps), move the four functions; `routes_ops.py` imports them from there.
- [ ] Step 3: `uv run pytest tests/test_ops_idempotency.py tests/test_ops_endpoint.py -q` -> PASS; openapi and golden diffs empty.
- [ ] Step 4: commit `refactor(pkm-87w0): move the batch hashes to ops_hash.py`.

### Task 2: `conflict_notes.py`

**Files:**
- Create: `server/src/pkm/server/conflict_notes.py`, `server/tests/test_conflict_notes.py`
- Modify: `server/src/pkm/server/ops_core.py` (remove `_links_back`, `existing_page_label`, `conflict_label`, `overwritten_header_text`, `orphan_header_text`, `live_block_header_text`, `_SKIPPED_WHAT`, `skipped_note`, `move_parent_missing_note`, `MOVE_CYCLE_NOTE`)
- Test: `server/tests/test_ops_core.py` (move `test_conflict_label_table` and its parametrize table to the new file)

**Interfaces:**
- Produces, all pure, in `pkm.server.conflict_notes`: `existing_page_label(title: str) -> str`, `conflict_label(page_title: str | None, hint_page_exists: bool) -> str`, `overwritten_header_text(page_title: str, uid: str) -> str`, `orphan_header_text(page_title: str | None, hint_page_exists: bool) -> str`, `live_block_header_text(page_title: str, uid: str) -> str`, `block_missing_note(op: MoveOp | SetHeadingOp | SetViewTypeOp) -> str` (replaces `skipped_note(_SKIPPED_WHAT[type(op)], op.uid)`; the dict becomes private here), `move_parent_missing_note(parent_uid: str) -> str`, `MOVE_CYCLE_NOTE: str`.

- [ ] Step 1: write `test_conflict_notes.py`: the moved `test_conflict_label_table`, plus
  ```python
  def test_block_missing_note_names_what_was_skipped():
      assert block_missing_note(MoveOp(op="move", uid="ghost99", parent_uid=None, order_idx=0)) == "move skipped: block ghost99 not found"
      assert block_missing_note(SetHeadingOp(op="set_heading", uid="ghost99", heading=1)) == "heading change skipped: block ghost99 not found"
      assert block_missing_note(SetViewTypeOp(op="set_view_type", uid="ghost99", view_type="numbered")) == "view type change skipped: block ghost99 not found"
  def test_existing_page_label_falls_back_when_a_link_would_not_read_back():
      assert existing_page_label("Paper") == "[[Paper]]"
      assert existing_page_label("Paper]") == "`Paper]`"
      assert existing_page_label("a`b]") == "(page unknown)"
  ```
  Run -> FAIL (ModuleNotFoundError).
- [ ] Step 2: create `conflict_notes.py` (`# pattern: Functional Core`; docstring: the text of `[[conflict]]` headers and skip notes; never a `[[link]]` to a page that does not exist). Move the functions verbatim; fix `orphan_header_text`'s docstring references to name `ops_core.classify_skip` (task 3) and the shell's `hint_page_exists`. `ops_core` imports what it uses.
- [ ] Step 3: `uv run pytest tests/test_conflict_notes.py tests/test_ops_core.py -q` -> PASS; openapi and golden diffs empty.
- [ ] Step 4: commit `refactor(pkm-87w0): move conflict header and note text to conflict_notes.py`.

### Task 3: rename the `MissingTarget` family to `Skip`

The family holds every op the ack lists under `skipped`, cycles included, so it takes the ack's word; the kind that was itself called `skipped` becomes `orphan_structural` (a move / set_heading / set_view_type of a missing block, parallel to `orphan_edit`).

**Files:**
- Modify: `server/src/pkm/server/ops_core.py`, `server/src/pkm/server/ops_apply.py`, `server/tests/test_ops_core.py`, `server/tooling/perfcheck/backend.py:47,139` (comments)

**Interfaces:**
- Produces: `SkipKind = Literal["noop", "orphan_structural", "orphan_edit", "diverted_create", "move_parent_missing", "move_cycle"]`; `@dataclass(frozen=True) class Skip: kind: SkipKind; landing_uid: str | None`; `classify_skip(op, block_exists, parent_exists, parent_chain=()) -> Skip | None`; `impossible_uid_reason(op, skip: Skip) -> str | None`; private `_plan_skip`; shell `_skip_context`. `skip_report` keeps its name.

- [ ] Step 1: rename in `test_ops_core.py` (imports, `MissingTarget(` -> `Skip(`, `"skipped"` kind -> `"orphan_structural"`, test names that say `classify_missing_target` -> `classify_skip`); run -> FAIL (ImportError).
- [ ] Step 2: rename in `ops_core.py` / `ops_apply.py`; docstring of `Skip` lists the kinds with `move_cycle` described as a live block whose move target is itself or a descendant (no "not a missing target strictly" apology needed now).
- [ ] Step 3: `uv run pytest tests/test_ops_core.py tests/test_ops_apply.py tests/test_ops_endpoint.py -q` -> PASS; `git grep -n "MissingTarget\b\|classify_missing_target\|_plan_missing_target\|_missing_target_context" server` -> nothing; openapi and golden diffs empty.
- [ ] Step 4: commit `refactor(pkm-87w0): name the skip family after the ack list it fills`.

### Task 4: per-kind contexts carrying the one classification

**Decision (deviation from the bean's wording):** the bean suggests `plan_op` return the classification for the shell to carry. The shell must classify before planning anyway (it decides what to read), so instead the shell's single classification rides into the planner in the context, and `apply_batch` reads it from there. Classification then runs once per op instead of three times, and nothing needs to agree.

**Files:**
- Modify: `server/src/pkm/server/ops_core.py`, `server/src/pkm/server/ops_apply.py`
- Test: `server/tests/test_ops_core.py` (restructured: every `OpContext(...)` becomes the matching per-kind context; the three tests that assert "conflict context missing" are deleted, since those states are no longer representable; `test_create_follows_its_parent_onto_the_parents_page` is deleted, the rule now lives in the shell and `test_ops_apply.py::test_create_under_a_parent_on_another_page_follows_the_parent` plus the placement fixture pin it; the unneeded `conflict_uid` seed in `_ctx` goes with the bag)

**Interfaces (all `@dataclass(frozen=True)` in `ops_core.py`, every field required unless shown):**
- `ExistingHeader(uid: str, next_idx: int)`; `FreshHeader(uid: str, append_idx: int)`
- `ConflictLanding(daily_page_id: int, daily_title: str, entry_uid: str, header: ExistingHeader | FreshHeader)`
- `PageContext(page_id: int)` — create_page
- `CreateContext(uid_taken: bool, page_id: int)` — a create whose parent, if named, exists; `page_id` is where it lands (the live parent's page, else `op.page_title` resolved)
- `MoveContext(block: BlockInfo, parent: BlockInfo | None, page_id: int | None, subtree: tuple[str, ...])` — `page_id` only for a top-level move naming a page
- `DeleteContext(block: BlockInfo, subtree: tuple[str, ...])`
- `BlockContext(block: BlockInfo)` — set_collapsed, set_heading, set_view_type, hashless update_text
- `TextEditContext(block: BlockInfo, outcome: TextEditOutcome)` — hashed edit `classify_text_edit` found identical or clean
- `TextConflictContext(block: BlockInfo, text: str, current_text: str, page_title: str, landing: ConflictLanding)` — found a conflict; `text` is the replayed edit
- `SkipContext(skip: Skip)` — nothing lands (`skip.landing_uid is None`)
- `LandedSkipContext(skip: Skip, landing: ConflictLanding, hint_page_exists: bool)` — orphan_edit, diverted_create, orphan_structural with an entry to land
- `StuckMoveContext(skip: Skip, landing: ConflictLanding, page_title: str, subtree: tuple[str, ...])` — move_parent_missing, move_cycle
- `SkippedContext = Union[SkipContext, LandedSkipContext, StuckMoveContext]`; `SKIPPED_CONTEXTS` = that tuple of classes; `OpContext = Union[<all ten>]`
- `conflict_entry_effects(target_uid: str, lost_text: str, header_text: str, landing: ConflictLanding) -> tuple[Effect, ...]` (same effects, same order)
- `skip_report(index: int, op: BlockOp, ctx: SkippedContext) -> dict` (`note_page` = `ctx.landing.daily_title`, or None for `SkipContext`)
- `plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]`: create's `invalid uid` check first for any context; skipped contexts -> `impossible_uid_reason` then `_plan_skip`; `CreateContext.uid_taken` -> `uid already exists`; dispatch on the context type with `assert isinstance(op, ...)` for the op it fits. Every `"conflict context missing"` raise, `_conflict_landing_ready`, `"page could not be resolved"`, and the landing asserts disappear. `OpError` messages otherwise unchanged.
- Shell: `_conflict_landing(db, target_uid, now_ms) -> ConflictLanding` (same queries in the same order; mints the header uid, when no header exists, before the entry uid); `_skip_context(db, op, skip, block, now_ms) -> SkippedContext` (hint query, then page title via `_require_page_title`, then subtree, then landing — same order as today); `_context_for(db, op, now_ms) -> OpContext` keeps its signature (test_ops_concurrency monkeypatches it and `_hint_page_exists`); `_broadcast_page_title` reads `page_id` from `CreateContext`/`PageContext` and `block` from `MoveContext`; `apply_batch` appends `skip_report(index, op, ctx)` when `isinstance(ctx, SKIPPED_CONTEXTS)`, else the broadcast.

- [ ] Step 1: restructure `test_ops_core.py` onto the new contexts. Helpers: `_landing(**over) -> ConflictLanding` (daily 9, "September 28th, 2026", entry "uid_ch1", `FreshHeader("uid_hd1", 4)`), `_existing(**over)` with `ExistingHeader("uid_hd0", 3)`. Add:
  ```python
  def test_a_context_that_does_not_fit_the_op_is_a_programmer_error_not_a_400():
      move = MoveOp(op="move", uid="uid_b3", parent_uid=None, order_idx=0)
      with pytest.raises(AssertionError):
          plan_op(0, move, DeleteContext(B, ("uid_b3",)))
  ```
  Run -> FAIL (ImportError).
- [ ] Step 2: implement the contexts, `plan_op`, `_plan_skip`, `conflict_entry_effects`, `skip_report` in `ops_core.py`; rewrite `_context_for`, `_skip_context`, `_conflict_landing`, `_broadcast_page_title`, `apply_batch` in `ops_apply.py`. `AppliedBatch` docstring names `skip_report` still.
- [ ] Step 3: `uv run pytest -q` (whole server suite, coverage gate) -> PASS; `uv run pyrefly check`, `uv run ruff check` clean; openapi and golden diffs empty.
- [ ] Step 4: commit `refactor(pkm-87w0): per-kind op contexts carry the shell's one classification`.

### Task 5: docs

**Files:** `docs/architecture/backend.md` (module map rows for `ops_hash.py` and `conflict_notes.py`; `OpContext` -> per-kind contexts in the module map and the write-path diagram; "`plan_op` and `_context_for` both call it" for `classify_text_edit` and `classify_missing_target` -> the shell classifies once and the context carries the result; `classify_missing_target`/`_plan_missing_target` -> `classify_skip`/`_plan_skip`; `batch_replay_hash` and `existing_page_label` module names; the fixture table row at :649), `docs/architecture/sync-and-offline.md:181`, `docs/architecture/sync-recovery.md:33,35,506`, `docs/architecture/performance-checks.md:207`, `docs/troubleshooting.md:27` (current function name in the cause column).

- [ ] Step 1: invoke `architecture-docs`; make the edits; `git grep -n "classify_missing_target\|OpContext\|_plan_missing_target" docs/architecture docs/troubleshooting.md` -> nothing.
- [ ] Step 2: `node .claude/skills/architecture-docs/check-docs.mjs <edited files>` clean.
- [ ] Step 3: commit `docs(pkm-87w0): name the split ops modules, the skip family and the per-kind contexts`.

No troubleshooting row: this bean fixes no failure; the one existing row that names the old function is corrected instead.

### Task 6: web test hygiene (comments and group names)

**Files:** `web/src/sync/opQueue.replica.test.ts` (the comment in "a retained op queued behind one durable batch keeps its place between them" that credits a count of durable batches; the comment in "a poisoned durable batch stops standing ahead of a retained op" that says no deleteBatch arrives "to decrement the lane" — both restated in terms of `follows` marks: ordering is by batch identity), `web/src/replica/queue.test.ts` ("a caller-hashed op is persisted exactly as the lane would keep it": the copies need not be byte-identical, since the server's replay hash ignores `base_text_hash` and `page_title` on update_text; the test pins that the worker fills only what the caller left out), `web/src/replica/apply.test.ts` (the four `describe` titles that start with a bean id are renamed by behaviour, keeping the `applyChanges:` prefix style of their neighbours).

- [ ] Step 1: edit; `pnpm vitest run src/sync/opQueue.replica.test.ts src/replica/queue.test.ts src/replica/apply.test.ts` -> same test count, PASS.
- [ ] Step 2: commit `test(pkm-87w0): correct stale lane-ordering comments; name apply groups by behaviour`.

### Task 7: describe grouping in the flat web test files

**Files:** `web/src/sync/SyncProvider.test.tsx`, `web/src/sync/opQueue.replica.test.ts`, `web/src/sync/replicaSync.test.ts`.

Wrap contiguous runs of top-level `test(...)` calls in `describe("<behaviour>", () => { ... })`, indenting their lines by two spaces (none of the three files holds a multi-line template literal, so indentation cannot change a string). Top-level hooks and helpers used by more than one group stay at top level; a helper used by one group only may move inside it. No test body, name or order changes; the `// --- ... ---` section banners that a describe title now replaces are removed (banner text with a rule in it moves into a comment under the describe line).

- [ ] Step 1: for each file, record `pnpm vitest run <file>` test count before.
- [ ] Step 2: regroup; `git diff --no-ext-diff -w --stat` and `git diff --no-ext-diff -w <file>` show only describe lines, closing lines and banner comments.
- [ ] Step 3: same test counts, PASS; `pnpm typecheck && pnpm lint`.
- [ ] Step 4: commit `test(pkm-87w0): group the flat sync test files by behaviour`.

### Task 8: verification and bean

- [ ] Server: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`.
- [ ] Web: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`.
- [ ] Openapi dump diff and golden diff empty.
- [ ] Bean: checklist ticked, `## Summary of Changes`, completed, committed last.
