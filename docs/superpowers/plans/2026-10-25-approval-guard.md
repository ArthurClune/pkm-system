# Approval Guard: Allow Refuses a Block Edited Since the Card Showed It

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks Allow on the assistant's approval card, the
write applies only if every block the card showed is still as the card
showed it. This covers `update_block` and a batch's updates, moves and
deletes. Otherwise nothing is written and the tool reports the refusal.

**Architecture:** When the card is built, the server records one
expectation per block the card shows: a hash of the block's full stored
text, or for a delete a hash of the whole subtree, or "no block". On Allow,
`can_use_tool` returns the input the card was built from, plus these
expectations as an `expect` argument, through the SDK's
`PermissionResultAllow.updated_input`. The MCP tool forwards `expect` on its
`/api/ops` batch. The server checks every expectation inside the batch's
write transaction, before any op runs, and refuses the whole batch with 412
on a mismatch. A model-supplied `expect` is refused when the card is built.
The browser never sees or sends the hashes.

**Tech Stack:** Python 3.12, FastAPI, pydantic, mcp FastMCP,
claude_agent_sdk 0.2.168, SQLite; React/TS, Playwright.

**Spec:** Arthur's ruling of 2026-10-25, recorded on the bean
(`.beans/pkm-6fcv--approval-card-allow-should-not-overwrite-text-edit.md`).
Its row in `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`
lands on another branch. The ruling, verbatim: "Allow refuses when a block the card shows
was edited after the card showed it. The text the card showed is what Allow
is checked against, for `update_block` and for a batch's updates, moves and
deletes." It builds on the card in `docs/architecture/assistant.md`
§ The write approval card and § The blocks a write changes, and on
`docs/superpowers/plans/2026-10-25-approval-card-targets.md`.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.claude/worktrees/6fcv` (branch
  `security/6fcv`). Run `pwd` first in every shell. Never touch
  `/Users/arthur/code/llm/pkm` directly.
- Ports: a scratch server uses 9036, and Playwright uses `E2E_PORT=8986`. Port
  8974 is production: never bind it.
- Put a `# pattern: Functional Core` / `# pattern: Imperative Shell` header on
  every new file with runtime behaviour (`// pattern:` in TS). Test files are
  exempt.
- Comment lines are at most 80 columns; other lines at most 120. Comments,
  tests and `docs/architecture/` carry no bean ids and no line numbers. Run
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all` before each
  commit. The same sweep runs the brand rules.
- Server gates: `cd server && uv run pytest -q`, `uv run pyrefly check` and
  `uv run ruff check`.
- Web gate: `cd web && set -o pipefail && E2E_PORT=8986 pnpm verify`.
  `pnpm typecheck` plus `pnpm test:unit` is not enough.
- `OpBatch` changes, and so does the `/api/ops` docstring, so regenerate
  per `docs/architecture/backend.md` § Generated artifacts:
  `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`,
  then `cd web && pnpm gen-types`. If a `brand_registry` row is added, also
  run `uv run python -m pkm.rows_dump`.
- Update `docs/troubleshooting.md` (one row) and the owning
  `docs/architecture/` sections through the `architecture-docs` skill.
- Commit by explicit path. Never stage `.beans/` or `web/node_modules`.
  Messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
  and carry no session URL or `Claude-Session:` line.
- e2e specs create their own page (`POST /api/pages`) and delete it in
  `afterEach`, as `web/e2e/assistant.spec.ts` already does.

## Decisions (the executor does not revisit these)

| Question | Decision | Why |
|---|---|---|
| What is hashed | `text_hash(StoredBlock.text)`, using `pkm.contracts.ops.text_hash`, of the full text read when the card is built. Never the 200-character excerpt the card displays. A delete target hashes `subtree_hash` over the `(uid, text)` of the block and every block under it. | The excerpt is a display clip: an edit past character 200 would pass a guard built on it. `text_hash` is the function the server already uses, so both sides hash the same way, `well_formed` included. A delete removes the subtree the card counts ("and N blocks under it"). An edit or a new child under it changes what Allow destroys, so it refuses too. This is the ruling's principle applied to the count the card shows. `subtree_hash` ignores order, so a reorder inside the subtree does not refuse. |
| A move or an update | The moved or updated block's own text hash. A move's children are not guarded. | The card shows the moved block's text only. A move destroys nothing. |
| A uid that is both updated and deleted in one batch | One expectation, the subtree one, which covers the root's text. | One entry per uid. The check runs against the store before the batch. |
| A block missing when the card showed it (`MissingBlock`) | Expectation `absent`. If a block with that uid exists at Allow (a synced offline create), the batch is refused. | The card said "no block has this uid". The user never saw the block that is now there. |
| A block deleted after the card showed it | Refused: `block ((U)) was deleted after the approval card showed it, so nothing was written`. | Without the guard, a batch update would land its text on today's daily note as an orphan edit. That is a write the user approved for a different situation. |
| `{{alias}}` targets (`CreatedInBatch`) and malformed uids | No expectation. | An alias names a block the batch itself creates. A spec `_target_uid` rejects cannot be a stored block: `BlockUid` validation refuses the op (pinned by a Task 4 test). |
| Where the hashes travel | Server to server. `preview_write` builds them from the rows it read. `can_use_tool` returns `PermissionResultAllow(updated_input=<snapshot + expect>)`. The CLI hands that input to the `pkm-mcp` subprocess, whose tool posts it as `OpBatch.expect`. `/api/ops` checks it. | The browser sends only `confirm_id` and a boolean, so it cannot forge or drop a hash. The model never sees `updated_input`, and its own `expect` is refused at the card. The SDK always sends `updatedInput`: `_internal/query.py` falls back to the original input only when ours is None, and we never pass None. A record held in the web process and keyed to the confirm id would need the tool's HTTP call matched to a confirm. Two allowed writes can be in flight at once, so that matching is fragile. |
| Where the check runs | In `routes_ops.post_ops`, after the `batch_id` dedupe read and before `apply_batch`, inside the `BEGIN IMMEDIATE` transaction. | It is atomic with the write, so no edit can land between the check and the write. Checking after dedupe means a retried batch that already applied replays its ack and is not refused by its own effect. |
| No Allow-time re-read in `can_use_tool` | Not added. | The in-transaction check is the one authority. A re-read at Allow would leave a window before the tool's POST, and it duplicates the rule. |
| Status and wording | 412, `detail = {"index": None, "reason": <text>}`, the shape `friendly_error` already reads. The first unmet expectation in `expect` order is reported: `block ((U)) changed after the approval card showed it, so nothing was written`; `block ((U)) or a block under it changed after the approval card showed it, so nothing was written`; `block ((U)) was deleted after the approval card showed it, so nothing was written`; `block ((U)) did not exist when the approval card was shown but does now, so nothing was written`. | 409 already means batch-id reuse in this route. 412 is the precondition status, so no client confuses the two. Uids match `UID_RE`, so they need no echo. |
| How the refusal reaches the user | As the tool's error. FastMCP returns `Error executing tool …: 412: block …`, and the model relays it. The card does not re-show (Arthur: refuse). | The model already relays tool errors such as 404. A retry by the model builds a fresh card against the current text, so a blind retry is still approved by the user. Whether the panel should show the refusal itself is a question for Arthur, not built here. |
| Model-supplied `expect` | `_validate` refuses any input that carries the key, whatever the value (null and `[]` included): `<short>: expect is set by the approval card, never by the caller`. | Overwriting the key on Allow would also be safe, but the card would then preview an argument the tool never receives. A refusal shows the model the rule. |
| Ops-level `base_text_hash` | Unchanged. `edit_block` still sends the hash of the text it reads. Batch updates still send none. | `expect` runs first and refuses on a mismatch. When it passes, the stored text equals the card's, so `base_text_hash` sees a clean edit. That guard still protects `pkm update` and non-assistant MCP callers. It also lets an editor edit pushed after the tool's write land as a conflict copy instead of being lost. |
| Contract shape | `ExpectedBlock {uid, kind: "text"/"subtree"/"absent", shown_hash}`. `shown_hash` is required except for `absent`, where it must be null. `OpBatch.expect: list[ExpectedBlock] = []`, at most `MAX_OPS_PER_BATCH` entries, each uid at most once (422 otherwise). It is not part of `batch_request_hash` or `batch_replay_hash`. | Each command guards at most one uid. The idempotency hashes cover ops only. The web replica never sends `expect`. Only the server's assistant path does, so the replica's offline `/api/ops` shim needs no counterpart. |
| Subtree walk parity | `db_block_reader` replaces `_DESCENDANTS_SQL` with `ops_apply.subtree_rows`, renamed from `_subtree_rows`. The card's count is `len(rows) - 1` and its hash is `subtree_hash` of the rows. The server check uses the same function. | Two walks could disagree on corrupt data, refusing a valid Allow or missing a change. One function cannot disagree with itself. |
| Queued cards on the same block | The second card's Allow is refused if the first card's write changed the block. | Card two showed text that no longer stands, and the ruling refuses that. The `writes_in_flight` stale marker already tells the user beforehand. |

## Review Focus

Ways the guard could be bypassed. Each has a test in its owning task.

- The model sends `expect` itself (a list, `[]`, `null`, or a JSON string),
  hoping to supply stale hashes or an empty guard. It is refused at the card
  (Task 3), and Allow never passes the model's value (Task 4).
- `updated_input` is None or lacks `expect`, so the tool runs the model's raw
  input unguarded. Every write tool's Allow carries `updated_input`, and
  `update_block` and `batch` always carry `expect` (Task 4). A future SDK or
  CLI that ignored `updatedInput` would unguard silently. Task 5 checks the
  real harness once.
- A uid spelling that the expectation and the planner read differently
  (`((uid))`, padding, an alias-like spec), so the guard sits on one uid and
  the write lands on another. Each spec form validate_batch accepts either
  maps to the same uid in both, or the batch cannot write (Task 4).
- The reader's subtree differs from the server's (a cycle, a child added
  between the read and the hash). The reader and the check share
  `subtree_rows`, and a parity test compares their hashes (Task 4).
- A replayed `batch_id` used to skip the check. A replay applies nothing and
  returns the stored ack. A first submission whose expectation fails stores
  no ack, so a later retry is still checked (Task 2).

---

### Task 1: Reproduce the overwrite (red), and let the fake engine run the real tool (model: opus)

**Files:**
- Create: `server/tests/tool_runner.py` (`# pattern: Imperative Shell`)
- Create: `server/tests/test_approval_guard.py`
- Modify: `server/tests/fake_engine.py` (`FakeEngine(read_blocks=None,
  run_tool=None)`; the `please update` trigger runs the tool on Allow when
  `run_tool` is set; module docstring)
- Modify: `server/tests/e2e_serve.py` (wire `run_tool` against its own
  server)
- Modify: `server/tests/test_fake_engine.py`
- Modify: `web/e2e/assistant.spec.ts`

**Interfaces:**
- Produces, in `tool_runner.py`:
  ```python
  def run_tool(short: str, tool_input: Mapping[str, object]) -> str: ...
  def sdk_tool_input(original: Mapping[str, object],
                     decision: PermissionResultAllow) -> dict[str, object]: ...
  ```
  `run_tool` calls `getattr(pkm.mcp.tools, short)` as `pkm-mcp` would:
  `asyncio.run(func_metadata(fn).call_fn_with_arg_validation(fn, False,
  dict(tool_input), None))`. That is FastMCP's own JSON pre-parse and
  argument-model path, without building a `FastMCP`, which would reconfigure
  logging in the e2e server. `sdk_tool_input` returns
  `decision.updated_input` when it is not None, else the original. This is
  what `claude_agent_sdk/_internal/query.py` sends the CLI.
- Produces, in `fake_engine.py`: `FakeEngine(read_blocks: BlockReader | None = None,
  run_tool: Callable[[str, Mapping[str, object]], str] | None = None)`. On
  Allow in `_update`, when `run_tool` is set, it awaits
  `asyncio.to_thread(run_tool, "update_block", <the input the real engine
  would hand the tool>)`. On success it yields `ToolFinished` and then
  "Updated.". On any exception it yields `ToolFinished` and then
  `TextDelta(f"Not updated: {exc}")`. Today "the input the real engine
  would hand the tool" is the input it previewed. Task 4 makes it the
  approval's `tool_input`.
- `e2e_serve.py`: sets `pkm.mcp.tools._client_factory` to build
  `PkmClient(CliConfig(url=f"http://127.0.0.1:{PORT}",
  token=sign_session(bytes.fromhex(config.session_secret), now_ms)))`, and
  passes `FakeEngine(read_blocks=..., run_tool=run_tool)`.

- [ ] **Step 1: Write the red tests.**
  - `test_approval_guard.py`. Each test drives `ClaudeConversation.can_use_tool`
    through `make_engine(tmp_path, read_blocks=db_block_reader(seeded_config.db_path))`,
    in the pattern of `test_claude_engine.py`'s allow test. It reads the
    `ConfirmRequest` off `conv.send(...)` and then runs `meanwhile()`, an
    editor-style write through `pkm_client.post_ops` (an `update_text`
    carries `base_text_hash=text_hash(<old>)`, as the web sends it). Then it
    resolves Allow and runs
    `run_tool(short, sdk_tool_input(tool_input, decision))` with the `tools`
    fixture's client (copy the fixture from `test_mcp_server.py`). Mark the
    `refuses` tests `@pytest.mark.xfail(strict=True, reason="Allow is not
    yet checked against the shown text")`:
    - `test_allow_refuses_an_update_whose_block_was_edited_after_the_card`:
      `update_block` on `uid_of("uid_b4")` to `"Replaced."`. The editor sets
      `"Edited in the editor."`. Running the tool raises `ApiError` with
      `status == 412` and `"changed after the approval card showed it"` in
      `.message`. `pkm_client.get_block(uid).block.text == "Edited in the editor."`.
    - `test_allow_refuses_a_batch_update_whose_block_was_edited`: the same
      through `batch` (`update`).
    - `test_allow_refuses_a_move_of_a_block_whose_text_changed`: a batch
      `move` of `uid_b4` to page `"AI"`. The block stays on its page with
      the edited text.
    - `test_allow_refuses_a_delete_after_a_child_was_added`: a batch
      `delete` of `uid_b2`. Meanwhile a `create` of a child under `uid_b2`.
      The message contains `"or a block under it changed"`, and `uid_b2`,
      `uid_b3` and the new child all still exist.
    - `test_allow_refuses_a_write_to_a_block_deleted_after_the_card`: a batch
      `update` of `uid_b4`. Meanwhile `delete` it. The message contains
      `"was deleted after"`, and today's daily page holds no `"Replaced."`.
    - `test_allow_refuses_a_block_that_appeared_after_the_card_said_none`: a
      batch `update` of a well-formed uid no block has. Meanwhile `create` a
      block with that uid. The message contains `"did not exist when"`, and
      the created block's text is unchanged.
  - Unmarked (they pass before and after):
    `test_allow_applies_when_nothing_changed` (the text becomes
    `"Replaced."`) and
    `test_an_alias_target_needs_no_expectation` (`[create as a on "AI",
    update {{a}}]` applies).
  - `test_fake_engine.py::test_please_update_runs_the_tool_on_allow`: a
    recording `run_tool` gets `("update_block", {"uid": U, "text": "Replaced."})`
    and the turn says "Updated.". A raising `run_tool` gives
    `"Not updated: boom"`. Without `run_tool`, the behaviour is unchanged.
  - `web/e2e/assistant.spec.ts`. Log in, create page
    `ApprovalGuard${stamp}` with block `ag${stamp}` holding `"Shown text."`
    via `/api/ops`, go to `/page/<title>`, then press `Control+j`:
    - `test.fail()` `"Allow refuses an update to a block edited after the
      card showed it"`. Send `please update ag${stamp}` and wait for the
      card. Click `.block-text` with text `"Shown text."`, press `End`, and
      type `" Edited."` with `page.keyboard.type` (real keypresses). Press
      `Escape`, then `waitForServerText(page, title, "Shown text. Edited.")`.
      Click Allow. Expect the panel to show
      `/changed after the approval card showed it/`, the editor's
      `.block-text` to read `"Shown text. Edited."`, and the server page
      texts (poll `/api/page/<title>` as `server-state.ts` does) to contain
      it and not `"Replaced."`.
    - `"Allow applies an update to an unchanged block"`: the same without
      the edit. The panel says "Updated." and the server text becomes
      `"Replaced."`.
- [ ] **Step 2: Run them.**
  `cd server && uv run pytest -q tests/test_approval_guard.py tests/test_fake_engine.py`
  gives the six `refuses` tests as XFAIL (each one overwrites today) and
  the rest as PASS. Then `cd web && set -o pipefail && E2E_PORT=8986 pnpm verify`
  gives PASS, with the `test.fail()` spec reported as an expected failure.
  Open the trace once to confirm the block really reads `"Replaced."`.
- [ ] **Step 3: Commit.**
  `git add server/tests/tool_runner.py server/tests/test_approval_guard.py server/tests/fake_engine.py server/tests/e2e_serve.py server/tests/test_fake_engine.py web/e2e/assistant.spec.ts`
  `git commit -m "tests: reproduce Allow overwriting a block edited while its card was open"`

### Task 2: `/api/ops` refuses a batch whose expected blocks changed (model: sonnet)

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`ExpectedBlock`, `OpBatch.expect`)
- Create: `server/src/pkm/server/ops_expect.py` (`# pattern: Functional Core`)
- Modify: `server/src/pkm/server/ops_apply.py` (rename `_subtree_rows` to
  `subtree_rows`; add `expected_now`)
- Modify: `server/src/pkm/server/routes_ops.py` (the check and the 412;
  docstring)
- Modify: `server/src/pkm/brand_registry.py` only if the brand sweep asks
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_ops_expect.py` (new), `server/tests/test_ops_endpoint.py`,
  `server/tests/test_ops_idempotency.py`, `server/tests/test_ops_apply.py`
  (the rename)

**Interfaces:**
- Produces, in `contracts/ops.py`:
  ```python
  ExpectKind = Literal["text", "subtree", "absent"]

  class ExpectedBlock(WellFormedModel):
      uid: BlockUid
      kind: ExpectKind
      # text_hash of the text ("text") or subtree_hash of the subtree
      # ("subtree") as the approval card showed it; None for "absent"
      shown_hash: Sha256Hex | None = Field(default=None, min_length=64,
                                           max_length=64)
      # model_validator: shown_hash is None exactly when kind == "absent"

  # OpBatch gains:
  #   expect: list[ExpectedBlock] = Field(default_factory=list,
  #                                       max_length=MAX_OPS_PER_BATCH)
  #   with a validator refusing a uid that appears twice
  ```
- Produces, in `ops_expect.py`:
  `def unmet_expectation(expect: Sequence[ExpectedBlock], now: Mapping[BlockUid, Sha256Hex | None]) -> str | None`.
  `now[uid]` is the hash of the expectation's own kind, as stored now, or
  None when no block has the uid. For `absent`, any non-None value means the
  block exists. It returns the first unmet expectation's reason, worded
  exactly as in Decisions, or None.
- Produces, in `ops_apply.py`:
  `def subtree_rows(db: Db, uid: BlockUid) -> tuple[SubtreeRow, ...]` (the
  rename, body unchanged) and
  `def expected_now(db: Db, expect: Sequence[ExpectedBlock]) -> dict[BlockUid, Sha256Hex | None]`.
  `text` and `absent` read `SELECT text FROM blocks WHERE uid = ?` and hash
  it with `text_hash`. `subtree` uses `subtree_rows`: empty gives None, else
  `subtree_hash((r.uid, r.text) for r in rows)`.
- `routes_ops.post_ops`: after the dedupe block and before `apply_batch`,
  `if batch.expect:` compute `unmet_expectation(batch.expect, expected_now(db, batch.expect))`.
  On a reason: `db.rollback()`, then
  `HTTPException(status_code=412, detail={"index": None, "reason": reason})`.
  The docstring gains one sentence: the batch applies only if every
  `expect` entry still holds, checked in the same transaction, else 412 and
  nothing is written.

- [ ] **Step 1: Write the failing tests.**
  - `test_ops_expect.py`. Each Decisions wording appears once, as an exact
    string. Cases: met text gives None; met subtree gives None; `absent`
    with no row gives None; a changed text; a changed subtree; a found block
    now gone (for each of `text` and `subtree`); `absent` now present; with
    two unmet entries, the first in list order is reported.
  - `test_ops_endpoint.py`:
    - `test_expect_refuses_the_whole_batch_with_412`: a batch `[create X on
      "AI", update_text uid_b4]` with `expect=[{uid_b4, "text",
      text_hash("not the text")}]` gives 412 and
      `detail == {"index": None, "reason": "block ((uid_b4)) changed after the approval card showed it, so nothing was written"}`.
      X does not exist and `uid_b4`'s text is unchanged. Resending the same
      `batch_id` with a met `expect` gives 200, so no ack was stored.
    - `test_expect_met_applies`: `text_hash(<seed text>)` gives 200 with the
      text replaced.
    - `test_expect_subtree_sees_a_new_child`: `subtree_hash` of
      `uid_b2`/`uid_b3` is met (200 for a no-op `set_collapsed`). After a
      child is added under `uid_b2`, the same expectation gives 412 with
      `"or a block under it changed"`.
    - `test_expect_absent`: an unused uid gives 200. `uid_b4` as `absent`
      gives 412 with `"did not exist when"`.
    - `test_expect_validation_422`, parametrized: `absent` with a hash;
      `text` without one; a hash of 63 characters; a duplicate uid; 501
      entries.
  - `test_ops_idempotency.py::test_a_replayed_batch_is_not_rechecked`: post
    an update with a met `expect` (200). Repost the identical body: 200 with
    the same ack, though the text no longer matches.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_ops_expect.py tests/test_ops_endpoint.py tests/test_ops_idempotency.py`
  gives FAIL (ImportError: `ExpectedBlock`).
- [ ] **Step 3:** Implement, rename `_subtree_rows` at its callers, then
  regenerate `openapi.json` and `types.d.ts` (Global Constraints). If the
  brand sweep reports `shown_hash`, add the `brand_registry` row and run
  `rows_dump`.
- [ ] **Step 4:** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  gives PASS (`test_openapi_sync.py` included). `cd web && pnpm typecheck`
  gives PASS. Mutation check: delete the `if batch.expect:` block and
  confirm `test_expect_refuses_the_whole_batch_with_412` goes red, then
  restore it.
- [ ] **Step 5: Commit.**
  `git add server/src/pkm/contracts/ops.py server/src/pkm/server/ops_expect.py server/src/pkm/server/ops_apply.py server/src/pkm/server/routes_ops.py server/tests/test_ops_expect.py server/tests/test_ops_endpoint.py server/tests/test_ops_idempotency.py server/tests/test_ops_apply.py web/src/api/openapi.json web/src/api/types.d.ts`
  (plus `brand_registry.py` and `web/tooling/brandRegistry.gen.json` if
  changed)
  `git commit -m "ops: a batch may carry expected blocks; any that changed refuse it with 412"`

### Task 3: The client and the MCP tools forward `expect`; the card refuses a caller's (model: sonnet)

**Files:**
- Modify: `server/src/pkm/client/api.py` (`PkmClient.post_ops`)
- Modify: `server/src/pkm/client/workflows.py` (`edit_block`, `apply_batch`)
- Modify: `server/src/pkm/mcp/tools.py` (`update_block`, `batch`, and their
  docstrings)
- Modify: `server/src/pkm/assistant/policy.py` (`GATE_FIELDS`,
  `GUARDED_TOOLS`)
- Modify: `server/src/pkm/assistant/write_preview.py` (`_validate` refuses
  a caller's `expect`)
- Test: `server/tests/test_client_workflows.py`, `server/tests/test_mcp_server.py`,
  `server/tests/test_write_preview.py`, `server/tests/test_assistant_policy.py`

**Interfaces:**
- Consumes: `ExpectedBlock`, `OpBatch.expect` (Task 2).
- Produces:
  - `PkmClient.post_ops(ops, batch_id: BatchId, expect: Sequence[ExpectedBlock] = ()) -> OpsAck`.
  - `edit_block(client, uid, text=None, mark=None, expect: Sequence[ExpectedBlock] = ()) -> None`.
  - `apply_batch(client, commands, expect: Sequence[ExpectedBlock] = ()) -> OpsAck`.
  - `update_block(uid: BlockUid, text: str | None = None, mark: TaskMark | None = None, expect: list[ExpectedBlock] | None = None) -> str`
    and `batch(commands: list[dict[str, object]], expect: list[ExpectedBlock] | None = None) -> str`.
    Each docstring gains: "`expect` is set by the PKM assistant's approval
    card, which refuses it from anyone else; leave it out."
  - `policy.GATE_FIELDS: frozenset[str] = frozenset({"expect"})`: tool
    arguments only the approval gate sets.
  - `policy.GUARDED_TOOLS: frozenset[str] = frozenset({"update_block", "batch"})`:
    the write tools that take `expect`.
  - `_validate`: before `_unknown_key`, any key in `GATE_FIELDS` gives
    `Refusal(f"{short}: {key} is set by the approval card, never by the caller")`.

- [ ] **Step 1: Write the failing tests.**
  - `test_client_workflows.py`:
    `test_edit_block_sends_expect_and_a_mismatch_writes_nothing`
    (`ApiError.status == 412`, text unchanged) and the met case;
    `test_apply_batch_sends_expect` (412 on mismatch, nothing created).
  - `test_mcp_server.py::test_update_block_expect_through_fastmcp`: call
    `mcp_server.build_server(["update_block"]).call_tool("update_block", {...})`
    with `expect` as a list of dicts, and again as a JSON string (FastMCP
    pre-parse). An unmet entry raises with
    `"changed after the approval card showed it"`.
  - `test_write_preview.py`:
    - `test_a_callers_expect_is_refused`, parametrized over `update_block`
      and `batch` and over the values `[]`, `None`, a valid list, and
      `"[]"`. The refusal is `<short>: expect is set by the approval card,
      never by the caller`, and `write_target_uids(...) == []`.
    - `test_every_tool_field_is_classified`: compare the parameters minus
      `GATE_FIELDS`, and assert `GUARDED_TOOLS` equals the write tools whose
      signature has `expect`.
    - The `_Recorder` parity fakes accept the new `expect` keyword.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_client_workflows.py tests/test_mcp_server.py tests/test_write_preview.py tests/test_assistant_policy.py`
  gives FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the server gates. The six `xfail` tests stay XFAIL.
- [ ] **Step 5: Commit.**
  `git add server/src/pkm/client/api.py server/src/pkm/client/workflows.py server/src/pkm/mcp/tools.py server/src/pkm/assistant/policy.py server/src/pkm/assistant/write_preview.py server/tests/test_client_workflows.py server/tests/test_mcp_server.py server/tests/test_write_preview.py server/tests/test_assistant_policy.py`
  `git commit -m "mcp: update_block and batch forward expect; the approval card refuses one from the model"`

### Task 4: The card records what it showed; Allow hands it to the tool (model: opus)

**Files:**
- Modify: `server/src/pkm/assistant/write_preview.py` (`StoredBlock.subtree_hash`,
  `shown_blocks`, `Approval`, `approved_input`)
- Modify: `server/src/pkm/assistant/target_reader.py` (`subtree_rows`
  replaces `_DESCENDANTS_SQL`; `preview_write` returns `Approval | Refusal`;
  module docstring)
- Modify: `server/src/pkm/assistant/claude_engine.py` (`can_use_tool`)
- Modify: `server/tests/fake_engine.py` (`_park` uses `Approval`; Allow
  runs `approval.tool_input`)
- Modify: `server/tests/test_approval_guard.py` (remove every `xfail`)
- Test: `server/tests/test_write_preview.py`, `server/tests/test_target_reader.py`,
  `server/tests/test_claude_engine.py`, `server/tests/test_fake_engine.py`,
  `server/tests/test_planning.py` (the uid-spec agreement)

**Interfaces:**
- Consumes: `ExpectedBlock`, `subtree_rows`, `expected_now` (Task 2);
  `GUARDED_TOOLS`, `GATE_FIELDS` (Task 3).
- Produces, in `write_preview.py`:
  ```python
  # StoredBlock gains, after ancestors:
  #     subtree_hash: Sha256Hex | None = None   # set for delete targets

  def shown_blocks(short: str, tool_input: Mapping[str, object],
                   blocks: Mapping[BlockUid, StoredBlock]
                   ) -> list[ExpectedBlock]: ...

  @dataclass(frozen=True)
  class Approval:
      preview: WritePreview
      # what the tool runs with on Allow: the input the card was built
      # from, plus `expect` for a tool in GUARDED_TOOLS
      tool_input: dict[str, object]

  def approved_input(short: str, tool_input: Mapping[str, object],
                     blocks: Mapping[BlockUid, StoredBlock]
                     ) -> dict[str, object]: ...
  ```
  `shown_blocks` builds one entry per uid that `_target_uid` gives, in
  first-seen order, over the ops of `_accepted(...)`. A uid that any
  `SUBTREE_DELETE_ENTRIES` op names gets `subtree` with
  `stored.subtree_hash`. A found uid gets `text` with
  `text_hash(stored.text)`. A uid with no row gets `absent`. A found delete
  target whose `subtree_hash` is None raises `ValueError`, since a weaker
  guard must never be issued silently. `approved_input` returns
  `dict(tool_input)` for a tool outside `GUARDED_TOOLS`, else
  `{**tool_input, "expect": [e.model_dump(mode="json") for e in shown_blocks(...)]}`.
  A batch of creates only gets `[]`.
- Produces, in `target_reader.py`:
  `async def preview_write(short, tool_input, read_blocks) -> Approval | Refusal`.
  It calls `build_write_preview` on the snapshot. On a `WritePreview`, it
  returns `Approval(preview, approved_input(short, snapshot, blocks))`. A
  `ValueError` from `approved_input` becomes the existing
  `could not be read` refusal, logged by type. For delete targets, the
  reader calls `subtree_rows(db, uid)` and sets
  `descendants=len(rows) - 1` and
  `subtree_hash=subtree_hash((r.uid, r.text) for r in rows)`.
- `can_use_tool`: the card uses `approval.preview` (stamped as now). Allow
  returns `PermissionResultAllow(updated_input=approval.tool_input)` for
  every write tool.

- [ ] **Step 1: Write the failing tests.**
  - `test_write_preview.py`:
    - `test_shown_blocks_hash_the_full_text_not_the_excerpt`: text
      `"y" * 1000` gives `[ExpectedBlock(uid=A, kind="text", shown_hash=text_hash("y" * 1000))]`,
      and that hash differs from `text_hash("y" * 200)`.
    - `test_a_missing_block_is_expected_absent`, and
      `test_a_malformed_uid_and_an_alias_expect_nothing`.
    - `test_one_uid_updated_moved_and_deleted_expects_its_subtree`: one
      `subtree` entry.
    - `test_shown_blocks_keep_first_seen_order`: update A, move B, delete C
      gives `[A text, B text, C subtree]`.
    - `test_a_delete_target_without_a_subtree_hash_raises`.
    - `test_approved_input`: `save_note` gives its input with no `expect`
      key. A creates-only batch gives `expect == []`. `update_block` gives
      the input plus one entry.
  - `test_target_reader.py`:
    - `test_a_delete_target_carries_its_subtree_hash`: `uid_b2` in
      `count_under` gives `descendants == 1` and `subtree_hash` equal to
      `expected_now(db, [ExpectedBlock(uid=uid_b2, kind="subtree", shown_hash=<it>)])[uid_b2]`,
      so the reader and the server agree. A non-delete target has
      `subtree_hash is None`. The existing count tests stay green.
    - `test_preview_write_returns_an_approval_from_the_snapshot`: a reader
      that mutates the caller's `tool_input` leaves `approval.tool_input`
      with the original values.
  - `test_claude_engine.py`:
    - `test_allow_hands_the_tool_the_carded_input_with_expect`: a reader
      giving `{A: StoredBlock("Inbox", "old")}` and an `update_block` of A
      to `"new"` give `decision.updated_input == {"uid": A, "text": "new", "expect": [{"uid": A, "kind": "text", "shown_hash": text_hash("old")}]}`.
    - `test_allow_carries_updated_input_for_every_write_tool`: `save_note`
      and `rename_page` Allows have `updated_input` equal to their input,
      never None.
    - `test_allow_input_ignores_a_change_to_the_dict_after_the_card`:
      mutating the dict passed to `can_use_tool` before Allow leaves
      `updated_input` unchanged.
  - `test_planning.py::test_uid_specs_the_card_reads_are_the_uids_planned`,
    parametrized over `"uid_b4"`, `"((uid_b4))"`, `" uid_b4"`, `"uid_b4 "`
    and `"{{x}}"` (with a prior `create as x`), for `update`, `move` and
    `delete`. Either `_target_uid` returns the uid `plan_batch` puts on the
    op, or `OpBatch` validation rejects the planned ops, so nothing writes
    unguarded.
  - Remove every `xfail` marker in `test_approval_guard.py`.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_write_preview.py tests/test_target_reader.py tests/test_claude_engine.py tests/test_planning.py tests/test_approval_guard.py`
  gives FAIL.
- [ ] **Step 3:** Implement. Update `fake_engine.py` so Allow runs
  `approval.tool_input`, and the `ConfirmRequest` takes `approval.preview`.
- [ ] **Step 4:** Run the server gates: all PASS, `test_approval_guard.py`
  included. Mutation checks, each restored afterwards: make
  `approved_input` return `dict(tool_input)` for every tool, and confirm
  `test_approval_guard.py` goes red. Then hash `stored.text[:CURRENT_EXCERPT_CHARS]`
  instead of the whole text, and confirm
  `test_shown_blocks_hash_the_full_text_not_the_excerpt` goes red.
- [ ] **Step 5: Commit.**
  `git add server/src/pkm/assistant/write_preview.py server/src/pkm/assistant/target_reader.py server/src/pkm/assistant/claude_engine.py server/tests/fake_engine.py server/tests/test_approval_guard.py server/tests/test_write_preview.py server/tests/test_target_reader.py server/tests/test_claude_engine.py server/tests/test_fake_engine.py server/tests/test_planning.py`
  `git commit -m "assistant: Allow runs the carded input with the blocks it showed as expectations"`

### Task 5: Green e2e, docs, live check and merge gates (model: opus)

**Files:**
- Modify: `web/e2e/assistant.spec.ts` (drop `test.fail()`)
- Modify, through the `architecture-docs` skill:
  - `docs/architecture/assistant.md` § The write approval card: one rule
    row. Allow applies only while every block the card shows stands as
    shown. Name the mechanism (`approved_input`, then `updated_input`, then
    `OpBatch.expect`, checked in `routes_ops`), and say why the hashes never
    pass through the browser or the model and why a caller's `expect` is
    refused.
  - Same file, § The blocks a write changes: replace the closing "Edits from
    outside the turn … are not covered" with the refusal. Replace the
    `_DESCENDANTS_SQL` row with `subtree_rows`, shared with the server
    check.
  - `docs/architecture/backend.md` § The write path: one sentence and one
    flowchart node for the `expect` check after dedupe. § HTTP API
    reference, the `/api/ops` row: "412 when an `expect` entry no longer
    holds; nothing is written".
  - `docs/architecture/cli-and-mcp.md` § The MCP tool surface: the
    `update_block` and `batch` rows mention `expect`, which the approval
    card sets.
- Modify: `docs/troubleshooting.md` § Assistant: one row. Symptom: Allow
  overwrote a block edited in the editor while its card was open; a batch
  update had no guard at all. Cause: the guard was computed when the tool
  ran, not from the text the card showed. Where:
  `assistant.md § The write approval card`. Ref: pkm-6fcv.

- [ ] **Step 1:** Drop `test.fail()`. Run
  `cd web && set -o pipefail && E2E_PORT=8986 pnpm verify`: PASS. This spec
  writes shared state, so the full suite runs here.
- [ ] **Step 2:** Update the docs. Verify every claim against the code, not
  this plan. Then run
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all`: clean.
- [ ] **Step 3: Live check on the real harness** (the `verify` skill, scratch
  server on port 9036). Open a page and ask the assistant to replace one
  block's text. While the card shows, type into that block in the editor
  and wait for it to save, then click Allow. The assistant's reply carries
  the 412 refusal, and the block keeps the typed text. Repeat without
  typing: the write applies. This is the only check that the bundled CLI
  honours `updatedInput` for an MCP tool. Stop the server by PID.
- [ ] **Step 4: Merge gates**, each under `set -o pipefail`:
  - `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  - `cd web && E2E_PORT=8986 pnpm verify`
  - `proptest/check.sh server` (`/api/ops` and `OpBatch` changed)
  - `perf/check.sh` on a quiet machine. A regression means reading the
    `/api/ops` diff first, per AGENTS.md. The perf table goes in the review
    package.
- [ ] **Step 5: Commit.**
  `git add web/e2e/assistant.spec.ts docs/architecture/assistant.md docs/architecture/backend.md docs/architecture/cli-and-mcp.md docs/troubleshooting.md`
  `git commit -m "docs: Allow refuses a block edited since its card showed it; e2e green"`
