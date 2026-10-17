# Brand Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Names that mean a brand must carry it, brands are minted only at
declared sites, and rows from our own databases arrive already branded, on
server and web, with no allow-list.

**Architecture:** One pure-data registry (`server/src/pkm/brand_registry.py`)
and one row vocabulary (`server/src/pkm/rows.py`) are the single source of
truth. The server reads rows only through a typed `Db` wrapper
(`server/src/pkm/database.py`); the web reads them through a column-named
`ReplicaDb.select`. A stdlib AST lint (`server/tooling/brandlint`) and a
local type-aware ESLint plugin (`web/tooling/eslint-plugin-brands`) enforce
the name and mint rules; both read the same registry (the web via a
generated JSON).

**Tech Stack:** Python 3 / FastAPI / sqlite3 / pydantic / pyrefly / ruff;
TypeScript / sqlite-wasm / ESLint flat config with typescript-eslint /
vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-brand-check-design.md`. Read
it first; this plan argues from it and does not repeat its reasoning.

## Global Constraints

- No allow-list or baseline file of existing violations, anywhere. Every
  existing violation is fixed.
- Tests are exempt from rules 1 and 2: `server/tests/**`, `*.test.*`, and
  the test-support files listed in `brand_registry.TEST_SUPPORT`
  (initially `web/src/test-helpers.ts`, `web/src/props/`,
  `web/src/replica/replayArbs.ts`, `web/src/sync/memReplica.ts`).
- `title` is not a rule-1 name (follow-up pkm-hc95). Columns named `title`
  still have a typed key in the row vocabulary.
- The wire contracts (pydantic models, FastAPI params) are declared mints;
  no shape validators are added; what the server accepts does not change.
- The runtime row check runs in every test suite (pytest, the e2e server,
  the proptest server, vitest) and never in production.
- `brandlint` is stdlib only and runs under the system `python3` (the
  pre-commit hook must not need a synced venv), like `commentlint`.
- Every rule failure message names the fix (the helper or the read path to
  use), not only what is wrong.
- AGENTS.md rules apply: FCIS header on every new runtime file; comments at
  most 80 columns, code at most 120; no bean ids, line numbers or
  pathless spec pointers in comments; commit messages carry no session URL.
- Server phase (Tasks 1-9) is reviewed and merged to `main` before the web
  phase (Tasks 10-14) starts on a fresh branch from the merge.

## Review Focus

1. **NULL where a key says non-null**: `MAX(seq)` over an empty table, a
   `LEFT JOIN` with no match, an aggregate with no rows. Expected: the query
   uses `COALESCE` or a nullable alias key; the test-time check raises if
   not. Pinned in Task 3 (`test_seq_frame_on_empty_journal`) and Task 4
   (`test_backlinks_left_join_missing_page`).
2. **Transaction semantics through `Db`**: `routes_ops`'s `BEGIN IMMEDIATE`
   dedupe, rollback on `OpError`, and `isolation_level` left as sqlite3's
   default. Expected: unchanged behaviour. Pinned in Task 2
   (`test_db_preserves_isolation_level`, `test_begin_immediate_blocks_second_writer`).
3. **Integer columns the payload exposes as booleans** (`collapsed`):
   expected to serialise exactly as before. Pinned in Task 3
   (`test_tree_collapsed_is_bool`).
4. **Read-only snapshots via URI** (`mode=ro&immutable=1` in backup, export
   and perf): expected to open through `Db` and refuse writes. Pinned in
   Task 2 (`test_read_only_db_refuses_write`).
5. **A wire contract field renamed or retyped by the rename to brands**:
   expected: field names never change, only their annotations; the
   regenerated `openapi.json` differs only by `x-brand` markers and
   `response_model` shapes that were already declared. Pinned in Task 4
   (`test_openapi_diff_is_brand_markers_only`: compare the regenerated
   schema with `x-brand` keys stripped against `main`'s committed one).

---

## Phase 1: server (branch `feat/brand-check`)

### Task 1: Registry and row vocabulary

**Files:**
- Create: `server/src/pkm/brand_registry.py` (data only: no imports, so
  `brandlint` can load it under system `python3`)
- Create: `server/src/pkm/rows.py` (`# pattern: Functional Core`)
- Modify: `server/src/pkm/schema.py` (`SchemaRow` becomes an alias of
  `rows.Row`, then is removed in Task 6)
- Modify: `server/src/pkm/contracts/ops.py`, `contracts/responses.py`
  (new brand `SidebarOrderIdx`, `SyncSidebarEntry.order_idx:
  SidebarOrderIdx`)
- Test: `server/tests/test_rows_vocabulary.py`, `server/tests/test_rows_check.py`

**Interfaces:**
- Produces, in `brand_registry.py` (plain literals):
  - `NAMES: dict[str, tuple[str, ...]]`: parameter/field name -> the brands
    any one of which it must carry. Seed it from the spec plus a survey of
    `server/src` and `web/src` for brand-meaning names; at least:
    `uid, parent_uid, block_uid, src_block_uid, target_block_uid,
    target_uid, uids, block_uids -> BlockUid`; `page_id, target_page_id,
    src_page_id, page_ids -> PageId`; `order_idx -> OrderIdx,
    SidebarOrderIdx`; `seq, seen_seq -> SyncSeq`; `sidebar_entry_id ->
    SidebarEntryId`; `client_id -> ClientId`; `batch_id -> BatchId`;
    `goodlinks_id -> GoodlinksId`; `conversation_id -> ConversationId`;
    `confirm_id -> ConfirmId`; the `sha256`-style names -> `Sha256Hex`.
    Web-only brands (`PendingRowId`, `TicketId`, `RequestId`, `Revision`)
    get their names too. camelCase is derived, never listed.
  - `MINT_SITES: dict[str, tuple[str, ...]]`: brand -> repo-relative files
    or directory prefixes (ending `/`) allowed to construct or cast to it.
    Every brand's declaring file is implicitly included. `server/src/pkm/
    contracts/` is a mint site for every server brand.
  - `CAST_SITES: tuple[str, ...]`: server files where `typing.cast` is
    allowed (`server/src/pkm/database.py` plus today's four uses if they
    survive review; each with its reason as a comment in the registry).
  - `TEST_SUPPORT: tuple[str, ...]`, `OPT_OUT_FILES: tuple[str, ...]`
    (glob patterns: `server/src/pkm/**/routes_*.py`,
    `server/src/pkm/**/routes.py`, web boundary files added in Task 13).
  - `COLUMN_KEYS: dict[str, dict[str, str]]`: table -> {column: key} for
    every column that does not read under its own name (every `id`,
    `sidebar_entries.order_idx -> sidebar_order_idx`, nullable
    `changes.page_id`, NOT NULL `block_rewrites.created_at`,
    `replay_log.key`, `sync_meta.key`, and whatever else Step 1 surfaces).
  - `SHAPES: dict[str, tuple[str, str | None]]`: brand -> (`"text"` or
    `"int"`, full-match regex or None). `BlockUid -> ("text",
    "[a-zA-Z0-9_-]{6,32}")`, `Sha256Hex -> ("text", "[0-9a-f]{64}")`, id/
    index/seq brands -> `("int", None)`, other text brands -> `("text",
    None)`.
  - `CLIENT_KEYS: dict[str, tuple[str, bool]]`: web-only keys for the
    client-only tables -> (TS type name, nullable).
  - `FTS_SHADOW_SUFFIXES = ("_data", "_idx", "_config", "_docsize", "_content")`.
- Produces, in `rows.py`:
  - `class Row(TypedDict, total=False)`: one key per name any server query
    returns, typed with its brand or plain type (`uid: BlockUid`,
    `parent_uid: BlockUid | None`, `page_id: PageId`, `n: int`, ...).
  - `def row_problems(row: Mapping[str, object]) -> list[str]`: one message
    per column whose name is not a `Row` key, or whose value does not fit
    the key's type (`None` for a non-nullable key; wrong base type; a brand
    value failing `SHAPES`). `bool` never counts as `int`.

- [ ] **Step 1: Write the failing vocabulary test**

`test_rows_vocabulary.py::test_every_column_has_a_key`: build an in-memory
DB from `schema.DDL` (BASE + SERVER), and for every table from
`sqlite_master` (skipping FTS shadow tables by `FTS_SHADOW_SUFFIXES`), for
every `PRAGMA table_info` column, resolve its key (`COLUMN_KEYS` override,
else the column name) and assert the key is in `Row`'s annotations.
`test_key_types_match_the_ddl`: the key's base type matches the column's
declared type (`TEXT` -> str-based, `INTEGER` -> int-based) and it is
nullable exactly when the column is (`notnull == 0` and not a primary key).
`test_names_point_at_declared_brands`: every brand in `NAMES`,
`MINT_SITES` and `SHAPES` is declared somewhere (a server `NewType` or a
web brand listed in `CLIENT_KEYS`/a web-only set the registry names).

- [ ] **Step 2: Run, expect FAIL** (`cd server && uv run pytest
  tests/test_rows_vocabulary.py -q`: module not found)

- [ ] **Step 3: Write the failing row-check tests**

`test_rows_check.py`: `row_problems({"uid": "abcdef"}) == []`;
`row_problems({"uid": "a"})` names `uid` and `BlockUid`;
`row_problems({"page_id": None})` reports non-null; `row_problems(
{"parent_uid": None}) == []`; `row_problems({"page_id": True})` reports
the bool; `row_problems({"nope": 1})` reports an unregistered column;
`row_problems({"text": 3})` reports a base-type mismatch.

- [ ] **Step 4: Implement `brand_registry.py`, `rows.py`, the
  `SidebarOrderIdx` brand (`brand(SidebarOrderIdx)`, int, x-brand), and
  `schema.SchemaRow = Row`**

`row_problems` resolves `Row`'s hints once at import (`get_type_hints`),
unwraps `X | None`, follows a `NewType` to its base and brand name, and
applies `SHAPES` for brands.

- [ ] **Step 5: Run Task 1 tests, pyrefly, ruff; expect PASS.** Regenerate
  `openapi.json` and `web/src/api/types.d.ts` per the generated artifacts
  table in `docs/architecture/backend.md` (the new x-brand), add
  `SidebarOrderIdx` to `web/src/api/brands.ts`, run `cd web && pnpm
  typecheck`.

- [ ] **Step 6: Commit** `feat(pkm-zv2s): brand registry and row vocabulary`

### Task 2: The `Db` wrapper, everywhere

**Files:**
- Create: `server/src/pkm/database.py` (`# pattern: Imperative Shell`)
- Modify: `server/src/pkm/server/db.py` (`open_db`, `get_db`, `init_db`,
  migrations use `Db`), every `sqlite3.connect` site
  (`importer/run.py`, `importer/import_sidebar.py`,
  `importer/migrate_mermaid_blocks.py`, `backup/__main__.py`), and every
  `sqlite3.Connection` annotation in `server/src` (129 mentions, 23 files)
- Modify: `server/tests/conftest.py`, `server/tests/e2e_serve.py`,
  `server/tooling/proptest/sync_server.py`, `server/tooling/perfcheck/*`
  (callers of `open_db`; set `PKM_ROW_CHECK=1` in the three test servers)
- Test: `server/tests/test_database.py`

**Interfaces:**
- Consumes: `rows.Row`, `rows.row_problems`.
- Produces, in `database.py`:
  - `class RowCheckError(AssertionError)`
  - `class WriteResult(NamedTuple): rowcount: int; lastrowid: int | None`
  - `class Db`, constructed `Db(con: sqlite3.Connection, *, check_rows:
    bool)`:
    - `select(sql: str, params: Sequence[object] | Mapping[str, object] =
      ()) -> list[Row]`; `select_one(...) -> Row | None`. Rows are new
      dicts keyed by `cursor.description` names. With `check_rows`, each
      row's `row_problems` non-empty raises `RowCheckError` naming the SQL.
    - `execute(sql, params=()) -> sqlite3.Cursor` **for this task only**
      (compatibility while reads migrate; Task 6 narrows it to
      `WriteResult`).
    - `executemany(sql, seq) -> WriteResult`, `executescript(sql) -> None`,
      `commit()`, `rollback()`, `close()`, `in_transaction: bool`,
      `begin_immediate() -> None`, `table_columns(table: str) -> set[str]`
      (wraps `PRAGMA table_info` for migrations), `backup_to(path: Path)
      -> None` (the sqlite backup API; the destination is the one raw
      connection that never becomes a `Db`).
    - `raw: sqlite3.Connection` property: for tests and tooling only;
      Task 8's lint bans it in `server/src` outside `database.py`.
  - `def connect(path: Path | str, *, read_only: bool = False, uri: bool =
    False, check_same_thread: bool = True) -> Db`: sets
    `row_factory = None` on the raw connection (rows are converted in
    `select`), leaves `isolation_level` at sqlite3's default, and reads
    `check_rows` from `os.environ.get("PKM_ROW_CHECK") == "1"`.
- Changes: `open_db(path) -> Db`; `get_db(request) -> Iterator[Db]`.

- [ ] **Step 1: Write the failing tests** in `test_database.py`:
  `test_select_returns_dicts_keyed_by_column`, `test_select_one_none_when_empty`,
  `test_row_check_raises_on_unregistered_alias` (`SELECT text AS uid` on a
  row whose text is `"hello world"` raises `RowCheckError`),
  `test_row_check_off_without_env`, `test_db_preserves_isolation_level`
  (`db.raw.isolation_level == ""`), `test_begin_immediate_blocks_second_writer`
  (second `Db` on the same file times out acquiring `BEGIN IMMEDIATE`
  while the first holds it, with a short `busy_timeout`),
  `test_read_only_db_refuses_write` (`connect(..., read_only=True)` then a
  write raises `sqlite3.OperationalError`), `test_table_columns`,
  `test_backup_to_copies`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `database.py`.**
- [ ] **Step 4: Flip every caller**: `open_db`/`get_db`/`init_db` return or
  use `Db`; every `sqlite3.connect` site goes through `connect`; replace
  every `sqlite3.Connection` annotation in `server/src` with `Db`. Tests
  that open their own `sqlite3.connect` and pass it to product code wrap it
  as `Db(con, check_rows=True)`; tests reading raw rows keep using the
  cursor `execute` returns for now.
- [ ] **Step 5: Run the full server gates**: `cd server && uv run pytest
  -q` (all pass, coverage >= 95%), `uv run pyrefly check` (0 errors), `uv
  run ruff check` (clean). Fix every row-check failure the flip exposes by
  fixing the query or the test data, never by relaxing `row_problems`.
- [ ] **Step 6: Commit** `feat(pkm-zv2s): every connection is a Db`

### Task 3: Server core reads through `select`

**Files:**
- Modify: `server/src/pkm/server/{ops_apply,ops_core,tree,grouping,store,
  title_migration,notify,query}.py` and every other non-route module under
  `server/src/pkm/server/` that reads rows
- Test: the existing tests for each module, plus the new ones below

**Interfaces:**
- Consumes: `Db.select`, `Db.select_one`, `rows.Row`.
- Produces: `tree.TreeNode` and the `grouping` TypedDicts typed with the
  brands (`uid: BlockUid`, `order_idx: OrderIdx`, `view_type: ViewType |
  None`, `heading: StoredHeading`), matching `contracts.BlockNode`.
  `grouping.GroupItem` is renamed `GroupedBlock` (it collided with
  `contracts.responses.GroupItem`).

- [ ] **Step 1: Write the failing tests**:
  `test_notify.py::test_seq_frame_on_empty_journal` (fresh DB, `seq_frame`
  returns seq 0 with the row check on),
  `test_tree.py::test_tree_collapsed_is_bool` (a collapsed block's
  `TreeNode["collapsed"] is True`).
- [ ] **Step 2: Run, expect FAIL or PASS-for-the-wrong-reason**; if the
  empty-journal test passes already, keep it as a guard and note it.
- [ ] **Step 3: Move every read in these modules to `select`/`select_one`**:
  positional reads become named aliases (`SELECT COALESCE(MAX(seq), 0) AS
  seq`), bare `id` becomes its key, tuple-unpacking loops become key reads,
  and every `BlockUid(row[...])`-style row mint is deleted.
- [ ] **Step 4: Run the server gates (pytest, pyrefly, ruff); expect PASS.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): server core reads branded rows`

### Task 4: Routes read through `select` and return their models

**Files:**
- Modify: `server/src/pkm/server/routes_*.py`, `server/src/pkm/assistant/routes.py`,
  `server/src/pkm/describe/routes.py`, `server/src/pkm/server/auth.py`, the
  `healthz` handler, `server/src/pkm/contracts/responses.py` (new models for
  handlers that have none)
- Modify: `web/src/api/openapi.json`, `web/src/api/types.d.ts` (regenerated)
- Test: `server/tests/test_routes_models.py`, plus existing route tests

**Interfaces:**
- Consumes: Task 3's branded `TreeNode`/grouping types.
- Produces: every JSON handler annotated with and returning its
  `response_model` (18 with a model today, plus `routes_sidebar` x3,
  `routes_assets`, `routes_sync.client_diagnostics`, `auth.py`,
  `healthz`, each given one). Non-JSON handlers keep their response type.

- [ ] **Step 1: Write the failing tests**:
  `test_routes_models.py::test_no_handler_returns_a_bare_dict` (walk
  `app.routes`; for every `APIRoute`, the endpoint's return annotation is
  not `dict[str, object]`/`dict`), `test_backlinks_left_join_missing_page`
  (a ref whose target page row is gone is handled with the row check on),
  `test_openapi_diff_is_brand_markers_only` (regenerate the schema; with
  every `x-brand` key stripped, it equals `main`'s committed one stripped
  the same way, except the components added for previously model-less
  handlers, listed by name in the test).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Move every route read to `select`, construct the models,
  give model-less handlers a model.**
- [ ] **Step 4: Regenerate `openapi.json` and `types.d.ts`; run server
  gates and `cd web && pnpm typecheck && pnpm test:unit`; expect PASS.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): routes read branded rows and return their models`

### Task 5: Reads outside `pkm/server`

**Files:**
- Modify: every module in `server/src/pkm/` outside `server/` that reads
  rows: importer, backup, export, describe, assistant, goodlinks, cli/mcp,
  rename, planning, and `server/db.py`'s own migrations (via
  `Db.table_columns` and `select`)
- Test: existing tests, plus
  `test_backup.py::test_export_reads_snapshot_through_read_only_db`

- [ ] **Step 1: Write the failing test** above (export of a snapshot
  opened `mode=ro&immutable=1` produces the same graph as before).
- [ ] **Step 2: Run, expect FAIL** (or PASS-as-guard; note which).
- [ ] **Step 3: Move every remaining read to `select`.** After this task,
  `grep -rnE "\.fetch(one|all|many)\(|for .* in .*\.execute\(" server/src`
  matches nothing outside `database.py`.
- [ ] **Step 4: Run the server gates; expect PASS. Run the grep; expect no
  matches.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): importer, backup and clients read branded rows`

### Task 6: Narrow `Db.execute`

**Files:**
- Modify: `server/src/pkm/database.py`, `server/src/pkm/schema.py`
  (delete `SchemaRow`; callers use `rows.Row`), any stragglers pyrefly
  reports, and `server/tests/**` reads that used the cursor (`db.raw.
  execute(...)` or `select`)

- [ ] **Step 1: Write the failing test**
  `test_database.py::test_execute_returns_write_result` (`execute` returns a
  `WriteResult`, with `rowcount` and `lastrowid` set for an INSERT).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: `Db.execute(sql, params=()) -> WriteResult`; delete
  `SchemaRow`; fix what pyrefly and the tests report.**
- [ ] **Step 4: Run the server gates; expect PASS.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): Db.execute is write-only`

### Task 7: Rule 1 on the server (names carry their brand)

**Files:**
- Create: `server/tooling/brandlint/__init__.py`, `brandlint/registry.py`
  (loads `server/src/pkm/brand_registry.py` by path with `importlib.util`;
  stdlib only), `brandlint/core.py` (`# pattern: Functional Core`)
- Modify: `server/tooling/commentlint/run.py` (collect `brandlint`
  violations too), `commentlint/core.py` (`format_report` takes the remedies
  of whichever rule families fired; header names both), `.githooks/pre-commit`
  (header comment lists the new rules)
- Modify: every rule-1 violation in `server/src` (about 70: `uid: str`,
  `page_id: int`, `order_idx: int`, ...)
- Test: `server/tests/test_brandlint_names.py`

**Interfaces:**
- Consumes: `brand_registry.NAMES`, `OPT_OUT_FILES`.
- Produces: `brandlint.core.check_text(path: str, text: str, registry:
  Registry) -> list[commentlint.core.Violation]` with rule ids
  `brand-name` and `brand-opt-out`; `brandlint.core.RULES: dict[str, str]`
  (remedy per rule id, naming the fix: "`<name>` must be `<Brand>`: read
  it from a `select()` row, take it from a contract model, or parse it with
  the brand's parser; untrusted route input may carry `# brand: untrusted
  -- <reason>`"). Scope: `server/src/**/*.py`.

- [ ] **Step 1: Write the failing tests** (`check_text` on literal
  sources): `def f(uid: str)` -> `brand-name`; `def f(uid: BlockUid)`,
  `uid: BlockUid | None`, `uids: list[BlockUid]`, `"BlockUid"` string
  annotation -> clean; a TypedDict/dataclass/BaseModel field `page_id: int`
  -> `brand-name`; keyword-only and `*`-args parameters are checked;
  `order_idx: SidebarOrderIdx` -> clean (either brand allowed); `title:
  str` -> clean; `# brand: untrusted -- comma-separated query param` on a
  `uids: str` parameter in `routes_pages.py` -> clean, the same in
  `ops_core.py` -> `brand-opt-out`, and with no reason -> `brand-opt-out`;
  a test file path -> no violations. `test_commentlint_run.py`'s tree test
  keeps passing.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `brandlint`** (AST: `FunctionDef`/`AsyncFunctionDef`
  args, class-body `AnnAssign`; an annotation passes when any `Name`/
  `Attribute` in it, or in a parsed string annotation, is one of the
  name's brands), and wire it into `commentlint.run.main`.
- [ ] **Step 4: Fix every violation** in `server/src` the `--all` sweep
  reports (`PYTHONPATH=server/tooling python3 -m commentlint.run --all`).
- [ ] **Step 5: Run the server gates plus the sweep; expect PASS.**
  Mutation check: add `def _probe(uid: str) -> None: ...` to a product
  module, confirm the sweep, pytest's tree test and `git commit` (hook)
  each fail with the remedy text; remove it.
- [ ] **Step 6: Commit** `feat(pkm-zv2s): server names carry their brand`

### Task 8: Rule 2, escape hatches and the connection rule (server)

**Files:**
- Modify: `server/tooling/brandlint/core.py`, `brand_registry.py`
  (`MINT_SITES`, `CAST_SITES` filled from the survey)
- Modify: every violation in `server/src`
- Test: `server/tests/test_brandlint_mints.py`

**Interfaces:**
- Produces rule ids: `brand-mint` (a call to a brand name, found by
  scanning `server/src` for `X = NewType(...)`, outside `MINT_SITES`),
  `brand-cast` (`cast(...)` / `typing.cast(...)` outside `CAST_SITES`),
  `model-construct` (any `.model_construct(` in `server/src`),
  `raw-sqlite` (`sqlite3.connect`, `.cursor(`, `sqlite3.Connection`,
  `sqlite3.Cursor`, or `.raw` attribute access in `server/src` outside
  `database.py`). Each remedy names the fix ("read it from a `select()`
  row", "use `Db`", "parse with `parse_*`").

- [ ] **Step 1: Write the failing tests**: `BlockUid(x)` in
  `routes_pages.py` -> `brand-mint`, in `contracts/ops.py` -> clean;
  `cast(BlockUid, x)` and `cast(Row, x)` outside `CAST_SITES` ->
  `brand-cast`; `Model.model_construct()` -> `model-construct`;
  `sqlite3.connect(p)` / `db.raw` in `store.py` -> `raw-sqlite`, in
  `database.py` -> clean; `NewType("BlockUid", str)` itself -> clean.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the rules; fill `MINT_SITES` with the genuine
  parse points the survey finds (each with a comment saying why it is a
  parse point); move or delete every other mint.**
- [ ] **Step 4: Run the server gates plus the sweep; expect PASS.**
  Mutation check, one at a time, each must fail the sweep with its remedy:
  a stray `BlockUid("x")` in `store.py`; a `cast(PageId, 1)` in
  `tree.py`; a `con.raw.execute(...)` in `notify.py`; an unregistered
  column alias in a query that a test runs (fails pytest via
  `RowCheckError`); a `SELECT text AS uid` in a tested query.
- [ ] **Step 5: Commit** `feat(pkm-zv2s): server brands minted only at declared sites`

### Task 9: Server docs, gates and phase review

**Files:**
- Modify: `docs/architecture/enforced-checks.md` (pre-commit row lists the
  brand rules; pytest table gains the vocabulary tests and the row check),
  `docs/architecture/backend.md` (typing policy: `Db`, `select`, `Row`,
  the registry; module map gains `database.py`, `rows.py`,
  `brand_registry.py`; generated-artifacts table if Task 10's dump is not
  yet there, leave it for Task 10), `AGENTS.md` FCIS/comment section if the
  hook description changes
- Use the `architecture-docs` skill for the `docs/architecture/` edits.

- [ ] **Step 1: Update the docs; run `node .claude/skills/architecture-docs/
  check-docs.mjs docs/architecture/enforced-checks.md` and the same for
  `backend.md`.**
- [ ] **Step 2: Gates**: server pytest/pyrefly/ruff; `cd web && pnpm
  verify`; `proptest/check.sh server`; `perf/check.sh backend` (a
  regression is investigated per AGENTS.md, not accepted by default).
- [ ] **Step 3: Whole-branch review** on the strongest model with the perf
  table, then merge `feat/brand-check` to `main` with `--no-ff`.
- [ ] **Step 4: Commit** docs as `docs(pkm-zv2s): brand rules and the typed connection`

---

## Phase 2: web (branch `feat/brand-check-web`, from the Phase 1 merge)

### Task 10: Generated columns and registry for the web

**Files:**
- Create: `server/src/pkm/rows_dump.py` (`# pattern: Imperative Shell`;
  `uv run python -m pkm.rows_dump`)
- Create (generated): `web/src/replica/columns.gen.ts`,
  `web/tooling/brandRegistry.gen.json`
- Test: `server/tests/test_rows_artifact.py`,
  `web/src/replica/columns.test.ts`

**Interfaces:**
- Produces in `columns.gen.ts`: `export interface Columns` (every `Row`
  key plus `CLIENT_KEYS`, TS types using the brands from
  `../api/brands`, `X | None` as `X | null`, `str` as `string`, `int` as
  `number`) and `export const COLUMN_META: { readonly [K in keyof
  Columns]: { brand: string | null; base: "text" | "int" | "real" |
  "blob"; nullable: boolean } }`, and `export const BRAND_SHAPES`
  mirroring `SHAPES`.
- Produces in `brandRegistry.gen.json`: `{ names, mintSites, testSupport,
  optOutFiles }` from the registry, names in both snake_case and derived
  camelCase.
- `rows_dump` is added to the generated artifacts table in `backend.md`.

- [ ] **Step 1: Write the failing tests**: the server drift test (committed
  artifacts equal `rows_dump`'s output, as `test_schema_artifact.py` does
  for `baseSchema.gen.ts`); `columns.test.ts::every client column has a
  key` (open an in-memory replica with `BASE_SCHEMA` + `CLIENT_DDL`, walk
  `PRAGMA table_info` for the client-only tables, resolve via the same
  `COLUMN_KEYS` overrides exported in `COLUMN_META`'s companion map, and
  assert key, base type and nullability).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `rows_dump.py`, generate the artifacts.** Also
  resolve the second declaration of `pending_ops` in
  `replica/carryStore.ts` against `CLIENT_DDL` (one source, or a test
  that they agree).
- [ ] **Step 4: Run server pytest and `cd web && pnpm test:unit`; expect PASS.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): generated columns and brand registry for the web`

### Task 11: Column-named `select` and the web row check

**Files:**
- Modify: `web/src/replica/db.ts` (`select` signature, row check),
  every `.select<` call site (67 in 18 files)
- Create: `web/src/replica/rowCheck.ts` (`// pattern: Functional Core`)
- Modify: web tests whose replica uids fail the check (helper
  `uidOf(tag: string): BlockUid` in `web/src/test-helpers.ts`, returning a
  uid-shaped value derived from `tag`)
- Test: `web/src/replica/rowCheck.test.ts`, `web/src/replica/db.test.ts`

**Interfaces:**
- Consumes: `Columns`, `COLUMN_META`, `BRAND_SHAPES`.
- Produces: `ReplicaDb.select<K extends keyof Columns>(sql: string,
  params?: SqlValue[]): Pick<Columns, K>[]`; `rowProblems(row:
  Record<string, SqlValue>): string[]` (same contract as the server's
  `row_problems`); `wrapSqlite(raw, opts?: { checkRows?: boolean })`,
  where the default is `import.meta.env.MODE === "test"`.

- [ ] **Step 1: Write the failing tests**: `rowCheck.test.ts` mirrors
  Task 1 Step 3's cases; `db.test.ts::select with the check on throws on
  SELECT text AS uid`; a type test (`// @ts-expect-error` on
  `db.select<"nope">(...)`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement; migrate every call site** (a `select<T>` that
  forwards a caller's `T` becomes generic in `K`). Turn the check on; fix
  each failing test by switching its replica uids to `uidOf(...)`, never
  by loosening `rowProblems`.
- [ ] **Step 4: Run `cd web && pnpm typecheck && pnpm test:unit`; expect PASS.**
- [ ] **Step 5: Commit** `feat(pkm-zv2s): replica selects name columns, rows arrive branded`

### Task 12: ESLint brands plugin (rules 1 and 2, escape hatches)

**Files:**
- Create: `web/tooling/eslint-plugin-brands/index.mjs` (rules
  `brands/name-carries-brand`, `brands/no-brand-assertion`), reading
  `web/tooling/brandRegistry.gen.json`
- Create: fixtures in `web/tooling/eslint-fixtures/` (`brand-name.ts`,
  `brand-assertion.ts`, `brand-assertion-structural.ts`,
  `brand-opt-out-outside-boundary.ts`)
- Modify: `web/eslint.config.js` (register the plugin; test-support files
  from the registry are exempt), `web/tooling/lintConfig.test.ts` (one case
  per fixture, each with its corrected variant)

**Interfaces:**
- `brands/name-carries-brand`: function/method/arrow parameters,
  interface and type-literal property signatures, and class properties
  whose name (snake or camel) is in `names` must have a declared type
  that, per the type checker, contains a `__brand` property whose literal
  is one of the name's brands (anywhere in a union, array or tuple).
  Opt-out `// brand: untrusted -- <reason>` only in `optOutFiles`.
- `brands/no-brand-assertion`: an `as` or `<T>` assertion whose target type
  contains a `__brand` property anywhere in its structure (properties,
  union/intersection members, array/tuple elements, type arguments;
  visited-set guarded) is reported outside the brand's `mintSites`.
  Messages name the parser or `select` to use.

- [ ] **Step 1: Write the fixtures and `lintConfig.test.ts` cases**: `uid:
  string` param -> `brands/name-carries-brand`; `pageId: number` property
  -> same; `x as BlockUid`, `x as unknown as BlockUid`, `<BlockUid>x`,
  `rows as { uid: BlockUid }[]`, `JSON.parse(s) as PendingOp` ->
  `brands/no-brand-assertion`; each corrected variant clean.
- [ ] **Step 2: Run `cd web && pnpm test:unit tooling/lintConfig.test.ts`,
  expect FAIL.**
- [ ] **Step 3: Implement the plugin and register it.**
- [ ] **Step 4: Run the test; expect PASS. Do not fix product violations
  yet** (Task 13).
- [ ] **Step 5: Commit** `feat(pkm-zv2s): eslint brands plugin`

### Task 13: Fix every web violation

**Files:**
- Modify: every file `pnpm lint` reports (about 40 parameter sites, every
  brand assertion outside a mint site, parsers added where a value is
  genuinely parsed: e.g. a `parsePendingOps(json: string)` in the queue
  module that owns `pending_ops`); `brand_registry.py` `MINT_SITES` /
  `OPT_OUT_FILES` for genuine parse points and boundary files (each with a
  reason comment); regenerate `brandRegistry.gen.json`

- [ ] **Step 1: Run `cd web && pnpm lint`; record the count.**
- [ ] **Step 2: Fix every violation** (brand the name, or route the value
  through `select`/a parser; register a mint site only for a genuine parse
  point).
- [ ] **Step 3: Run `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`;
  expect clean. Mutation check, one at a time: a `uid: string` param in
  `outline/`; an `as BlockUid` in `replica/apply.ts`; an `as unknown as
  PageId`; a `select<{ uid: string }>`-style raw cast via `as`; each must
  fail `pnpm lint` (or `pnpm typecheck`) with the remedy.**
- [ ] **Step 4: Commit** `feat(pkm-zv2s): web names carry their brand, brands minted only at declared sites`

### Task 14: Web docs, gates and final review

**Files:**
- Modify: `docs/architecture/enforced-checks.md` (lint row gains the
  brand rules; vitest row check), `docs/architecture/frontend.md` (replica
  db access: column-named `select`, `columns.gen.ts`),
  `docs/architecture/backend.md` (generated-artifacts table: `rows_dump`),
  using the `architecture-docs` skill.

- [ ] **Step 1: Update the docs; run `check-docs.mjs` on each.**
- [ ] **Step 2: Gates**: `cd web && pnpm verify`; server pytest/pyrefly/
  ruff; `proptest/check.sh web`; `perf/check.sh frontend`.
- [ ] **Step 3: Whole-branch review** on the strongest model with the perf
  table; merge `--no-ff` to `main`; mark pkm-zv2s completed with a
  summary.
- [ ] **Step 4: Commit** docs as `docs(pkm-zv2s): web brand rules and column-named selects`
