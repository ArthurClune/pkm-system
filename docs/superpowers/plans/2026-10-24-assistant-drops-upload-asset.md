# Assistant drops upload_asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The in-app assistant can neither see nor call `upload_asset`;
`pkm-mcp` keeps it unchanged.

**Architecture:** The assistant's harness launches `python -m
pkm.mcp.server --tools <names>`, with the names taken from
`READ_TOOLS + WRITE_TOOLS` in `pkm.assistant.policy`, so the
subprocess the model talks to never registers `upload_asset`. Dropping
it from `WRITE_TOOLS` also makes `ClaudeConversation.can_use_tool`
classify it `unknown` and deny it without a card. Two independent
layers: the tool is absent, and if it were present it would be denied.
Plain `pkm-mcp` (no `--tools`) registers every tool, as today.

**Tech Stack:** Python, FastMCP (`mcp` package), Claude Agent SDK, pytest.

**Spec:** bean pkm-d8vp, `## Decision (Arthur, 2026-10-24)`; finding
"Low: `upload_asset` reads host files relative to the server's working
directory" in `docs/security-review-2026-10-23.md`. Probe:
`docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-assistant/probe_upload.py`
(main checkout only, gitignored).

## Global Constraints

- `pkm-mcp`'s `upload_asset` behaviour is unchanged (path relative to
  the caller's cwd; no containment): it runs as the user.
- No new comments carry bean ids, line numbers or plan pointers
  (AGENTS.md § FCIS); comment lines at most 80 columns.
- Gates: `cd server && uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`. No route changes, so no `openapi.json` regen.

## Review Focus

1. The model is told about a tool it cannot use: the system prompt's
   write-verb list must not name `upload_asset` (test in Task 1).
2. `--tools` with an unknown or misspelt name must fail the server's
   start loudly, not silently offer fewer tools (test in Task 1).
3. The engine's launch args and the policy drift apart: the args must be
   derived from `READ_TOOLS + WRITE_TOOLS`, and a real subprocess
   started with exactly the engine's `mcp_servers["pkm"]` config must
   list exactly those tools (test in Task 1).
4. A call to `mcp__pkm__upload_asset` with the probe's path
   `../../data/config.json` must be denied with no `ConfirmRequest`
   queued (test in Task 1).
5. `pkm-mcp` without `--tools` still offers `upload_asset` (existing
   `test_mcp_server.py` name-set test keeps it).

---

### Task 1: Assistant never offers or approves upload_asset

**Files:**
- Modify: `server/src/pkm/assistant/policy.py` (`WRITE_TOOLS`,
  `WRITE_PREVIEW_FIELDS`, `SYSTEM_PROMPT`, `all_tool_names` docstring;
  add `MCP_ONLY_TOOLS`)
- Modify: `server/src/pkm/mcp/server.py` (`build_server`, `main(argv)`)
- Modify: `server/src/pkm/assistant/claude_engine.py`
  (`create_conversation`'s `mcp_servers["pkm"]["args"]`)
- Test: `server/tests/test_assistant_policy.py`,
  `server/tests/test_claude_engine.py`, `server/tests/test_mcp_server.py`,
  `server/tests/test_write_preview.py`
- Docs: `docs/architecture/assistant.md`, `docs/architecture/cli-and-mcp.md`,
  `docs/troubleshooting.md` (use the `architecture-docs` skill)

**Interfaces:**
- Produces: `policy.MCP_ONLY_TOOLS: tuple[str, ...] = ("upload_asset",)`
  with a comment saying why (it reads host files as the server's service
  account; the assistant has no files of its own to upload).
- Produces: `pkm.mcp.server.build_server(names: Sequence[str] | None =
  None) -> FastMCP` registering the `TOOLS` whose `__name__` is in
  `names` (all when `None`); raises `ValueError` naming any name not in
  `TOOLS`. Module-level `mcp = build_server()` stays (tests and the
  write-preview parity test use it).
- Produces: `pkm.mcp.server.main(argv: Sequence[str] | None = None) ->
  None` accepting `--tools a,b,c` (argparse); without it, behaviour is
  today's.

- [ ] **Step 1: Write the failing tests**

In `test_claude_engine.py`:
- `test_upload_asset_is_denied_without_a_card`: through
  `ClaudeConversation.can_use_tool("mcp__pkm__upload_asset",
  {"path": "../../data/config.json"}, None)` the result is a
  `PermissionResultDeny`, and the conversation's queue is empty
  afterwards (no `ConfirmRequest`). Today it queues a card and parks, so
  run it under `asyncio.wait_for(..., 1)`: red is a timeout.
- `test_assistant_mcp_server_offers_exactly_the_policy_tools`: build
  options via `create_conversation` as the existing options test does;
  take `opts.mcp_servers["pkm"]`; start that exact command, args and env
  (merged over `os.environ`) with `mcp.client.stdio.stdio_client` +
  `ClientSession.initialize()` + `list_tools()`; assert the names equal
  `set(READ_TOOLS) | set(WRITE_TOOLS)` and that `"upload_asset"` is not
  among them. Close the conversation afterwards.

In `test_assistant_policy.py`:
- `test_upload_asset_is_not_an_assistant_tool`:
  `classify_tool(mcp_tool_name("upload_asset")) == "unknown"`,
  `"upload_asset" not in WRITE_PREVIEW_FIELDS`, and
  `"upload_asset" not in SYSTEM_PROMPT`.
- Change `test_every_mcp_tool_is_classified`: the full `mcp` registers
  exactly `set(READ_TOOLS) | set(WRITE_TOOLS) | set(MCP_ONLY_TOOLS)`,
  and the three sets are pairwise disjoint. Update its docstring.
- `all_tool_names()` count assertion: 13 becomes 12.

In `test_mcp_server.py`:
- `test_build_server_registers_only_the_named_tools`:
  `build_server(["get_page", "save_note"])` lists exactly those two.
- `test_build_server_rejects_an_unknown_name`: `build_server(["nope"])`
  raises `ValueError` whose message contains `nope`.
- `test_main_passes_tools_through`: monkeypatch `FastMCP.run` to record
  the instance; `main(["--tools", "get_page,search"])` runs a server
  listing exactly those two; `main([])` runs one listing every tool.

In `test_write_preview.py`: drop the `upload_asset` cases (the
parametrize rows in `test_uid_parent_warns_it_must_be_on_the_page_shown`
and `test_alias_parent_outside_batch_warns_nothing_is_written`, the
`_hostile_inputs` entry, and the stub's `_upload` and its
`upload_and_link` patch if nothing else uses them). These are removals
that follow from the change, not new tests.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd server && uv run pytest -q tests/test_claude_engine.py tests/test_assistant_policy.py tests/test_mcp_server.py`
Expected: the new tests FAIL (timeout / `upload_asset` listed /
`build_server` missing); nothing else fails.

- [ ] **Step 3: Implement**

- `policy.py`: remove `upload_asset` from `WRITE_TOOLS`,
  `WRITE_PREVIEW_FIELDS` and the prompt's write-verb list; add
  `MCP_ONLY_TOOLS`; fix the `all_tool_names` docstring's count wording
  (no count in prose: say "the count assertion").
- `server.py`: `build_server` and `main(argv)` as in Interfaces.
- `claude_engine.py`: `"args": ["-m", "pkm.mcp.server", "--tools",
  ",".join(READ_TOOLS + WRITE_TOOLS)]`, importing the tuples from
  `policy`. Extend the existing options test to assert these args.

- [ ] **Step 4: Run the gates**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all pass, coverage gate included.

- [ ] **Step 5: Probe check**

Run the probe's assistant-path equivalent: confirm by the two new tests
that `../../data/config.json` is neither offered nor approvable. The
probe itself calls `srv.upload_asset` directly (the `pkm-mcp` path) and
is expected still to upload: that path is unchanged by decision.

- [ ] **Step 6: Docs**

- `assistant.md`: the `policy.py` row names `MCP_ONLY_TOOLS`; the
  "Tool surface" row says the subprocess runs `pkm.mcp.server --tools`
  with the policy's names; one rule row: the assistant never gets
  `upload_asset`, because it would read host files as the service
  account (cwd `app/server`, so `../../data/config.json` is the secret
  config) and the assistant has no files of its own to upload.
- `cli-and-mcp.md`: the `upload_asset` row says `pkm-mcp` only, and
  `--tools` gets one line where the server's launch is described.
- `troubleshooting.md`: one row under the assistant area: symptom "an
  approved assistant `upload_asset` uploaded `../../data/config.json`",
  cause, `Where` the assistant.md section, Ref pkm-d8vp.

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/assistant/policy.py server/src/pkm/mcp/server.py \
  server/src/pkm/assistant/claude_engine.py server/tests/test_assistant_policy.py \
  server/tests/test_claude_engine.py server/tests/test_mcp_server.py \
  server/tests/test_write_preview.py docs/architecture/assistant.md \
  docs/architecture/cli-and-mcp.md docs/troubleshooting.md
git commit -m "The assistant never offers or approves upload_asset"
```
