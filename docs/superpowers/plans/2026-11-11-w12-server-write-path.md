# W12 Server Write Path: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** Make the server write path one owner per rule: the rewrite-replay engine in its own core module, one `TextEditOutcome` per hashed edit and one place the replay budget falls, one title reader per batch, op hashes pinned for every op kind, one `block_rewrites` writer, one read-transaction helper and one visited-path guard, with no behaviour, hash or budget change.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W12 and its Global Constraints; evidence in the local review reports `01-server-ops.md` (findings 2, 3, 4, 6, 7, 8, 9, 10, 11, 12) and `02-server-routes.md`. Branch `refactor/server-write-path`, stacked on the W17 gates branch (not yet merged), read at `6a98f601`. W2, W5 and W6 are in it.

**Architecture:** Pure moves first, each in its own commit, so a reviewer reads them with `--color-moved`. Then the structural changes, each guarded by tests that pin what must not move: the op hashes (Task 1, before anything else), the replay debits (the exact-charge tests stay until Task 10), and the patch points the property gate and the property sync server use.

**Tech stack:** Python 3.12, FastAPI, SQLite, pytest + Hypothesis, pyrefly, ruff; one web comment (`web/src/outline/baseTextHash.ts`, `web/src/props/sync/conflictNoise.ts`).

## Global Constraints

- Every task: its own worktree off `refactor/server-write-path`, merged back with `git merge --no-ff`. Run `pwd` and `git branch --show-current` before the first write.
- After every commit: `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`. A task that touches `web/` also runs the web gates (`pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build`).
- No behaviour change: no op hash, ack, journal row, `block_rewrites` row or replay debit may differ. Query counts move only in Task 9, and only as it lists.
- Comments: no bean ids, line numbers or plan pointers; at most 80 columns; none of the words AGENTS.md § Writing guidance bans. Each new runtime file declares its FCIS pattern.
- Fix what property checks find; never exempt in `props/`.
- Docs under `docs/architecture/` go through the `architecture-docs` skill (Task 11 only).
- Do not re-propose: changing `OpsAck.applied`; removing the replay budget; retiring `_stored_ack`'s strict-hash path; a backlinks-only endpoint.
- Ports: never 8974. Port 8978 belongs to `proptest/check.sh web`; only the orchestrator runs it.

## Review Focus

1. A batch committed before the deploy and retried after it, its ack lost: it must replay its stored ack, never 409. Pinned by `op_hashes.json` (Task 1) for every op kind, minimal and with every optional field set.
2. A batch of stale edits over a block with history: each op's debit, and the order of debits against the rows the batch reads and records, must not move. Guarded by the exact-charge tests kept until Task 10 and the allowance log diff (Traps) in Tasks 8 and 9.
3. An over-limit replay under plain-space titles: the block keeps its text and the landing makes every title the chain deleted or renamed away plain, padded spellings included. `test_replay_step_titles.py` and the padded-spelling tests in `test_ops_apply.py` must pass unchanged through Tasks 5, 8 and 9.
4. The property server's teeth after the move: stale, rewrite and limit teeth still bite. `test_proptest_sync_server.py`'s teeth tests run in `pytest -q`; the web sync suite runs them for real (orchestrator).
5. A move or delete across a corrupted parent cycle, and the assistant's card for a move under a descendant: the walks stop at the repeat and the ancestors list each block once. `test_parent_chain_and_subtree_terminate_on_preexisting_cycle` and `test_reader_ancestors_end_on_a_cycle` pass unchanged through Task 3.

---

## Where the code disagrees with W12

The code wins; the tasks are written to it.

| W12 says | The code says | Consequence |
|---|---|---|
| `replay_core.py` takes `unlink_stale_refs`… `rewrite_effects` | `rewrite_effects` reads `InsertBlock` and `UpdateText` from the planned effects and returns `RecordRewrite`, all `ops_core` effect types; `ops_core`'s contexts need `TextEditOutcome` from the engine. Moving it makes an import cycle. | `rewrite_effects` stays in `ops_core`. `_rewrite_chain`, `stale_titles_linked` and `unlink_stale_text` move. The engine's constants (`MAX_REPLAYED_REWRITES`, `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS`, `StepKey`) move with it. |
| Delete the public `replay_title_rewrites` wrapper; tests call `classify_text_edit` | Sixteen call sites, among them the unlink property's `replay_reproduces`, assert the replayed **base hash**, which no `TextEditOutcome` carries. W17's teeth expect a frame named `replay_reproduces`. | Task 6 deletes the tuple wrapper and makes `_replay`/`_Replayed` public as `replay`/`Replayed`; callers read `.text` and `.base_hash`. `replay_reproduces` keeps its name. |
| `BatchReplay.charge(outcome)` is the only debit site | `_read` also debits: each base hash's rows, and all that is left when a hash is too costly to read. Those debits happen before classification and carry no outcome. | One private `_spend(cost)` is the only assignment to `allowance`; `charge(outcome)` and `_read` call it. A scan test holds it (Task 8). |
| `RewriteHistory.walk(base) -> Iterator[RewriteStep]` | Neither consumer can work from bare steps. `next_unread` needs the hash the walk stopped at; `_replay` needs to know whether it stopped blind, and must tell that apart from the `MAX_REPLAYED_REWRITES` bound, where neither reads further. | `walk` yields `WalkStep(base_hash, step)`, ending with `step=None` exactly when it reaches a hash whose rows are unread or too costly (Task 8). |
| "No context field has a default" | `TextEditOutcome` has five defaults too, `canonical=normalize_title` among them, and nine test asserts compare outcomes with `==` on those defaults. `classify_text_edit` and the replay default `canonical` to `normalize_title`. | Task 8 drops every default on the outcome and the contexts; Tasks 6 and 8 make `canonical` required on `replay` and `classify_text_edit`. |
| `canonical` once, "threaded to every helper"; lists `_resolve_page`… `get_or_create_page` | The largest per-op reader is `_execute`'s `ReindexRefs` → `store.reindex_refs_for_text` → `index_ref` → `get_or_create_page`, which re-reads the flag per ref. `_conflict_landing` reads it for the daily page, `_destination_siblings` through `_existing_page_id`. `plan_op` is pure and needs the canonicaliser for the `over_limit` landing. | Task 9 threads one reader through every ops-path caller, through a keyword-only optional `canonical` on `get_or_create_page`, `index_ref` and `reindex_refs_for_text`. Store's rename, merge and delete paths are unchanged (Question 2). `TextEditOutcome.canonical` stays, set to the batch's reader; the contexts lose theirs. |
| `_parent_chain` public replaces `target_reader._ANCESTORS_SQL` | `_parent_chain` includes the block itself and has no `ORDER BY` (SQLite's recursive queue is FIFO, so it reads block first, root last). `_ANCESTORS_SQL` starts at the parent and would also yield a parent uid with no row, which the `ON DELETE CASCADE` foreign key rules out. | `ancestors = parent_chain(db, uid)[1:]`; the existing order and cycle tests decide. `parent_chain`'s SQL is unchanged. |
| Four `BEGIN … finally: rollback` sites | `target_reader` never rolls back: it closes the connection. `audit_title_migration` first refuses a caller's open transaction, and two tests match its message. | `read_txn` is `BEGIN`, then rollback in `finally`. `target_reader` keeps its `close`. The audit keeps its own check. |
| "One named constant" holds the visited-path guard | The five `ops_apply` walks spell it with two aliases (`c.path`, `s.path`). | A function `_unvisited(path, uid) -> str` that renders the identical text (Task 3). |
| `store.rewrite_referencing_blocks` has only test callers | It has no callers at all: two comments in `test_blank_titles.py` name it. | Task 6 deletes it and fixes the two comments. |
| Replace every "check N" | `web/src/props/ops/example.ts` and `ops/teeth.prop.ts` use "check 1/2/3" for the **ops property's own** checks, and the teeth match on `"check 1:"`. W12 misses some server-numbering sites: `conflict_notes.py` (four docstrings), `ops_apply._hint_page`, a comment in `test_ops_apply.py`, a comment in `test_perfcheck_backend.py`, and `web/src/props/sync/conflictNoise.ts` ("check 5"). | Task 7 renames the server numbering everywhere and leaves the ops property's labels alone. |
| `apply_batch`'s docstring names a move cycle | W6 fixed it already. | Nothing to do. |
| § Planning gets a "plan_op" heading | 24 lines link `#planning`, in backend.md, SECURITY.md, four other architecture docs and `troubleshooting.md`. | Question 3; default keeps the heading. |
| `ws.Hub._conns` is read only by tests | Five reads in `test_ws.py` and `test_origin_guard.py`. | They read `set(hub._clients)`. |
| Rename `AppliedBatch` | `contracts.responses.AppliedBatch` is an OpenAPI schema the web types import. | Only `ops_apply.AppliedBatch` becomes `BatchEffects`. |

## Measured fallout

Measured in this worktree by scratch edits, reverted:

- Dropping every context and `TextEditOutcome` default: 65 pyrefly errors, all in `tests/test_ops_core.py` (nine outcome constructions, three `LandedSkipContext`, the conflict helpers).
- Making `canonical` required: 22 `classify_text_edit` calls and 13 `replay_title_rewrites` calls, all in tests (`test_ops_core.py`, `test_ops_apply.py`, `test_replay_batch_work.py`, `test_replay_step_titles.py`, `test_unlink_bounds.py`, `props/test_unlink_props.py`).
- Qualified pointers to moved names (`ops_core.<moved>`): `test_replay_batch_work.py` 34, `test_replay_step_titles.py` 24, `test_ops_apply.py` 13, backend.md 13, `props/model.py` 6 (comments only; the model imports nothing from `pkm.server`), `perfcheck/backend.py` 3, `ops_apply.py` 2, and one each in `schema.py`, `store.py`, `perfcheck/build.py` and `perfcheck/fixture.py`.
- Loop-step counting names `ops_core` by module in four places: the `MODULES` tuples of `test_replay_batch_work.py`, `test_replay_step_titles.py` and `test_unlink_bounds.py`, and `test_ops_core.py`'s inline tuple in the unlink-work test.
- pyrefly is clean at the base (0 errors).

## Files

| File | Change |
|---|---|
| `server/src/pkm/server/replay_core.py` | new, Functional Core: the replay engine (Task 5) |
| `server/src/pkm/server/ops_core.py` | keeps judges, skips, contexts, effects, `plan_op`, `rewrite_effects` |
| `server/src/pkm/server/ops_apply.py` | `BatchReplay.charge`, `parent_chain`, `_unvisited`, `BatchEffects`, the batch reader |
| `server/src/pkm/server/store.py` | `insert_block_rewrites`; `canonical` keyword on three functions; `rewrite_referencing_blocks` deleted |
| `server/src/pkm/server/db.py` | `read_txn` |
| `server/src/pkm/server/routes_sync.py`, `server/title_migration.py`, `assistant/target_reader.py` | `read_txn`; `parent_chain` |
| `server/src/pkm/server/ws.py`, `routes_ops.py`, `ops_hash.py`, `conflict_notes.py` | comments; `_conns` deleted |
| `server/tooling/proptest/sync_server.py` | imports from `replay_core` |
| `shared/fixtures/op_hashes.json` | new, hand-edited |
| `docs/architecture/backend.md` | Task 11 |

## Tasks

"Server gates" means `uv run pytest -q`, `uv run pyrefly check` and `uv run ruff check` from `server/`.

### Task 1: Op hashes are pinned for every op kind

**Implementer:** opus (hash pins: a wrong value pins a break).

**Files:** create `shared/fixtures/op_hashes.json`; modify `server/tests/test_ops_idempotency.py`. Do not touch `ops_hash.py`.

**Interfaces:**
- Produces: `op_hashes.json` = `{"cases": [{"name": str, "op": <wire op>, "request_hash": str, "replay_hash": str}]}`. Each case hashes the one-op batch `[op]`; the envelope is not hashed.
- In the test module: `HASHED_FIELDS: dict[str, frozenset[str]]` (op kind → fields always in the strict hash), `DROPPED_WHEN_UNSET: dict[str, frozenset[str]]` (`update_text`: `page_title`; `delete`: `base_subtree_hash`), `REPLAY_EXCLUDED: dict[str, frozenset[str]]` (`update_text`: `base_text_hash`, `page_title`; `delete`: `base_subtree_hash`).

- [ ] **Cases.** For each `BlockOp` member, a `<kind>-minimal` case with every optional field unset. For each member with optional fields (`create`, `update_text`, `move`, `delete`, `set_heading`), a `<kind>-full` case with every one set. Two minimal ops are fixed: `update_text` is `{"uid": "uid_b1", "text": "golden"}` and `delete` is `{"uid": "uid_a"}`. Their hashes must equal the values `test_hintless_update_text_hash_is_unchanged_across_deploys` and `test_hashless_delete_keeps_its_pre_field_hash` already pin, which were recorded before those fields existed. If they differ, the fixture is wrong; stop and report.
- [ ] **Fill the hashes once** from the code at the branch base, with a throwaway script that is not committed and not named `*_dump.py` (`test_regen` would demand a regen step, and a pin that regenerates pins nothing).
- [ ] **`test_every_op_kind_has_pinned_hashes`:** unwrap `BlockOp` (`get_args` on the `Annotated`, then on the `Union`), read each member's `op` literal, and assert the set equals the set of minimal case kinds. Validate each case's op with `TypeAdapter(BlockOp)`, and assert both hashes of `_gold_batch([op])` equal the case.
- [ ] **`test_every_op_field_is_classified`:** for each member, `set(model_fields) == HASHED_FIELDS[kind] | DROPPED_WHEN_UNSET.get(kind, frozenset())`, and `REPLAY_EXCLUDED[kind] <= set(model_fields)`. The assertion message says what to do: a new field must be dropped while unset in `_canonical_op`, or the deploy re-hashes every stored op of that kind.
- [ ] **Teeth (not committed):** change `_canonical_op` to `op.model_dump(exclude_none=True)`, and the pin test fails on `update_text-minimal` and `delete-minimal`. Add a scratch optional field to `SetHeadingOp`, and both tests fail, naming `set_heading`. Revert both.
- [ ] **Done:** server gates green. Commit the fixture and the test together.

### Task 2: One read-transaction helper

**Implementer:** sonnet.

**Files:** `server/src/pkm/server/db.py`, `routes_sync.py`, `server/title_migration.py`, `server/src/pkm/assistant/target_reader.py`, `server/tests/test_write_txn.py`.

**Interfaces:** Produces `db.read_txn(db: Db) -> Iterator[None]` (`@contextmanager`): `db.execute("BEGIN")`, `yield`, `finally: db.rollback()`. The docstring says a multi-statement read takes one snapshot, so a write committed between statements cannot reach half of a payload; the body never writes.

- [ ] **Red scans** in `test_write_txn.py`, reusing its `_walk_same_scope` and helper-call matching:
  - `test_no_bare_begin_outside_db`: over `pkm/server/**` and `pkm/assistant/**`, a call whose string argument matches `^\s*BEGIN(\s+DEFERRED)?\s*$` (ignoring case) outside `pkm/server/db.py`. It fails today, naming `sync_changes`, `sync_snapshot`, `audit_title_migration` and `db_block_reader`. `importer/` is out of scope: its scripts write.
  - `test_a_read_txn_body_never_writes`: inside `with read_txn(...)`, no `.execute`, `.executemany`, `.commit` or `.rollback` call in the same scope. Give it flag and pass cases, as the write-lock scan has.
- [ ] **Behaviour tests:** `test_read_txn_ends_on_return_and_on_raise` (`db.in_transaction` is false after each, and a raise propagates); `test_read_txn_reads_one_snapshot` (a second connection commits between two `select`s inside the `with`, and the second still sees the old row).
- [ ] **Convert the four sites.** `target_reader` puts the `with` inside its existing `try … finally: db.close()` and keeps `from pkm.server.db import open_db`, which `test_reader_closes_its_connection` patches. `audit_title_migration` keeps its `in_transaction` check before the `with`. The route docstrings of `sync_changes` and `sync_snapshot` stay byte-identical (they feed OpenAPI).
- [ ] **Done:** server gates green. `test_sync_applied_batches.py` passes unmodified (it traces these statements).

### Task 3: One parent chain and one visited-path guard

**Implementer:** sonnet.

**Files:** `server/src/pkm/server/ops_apply.py`, `server/src/pkm/assistant/target_reader.py`, `server/tests/test_ops_apply.py`.

**Interfaces:**
- Produces `ops_apply.parent_chain(db: Db, uid: BlockUid) -> tuple[BlockUid, ...]` (renamed from `_parent_chain`, SQL unchanged). W14's `target_reader` work uses it.
- Produces `ops_apply._unvisited(path: str, uid: str) -> str`, returning exactly `f"instr({path}, ',' || {uid} || ',') = 0"`. Its comment says why it is exact: `UID_RE` admits no comma.

- [ ] **Red:** `test_the_visited_path_guard_is_written_once` greps `server/src/pkm/server/*.py` and `server/src/pkm/assistant/*.py` for `instr\(\w+\.path` and asserts one hit, in `_unvisited`. Today it finds six (five walks and `_ANCESTORS_SQL`).
- [ ] **Interpolate `_unvisited`** into `_block_with_depth`, `parent_chain`, `_subtree_with_height`, `subtree_rows` and `_conflict_header`. The rendered SQL must be byte-identical (Traps: query text).
- [ ] **`target_reader`:** delete `_ANCESTORS_SQL`; `ancestors = parent_chain(db, uid)[1:]`. Keep the module docstring's claim about `subtree_rows`, and add that the ancestors use the same walk as the server's cycle check.
- [ ] **Done:** server gates green; `test_target_reader.py` and `test_parent_chain_and_subtree_terminate_on_preexisting_cycle` pass unmodified, bar the import rename.

### Task 4: One `block_rewrites` writer

**Implementer:** sonnet.

**Files:** `server/src/pkm/server/store.py`, `ops_apply.py`, `server/tests/test_ops_apply.py`.

**Interfaces:** Produces `store.insert_block_rewrites(db: Db, uid: BlockUid, rows: Iterable[BlockRewrite], now_ms: int) -> None`: one `executemany` with `kind` from each row. It imports `BlockRewrite` from `pkm.server.ops_core`; Task 5 moves that import.

- [ ] **Red:** `test_block_rewrites_has_one_writer` greps `server/src` for `INTO block_rewrites` and asserts one hit, in `store.py`. It finds three today.
- [ ] **Convert** `_record_block_rewrite` (rows with `kind="retitle"`), `_record_delete_rewrite`, and `_execute`'s `RecordRewrite` branch. Build each row list in the order the old code inserted it (Traps: rowid order).
- [ ] **Done:** server gates green.

### Task 5: Move the replay engine to `replay_core.py` (pure move)

**Implementer:** sonnet (mechanical; one commit; no edits beyond imports and pointers).

**Files:** create `server/src/pkm/server/replay_core.py` (`# pattern: Functional Core`, a module docstring naming what it owns). Modify `ops_core.py`, `ops_apply.py`, `store.py` and `server/tooling/proptest/sync_server.py` (it imports `RewriteStep` and `StepKey`; `rewrite_effects` stays an `ops_core` import). In tests, update imports and qualified pointers in `test_ops_core.py`, `test_ops_apply.py`, `test_replay_batch_work.py`, `test_replay_step_titles.py`, `test_unlink_bounds.py` and `props/test_unlink_props.py`. Pointer comments only: `schema.py`, `props/model.py`, `perfcheck/backend.py`, `perfcheck/build.py`.

**Moves, verbatim:** `MAX_REPLAYED_REWRITES`, `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS`, `StepKey`, then `BlockRewrite` through `classify_text_edit` (including `TextEditOutcome` and `over_limit_landing_text`), then `unlink_stale_text`, `_rewrite_chain` and `stale_titles_linked`. `ops_core` imports what its contexts, `plan_op` and `rewrite_effects` use. `replay_core` imports nothing from `ops_core`.

- [ ] **Monkeypatch targets follow the code:** `ops_core.splice` becomes `replay_core.splice` (`test_replay_batch_work.py`), and `ops_core._derive` becomes `replay_core._derive` (`test_replay_step_titles.py`).
- [ ] **Loop counting follows the code:** add `replay_core` to the three `MODULES` tuples and to `test_ops_core.py`'s inline tuple. Before committing, print `loop_steps` for one test per file at the base and after the move; they must be equal (Traps: vacuous scaling tests).
- [ ] **Leave `server/tooling/perfcheck/fixture.py` byte-identical**, its stale pointer included (Traps: perf fixture hash).
- [ ] **Done:** server gates green. `git diff --no-ext-diff --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change HEAD~ -- server/src` shows only moved blocks and import or pointer lines. The brand sweep (`PYTHONPATH=server/tooling python3 -m commentlint.run --all` from the repo root) is clean.

### Task 6: Names, dead code and the patch-point comments

**Implementer:** sonnet.

**Files:** `ops_apply.py`, `ops_core.py`, `replay_core.py`, `store.py`, `ws.py`, `routes_ops.py`, `ops_hash.py`; tests `test_ws.py`, `test_origin_guard.py`, `test_blank_titles.py`, `test_ops_core.py`, `test_ops_apply.py`, `props/test_unlink_props.py`.

**Interfaces:** Produces `replay_core.replay(text: str, base_hash: Sha256Hex, rewrites: Sequence[BlockRewrite] | RewriteHistory, canonical: Callable[[str], str], known: Mapping[StepKey, str] | None = None, allowance: int | None = None) -> Replayed` and `replay_core.Replayed` (the renamed `_replay`/`_Replayed`). It also produces `ops_apply.BatchEffects` and `apply_batch(db, judged, now_ms) -> BatchEffects`, whose signature is otherwise unchanged (Traps: perf harness).

- [ ] **Replay public:** delete the tuple wrapper `replay_title_rewrites`, moving its docstring onto `replay`, and rename `_replay` → `replay`, `_Replayed` → `Replayed`. `canonical` has no default. Callers pass `normalize_title` explicitly and read `.text` and `.base_hash`. `replay_reproduces` in `test_unlink_props.py` keeps its name (W17's teeth match the frame).
- [ ] **Rename** `ops_apply.AppliedBatch` → `BatchEffects`.
- [ ] **Delete** `store.rewrite_referencing_blocks`, and fix the two comments in `test_blank_titles.py` to name `rewrite_snapshotted_blocks`. Delete `ws.Hub._conns`; the tests read `set(hub._clients)`.
- [ ] **Move** the orphaned UNTITLED comment under `_AddressedOp` into `_resolve_page`'s docstring, dropping "see module docstring above".
- [ ] **History comments to mechanism:** the `ws.py` module docstring (the "previous implementation" clause goes), `_stored_ack`'s "a row written before this change" (say "a row stored before `applied_batches` held the replay hash"), and `batch_replay_hash`'s "rows written after this change". The strict-hash path stays.
- [ ] **Patch-point comments:** at the call of `stale_titles` and of `rewrite_effects` in `apply_batch`, and of `find_op_text_limit_violation` in `judge_batch`, one line: `proptest/sync_server.py` (and, for the last, `props/test_teeth.py`) replaces it through this module global, so call it by its bare name.
- [ ] **Done:** server gates green; `git grep -n "replay_title_rewrites\|AppliedBatch\b\|_conns\|rewrite_referencing_blocks" -- server` shows only `contracts.responses.AppliedBatch`, its `routes_sync` use and `perfcheck/fixture.py`.

### Task 7: Name outcomes, not "check N"

**Implementer:** sonnet. Runs the web gates too.

**Files:** `ops_core.py`, `replay_core.py`, `conflict_notes.py`, `ops_apply.py`; tests `test_ops_core.py`, `test_ops_apply.py`, `test_perfcheck_backend.py`; `web/src/outline/baseTextHash.ts`, `web/src/props/sync/conflictNoise.ts`.

| Old | New |
|---|---|
| check 1 | `orphan_edit` |
| check 2 | `identical` |
| check 3 | hashless (`plan_op`'s `BlockContext` branch) |
| check 4 | `clean` |
| check 5 | `conflict` |

- [ ] Rename `test_check_2_identical_text_is_noop_even_with_stale_hash` → `test_identical_text_is_noop_even_with_stale_hash`, `test_check_3_absent_hash_applies_as_today` → `test_hashless_edit_applies_as_sent`, `test_check_4_…` → `test_clean_edit_applies_without_conflict`, and each `test_check_5_*` → `test_conflict_*`.
- [ ] `baseTextHash.ts`'s header points at `ops_core.plan_op`'s hashless branch, not `"check 3: legacy"`.
- [ ] **Leave** `web/src/props/ops/example.ts` and `ops/teeth.prop.ts` alone: their "check N" labels belong to the ops property, and the teeth match on them.
- [ ] **Done:** `git grep -nE "check [1-5]\b" -- server/src server/tests web/src/outline web/src/props/sync` is empty; server gates and web gates green.

### Task 8: One outcome per hashed edit, one debit point, one walk

**Implementer:** opus (context redesign and replay budget accounting).

**Files:** `replay_core.py`, `ops_core.py`, `ops_apply.py`; tests `test_ops_core.py`, `test_replay_step_titles.py`, `test_unlink_bounds.py`.

**Interfaces:**
- `TextEditOutcome(kind, text, replayed, canonical, known, reads, blind)`: no defaults; `compare=False` stays on the last five.
- `TextEditContext(block, outcome)`, `TextConflictContext(block, current_text, page_title, landing, outcome)`, `ReplayOverLimitContext(block, page_title, landing, outcome)`. Each conflict or over-limit field the outcome holds goes. `SkipContext(skip, ghost_page)` and `LandedSkipContext(skip, landing, hint_page, siblings, ghost_page)` lose their defaults.
- `HASHED_EDIT_CONTEXTS = (TextEditContext, TextConflictContext, ReplayOverLimitContext)`, spelled out for narrowing, as `SKIPPED_CONTEXTS` is.
- `class WalkStep(NamedTuple): base_hash: Sha256Hex; step: RewriteStep | None` and `RewriteHistory.walk(self, base_hash: Sha256Hex) -> Iterator[WalkStep]`. It yields each step, newest first and untaken, within `MAX_REPLAYED_REWRITES`. It ends with `WalkStep(h, None)` exactly when it reaches a hash `h` that `is_unread`, or that is not read; at a chain's end or at the bound it simply stops.
- `BatchReplay.charge(self, outcome: TextEditOutcome) -> None` and `BatchReplay._spend(self, cost: int) -> None`, the only assignment to `allowance` after construction.

- [ ] **Red, contexts:** the test helpers in `test_ops_core.py` (`_text_ctx`, `_skip_ctx`, the conflict test, the over-limit test) build contexts in the new shape through an `_outcome(kind, text, **fields)` helper that passes every field. Outcome comparisons become `(o.kind, o.text) == (…)`. The run fails with `TypeError`s until the dataclasses change.
- [ ] **Red, debit point:** `test_the_replay_allowance_falls_in_one_place` parses `ops_apply.py` and asserts every `Assign`/`AugAssign` to an attribute named `allowance` sits in `BatchReplay._spend`. It fails today: `_read` has two such assignments and `apply_batch` three.
- [ ] **Red, walk:** in `test_replay_step_titles.py`, three tests: `test_walk_yields_steps_newest_first_until_an_unread_hash`, `test_walk_ends_with_none_at_a_hash_too_costly`, and `test_walk_stops_at_the_bound_without_none` (a chain longer than `MAX_REPLAYED_REWRITES`, whose next hash is unread). Extend `test_a_walk_stops_blind_at_a_hash_too_costly_to_read` to walk too.
- [ ] **Implement.** `next_unread` and `replay` consume `walk`, and neither keeps its own `taken` set or loop bound. `plan_op` reads `ctx.outcome` and asserts `outcome.kind` fits the context (`identical`/`clean`, `conflict`, `over_limit`): a mismatch is an `AssertionError`, never an `OpError`. The over-limit landing still lands `op.text`. `apply_batch` charges once, right after `plan_op` and before the effects loop. For `rewrite_effects`, `replayed` and `known` come from the outcome except when it is `over_limit`, where they stay `()` and `{}` as today.
- [ ] **Allowance log diff** (Traps: replay debits) at this task's base and head: identical.
- [ ] **Done:** server gates green; every exact-charge test in `test_replay_batch_work.py` and `test_replay_step_titles.py` passes unmodified. The orchestrator then runs `proptest/check.sh server` and the perf checkpoint (Final gates).

### Task 9: One title reader per batch

**Implementer:** opus (threading, plus the query-count moves it causes).

**Files:** `ops_apply.py`, `replay_core.py`, `store.py`; tests `test_ops_apply.py`, `test_ops_concurrency.py`, `test_replay_step_titles.py`, `test_ops_core.py`.

**Interfaces:**
- `apply_batch` reads `canonical = title_reader(db)` once, first, and passes it on. The keyword-only `canonical` is required on `_context_for` and `_execute`; `_skip_context`, `_conflict_landing`, `_destination_siblings`, `_diverted_create_page`, `_existing_page_id`, `_resolve_page` and `_hint_page(db, page_title, canonical)` take it too.
- `store.get_or_create_page(db, title, now_ms, *, canonical: Callable[[str], CanonicalTitle] | None = None)`, `index_ref(..., *, canonical=None)` and `reindex_refs_for_text(..., *, canonical=None)`: None reads the flag as today. Store's own callers pass nothing.
- `BatchReplay` loses `reader` and `canonical()`. `RewriteStep.derived: tuple[Callable[[str], str], StepTitles] | None`; `_derived` asserts the held function `is` the one asked for.

- [ ] **Red:** `test_a_batch_reads_the_title_flag_once`, in `test_ops_apply.py`. Trace (`rawread.trace`) one batch holding: a top-level create on a new page whose text links two titles; a hashed `update_text` that conflicts (a daily-page landing); and an orphan `update_text` with a `page_title` hint. Count the statements that read `plain_space_title_canonicalization`: one. Today it counts several. Add `test_a_batch_that_resolves_no_title_reads_the_flag_once` (a `set_collapsed` batch: one, where today it reads none). It records the one expected rise.
- [ ] **Red:** `test_a_step_derives_under_one_canonicalisation`: derive a step under `normalize_title`, then ask under another function, and it raises `AssertionError`.
- [ ] **Implement.** Delete `_context_for`'s branch that picks `normalize_title` for an edit with no rewrite row: with no rows, nothing reads the canonicaliser. `rewrite_effects` gets the batch's `canonical` in place of `stale_canonical or replay_canonical`. The `is_stale` closure uses it.
- [ ] **Test patches follow signatures:** `test_ops_concurrency.py`'s `_hint_page` racer takes `(db, page_title, canonical)`, and `test_ops_apply.py`'s `recording_execute` forwards `**kwargs`.
- [ ] **Allowance log diff:** identical to Task 8's head.
- [ ] **Done:** server gates green; `test_each_step_derives_its_titles_once_per_batch` and the padded-spelling replay tests pass unmodified.

### Task 10: Budget tests assert behaviour, not the charge formula

**Implementer:** opus (replay budget accounting). Last code task: the exact sums guard Tasks 5, 8 and 9.

**Files:** `server/tests/test_replay_batch_work.py`, `server/tests/test_replay_step_titles.py`.

- [ ] Each assertion that restates a charge as a sum (`… == (text, len(text) + … + ROW_CHARS + …)`) becomes two facts. The step is charged at least the text it scanned plus the text it built, and never more than an allowance it was given. Where a test pairs "fits at its own cost" with "stops one below it", keep the pair: that pins self-consistency, not the formula.
- [ ] Keep unchanged: every `loop_steps` comparison (`large < 2 * small` and the like), every `skipped.count("text_limit")`, `test_a_batch_reads_a_hashs_rows_once_however_many_ops_record`, and `test_each_step_derives_its_titles_once_per_batch`.
- [ ] **Teeth (not committed):** in `replay_core._charged`, drop the row charge (`cost += …chars`), and `test_the_rows_a_batch_records_for_its_replays_fit_its_budget` still fails. Revert.
- [ ] **Done:** server gates green; `git grep -n "ROW_CHARS +" -- server/tests/test_replay_*.py` lists no exact-sum assertion.

### Task 11: Docs say what W12 made true

**Implementer:** opus (the Planning bullets keep invariants and drop restated mechanism). Invoke `architecture-docs`.

**Files:** `docs/architecture/backend.md`.

- [ ] **Module map:** add `replay_core.py  Core  the rewrite replay: walk, steps, budget charges, classify_text_edit`. `ops_core.py` becomes "judges, skips, contexts, effects, plan_op". A note says `pkm/planning.py` is the client's batch builder, not this.
- [ ] **§ Planning:** "Some have defaults…" becomes: no context field has a default, and the outcome rides whole. Under the default for Question 3, the heading stays, with one sentence saying it means `plan_op`. In the Replayed text and Replay budget bullets, keep the invariants and their reasons:
  - a replay never answers 400;
  - server-made text passes a limit only by the stated backticks;
  - one budget per batch bounds all history-derived work, and an edit past it lands `over_limit`;
  - the uncharged costs, and why each exists;
  - the batch reads the title flag once.

  Replace restated mechanism with links to the `replay_core` symbols. `ops_core.<moved>` pointers become `replay_core.<moved>`, and `_rewrites_within`, `BatchReplay` and `charge` are named where the budget falls.
- [ ] **§ Conflicts:** the case table's `ops_core.replay_title_rewrites` becomes `replay_core.replay`.
- [ ] **§ Schema:** the `block_rewrites` writer cell names `store.insert_block_rewrites` and its three callers.
- [ ] **§ Breadcrumbs and recursive traversal:** the walks table names `ops_apply.parent_chain` (also the assistant card's ancestors), and the paragraph names `_unvisited` as the one place the guard is spelled.
- [ ] **§ The write lock:** one sentence: a multi-statement read takes one snapshot through `db.read_txn`, and its body never writes.
- [ ] **Idempotency bullet and generated-artifacts table:** a row for `op_hashes.json` (hand-edited | `test_ops_idempotency.py` | `batch_request_hash` and `batch_replay_hash` for every op kind, and which fields each leaves out).
- [ ] **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `git grep -n "ops_core\.\(_replay\|_derive\|_step\|_charged\|_spent\|replay_title\|ROW_CHARS\|MAX_BATCH\|classify_text_edit\|over_limit_landing\)" -- docs/architecture` is empty.

## Order and parallel lanes

```
Lane H (hash pins):   T1                                   first; touches nothing else
Lane R (read path):   T2 -> T3                             target_reader.py in both
Lane W (write path):  T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10   serial
T3 merges before T8 starts; T11 after everything.
```

Lanes H, R and W can start together in separate worktrees. T3 and T4 to T7 edit different hunks of `ops_apply.py` and `test_ops_apply.py`; rebase onto the branch before merging.

| File | Tasks | Rule |
|---|---|---|
| `ops_apply.py` | T3 (walks), T4 (`_execute`), T5 (imports), T6, T7, T8, T9 | T8 and T9 start from a branch with T3 merged |
| `ops_core.py`, `replay_core.py` | T5, T6, T7, T8, T9 | serial; T5's move is alone in its commit |
| `assistant/target_reader.py` | T2, T3 | T2 first |
| `store.py` | T4, T5 (import), T6, T9 | serial in lane W |
| `test_ops_core.py` | T5, T6, T7, T8, T9 | serial |
| `test_replay_*.py` | T5, T8, T9, T10 | T10 last |
| `test_ops_apply.py` | T3, T4, T5, T6, T9 | distinct tests; rebase |
| `docs/architecture/backend.md` | T11 only | |

Other branches: W13 also edits `store.py` and `server/title_migration.py`, and W14 edits `assistant/target_reader.py`. Per the epic W12 merges first; whichever merges second rebases.

## Traps

- **Op hashes.** A change to what `_canonical_op` or `_canonical_replay_op` hashes, or to how a field serialises, breaks the hash of every stored batch of that kind. A retry after the deploy then 409s, and the client poisons a batch the server holds. *Detect:* Task 1's pins, which must pass unmodified in every later task; a diff that touches `op_hashes.json` after Task 1 is a stop-and-report. No W12 task edits `ops_hash.py` beyond Task 6's docstring.
- **Replay debits.** The exact-charge tests are what catch a debit that moved, so loosening them first (Task 10) would hide a change Task 8 or 9 made. Charging after the effects loop, rather than right after `plan_op`, changes what `BatchReplay.recorded` may spend. *Detect:* keep Task 10 last. And diff an allowance log: a scratch, uncommitted conftest fixture patches `ops_apply.BatchReplay` with a subclass whose `__setattr__` appends each new `allowance` value, tagged with the test id, to a JSONL file. Run `test_replay_batch_work.py`, `test_replay_step_titles.py`, `test_ops_apply.py`, `test_ops_endpoint.py`, `test_text_limits_ops.py` and `test_stale_page_ops.py` with `--no-cov` at the task's base and head, collapse repeated values, and diff. They must be identical.
- **Vacuous scaling tests.** `loop_steps` counts jumps in the named modules' files only. After Task 5, replay loops run in `replay_core.py`, and a `MODULES` tuple without it no longer sees the replay's own work, so a scaling comparison can pass while that work grows. *Detect:* the before/after print in Task 5.
- **Patch points.** W17's teeth patch `pkm.server.ops_core.find_op_text_limit_violation`. The property sync server swaps `ops_apply.stale_titles`, `ops_apply.rewrite_effects` and `ops_core.find_op_text_limit_violation` through module globals. Unit tests patch `ops_apply._context_for`, `_hint_page`, `_execute`, `_rewrites_within`, `_page_title`, `MAX_BATCH_REPLAY_WORK`, `routes_ops.apply_batch`, `replay_core.splice` and `replay_core._derive`. Each works only while the caller looks the name up in that module at call time. `MAX_BATCH_REPLAY_WORK` must stay an `ops_apply` global read inside `apply_batch`, never a dataclass default. A patch on a name that no longer exists raises; a patch on a name the caller stopped using passes silently. *Detect:* `test_proptest_sync_server.py`'s teeth tests (stale, rewrites, limits) in `pytest -q`; W17's `test_teeth.py` under `proptest/check.sh server`; and for each unit patch, the test fails when the patch is removed.
- **Signature patches.** `test_ops_concurrency.py`'s racers and `test_ops_apply.py`'s `recording_execute` mirror the patched function's signature. A new positional parameter breaks them with a `TypeError` inside the route, which shows as a 500. *Detect:* the run; keep new parameters keyword-only where the racer forwards `**kwargs`.
- **Query counts.** Tasks 2 to 8 must leave every count unchanged. `read_txn` issues the same `BEGIN`. `insert_block_rewrites` keeps one `executemany`. `_unvisited` renders identical SQL, which matters because the perf check's plan analysis reads the text. Task 9 moves only `ops/*` scenarios: +1 statement (the flag read) for a batch that resolved no title (`ops/edit-1`, `ops/edit-hashed-identical`), and fewer for batches that resolved pages, indexed links or landed on the daily page (`ops/paste-50`, `ops/edit-hashed-conflict`, `ops/create-missing-parent`). `rename/hub`, `page/*`, `sync/*` and every read scenario must not move. Neither may VM work beyond those statements, nor any full-scan count. *Detect:* `perf/check.sh backend` at the checkpoint after T8 (expect no change) and at the end. A move outside that list is a regression to investigate before any `--bootstrap`.
- **Perf fixture hash.** `perfcheck/fixture.py`'s bytes are the baseline's `fixture_hash`: editing it, even a comment, makes every baseline incomparable and calls for `--rebaseline`. *Detect:* `git diff --stat main -- server/tooling/perfcheck/fixture.py` is empty at the end. Its one stale pointer waits for the next change that edits that file anyway.
- **Perf harness imports.** A merge-base run imports this branch's harness with the base's `pkm`, so `perfcheck/build.py` must keep importing only names both have (`apply_batch`, `ops_core.judge_batch`, `JudgedBatch`, `rename_page_rows`, `title_reader`). Keep `apply_batch(db, judged, now_ms)`.
- **Rowid order.** Replay reads a hash's rows newest first by rowid, and an older row's copy of a key wins. `insert_block_rewrites` must insert each list in the order the old code did: no `set`, no `sorted` added. *Detect:* the rename, delete and replay suites; for certainty, dump `SELECT rowid, * FROM block_rewrites ORDER BY rowid` after `test_ops_endpoint.py`'s rename and delete flows, before and after.
- **Defaults and pyrefly.** A frozen dataclass field without a default cannot follow one with a default. Remove them all in one change, or pyrefly and the import fail. `field(compare=False)` stays where equality ignored the field. *Detect:* pyrefly, which went from 0 to 65 errors in the scratch edit, all in `test_ops_core.py`.
- **One canonicaliser per step.** `derived` becomes one slot guarded by an assert. A test that derives one step under two functions trips it; give that test one function, never weaken the assert. *Detect:* the run.
- **Generated artifacts.** No W12 task changes a route, query param, response model or route docstring. An edit to `post_ops`', `sync_changes`' or `sync_snapshot`'s docstring stales `web/src/api/openapi.json`. *Detect:* `test_openapi_sync.py`; regenerate with `uv run python -m pkm.regen`. The Task 1 fixture is hand-edited and must never become a regen step.
- **Coverage.** `--cov-fail-under` is enforced over `pkm`. The moves are neutral and the deletions remove little-covered code. *Detect:* `uv run pytest -q`'s last line.
- **FCIS and brand rules.** `replay_core.py` declares `# pattern: Functional Core` and imports no shell module (not `store`, `db`, `sync_meta` or `ops_apply`). It mints no brand outside the registry: `OrderIdx(...)` calls stay in `ops_core`, a registered mint site. *Detect:* the brand sweep and `test_brandlint_*.py` inside `pytest -q`.
- **Comment lint.** Moved and renamed comments are re-judged whole. Wrap to 80 columns, and give no plan or bean pointers. *Detect:* the pre-commit hook and `test_the_tracked_tree_is_clean`.

## Final gates

| Gate | Who |
|---|---|
| Server gates after every commit | each implementer |
| Web gates | Task 7's implementer |
| Allowance log diff | Tasks 8 and 9's implementers |
| `uv run pytest -q`, pyrefly, ruff on the merged branch | orchestrator, after each merge |
| `proptest/check.sh server` | orchestrator, after T8 merges |
| `perf/check.sh backend` checkpoint (expect no count change) | orchestrator, after T8 merges, on a quiet machine |
| `perf/check.sh backend` final; `--bootstrap` with the Task 9 reason only after reading each moved scenario against the Traps list | orchestrator, after T10 |
| `proptest/check.sh` both sides (server, then web; the web sync suite drives this server) | orchestrator, serially, at the end, once port 8978 is free |
| `node .claude/skills/architecture-docs/check-docs.mjs` | Task 11's implementer |

## Questions for Arthur

1. **One title reader per batch, read eagerly or lazily?** Eagerly adds one indexed `sync_meta` read to every batch that resolves no title, which includes most typing batches; a lazy reader reads only on first use, at the cost of keeping a laziness mechanism. *Recommendation and default:* eager, as W12 decided. It is the simplest, and the read happens inside a transaction that already holds the lock.
2. **How far does the reader thread?** Through the ops path only, or also through store's rename, merge and page-delete reindexing, which re-read the flag per link? *Recommendation and default:* ops path only. That keeps every perf move inside `ops/*` scenarios, where Task 9 can explain it; the store paths are a follow-up bean.
3. **Keep the `#planning` anchor?** W12 renames the heading to "plan_op"; 24 lines in seven docs link the anchor, and W18 restructures the section anyway. *Recommendation and default:* keep the heading and add one sentence plus a module-map note naming `plan_op` and setting it apart from `pkm/planning.py`.
4. **Pin the web worker's fill set to the replay-hash exclusions?** Today only comments on both sides hold that agreement. Pinning it needs `replica/queue.ts` to export the fields it fills, and a web test against `op_hashes.json`. *Recommendation and default:* a follow-up bean, not W12, which stays server-side bar comments.
