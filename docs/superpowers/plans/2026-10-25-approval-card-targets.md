# Approval Card: Current Targets and Residuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant's approval card shows the current text (an explicit
excerpt) and page of every block a write updates, moves or deletes; a batch
that reuses an `as` alias is refused for every caller; refusal messages and
the card are bounded; values render left-to-right; and the web renders only
the keys each action can have.

**Architecture:** The current text is read on the server, in the shell that
builds the card (`can_use_tool`), from the same database the tool writes,
immediately before the `confirm_request` is sent. The pure builder
`build_write_preview` takes the rows read and attaches one `current` value to
each update, move and delete op. Alias bookkeeping (a reused `as`, an
`{{alias}}` no earlier command made) moves to `pkm.batch`'s upfront
validation, which the CLI, the MCP tool and the preview all run. The web
parser checks every op against a per-action key list generated from the
server's `WRITE_PREVIEW_FIELDS`.

**Tech Stack:** Python 3.12, FastAPI, pydantic, mcp FastMCP, SQLite; React +
TS, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`,
row pkm-g2w9; the bean `.beans/pkm-g2w9--approval-card-low-residuals-from-the-adversarial-r.md`;
the card's current rules in `docs/architecture/assistant.md` § The write
approval card.

## Global Constraints

- Spec, verbatim: "The card shows the current text (clipped) and page of each
  block a write updates, moves or deletes, read when the card opens. A batch
  that reuses an `as` alias is refused (my call). The other residuals
  (bounded refusal messages and card size, `dir="ltr"` on values, client-side
  key allow-list) are engineering"
- Never a silent cut. A clipped excerpt carries the whole text's length and
  the card says "first 200 of N characters". A clipped echo in a message ends
  `… (N characters)` after its closing quote. This is the `excerpt` +
  `text_length` convention of the parallel `security/limits` branch
  (`BLOCKER_EXCERPT_CHARS = 200`). Nothing here imports that branch's code.
- Targets are still never clipped. A current block's page title follows the
  target rule: past `TARGET_LIMIT_CHARS` the write is refused, not clipped.
- Constants (new): `CURRENT_EXCERPT_CHARS = 200`, `ECHO_LIMIT_CHARS = 80`,
  `REFUSAL_LIMIT_CHARS = 500`, `PREVIEW_LIMIT_CHARS = 250_000`,
  `MAX_OPS_PER_BATCH = 500` (extracted from `OpBatch.ops`, value unchanged).
- AGENTS.md: a `# pattern:` / `// pattern:` header on every new file with
  runtime behaviour. Comments carry no bean ids or line numbers and are at
  most 80 columns. Run `PYTHONPATH=server/tooling python3 -m commentlint.run --all`
  before each commit. Web work is verified with `pnpm verify`, which runs
  eslint brand rules, `lint:comments` and `check:fcis`; `pnpm typecheck` +
  `pnpm test:unit` is not enough.
- No HTTP route or response model changes, so `openapi.json` is untouched. If
  a task finds it must change one, regenerate per backend.md § Generated
  artifacts.
- e2e specs create their own page (`POST /api/pages`) and delete it in
  `afterEach`. Run them with your own `E2E_PORT`, never 8974.

## Decisions (the executor does not revisit these)

| Question | Decision | Why |
|---|---|---|
| Where the current text comes from | A server read in `can_use_tool`, through an injected `BlockReader`, immediately before the `confirm_request`. Not a web fetch when the card renders. | The tool writes the server DB, so that is the text to show. The card stays one server payload, parsed once. A web fetch would add a route, a loading state and a "may Allow arm before the read lands?" rule to the card the user relies on. The read happens milliseconds before the card renders. |
| Staleness | The card shows a snapshot taken when its `confirm_request` was built. A second, queued card was read when its request arrived, so it can predate a write the user allows on the card ahead of it. Documented in assistant.md, not engineered away. | Under either source, the gap between read and Allow is the user's reading time. Serializing confirms on the server would remove the queue's "1 of 2" and touch the teardown code. The open-risk note is in the report. |
| Clip | `excerpt = text[:200]` (code points) and `text_length = len(text)`. The card shows `current text: (first 200 of 1,234 characters)` above the quoted excerpt, followed by `…` outside the closing quote. No [show]: the rest is never sent. | Arthur rejects silent truncation. The block can hold a million characters. |
| Uid no block has (including a malformed one) | `current text: no block has this uid`. A malformed uid is never sent to SQL. | It is true in every case. The existing warnings already say what the tool then does. |
| `{{alias}}` target in a batch | `current text: none yet (write N above creates it as "a")`. N is the 1-based number of the creating command, which is what the card's `<ol>` shows. The alias-parent warning names the same write. | Duplicate aliases are refused, so N is unambiguous. |
| Reused `as`, and an alias used before any command made it | Refused by a new `pkm.batch.batch_aliases`, which `validate_batch` and `plan_batch` both call. `BatchItemError` gives `batch[i]: as "n" already names the block item j creates` and `batch[i]: unknown alias: "n"`. | One place for the CLI, the MCP tool and the preview, with one error contract. Doing the unknown-alias check upfront means the card never shows a batch that cannot plan, so it has no "unknown alias" state. |
| Bounded messages | `pkm.echo.echo()` quotes and clips every echoed value (unknown argument, unknown command, a long `loc` segment, an alias name). `build_write_preview` also caps any `Refusal` at `REFUSAL_LIMIT_CHARS` as a backstop. | A 2 MB key is logged and reaches the model on every retry. |
| Card size | At most `MAX_OPS_PER_BATCH` commands, and at most `PREVIEW_LIMIT_CHARS` across all target strings, content and current values. Either limit is a refusal that tells the model to split the batch. | `/api/ops` takes at most 500 ops and every command plans at least one, so a longer batch could never apply. 250,000 is five content values at their limit. Real batches are a few KB. |
| Client allow-list | Generated `web/src/assistant/previewKeys.gen.ts` (a `ReadonlyMap` from label to `{targets, content, current}`). `parseWritePreview` returns null, leaving Deny only, for an unknown action, a target or content key outside its label's lists, or `current` present or absent against the label's flag. | Defence in depth with no drift: the server test fails when the generated file is stale. A `Map` cannot be fooled by `"constructor"` or `"__proto__"`. |
| RTL | `dir="ltr"` on every `.assistant-confirm-value` `<bdi>`. | A value that starts with an RTL letter otherwise renders reversed relative to the same title in a warning. |

## Review Focus

- A batch that updates, then moves, then deletes the same uid. The uid is
  read once, and all three ops show the same current text (Task 2 test).
- Alias names with braces (`as: "a}"`, referenced as `{{a}}}`). The upfront
  check and the planner must agree on every name (Task 1 test).
- An astral character at the clip boundary, and text of exactly 200 or 201
  code points. The excerpt never splits a code point, and "first 200 of"
  shows only when clipped (Task 2 and Task 5 tests).
- A Hebrew page title, or an excerpt that starts with U+202E. It renders
  quoted, escaped and left-to-right (Task 6 test).
- The DB read raises (a locked or missing DB). The write is refused with a
  reason, never raised into the SDK (Task 4 test).

---

### Task 1: Refuse reused and premature batch aliases (model: sonnet)

**Files:**
- Create: `server/src/pkm/echo.py` (`# pattern: Functional Core`)
- Modify: `server/src/pkm/batch.py` (`batch_aliases`; call it from
  `validate_batch` and `plan_batch`; `_resolve_alias` and `_alias_uid` use
  `echo`; update the schema comment that says the schema does not check that
  an alias was defined earlier)
- Modify: `server/src/pkm/mcp/tools.py` (`batch` docstring: "each 'as' name
  once per batch, and only after the command that makes it")
- Modify: `server/src/pkm/cli/main.py` (`_BATCH_EPILOG`, the `create` entry:
  same sentence)
- Modify: `docs/cli.md` § Batch transactions (fails-table row "an `as` name
  given twice", and the `as` paragraph)
- Test: `server/tests/test_echo.py`, `server/tests/test_planning.py`,
  `server/tests/test_mcp_server.py`, `server/tests/test_cli_main_write.py`,
  `server/tests/test_write_preview.py`,
  `server/tests/test_regex_trailing_newline.py` (expect `unknown alias: "a"`)

**Interfaces:**
- Produces, in `pkm/echo.py`:
  ```python
  ECHO_LIMIT_CHARS = 80
  def echo(value: str, limit: int = ECHO_LIMIT_CHARS) -> str: ...
  def loc_text(loc: Sequence[object]) -> str: ...
  ```
  `echo` returns `json.dumps(value[:limit])` (ASCII-escaped, so one line).
  When `len(value) > limit` it appends `f"… ({len(value):,} characters)"`
  after the closing quote. `loc_text` joins the parts with `.`. A `str` part
  longer than `ECHO_LIMIT_CHARS` becomes `echo(part)`, every other part
  `str(part)`. Task 3 uses it.
- Produces, in `pkm/batch.py`:
  ```python
  def batch_aliases(commands: Sequence[BatchCommand]) -> dict[str, int]: ...
  ```
  Maps each `as` name to the index of the item that creates it. It walks the
  items in order and, for each one, first checks every reference (the
  `parent` of create/todo/outline/move, the `uid_spec` of update/move/delete)
  whose `alias_name()` is not None. It raises
  `BatchItemError(i, f"unknown alias: {echo(name)}")` when the name is not
  yet mapped. After that it records a truthy `as_` of create/todo, raising
  `BatchItemError(i, f"as {echo(name)} already names the block item {j} creates")`
  on a reuse. An empty `as` is no alias, as in `_batch_create`.

- [ ] **Step 1: Write the failing tests**
  - `test_echo.py`: `echo("a") == '"a"'`; `echo("x" * 2_000_000) == '"' + "x" * 80 + '"… (2,000,000 characters)'`;
    `echo("a b") == '"a\\u2028b"'`;
    `loc_text(["params", "k" * 1000]) == "params." + echo("k" * 1000)`;
    `loc_text(["commands", 0]) == "commands.0"`.
  - `test_planning.py`:
    - `test_validate_batch_refuses_a_reused_alias`: two creates with `as: "n"`
      raise `BuildError`, `str(exc) == 'batch[1]: as "n" already names the block item 0 creates'`.
    - `test_plan_batch_refuses_a_reused_alias_identically`: the same through
      `plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen())` gives the
      same string.
    - `test_an_alias_used_before_it_is_made_is_refused_upfront`: `[update {{n}}, create as n]`
      makes `validate_batch` raise with `str == 'batch[0]: unknown alias: "n"'`.
    - `test_a_command_cannot_name_its_own_alias_as_parent`: a create with
      `parent "{{n}}", as "n"` gives `batch[0]: unknown alias: "n"`.
    - `test_an_empty_as_is_no_alias`: two creates with `as: ""` validate.
    - `test_batch_aliases_maps_each_name_to_its_item`: `{"a": 0, "b": 2}`.
    - `test_alias_names_with_braces_agree_with_the_planner` (parametrized
      over `"a}"`, `"{a"`, `"a b"`): a create `as: name` then an update
      `uid: "{{" + name + "}}"` passes `validate_batch` and `plan_batch` plans
      the update onto the created uid.
    - `test_an_overlong_alias_is_echoed_bounded`: an unknown alias of 10,000
      characters gives a message under 200 characters ending
      `… (10,000 characters)`.
  - `test_mcp_server.py::test_batch_reused_alias_raises` (`BuildError`,
    match `already names`) and
    `test_cli_main_write.py::test_batch_reused_alias_exits_1` (exit 1,
    `"already names" in err`, nothing posted: follow
    `test_batch_unknown_alias_exits_1`).
  - `test_write_preview.py::test_a_reused_alias_is_refused`: the message
    starts `batch item 1: as "x" already names`.

- [ ] **Step 2: Run them to verify they fail**
  Run: `cd server && uv run pytest -q tests/test_echo.py tests/test_planning.py tests/test_mcp_server.py tests/test_cli_main_write.py tests/test_write_preview.py tests/test_regex_trailing_newline.py`
  Expected: FAIL (`ModuleNotFoundError: pkm.echo`, then the alias tests).

- [ ] **Step 3: Implement `echo`, `loc_text`, `batch_aliases` and the two
  call sites.** `plan_batch` calls `batch_aliases(parsed)` right after its
  parse loop. Also update the docstrings and docs listed under Files.

- [ ] **Step 4: Run them, then the whole server gate**
  Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  Expected: all pass. The props suite is not in this run: Task 7 runs
  `proptest/check.sh server`.

- [ ] **Step 5: Commit**
  `git add server/src/pkm/echo.py server/src/pkm/batch.py server/src/pkm/mcp/tools.py server/src/pkm/cli/main.py docs/cli.md server/tests/test_echo.py server/tests/test_planning.py server/tests/test_mcp_server.py server/tests/test_cli_main_write.py server/tests/test_write_preview.py server/tests/test_regex_trailing_newline.py`
  `git commit -m "batch: refuse a reused as alias, and an alias used before it is made, upfront"`

### Task 2: The preview carries each target block's current text (model: opus)

**Files:**
- Modify: `server/src/pkm/assistant/policy.py` (`CURRENT_TEXT_ENTRIES`)
- Modify: `server/src/pkm/assistant/write_preview.py`
- Modify: `server/src/pkm/assistant/claude_engine.py`,
  `server/tests/fake_engine.py` (pass `{}` for now; Task 4 wires the reader)
- Test: `server/tests/test_write_preview.py`,
  `server/tests/test_assistant_events.py`, `server/tests/test_fake_engine.py`

**Interfaces:**
- Consumes: `batch_aliases` (Task 1).
- Produces, in `policy.py`:
  `CURRENT_TEXT_ENTRIES: frozenset[str] = frozenset({"update_block", "batch:update", "batch:move", "batch:delete"})`.
- Produces, in `write_preview.py`:
  ```python
  CURRENT_EXCERPT_CHARS = 200

  @dataclass(frozen=True)
  class StoredBlock:          # what the shell read for one uid
      page_title: str
      text: str

  @dataclass(frozen=True)
  class FoundBlock:
      page_title: str
      excerpt: str            # text[:CURRENT_EXCERPT_CHARS]
      text_length: int        # len(text), code points
      state: Literal["found"] = "found"

  @dataclass(frozen=True)
  class MissingBlock:
      state: Literal["missing"] = "missing"

  @dataclass(frozen=True)
  class CreatedInBatch:
      write: int              # 1-based number of the creating command
      alias: str
      state: Literal["created"] = "created"

  CurrentBlock = FoundBlock | MissingBlock | CreatedInBatch

  # PreviewOp gains, after warnings:
  #     current: CurrentBlock | None   (None: the op touches no existing block)

  def write_target_uids(short: str, tool_input: Mapping[str, object]
                        ) -> list[BlockUid]: ...
  def build_write_preview(short: str, tool_input: Mapping[str, object],
                          blocks: Mapping[BlockUid, StoredBlock]
                          ) -> WritePreview | Refusal: ...
  ```
  SSE JSON per op (via `asdict`): `"current": null` or
  `{"page_title", "excerpt", "text_length", "state": "found"}` /
  `{"state": "missing"}` / `{"write", "alias", "state": "created"}`.

Rules the body must follow:
- Split `_build` so that validation (the unknown-key check, the arg model, and
  for `batch` `validate_batch`) is one helper that both public functions use.
- `write_target_uids` returns, in first-seen order and without repeats, every
  `parse_block_uid`-valid uid of an op whose entry is in
  `CURRENT_TEXT_ENTRIES` and whose spec is not an alias. For input that
  validation refuses, or that raises, it returns `[]`. It never raises.
- `current` for an op in `CURRENT_TEXT_ENTRIES`: inside a batch, an alias
  spec gives `CreatedInBatch(write=aliases[name] + 1, alias=name)`. Otherwise
  `parse_block_uid(spec)` is looked up in `blocks`, giving `FoundBlock` or
  `MissingBlock()`. `update_block`'s `{{x}}` is not an alias and gives
  Missing. Every other op gets `current=None`.
- `_limit_problem` also refuses a `FoundBlock` whose `page_title` is longer
  than `TARGET_LIMIT_CHARS`:
  `f"the block's page title is {n} characters; a target is at most {TARGET_LIMIT_CHARS}"`.
- The batch alias-parent warning becomes
  `f"parent {_quoted(parent)} is the block write {n} creates as {_quoted(alias)}: this lands under it, on that block's page, whatever the page row says"`.
  The "(no such earlier block…)" clause goes: Task 1 refuses that batch.

- [ ] **Step 1: Write the failing tests.** In `test_write_preview.py`, `_preview`
  and `_refusal` take `blocks: Mapping[BlockUid, StoredBlock] = {}` and pass
  it on. Mint uids with the test helpers (`uid_of`).
  - `test_update_block_shows_the_current_text_and_page`: blocks
    `{VICTIMUID01: StoredBlock("Inbox", "old text")}` gives
    `ops[0].current == FoundBlock("Inbox", "old text", 8)`.
  - `test_current_text_is_an_excerpt_with_the_whole_length`: `"y" * 1000`
    gives excerpt `"y" * 200`, `text_length == 1000`. With 200 characters,
    excerpt is the whole text and `text_length == 200`.
  - `test_excerpt_counts_code_points`: `"😀" * 300` gives
    `excerpt == "😀" * 200` and `text_length == 300`.
  - `test_a_uid_no_block_has_is_missing`: blocks `{}` gives `MissingBlock()`.
  - `test_a_malformed_uid_is_missing_and_never_read`: batch delete
    `uid "((abc))"` gives `write_target_uids(...) == []` and
    `current == MissingBlock()`.
  - `test_batch_alias_target_names_the_creating_write`: `[create as n, create as m, update {{m}}]`
    gives `ops[2].current == CreatedInBatch(write=2, alias="m")`.
  - `test_one_uid_updated_moved_and_deleted_shows_one_text`: three ops on
    uid A. `write_target_uids == [A]`, and all three `current` values are
    the same `FoundBlock`.
  - `test_write_target_uids_skips_parents_and_creates`: update A, move B
    with `parent "((CCCCCC))"`, delete A, create on a page gives `[A, B]`.
  - `test_write_target_uids_of_refused_input_is_empty`: `commands="nope"`,
    an unknown key, and `rename_page` each give `[]`.
  - `test_ops_that_touch_no_existing_block_have_no_current`: save_note,
    rename_page, and batch create/todo/outline have `current is None`.
  - `test_a_long_page_title_on_the_current_block_is_refused`: title
    `"t" * 1001` gives a refusal containing `page title is 1001 characters`.
  - Update `_ALIAS_WARNING` to the new text (`write 1 creates as "x"`).
  - `test_assistant_events.py::test_confirm_request_sse_shape`: add `current`
    to the fixture `PreviewOp` and assert the found, missing and created JSON
    shapes above, and `null` for a create.

- [ ] **Step 2: Run them to verify they fail**
  Run: `cd server && uv run pytest -q tests/test_write_preview.py tests/test_assistant_events.py`
  Expected: FAIL (ImportError: `StoredBlock`).

- [ ] **Step 3: Implement.** Pass `blocks={}` at the `claude_engine.py` and
  `fake_engine.py` call sites. Task 4 replaces both.

- [ ] **Step 4: Run to verify they pass**
  Run: `cd server && uv run pytest -q tests/test_write_preview.py tests/test_assistant_events.py tests/test_claude_engine.py tests/test_fake_engine.py && uv run pyrefly check && uv run ruff check`
  Expected: PASS. Mutation check: drop the alias branch, then drop the
  `CURRENT_TEXT_ENTRIES` membership test. Each must turn a test red. Restore.

- [ ] **Step 5: Commit**
  `git commit -m "assistant: the write preview carries each updated, moved or deleted block's current text"`
  (stage the files above by path).

### Task 3: Bound refusal messages and the card's size (model: sonnet)

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`MAX_OPS_PER_BATCH = 500`,
  used by `OpBatch.ops`'s `max_length`)
- Modify: `server/src/pkm/batch.py` (`_command_problem`: `unknown command:
  {echo(str(tag))}`, and `loc_text(first["loc"][1:])` for the path)
- Modify: `server/src/pkm/assistant/write_preview.py`
- Test: `server/tests/test_write_preview.py`, `server/tests/test_planning.py`

**Interfaces:**
- Consumes: `echo`, `loc_text` (Task 1); `PreviewOp.current` (Task 2).
- Produces, in `write_preview.py`: `REFUSAL_LIMIT_CHARS = 500`,
  `PREVIEW_LIMIT_CHARS = 250_000`, and `MAX_PREVIEW_OPS = MAX_OPS_PER_BATCH`.

Rules:
- `_build`'s unknown argument becomes `f"{short}: unknown argument {echo(unknown)}"`,
  and `_first_error` uses `loc_text`.
- In `_batch_preview`, before `validate_batch`: more than `MAX_PREVIEW_OPS`
  commands gives `Refusal(f"batch: {n} commands; at most {MAX_PREVIEW_OPS} fit one batch, so split it")`.
- After building the ops, the card size is the summed length of every `str`
  target value, every content text, and a current op's `page_title`,
  `excerpt` or `alias`. Over `PREVIEW_LIMIT_CHARS` it gives
  `Refusal(f"{short}: the card would hold {size:,} characters; split the write into parts under {PREVIEW_LIMIT_CHARS:,}")`.
  This applies to single-op tools too.
- `build_write_preview` cuts any `Refusal` whose message is longer than
  `REFUSAL_LIMIT_CHARS` to `message[:REFUSAL_LIMIT_CHARS] + f"… ({len(message):,} characters)"`.

- [ ] **Step 1: Write the failing tests**
  - `test_unknown_key_refusal_is_bounded`: a 2,000,000-character key gives a
    message under 200 characters ending `… (2,000,000 characters)`.
    `test_unknown_key_is_refused` still passes, since short keys are
    unchanged.
  - `test_an_unknown_command_is_echoed_bounded`: a command tag of 1,000,000
    characters gives a bounded refusal. Update the existing parametrized
    needle `"unknown command: 'drop'"` to `'unknown command: "drop"'`.
  - `test_an_extra_param_key_is_echoed_bounded`: a batch item with params key
    `"k" * 1_000_000` gives a bounded refusal. Add the same case for
    `validate_batch` in `test_planning.py`.
  - `test_a_batch_over_the_op_limit_is_refused`: 501 deletes are refused
    with `501 commands`, and 500 deletes preview.
  - `test_a_card_over_the_size_limit_is_refused`: six batch updates of 50,000
    characters each are refused with `the card would hold 300,0` (the
    uids add a few characters), and four are previewed.
  - `test_current_text_counts_toward_the_card_size`: monkeypatch
    `PREVIEW_LIMIT_CHARS` to 250. An update whose `FoundBlock` excerpt is 200
    characters, with a 60-character text, is refused.
  - `test_every_refusal_is_bounded`: monkeypatch `_build` to return
    `Refusal("x" * 10_000)` (the exception wrapper stays). The message is 500
    characters plus `… (10,000 characters)`.

- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_write_preview.py tests/test_planning.py` gives FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` gives PASS.
- [ ] **Step 5: Commit** `git commit -m "assistant: refusal echoes and the approval card are bounded"`

### Task 4: Read the target blocks in the shell; wire both engines (model: opus)

**Files:**
- Create: `server/src/pkm/assistant/target_reader.py` (`# pattern: Imperative Shell`)
- Modify: `server/src/pkm/assistant/claude_engine.py` (`ClaudeEngine(...,
  read_blocks: BlockReader)` is a required keyword; `ClaudeConversation(config_path,
  read_blocks)`; `can_use_tool` awaits `preview_write`)
- Modify: `server/src/pkm/server/app.py` (passes `db_block_reader(config.db_path)`)
- Modify: `server/tests/fake_engine.py` (`FakeEngine(read_blocks: BlockReader | None = None)`;
  new trigger), `server/tests/fake_sdk_client.py` (`make_engine(...,
  read_blocks=lambda uids: {})`), `server/tests/conftest.py` (the
  `fake_engine` fixture takes `seeded_config` and passes
  `db_block_reader(seeded_config.db_path)`), `server/tests/e2e_serve.py`
  (`FakeEngine(read_blocks=db_block_reader(db_path))`)
- Test: `server/tests/test_target_reader.py`,
  `server/tests/test_claude_engine.py`, `server/tests/test_assistant_routes.py`,
  `server/tests/test_fake_engine.py`

**Interfaces:**
- Consumes: `write_target_uids`, `build_write_preview`, `StoredBlock`
  (Task 2).
- Produces, in `target_reader.py`:
  ```python
  BlockReader = Callable[[Sequence[BlockUid]], Mapping[BlockUid, StoredBlock]]

  def db_block_reader(db_path: Path) -> BlockReader: ...
  async def preview_write(short: str, tool_input: Mapping[str, object],
                          read_blocks: BlockReader) -> WritePreview | Refusal: ...
  ```
  `db_block_reader` returns a function that opens `open_db(db_path)`, runs one
  `SELECT b.uid, b.text, p.title FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.uid IN (...)`,
  and closes the connection in a `finally`. `preview_write`:
  1. Deep-copies `tool_input`, so the uids read and the card come from one
     value.
  2. Calls `write_target_uids`.
  3. When there are uids, reads them with `await asyncio.to_thread(read_blocks, uids)`.
  4. Returns `build_write_preview(short, copy, blocks)`.

  Any exception in steps 1 to 3 is logged at WARNING with its type only and
  becomes `Refusal(f"{short}: the blocks this write changes could not be read")`.
- Fake engine trigger: `please update <uid>` (the first whitespace-delimited
  word after it) parks a card for
  `preview_write("update_block", {"uid": <uid>, "text": "Replaced."}, read_blocks)`.
  Allow yields `ToolFinished` and "Updated."; Deny yields "Not updating.".
  Document it in the module docstring with the other triggers.

- [ ] **Step 1: Write the failing tests**
  - `test_target_reader.py`:
    - `test_reader_returns_text_and_page_of_existing_uids`: take a uid from
      conftest `SEED_BLOCKS` and its page title from `SEED_PAGES`, use
      `seeded_config.db_path`, and expect
      `{uid: StoredBlock(title, text)}`. An unknown well-formed uid is
      absent.
    - `test_preview_write_reads_only_what_the_card_shows`: a recording
      reader is called once, with exactly `write_target_uids(...)`, and not
      at all for save_note.
    - `test_a_failing_read_is_a_refusal_not_a_raise`: a reader raising
      `sqlite3.OperationalError` gives a `Refusal` with
      `could not be read`. caplog holds the type name and not the
      exception message.
    - `test_preview_write_is_a_snapshot`: a reader that mutates the caller's
      `tool_input` while reading leaves the card with the original values.
  - `test_claude_engine.py::test_confirm_card_shows_the_blocks_current_text`:
    `make_engine(tmp_path, read_blocks=lambda uids: {VICTIMUID01: StoredBlock("Inbox", "old")})`
    and an `update_block` call give a card with
    `ops[0].current == FoundBlock("Inbox", "old", 3)`.
  - `test_assistant_routes.py::test_confirm_request_carries_current_text`:
    through `assistant_client`, send `please update <seed uid>`. The SSE
    `confirm_request` JSON has `current.state == "found"` and the seed page
    title.

- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_target_reader.py tests/test_claude_engine.py tests/test_assistant_routes.py tests/test_fake_engine.py` gives FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` gives PASS.
- [ ] **Step 5: Commit** `git commit -m "assistant: read each target block when its approval card is built"`

### Task 5: Web parses `current` and allows only each action's keys (model: opus)

**Files:**
- Create: `server/src/pkm/assistant/preview_keys_dump.py` (`# pattern:
  Imperative Shell`, after `pkm/title_whitespace_dump.py`)
- Create (generated): `web/src/assistant/previewKeys.gen.ts`
- Test: `server/tests/test_preview_keys_artifact.py` (after
  `test_title_whitespace_artifact.py`)
- Modify: `web/src/assistant/writePreview.ts` (+ `writePreview.test.ts`)
- Modify: `web/src/assistant/sse.test.ts`,
  `web/src/assistant/AssistantPanel.test.tsx` fixtures (real labels; an
  update op carries `current`)

**Interfaces:**
- Consumes: `WRITE_PREVIEW_FIELDS`, `CURRENT_TEXT_ENTRIES` (Task 2); the SSE
  shape (Task 2).
- Produces, in the dump: `ts_module(fields, current_entries) -> str` and
  `main() -> int`. The output, at most 80 columns per comment line:
  ```ts
  // GENERATED by `uv run python -m pkm.assistant.preview_keys_dump`.
  // Do not edit; regenerate when assistant/policy.py WRITE_PREVIEW_FIELDS
  // or CURRENT_TEXT_ENTRIES changes (server test enforces).
  export type PreviewKeys = { targets: readonly string[];
    content: readonly string[]; current: boolean };
  export const PREVIEW_KEYS: ReadonlyMap<string, PreviewKeys> = new Map([
    ["add outline", { targets: ["page", "parent"], content: ["items"], current: false }],
    ...
  ]);
  ```
  Entries that share a label (`update block`) are merged: union of keys,
  sorted by label. `ts_module` raises `ValueError` when entries sharing a
  label disagree on `current`.
- Produces, in `writePreview.ts`:
  ```ts
  export type CurrentBlock =
    | { state: "found"; page_title: string; excerpt: string; text_length: number }
    | { state: "missing" }
    | { state: "created"; write: number; alias: string };
  // PreviewOp gains: current: CurrentBlock | null
  ```
  `parseOp(raw, index)` rejects the op (so the whole preview is null) when:
  - `PREVIEW_KEYS.get(action)` is undefined;
  - a target key is not in `targets`, or a content key not in `content`;
  - `current` is null while the label's flag is true, or non-null while it
    is false;
  - a found block's `page_title` or `excerpt` is not a string, or its
    `text_length` is not a safe integer at least `[...excerpt].length`;
  - a created block's `write` is not an integer in `1..index` (only an
    earlier write can create it), or its `alias` is not a string.

  Keys keep `escapeLabel`. `page_title`, `excerpt` and `alias` stay raw: the
  card quotes them.

- [ ] **Step 1: Write the failing tests**
  - `test_preview_keys_artifact.py`: the committed file equals
    `ts_module(WRITE_PREVIEW_FIELDS, CURRENT_TEXT_ENTRIES)`; disagreeing
    `current` raises; `main()` prints the module.
  - `writePreview.test.ts`:
    - `validOp` becomes `action: "update block"` with a found `current`.
    - Each rejection above returns null, one case each. The cases include an
      action `"constructor"`, an action `"__proto__"`, a `save note` op
      carrying a `uid` target, and `{state: "created", write: 1}` on the
      first op.
    - `accepts text_length equal to the excerpt's code points ("😀" twice, 2)`
      and `rejects text_length below them ("😀😀", 1)`.
    - Rewrite the key-escaping tests that used unknown keys as rejection
      tests. Keep the warning-escaping test.
  - `sse.test.ts`: the `confirm_request` fixture carries `current` and parses.

- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_preview_keys_artifact.py` and `cd web && pnpm test:unit -- src/assistant` give FAIL.
- [ ] **Step 3:** Implement the dump, generate the file with
  `cd server && uv run python -m pkm.assistant.preview_keys_dump > ../web/src/assistant/previewKeys.gen.ts`,
  then implement the parser.
- [ ] **Step 4:** `cd server && uv run pytest -q tests/test_preview_keys_artifact.py` and `cd web && E2E_PORT=<yours> pnpm verify` give PASS.
- [ ] **Step 5: Commit** `git commit -m "web: approval card parses current text and allows only each action's keys"`

### Task 6: The card shows current text and page; values are LTR (model: opus)

**Files:**
- Modify: `web/src/assistant/AssistantPanel.tsx` (`PreviewOps` renders a
  `CurrentRows` component after the targets and before the warnings)
- Modify: `web/src/styles.css` (`.assistant-confirm-current`: the same layout
  as `.assistant-confirm-target`, with existing tokens per
  `docs/architecture/styling.md`)
- Modify: `web/src/assistant/AssistantPanel.test.tsx`
- Modify: `web/e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: `CurrentBlock` (Task 5), the `please update <uid>` trigger
  (Task 4).
- Copy, exactly (each row a `.assistant-confirm-current` with a
  `.assistant-confirm-key` label):
  - found: `current page: ` + `quoteValue(page_title, false)`. Then
    `current text: `, plus `(first 200 of 1,234 characters)` in
    `.assistant-confirm-length` when `[...excerpt].length < text_length`.
    Under it, a `.assistant-confirm-value.assistant-confirm-text` box holding
    `quoteValue(excerpt)`, then `…` outside the quote when clipped. Numbers
    are `toLocaleString("en-US")`, and the "200" is the excerpt's own
    code-point count.
  - missing: `current text: no block has this uid`.
  - created: `current text: none yet (write 2 above creates it as "a")`, with
    the alias through `quoteValue(alias, false)`.
- Every `<bdi className="assistant-confirm-value ...">` (targets, content,
  current) gets `dir="ltr"`.

- [ ] **Step 1: Write the failing tests** in `AssistantPanel.test.tsx`
  (`op()` defaults to a found `current`):
  - `current page and text follow the targets and precede warnings and
    content`: checked by document order.
  - `a clipped current text says so`: excerpt `"a" * 200` with
    `text_length` 1234 shows `(first 200 of 1,234 characters)` and the value
    text `'"' + "a" * 200 + '"…'`. An unclipped excerpt shows no length and
    no `…`.
  - `a missing block and a block made earlier in the batch`: the exact copy
    above.
  - `every value is left-to-right`: a target `"ד 2"`, a page title `"שלום"`
    and an excerpt starting `‮`. Every `.assistant-confirm-value` has
    `dir="ltr"`, and the excerpt shows `‮` escaped as `\\u202E`.
- [ ] **Step 2:** `cd web && pnpm test:unit -- src/assistant/AssistantPanel` gives FAIL.
- [ ] **Step 3:** Implement the component and styles.
- [ ] **Step 4: e2e** in `assistant.spec.ts`, test `the card shows the
  current text of the block an update targets`:
  - Create page `ApprovalCardTarget${stamp}` and a block with uid
    `act${stamp}` and text `"Original text. ".repeat(20)` (300 characters),
    via `/api/ops` as `assistant-asset-link.spec.ts` does. `afterEach`
    deletes the page.
  - Send `please update act${stamp}`. The card shows
    `current page: "ApprovalCardTarget…"` and
    `(first 200 of 300 characters)`. Deny, and expect `Not updating.`.
  - Send `please update nosuchuid99`. The card shows
    `current text: no block has this uid`. Deny.

  Run `cd web && E2E_PORT=<yours> pnpm verify`, which gives PASS. This spec
  writes shared state, so the full suite runs here too (`pnpm verify` runs
  it).
- [ ] **Step 5: Commit** `git commit -m "web: approval card shows each target block's current text and page; values render LTR"`

### Task 7: Docs, bean, and the merge gates (model: opus)

**Files:**
- Modify: `docs/architecture/assistant.md`. Use the `architecture-docs`
  skill.
  - The file table gets `target_reader.py` and `preview_keys_dump.py`.
  - Rows in the approval-card rules table:
    - current text read in the shell before the card, and why the server is
      the source, not the web;
    - a queued card's snapshot may predate the write before it;
    - excerpt + `text_length`, never a silent cut;
    - reused or premature aliases refused in `pkm.batch`;
    - echoed values clipped by `pkm.echo`, plus the refusal backstop;
    - the op-count and card-size bounds;
    - `dir="ltr"`;
    - the web per-action key list, so an unknown key or action offers Deny
      only.
  - Replace the warning row's "(no such earlier block)" wording.
- Modify: `docs/architecture/backend.md` § Generated artifacts (a row for
  `previewKeys.gen.ts`)
- Modify: `docs/troubleshooting.md` (two rows, bean pkm-g2w9):
  - a reused `as` sent later references to the second block, and the
    warning did not say which;
  - a multi-MB unknown key made a multi-MB refusal on every retry.
- Modify: `.beans/pkm-g2w9--approval-card-low-residuals-from-the-adversarial-r.md`.
  Tick every item, add `## Summary of Changes`, and set completed.

- [ ] **Step 1:** Update the docs. Verify each claim against the code, not
  this plan.
- [ ] **Step 2:** Run `PYTHONPATH=server/tooling python3 -m commentlint.run --all`, which comes back clean.
- [ ] **Step 3:** Run the merge gates with `set -o pipefail`:
  - `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  - `cd web && E2E_PORT=<yours> pnpm verify`
  - `proptest/check.sh server` (`pkm.batch` validation changed)
  - `perf/check.sh` on a quiet machine. Read any regression per AGENTS.md.

  Put the perf table in the review package.
- [ ] **Step 4: Commit** `git commit -m "docs: approval card current text, alias refusal and bounds; complete pkm-g2w9"`
