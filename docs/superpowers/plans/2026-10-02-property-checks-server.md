# Property Checks: Gate and Server Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `proptest/check.sh` runs a Hypothesis suite before merge. The suite checks:
- server op invariants through `/api/ops`;
- CLI batch planning against "index is a position".

The default `pytest -q` never runs it.

**Architecture:** The tests live in `server/tests/props/` behind a `proptest` marker, which `addopts` deselects. A thin tooling module picks sides from the diff and execs pytest with the Hypothesis `merge` profile. Each property builds its own app from a copied template DB per example. Results are compared with a pure reference model written from the architecture docs.

**Tech Stack:**
- Python 3, pytest, Hypothesis (new dev dependency);
- FastAPI `TestClient`, `time-machine`, uv.

**Spec:** `docs/superpowers/specs/2026-10-02-property-checks-server-design.md`

**Bean:** pkm-svgx (epic pkm-nws9). Worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-svgx`, branch `feat/pkm-svgx-property-checks`.

## Global Constraints

**Commands.** Run every command from the worktree. Server commands run from `server/` with `uv run`.

**Gates.** At the end of every task, all of these must pass:
- `uv run pytest -q`, which keeps the 95% coverage gate;
- `uv run pyrefly check`, at 0 errors with no new suppressions;
- `uv run ruff check`.

**The default suite.**
- `pytest -q` must never run a `proptest`-marked test.
- `proptest/check.sh` must never apply the coverage gate.

**Run time.** The `merge` profile keeps the whole server side at 2–4 minutes on this machine. It has a random seed per run and `deadline=None`.

**FCIS headers.**
- `server/tooling/proptest/sides.py` is `# pattern: Functional Core`.
- `server/tooling/proptest/run.py` is `# pattern: Imperative Shell`.
- Test files are exempt.

**Comments and commits.**
- No bean ids in code or test comments.
- No `Claude-Session:` trailer or claude.ai URL in commit messages; the `.githooks/commit-msg` hook rejects them.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Product code is not changed.** A property failure that reveals a product bug is *not* fixed inside this plan:
- stop;
- write the shrunk example into the report;
- the controller files a bean, per the spec's failure policy.

**Where docs are silent.** When the reference model must decide something the docs don't state:
- read the code (`ops_core.classify_skip`, `skip_report`, `ops_apply`);
- encode what it does;
- add a line to `server/tests/props/DOC_GAPS.md` (gitignored scratch, not committed) naming the doc section that should say it. The controller turns these into doc fixes in Task 5.

## Review Focus

1. **The marker exclusion silently breaks:** `addopts`' `-m "not proptest"` is overridden by a user's own `-m`. `pytest -q -m "not slow"` would then run the props. Task 1's exclusion test pins the default invocation; the docs say to add `and not proptest` to any custom `-m`.
2. **Per-example state leaking across Hypothesis examples:** one shared DB or `TestClient` across examples makes later examples depend on earlier ones. Shrinking then produces nonsense. Task 1's fixture test pins per-example isolation.
3. **The model agreeing with the server by construction:** the model must not import `ops_core`/`ops_apply`/`planning`. Task 2's import test pins it.
4. **A generator that never reaches the interesting cases:** for example, no cycle moves, no stale hashes or no gapped keys. Tasks 3 and 4 assert coverage with Hypothesis `event()`, which also needs a statistics run.
5. **Daily-page interference:** generated ops landing on today's daily page would interleave with conflict headers and break model agreement. Task 2's strategies exclude the frozen daily title, and a test pins that.

---

### Task 1: The gate (marker, wrapper, profiles, per-example app)

**Files:**
- Modify: `server/pyproject.toml`:
  - add `hypothesis` to the `dev` group (`uv add --dev hypothesis`);
  - in `[tool.pytest.ini_options]`, set `addopts` to `"-m 'not proptest' --cov=pkm --cov-branch --cov-report=term-missing --cov-fail-under=95"`;
  - add `markers = ["proptest: heavyweight property checks, run by proptest/check.sh only"]`.
- Modify: `.gitignore`: add `server/.hypothesis/` and `server/tests/props/DOC_GAPS.md`.
- Modify: `server/tests/conftest.py`: extract `make_config(root: Path) -> Config` and `seed_db(db_path: Path) -> None` out of `seeded_config`; the fixture then calls both, with no behaviour change.
- Create: `server/tooling/proptest/__init__.py` (empty), `server/tooling/proptest/sides.py`, `server/tooling/proptest/run.py`.
- Create: `proptest/check.sh` (executable).
- Create: `server/tests/props/__init__.py`, `server/tests/props/conftest.py`, `server/tests/props/test_smoke_props.py`.
- Test: `server/tests/test_proptest_sides.py`, `server/tests/test_proptest_exclusion.py`.

**Interfaces:**
- Produces, `sides.py`:
  - `sides_for(paths: Iterable[str]) -> list[str]` returns a subset of `["server", "web"]`, in that order. `server/…` gives server. `web/…` gives web, except `web/e2e/` and `*.md`, which is perf's rule.
  - `available(side: str) -> bool` is True only for `"server"` in this sub-project.
- Produces, `run.py`:
  - `main(argv: list[str]) -> int`.
  - Args: `side` in `auto|server|web` (default `auto`) and `--seed N`.
  - `auto` reads the changed paths the same way `perfcheck.run` does: merge base with `main`, plus untracked files.
  - A side with nothing to run prints `"{side}: no properties yet"`.
  - Server runs `uv run pytest -m proptest --no-cov -q tests/props` in `server/`, with env `HYPOTHESIS_PROFILE=merge`, adding `--hypothesis-seed=N` when a seed is given.
  - It returns the max exit code, or 0 when no side runs; with `auto` and no matching side it prints "no property sides touched".
- Produces, `proptest/check.sh`: mirrors `perf/check.sh`: `set -euo pipefail`, `cd "$repo/server"`, then `TZ=Europe/London PYTHONPATH="$repo/server/tooling" exec uv run python -m proptest.run "$@"`.
- Produces, `props/conftest.py`:
  - Profiles:
    - `dev`, the default: `max_examples=20, deadline=None`;
    - `merge`: `deadline=None, print_blob=True, suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large]`, with `max_examples` left to each test via `settings(...)` decorators read from `MERGE_EXAMPLES: dict[str, int]`. Provisional values are `{"smoke": 4, "ops_state": 200, "planner": 500}`, and Task 5 calibrates them. Under `dev`, tests use `min(MERGE_EXAMPLES[k], 20)`.
    - The profile is loaded from `HYPOTHESIS_PROFILE`, defaulting to `dev`.
  - `pytestmark` cannot sit in a conftest, so every props test module declares `pytestmark = pytest.mark.proptest` itself.
  - Session fixture `template_db(tmp_path_factory) -> Path`: `init_db` plus `seed_db` once.
  - Helper `fresh_app(template: Path) -> FreshApp`:
    - copies the template into a new `tempfile.mkdtemp()` dir;
    - builds `make_config`, then `TestClient(create_app(cfg))`;
    - logs in with `TEST_PASSWORD`;
    - returns `FreshApp(client: TestClient, config: Config, root: Path)` with `.close()` removing the dir.
  - It is a plain function, not a fixture, because it is called once per Hypothesis example.
  - `FROZEN_NOW = datetime(2026, 7, 9, 12, 0, tzinfo=ZoneInfo("Europe/London"))` and `DAILY_TITLE = title_for_date(FROZEN_NOW.date())`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_proptest_sides.py
from proptest.sides import available, sides_for

def test_server_paths_pick_server():
    assert sides_for(["server/src/pkm/ops_core.py"]) == ["server"]

def test_web_e2e_and_markdown_pick_nothing():
    assert sides_for(["web/e2e/a.spec.ts", "web/README.md"]) == []

def test_both_sides_in_fixed_order():
    assert sides_for(["web/src/x.ts", "server/y.py"]) == ["server", "web"]

def test_docs_pick_nothing():
    assert sides_for(["docs/architecture/backend.md"]) == []

def test_only_server_is_available_yet():
    assert available("server") and not available("web")
```

```python
# tests/test_proptest_exclusion.py
import subprocess, sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]

def _collect(*args):
    return subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q",
                           "--no-cov", *args, "tests/props"],
                          cwd=SERVER, capture_output=True, text=True)

PROPERTY_FILES = ("test_smoke_props.py", "test_ops_state.py", "test_planner_props.py")

def test_default_run_deselects_every_property():
    # test_model.py lives in props/ unmarked on purpose: it guards the model on every commit
    lines = [l for l in _collect().stdout.splitlines() if "::" in l]
    assert not any(f in l for l in lines for f in PROPERTY_FILES)

def test_proptest_marker_selects_them():
    out = _collect("-m", "proptest").stdout
    assert "test_smoke_props.py::" in out
```

```python
# tests/props/test_smoke_props.py
import pytest
from hypothesis import given, strategies as st
from .conftest import fresh_app

pytestmark = pytest.mark.proptest

@given(st.integers(min_value=0, max_value=3))
def test_each_example_gets_its_own_db(template_db, n):
    app = fresh_app(template_db)
    try:
        r = app.client.post("/api/ops", json={"client_id": "p", "batch_id": f"smoke_{n:04d}xx",
            "ops": [{"op": "create_page", "page_title": f"Smoke {n}"}]})
        assert r.status_code == 200
        titles = [p["title"] for p in app.client.get("/api/pages").json()["pages"]]
        assert sum(t.startswith("Smoke ") for t in titles) == 1   # no leakage from earlier examples
    finally:
        app.close()
```

(Adjust the `/api/pages` read to whatever the route returns; the assertion is "exactly one Smoke page".)

- [ ] **Step 2: Run to verify failure.** Run `uv run pytest -q tests/test_proptest_sides.py tests/test_proptest_exclusion.py --no-cov`. Expected: FAIL (`ModuleNotFoundError: proptest`, smoke file missing).
- [ ] **Step 3: Implement.** Implement the files listed above, plus `uv add --dev hypothesis`.
- [ ] **Step 4: Verify.**
  - `uv run pytest -q tests/test_proptest_sides.py tests/test_proptest_exclusion.py --no-cov` passes.
  - `uv run pytest -q` passes, with coverage ≥ 95, and its summary shows the smoke test deselected.
  - `../proptest/check.sh server` exits 0 and runs one test.
  - `../proptest/check.sh web` prints `web: no properties yet` and exits 0.
- [ ] **Step 5: Commit.** Message: `feat(pkm-svgx): proptest gate -- marker, wrapper, profiles, per-example app`.

---

### Task 2: Strategies and the reference model

**Files:**
- Create: `server/tests/props/strategies.py`, `server/tests/props/model.py`.
- Test: `server/tests/props/test_model.py`. This is an ordinary fast example test with **no** proptest marker, so it runs on every commit and guards the model itself.

**Interfaces:**
- Consumes: `DAILY_TITLE` from `props/conftest.py`.
- Produces, `model.py` (pure; imports only `pkm.contracts.*` and `pkm.refs`, never `pkm.server.*` or `pkm.planning`):
  - `@dataclass(frozen=True) class MBlock`: `uid: str, page: str, parent: str | None, order_idx: int, text: str, heading: int | None, collapsed: bool, view_type: str | None`.
  - `@dataclass(frozen=True) class Outcome`: `status: int` (200 or 400), `skipped: tuple[tuple[int, str, str, str], ...]` as `(index, op, uid, reason)`, and `kept_texts: tuple[str, ...]` (texts the conflict rules say must now exist under a `[[conflict]]` header on `DAILY_TITLE`).
  - `class Model`:
    - `blocks: dict[str, MBlock]`, `pages: set[str]`, `deleted: set[str]`;
    - `@classmethod from_rows(pages: Iterable[str], rows: Iterable[MBlock]) -> Model`;
    - `apply(ops: Sequence[dict]) -> Outcome`, atomic: on a 400 the model is unchanged;
    - `snapshot() -> dict[str, MBlock]`.
  - The semantics it encodes are written from these docs, with a comment per rule naming the table row:
    - `backend.md § Conflicts`, `§ Missing targets` and `§ Concurrent structure edits`;
    - `sync-and-offline.md § Conflicts at push time`;
    - create/move key arithmetic: landing at K shifts siblings with key ≥ K up by one; a move first removes the block from its old group, with no renumbering, so gaps persist; a cross-page move re-pages the subtree; a block under a live parent lives on the parent's page whatever `page_title` says.
  - 400 cases: a uid failing `UID_RE`, create of an existing uid, and a title failing `title_syntax_reason`.
- Produces, `strategies.py`:
  - `PAGES = ("Alpha", "Beta", "Gamma")`. All are valid titles, and none equals `DAILY_TITLE`.
  - `uid_pool(n: int) -> list[str]`: n `UID_RE`-valid uids.
  - `texts() -> SearchStrategy[str]`: short texts drawn from plain words, `[[Alpha]]`, `#Beta`, `((<pool uid>))` and `""`.
  - `seed_tree(uids) -> SearchStrategy[list[MBlock]]`: 0–12 blocks over `PAGES`, nesting ≤ 3, keys gapped (each group's keys are strictly increasing with random gaps 1–4).
  - `op_for(model: Model, uids: list[str]) -> SearchStrategy[dict]`: one of the eight op kinds.
    - Target uid: live, deleted or never-existed, weighted 6:2:2.
    - `order_idx`: 0..(max key + 2).
    - `base_text_hash`: correct, stale (the hash of a different text) or absent.
    - `base_subtree_hash`: correct, stale or absent.
    - Moves include a target parent that is the block itself or a descendant (cycle) with weight ≥ 1/8.
    - About 1 in 50 ops carries a `UID_RE`-invalid uid, so the 400 path is reached.
  - `batch_for(model, uids) -> SearchStrategy[list[dict]]`: 1–20 ops. Later ops are drawn against the model *after* earlier ops in the same batch, using `st.data()` in the caller, so in-batch composition is exercised.
  - `cli_batch(blocks: list[MBlock], page: str) -> SearchStrategy[list[dict]]`: `{command, params}` items (`create`, `todo`, `move`, `delete`), with `index` None, inside or past the end, parents chosen from live blocks or `{{alias}}` of an earlier create, and moves including onto their own slot and cycles.

- [ ] **Step 1: Write the failing tests.** Write one example test per doc table row the model encodes. Each takes a tiny `Model.from_rows(...)`, applies one batch, and asserts the snapshot and `Outcome`. Names and the core assertions:
  - `test_create_shifts_siblings_at_and_after_key`: A@0, B@1; create X@1 gives A@0, X@1, B@2.
  - `test_move_leaves_gap_in_old_group`: P children A@0, B@1, C@2; move B to top level @5 gives A@0, C@2 under P.
  - `test_cycle_move_skipped`: A has child B; move A under B gives no change, `skipped == ((0, "move", "A", "cycle"),)`.
  - `test_move_to_missing_parent_skipped`: `reason == "parent_not_found"`, block unchanged.
  - `test_create_under_missing_parent_diverted`: no block created; text in `kept_texts`; `reason == "parent_not_found"`.
  - `test_create_under_missing_parent_blank_text_keeps_nothing`: `kept_texts == ()`.
  - `test_stale_hash_edit_keeps_overwritten_text`: block text "old", edit "new" with the hash of "older" gives text "new" and `kept_texts == ("old",)`.
  - `test_hashless_edit_is_lww`: `kept_texts == ()`.
  - `test_edit_to_deleted_block_keeps_incoming_text`.
  - `test_guarded_delete_with_changed_subtree_keeps_all_texts`: parent "p" with child "c", delete with a stale subtree hash, `kept_texts` ⊇ {"p", "c"}.
  - `test_delete_missing_is_noop`, `test_set_collapsed_missing_is_noop`.
  - `test_create_existing_uid_is_400_and_atomic`: a batch `[create new X, create existing A]` gives `status == 400`, and X is absent.
  - `test_create_under_parent_on_other_page_follows_parent`.
  - `test_cross_page_move_repages_subtree`.
  - `test_model_imports_no_server_code`: parse `model.py` with `ast` and assert no import from `pkm.server` or `pkm.planning`.
  - `test_strategies_never_target_daily_page`: `DAILY_TITLE not in PAGES`.

  Where a test's expected outcome is not determined by the docs (for example, whether a no-op delete appears in `skipped`), read the code, assert what it does, and log the gap in `DOC_GAPS.md`.
- [ ] **Step 2: Run to verify failure.** Run `uv run pytest -q tests/props/test_model.py --no-cov`. Expected: FAIL on the import.
- [ ] **Step 3: Implement** `model.py` and `strategies.py` to the interfaces above.
- [ ] **Step 4: Verify.**
  - `uv run pytest -q tests/props/test_model.py --no-cov` passes.
  - The full gates pass.
- [ ] **Step 5: Commit.** Message: `test(pkm-svgx): reference op model and strategies`.

---

### Task 3: Op invariants state machine

**Files:**
- Create: `server/tests/props/test_ops_state.py`.

**Interfaces:**
- Consumes:
  - `fresh_app`, `template_db`, `FROZEN_NOW`, `DAILY_TITLE` and `MERGE_EXAMPLES` from conftest;
  - `Model`, `MBlock` and `Outcome` from `model.py`;
  - `uid_pool`, `seed_tree`, `batch_for` and `PAGES` from `strategies.py`.
- Produces:
  - `class OpsMachine(RuleBasedStateMachine)`;
  - `TestOps = OpsMachine.TestCase`, with `TestOps.settings = settings(max_examples=MERGE_EXAMPLES["ops_state"], stateful_step_count=30)`.

**Design:**
- **`@initialize(rows=seed_tree(...))`:**
  - start `time_machine.travel(FROZEN_NOW, tick=False)`;
  - `self.app = fresh_app(template)`;
  - post the seed as create ops (parents before children, at their gapped keys);
  - build `Model.from_rows`.
- **The template.** Hypothesis state machines can't take function fixtures, so the template path comes from a module global set by an autouse session fixture in conftest.
- **`teardown`:** closes the app and stops the clock.
- **Rule `submit(data=st.data())`:**
  - draw `batch_for`;
  - POST with a fresh `batch_id`;
  - assert the status equals `model.apply(...).status`;
  - on 200, assert `ack["applied"] == len(ops)` and the ack's `skipped` (as tuples) equals the model's;
  - record `(batch_id, payload, response_json)` in `self.sent`;
  - add `outcome.kept_texts` to `self.kept`.
- **Rule `replay`:**
  - precondition: `self.sent` is not empty;
  - resend a sampled earlier batch unchanged;
  - assert the response JSON equals the stored one;
  - assert `MAX(seq)` of `changes` is unchanged and the DB snapshot is unchanged.
- **Rule `reuse`:**
  - same precondition;
  - send a different valid one-op payload under a sampled earlier `batch_id`;
  - assert 409 and that nothing changed.
- **`@invariant()` checks**, reading the DB through `sqlite3.connect(app.config.db_path)`, read-only:
  1. **Model agreement:** every block whose uid is in the generator pool has DB `(page title, parent_uid, order_idx, text, heading, collapsed, view_type)` equal to the model's. Pool uids the model has deleted are absent.
  2. **Unique sibling keys:** `SELECT page_id, parent_uid, order_idx, COUNT(*) … HAVING COUNT(*) > 1` is empty.
  3. **Well-formed tree:** every non-null `parent_uid` exists with the same `page_id`, and walking parents from any block terminates within the block count.
  4. **No text lost:** every text in `self.kept` equals the text of some block whose ancestor on `DAILY_TITLE` has text starting `[[conflict]]`.
  5. **Derived refs:**
     - for each block, `{(pages.title, kind)}` joined from `refs` equals the canonical titles and kinds from `pkm.refs.extract(text).refs`, ignoring blank titles;
     - `{dst}` from `block_refs` equals `set(extract(text).block_refs)`;
     - no `refs`/`block_refs` row has a `src_block_uid` with no block.
- **Coverage events:** call `event()` for the skip reason, the hash kind, cycle, 400, replay and reuse.

- [ ] **Step 1: Write the machine** as above. The test *is* the deliverable; there is no separate red step, but Step 3 makes it prove it can fail.
- [ ] **Step 2: Run.** Run `HYPOTHESIS_PROFILE=merge uv run pytest -m proptest --no-cov -q tests/props/test_ops_state.py --hypothesis-show-statistics`.
  - Expected: PASS.
  - The statistics show every `event()` label at least once.
  - If an invariant fails, decide whether it's a model or doc misreading (fix the model, log in `DOC_GAPS.md`) or a product bug (stop and report per the Global Constraints).
- [ ] **Step 3: Mutation probe, not committed.**
  - In `ops_core.py`, make `ShiftSiblings` a no-op for creates. Re-run. Expected: FAIL, shrinking to a ≤ 3-op batch.
  - Revert with `git checkout -- src/pkm/server/ops_core.py`.
  - Record the shrunk example in the report.
  - Repeat with a second probe in `routes_ops.py`: store the ack, then return a copy with a fresh `ts` on replay. Expected: the `replay` rule fails.
- [ ] **Step 4: Gates.**
  - `uv run pytest -q` (the machine is deselected), pyrefly and ruff all pass.
  - `../proptest/check.sh server` passes.
- [ ] **Step 5: Commit.** Message: `test(pkm-svgx): stateful op invariants through /api/ops`.

---

### Task 4: Planner vs server

**Files:**
- Create: `server/tests/props/test_planner_props.py`.
- Modify: `server/tests/props/model.py`. Add a pure position reference: `positions_after(groups: dict[str | None, list[str]], commands: Sequence[dict], new_uids: Iterator[str]) -> dict[str | None, list[str]]`. Its keys are parent uids, with `None` for top level, and its values are child uid lists. It applies:
  - **create/todo:** insert at `index`, or append when `index` is None or ≥ len.
  - **move:** remove first, then insert at `index` among the destination's children *without* the block; None appends.
  - **delete:** remove the subtree.
  - It uses list operations only and never keys.
- Test: `server/tests/props/test_model.py`. Add example tests for `positions_after`, taken from the pkm-78fk bean:
  - gap seed `A@0, B@5, C@6`, then create `index=2` X, gives `[A, B, X, C]`;
  - `{create X index 0}, {create Y}` on `[A, B]` gives `[X, A, B, Y]`;
  - `index 0` twice composes, with the second one first;
  - delete then indexed create;
  - move within a parent forwards, backwards and onto its own slot;
  - an index past the end appends.

**Interfaces:**
- Consumes: `fresh_app`, `seed_tree`, `cli_batch`, `PAGES` and `MERGE_EXAMPLES["planner"]`.
- Consumes: `pkm.client.workflows.apply_batch(client: PkmClient, commands: object) -> OpsAck`, and `PkmClient(CliConfig(url="http://testserver", token=…), http=app.client)` (copy the construction from `tests/conftest.py::pkm_client`).
- Consumes the uid source: `positions_after` must learn the uids the CLI minted. It reads them from the ops the CLI posted, captured by the wrapper below, in command order.

**Design** (`@given(data=st.data())`, one test `test_cli_batch_positions`):
1. **Seed.** `fresh_app`, then seed one page from `seed_tree` restricted to `PAGES[0]`, with gapped keys.
2. **Draw** `commands = cli_batch(seeded_blocks, PAGES[0])`.
3. **Optionally draw a concurrent delete** of one seeded uid that some command references (probability ~1/6).
4. **Wrap the client.** `class Racing(PkmClient)` overrides `post_ops` to:
   - first post the concurrent delete (if any) as its own batch;
   - record the ops;
   - then call `super().post_ops`.
5. **Run.** Call `apply_batch(racing, commands)`. A `BuildError` from planning is an allowed outcome, recorded with `event("build_error")`, and the test ends there. Otherwise read back per-parent child order on the page via `get_page_blocks`.
6. **Compute the expected order.** `expected = positions_after(seed_groups_minus_concurrent_delete, commands, iter(created_uids))`.
7. **Assert:**
   - if the ack's `skipped` is empty, every group equals `expected`;
   - otherwise, every group *not* equal to a skipped op's source parent or destination parent equals `expected`, and every skipped entry has reason `cycle` or `block_not_found`/`parent_not_found` caused by the concurrent delete;
   - in both cases, unique sibling keys and a well-formed tree, with the same SQL as Task 3 (move those two helpers into `props/conftest.py` as `assert_unique_keys(db_path)` and `assert_well_formed(db_path)`, and use them from both tests).
8. **Coverage events:** `index=None`, inside, past-end, alias parent, cycle, concurrent delete and gapped seed.

- [ ] **Step 1: Write the `positions_after` example tests.** Run them. Expected: FAIL on the missing function.
- [ ] **Step 2: Implement `positions_after`.** Run `uv run pytest -q tests/props/test_model.py --no-cov`. Expected: PASS.
- [ ] **Step 3: Write `test_cli_batch_positions`.** Run it with `--hypothesis-show-statistics` under `merge`. Expected: PASS, with every event seen. A failure is handled as in Task 3, Step 2.
- [ ] **Step 4: Mutation probe, not committed.**
  - In `batch.py` `_batch_create`, replace `ctx.planner.create_at(…, p.index, …)` with the pre-fix behaviour (pass `p.index` as an order key straight to `_create`). Expected: FAIL, shrinking to a gapped-seed create.
  - Revert the change.
  - Repeat with `Planner._land` skipping its sibling shift.
- [ ] **Step 5: Gates and commit.** Run the full gates and `../proptest/check.sh server`. Message: `test(pkm-svgx): CLI batch planning matches position semantics`.

---

### Task 5: Calibrate, document, close

**Files:**
- Modify: `server/tests/props/conftest.py`: set `MERGE_EXAMPLES`.
- Create: `docs/architecture/property-checks.md`. Invoke the `architecture-docs` skill first. It covers:
  - what each property checks (a table);
  - how to run it (`proptest/check.sh`, `--seed`);
  - how to read a failure (shrunk example, `@reproduce_failure`, `.hypothesis/` replay);
  - the custom-`-m` trap from Review Focus 1;
  - the model's doc-only rule.
- Modify:
  - `docs/architecture/overview.md`: link it beside `performance-checks.md`.
  - `AGENTS.md § Testing`: one bullet after the perf bullet. Run `proptest/check.sh` when major work touching sync, ops or planning is complete and before merge. A failure blocks the merge: a product bug gets fixed with the shrunk example as a unit test in `server/tests/`; a wrong property gets fixed in `props/` with the reason in the commit; a flaky property gets a bean against the gate.
  - The docs `DOC_GAPS.md` named: one fix per gap, in the doc that owns it.

- [ ] **Step 1: Calibrate.** Time `../proptest/check.sh server` with provisional values. Scale `MERGE_EXAMPLES["ops_state"]` and `["planner"]` so the total lands at about 3 minutes. Re-run twice with different seeds to confirm 2–4 minutes. Record the timings in the commit message.
- [ ] **Step 2: Write the docs** listed above. Run `node tooling/check-docs.mjs` if present (the `architecture-docs` skill names the checker).
- [ ] **Step 3: Final gates.**
  - `uv run pytest -q`, pyrefly and ruff.
  - `../proptest/check.sh server`.
  - `perf/check.sh backend`. Product code is unchanged, so expect no change, and include its table in the report.
- [ ] **Step 4: Close the bean.** Tick pkm-svgx's checklist and add `## Summary of Changes`. Commit the docs, the calibration and the bean. Message: `docs(pkm-svgx): property-checks architecture doc, AGENTS gate, doc gaps fixed`.
