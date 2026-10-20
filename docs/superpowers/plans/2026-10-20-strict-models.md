# Strict pydantic models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pydantic model is strict, so pyrefly checks every model
producer against its declared field types, and a brandlint rule keeps it so.

**Architecture:** Producers are made correct first, while the models are
still lax (tasks 1 and 2), so the strict flip (task 3) lands green. The
rule (task 4) then forbids the shapes pyrefly cannot check. Task 5 is the
branch-end verification.

**Tech Stack:** Python 3.12, pydantic 2.13, FastAPI 0.139, pyrefly 1.1.1,
brandlint (stdlib-only AST lint in `server/tooling/brandlint`).

**Spec:** `docs/superpowers/specs/2026-10-20-strict-models-design.md`. Bean:
pkm-aa5q.

## Global Constraints

- No `strict=False` anywhere: not on a `Field`, a `ConfigDict`, or a
  `model_validate` call. No opt-out comment for the new rule.
- Never weaken a type to make a producer pass (`str` where a brand was).
  Fix the producer.
- Test literals for brand fields go through `pkm.test_data.ids` helpers
  (`uid_of`, `order_idx_of`, `raw_title_of`, ...; the registry's
  `TEST_HELPERS` names them). No `# pyrefly: ignore` to silence a literal.
- A numeric bound on a brand field is written as the brand
  (`ge=SyncSeq(0)`).
- AGENTS.md rules apply: FCIS `# pattern:` headers, comment lines <= 80
  columns, no bean ids or line numbers in code comments, `--no-ff` merges.
- Server gates, from `server/`: `uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`. Each task ends with all three green.

## Review Focus

1. A block stored with `heading = 0` (Roam's "no heading") must still read
   as no heading once `build_tree` returns models. Task 2 pins it.
2. A stored `OpsAck` in the oldest shape (`{"ok": true, "ts": 1,
   "applied": 2}`, no `seq`) must still replay through both readers under
   strict. Task 3 pins it.
3. An agent calling the MCP/CLI `batch` tool with `"index": "2"` must get
   the usual readable batch error, not a traceback. Task 3 pins it.
4. The web client must never send a value strict rejects (a float
   `order_idx`, a `0`/`1` `collapsed`): a 422 there becomes a poisoned
   write. Task 5's full e2e run is the check; task 3 pins the 422 itself.
5. A model config written as a plain dict (`model_config = {"strict":
   False}`) must not slip past the rule. Task 4 pins it.

---

### Task 1: Test literals go through the id helpers

Mechanical. The literals are valid under lax mode too, so this lands green
before anything is strict.

**Files:**
- Modify: `server/tests/test_ops_core.py`, `test_planning.py`,
  `test_client_api.py`, `test_render.py`, `test_db_concurrency.py`,
  `test_conflict_notes.py`, `test_refs_reindex.py`, `test_ops_apply.py`
  (the trial's list; the enumeration below is authoritative)

**Interfaces:**
- Consumes: the helpers in `server/src/pkm/test_data/ids.py`.
- Produces: nothing new.

- [ ] **Step 1: Enumerate the sites.** Locally, uncommitted, add
  `model_config = ConfigDict(strict=True)` to a throwaway base and re-base
  the models in `server/src/pkm/contracts/ops.py` and
  `contracts/responses.py` on it, run `uv run pyrefly check`, and save the
  list of `bad-argument-type` errors under `server/tests`. Expected: about
  229 errors, mostly `BlockUid` and `OrderIdx` literals into op
  constructors. Revert the throwaway edit (`git diff --stat` shows only
  test files afterwards).
- [ ] **Step 2: Rewrite each literal** through its helper, e.g.
  `MoveOp(parent_uid="u_parent")` becomes
  `MoveOp(parent_uid=uid_of("u_parent"))`, `order_idx=0` becomes
  `order_idx=order_idx_of(0)`. A value built from an expression gets its
  helper around the expression. Leave the two `dict`-to-`ops` cases
  (`OpBatch(ops=[{...}])`) for task 4.
- [ ] **Step 3: Re-run the step 1 probe.** Expected: no errors under
  `server/tests` except the `ops=[{...}]` case(s). Revert the probe again.
- [ ] **Step 4: Run the gates.** Expected: all green.
- [ ] **Step 5: Commit** (`test: brand literals in model constructors go
  through the id helpers (pkm-aa5q)`).

### Task 2: The tree and grouping builders produce contract models

The 11 `Model.model_validate({...})` response sites become keyword
constructors, and the builders feeding them return the contract models
instead of TypedDicts with the same fields.

**Files:**
- Modify: `server/src/pkm/server/tree.py` (`build_tree`, `find_node`;
  delete `TreeNode`)
- Modify: `server/src/pkm/server/grouping.py` (`group_by_page`,
  `group_changed`, `group_backlinks`; delete `GroupedBlock`, `ChangedItem`,
  `BacklinkItem`, `PageGroup`, `ChangedGroup`, `BacklinkGroup`. Keep
  `ChangedRow`: it is an input row, not a payload)
- Modify: `server/src/pkm/server/routes_search.py`, `routes_pages.py`,
  `routes_migrations.py` (the 11 sites listed in the spec), and any helper
  in them that builds a nested payload dict (`_page_meta`, the journal
  `days` entries, the current-work `sections`, the title-migration groups)
- Modify: `server/src/pkm/export/markdown.py`, `export/resolve.py`,
  `export/writer.py`, `server/routes_export.py` (consume `BlockNode` and
  the group models by attribute)
- Test: `server/tests/test_tree.py`, `test_tree_find_node.py`,
  `test_grouping.py`, export tests as they need

**Interfaces:**
- Produces:
  - `build_tree(rows: Sequence[Row]) -> list[BlockNode]`
  - `find_node(nodes: Sequence[BlockNode], uid: BlockUid) -> BlockNode | None`
  - `group_by_page(rows: Sequence[Row]) -> list[BlockGroup]`
  - `group_changed(rows: Sequence[ChangedRow]) -> list[ChangedGroup]`
    (the `contracts.responses` model)
  - `group_backlinks(...) -> list[BacklinkGroup]` (the contracts model)
  - `render_page` and `render_page_resolved` take `Sequence[BlockNode]`.

- [ ] **Step 1: Write the failing tests** in `test_tree.py`:

```python
def test_build_tree_returns_block_nodes():
    tree = build_tree(ROWS)
    assert all(isinstance(n, BlockNode) for n in tree)
    assert tree[1].children[0].uid == "tuid-c1"

def test_a_stored_heading_zero_reads_as_no_heading():
    row = _row(uid_of("tuid-h0"), None, 0, "x", 0, None, 0)
    assert build_tree([row])[0].heading is None
```

  (`_row` and `ROWS` are `test_tree.py`'s existing helpers.) Add
  `isinstance` assertions for each grouping function in `test_grouping.py`
  (`BlockGroup`, `ChangedGroup`, `BacklinkGroup`).
- [ ] **Step 2: Run them.** Expected: FAIL (the builders return dicts).
- [ ] **Step 3: Implement.** The builders construct the models with
  keyword arguments. Each route site becomes `QueryPayload(groups=...,
  total=..., ref_counts=...)` and so on. Nested dict literals inside those
  sites become model constructors too (`PageMeta(...)`, `Backlinks(...)`,
  `JournalDay(...)`, `CurrentWorkSection(...)`, the `TitleMigration*`
  models). After this task, `grep -rn "model_validate(" server/src` lists
  only decode sites: `test_data/core.py`, `routes_sync.py` (the stored
  ack) and `client/api.py`.
- [ ] **Step 4: Run the gates.** Expected: all green, and the existing
  route, render and export tests pass unchanged apart from dict-to-attribute
  access.
- [ ] **Step 5: Commit** (`refactor: tree and grouping builders produce
  contract models; responses built by keyword (pkm-aa5q)`).

### Task 3: The strict base

**Files:**
- Create: `server/src/pkm/contracts/strict.py`
- Modify: every module declaring a `BaseModel` subclass under `server/src`
  (10 files, 89 classes), `server/tooling/proptest/sync_server.py` (4), and
  the test modules that declare models (4)
- Modify: `server/src/pkm/test_data/core.py` (`GraphSource`, `PageSource`)
- Modify: `server/src/pkm/planning.py` (`_create`), `server/routes_sync.py`
  (`sync_changes`), `server/src/pkm/client/api.py` (`post_ops`)
- Test: the existing tests for the routes and the batch module, plus the
  pins below

**Interfaces:**
- Produces: `class StrictModel(BaseModel)` in `pkm.contracts.strict`,
  `model_config = ConfigDict(strict=True)`, header `# pattern: Functional
  Core`. Task 4's rule treats this file and class name as the one allowed
  direct `BaseModel` subclass.

- [ ] **Step 1: Write the pin tests** (all fail today, because lax mode
  coerces):
  - Beside the existing `POST /api/ops` route tests: a create op with
    `"order_idx": "1"` and one with `1.0` each get 422; a `set_collapsed`
    op with `"collapsed": 1` gets 422.
  - Beside the existing `pkm.batch` tests: a move command with
    `"index": "2"` is refused through the same error path a negative index
    takes today (assert the error type and that the message names
    `index`).
  - In `test_sync_applied_batches.py` (or the existing ack replay test in
    `test_ops_idempotency.py` if it already covers both readers): the
    stored ack `{"ok": true, "ts": 1, "applied": 2}` replays through
    `routes_ops.post_ops` (JSON mode) and `routes_sync._applied_batches`
    (Python mode).
- [ ] **Step 2: Run them.** Expected: the 422 and batch pins FAIL; the ack
  pin passes (it is a guard against regression).
- [ ] **Step 3: Add `StrictModel` and re-base every model** on it. Models
  that subclass another model (`batch._Strict` and its 11 subclasses,
  `QueryPayload(GroupsPayload)`) need no edit. Existing `model_config`
  dicts merge with the parent's; leave them.
- [ ] **Step 4: Fix what breaks.**
  - `GraphSource` and `PageSource` validate their tuple fields from
    `json.loads` output: make `parse_graph_source` decode the source text
    with `GraphSource.model_validate_json`, or make the fields lists. Not
    `strict=False`.
  - `planning._create`: `parent: BlockUid | None`, with the callers'
    types following.
  - `routes_sync.sync_changes`: `next_since=NO_SEQ`.
  - `PkmClient.post_ops`: raw mappings become ops before `OpBatch` is
    built (e.g. `TypeAdapter(BlockOp).validate_python` per mapping, inside
    the existing `try`), so `OpBatch(ops=...)` gets `list[BlockOp]`.
  - Anything else pyrefly or pytest reports.
- [ ] **Step 5: Regenerate `web/src/api/openapi.json`** per the generated
  artifacts table in `docs/architecture/backend.md`. Expected: no diff. If
  there is one, follow the table's other regen steps and say why in the
  commit.
- [ ] **Step 6: Run the gates.** Expected: all green, pins included.
- [ ] **Step 7: Commit** (`feat: every pydantic model is strict
  (pkm-aa5q)`).

### Task 4: The rule

**Files:**
- Create: `server/tooling/brandlint/models.py` (`# pattern: Functional
  Core`, stdlib only)
- Modify: `server/tooling/brandlint/core.py` (add the rules to `RULES`;
  call the new module from `check_text`; reword `model-construct`'s fix,
  which currently suggests `model_validate`)
- Modify: `server/src/pkm/brand_registry.py` (`STRICT_BASE =
  ("server/src/pkm/contracts/strict.py", "StrictModel")`),
  `server/tooling/brandlint/registry.py` to load it
- Modify: the sites the rule reports: about 20 `model_validate` dict sites
  in tests and tooling, the 4 `model_copy(update=...)` sites in
  `server/src` (`render.clip_depth`, `server/ops_core.py`, two in
  `cli/main.py`), and any `OpBatch(ops=[{...}])` left from task 1
- Modify: `docs/architecture/enforced-checks.md`,
  `docs/architecture/backend.md`
- Test: `server/tests/test_brandlint_models.py`; a registry check in
  `test_brandlint_registry.py`

**Interfaces:**
- Consumes: `STRICT_BASE` from task 3's file and class name.
- Produces: rule ids `model-strict` and `model-unchecked`.

| Rule | Reports |
|---|---|
| `model-strict` | a class with `BaseModel` (`ast.Name` or `pydantic.BaseModel`) among its bases, except `STRICT_BASE`; a `strict=False` keyword on any call; a `"strict": False` key in a dict literal; a `create_model(...)` call; a `pydantic.dataclasses` import or attribute; `validate_call` |
| `model-unchecked` | `.model_validate(arg)` where `arg` is a dict literal, a dict comprehension or a `dict(...)` call; `.model_copy(...)` with an `update=` keyword |

- [ ] **Step 1: Write the failing tests** in `test_brandlint_models.py`,
  using the `rules(text, path)` helper pattern from
  `test_brandlint_mints.py`. One test per table cell, each asserting the
  rule id, for example:

```python
def test_a_direct_basemodel_subclass_is_reported():
    assert rules("class M(BaseModel):\n    x: int\n") == ["model-strict"]
    assert rules("class M(pydantic.BaseModel):\n    x: int\n") == ["model-strict"]

def test_the_strict_base_itself_is_allowed():
    assert rules("class StrictModel(BaseModel):\n    pass\n",
                 "server/src/pkm/contracts/strict.py") == []

def test_a_strict_model_subclass_is_clean():
    assert rules("class M(StrictModel):\n    x: int\n") == []

def test_a_dict_config_turning_strict_off_is_reported():
    assert rules('class M(StrictModel):\n    model_config = {"strict": False}\n') == ["model-strict"]

def test_validating_a_dict_built_in_place_is_reported():
    assert rules("m = M.model_validate({'a': 1})\n") == ["model-unchecked"]
    assert rules("m = M.model_validate(dict(a=1))\n") == ["model-unchecked"]
    assert rules("m = M.model_validate({k: v for k, v in xs})\n") == ["model-unchecked"]

def test_validating_decoded_input_is_clean():
    assert rules("m = M.model_validate(json.loads(body))\n") == []
    assert rules("m = M.model_validate_json(body)\n") == []
```

  Plus: each rule fires in a test path (`server/tests/...`) and a tooling
  path; `model_copy()` with no `update=` is clean; the registry test fails
  when `STRICT_BASE`'s file or class no longer exists.
- [ ] **Step 2: Run them.** Expected: FAIL (unknown rules).
- [ ] **Step 3: Implement** `models.py` as a generator of
  `(line, rule, what)` like `_escape_hatches`, and wire it into
  `check_text`. Messages name the fix: inherit `StrictModel`; build with
  keyword arguments; decode JSON text with `model_validate_json`.
- [ ] **Step 4: Run the tree sweep**
  (`PYTHONPATH=server/tooling python3 -m commentlint.run --all` from the
  repo root) and fix each reported site. A test that checks decoding
  itself (`test_brands.py`) decodes JSON text with `model_validate_json`;
  a fixture becomes a keyword constructor. Expected: the sweep is clean.
- [ ] **Step 5: Docs.** In `enforced-checks.md`, add the two rules to the
  brand rules table with `STRICT_BASE` in the registry column, and update
  the `pre-commit` row's summary of brand rules. In `backend.md`, replace
  the paragraph starting "None of this guards a pydantic model's
  constructor" with the current invariant: every model inherits
  `StrictModel`, so pyrefly checks constructors; name what it still cannot
  see (decoded input validated by `model_validate`, FastAPI's form-body
  models, the MCP library's argument models). Use the `architecture-docs`
  skill and run its `check-docs.mjs` on both files.
- [ ] **Step 6: Run the gates.** Expected: all green.
- [ ] **Step 7: Commit** (`feat: brandlint requires strict models and
  forbids unchecked producers (pkm-aa5q)`).

### Task 5: Branch-end verification

- [ ] **Step 1: Server gates** from `server/`. Expected: green.
- [ ] **Step 2: Web gate:** `cd web && E2E_PORT=<free port> pnpm verify`
  with `set -o pipefail`. Expected: green (Review Focus 4).
- [ ] **Step 3: Perf:** `perf/check.sh backend`. A regression on a read
  path is task 2's model construction: read the diff along that path, fix,
  re-run. Bring it to Arthur only if it survives.
- [ ] **Step 4: Property checks:** `proptest/check.sh server` (op
  validation changed). Expected: pass.
- [ ] **Step 5: Bean:** tick pkm-aa5q's checklist, add `## Summary of
  Changes`, mark it completed, commit with the last change.
