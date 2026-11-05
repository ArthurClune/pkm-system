# MCP List Tools Under the Result Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No pkm-mcp read tool's result is diverted to Claude Code's
overflow file: all read tools declare the result size, and the list tools
cut at the `--max-chars` budget with an explicit partial-list note.

**Architecture:** Pure bounded list renderers in `pkm/render.py` beside the
existing ones; `pkm/mcp/tools.py` calls them with `_max_chars`;
`pkm/mcp/server.py` registers the read set plain text with the declared
size.

**Tech Stack:** Python 3.12, FastMCP, pytest, uv.

**Spec:** `docs/superpowers/specs/2026-11-05-mcp-list-budget-design.md`
(bean pkm-erii)

## Global Constraints

- A list that fits (`len <= max_chars`) is byte-identical to today's MCP
  output of that tool.
- Every returned string is `<= max_chars`.
- Items are taken in payload order, whole; none is skipped to fit a later
  one.
- Partial-list note, verbatim format:
  `(Partial list: showing {shown} of {total} blocks from {pages_shown} of {pages_total} pages; the full result is {full:,} characters, over this tool's {max_chars:,}-character limit. {hint})`
- Hints verbatim: query `Narrow it with another operand, e.g. {and: [[A]] [[B]]}.`;
  backlinks `Narrow it with query, e.g. {and: [[<title>]] [[Other]]}.` (real
  title); todos `Narrow it with page=.`; changed_blocks
  `Narrow it with a shorter window or page=.`
- Clipping reuses `OUTLINE_TEXT_CHARS` and the outline's ` …[clipped]`
  marker; every line in a partial list ends `  ^{uid}`.
- The CLI's output is unchanged (it keeps calling the unbounded renderers).
- AGENTS.md comment rules (80-col comments, no bean ids in code/tests/
  docs/architecture); `render.py` stays Functional Core.

## Review Focus

1. A group whose first item fits but whose later items don't: the group
   header appears once, the note counts that page as shown.
2. Multi-line item text (changed_blocks prints full block text): in a
   partial list it is one clipped line, never a raw multi-line block.
3. `changed_blocks` where the route already capped at `limit`
   (`total > items returned`): the note's `{total}` is the payload total.
4. An empty result or a result exactly `max_chars` long: returned as today.
5. Backlinks title containing `[[`-like or quote characters in the hint:
   the hint is plain text, nothing escaped or broken.

Each has a test in Task 1.

---

### Task 1: Bounded list renderers in `pkm/render.py`

**Files:**
- Modify: `server/src/pkm/render.py` (beside `render_groups`,
  `render_changed`, `render_backlinks`)
- Test: `server/tests/test_render.py`

**Interfaces:**
- Produces:
  - `render_groups_bounded(payload: GroupsPayload, max_chars: int, hint: str) -> str`
    (used for query and todos; `include_uids=True` behaviour of
    `render_groups` when it fits)
  - `render_changed_bounded(payload: ChangedPayload, tz: tzinfo, max_chars: int, hint: str) -> str`
  - `render_backlinks_bounded(title: RawTitle, backlinks: Backlinks, max_chars: int) -> str`
    (builds its own hint from `title`)
  - All three raise `RenderError` when not even header + note + first item
    fit.

**Behaviour:** full render first; if it fits, return it. Otherwise one
shared private helper builds: the tool's header line if it has one
(`# Backlinks: ...` for backlinks), the note, then for each group in order a
blank-line-separated `## page` header with its first shown item, and item
lines in that tool's line shape (changed keeps `- [when] status: ` before
the clipped text) ending `  ^uid`, stopping at the first item that does not
fit with the note's final length accounted for. The note's counts are
computed from what was actually shown.

- [ ] **Step 1: Write the failing tests:**
  - `test_bounded_groups_that_fit_are_unchanged`: for a small
    `GroupsPayload`, `render_groups_bounded(p, len(full), hint) == render_groups(p)`;
    an empty payload likewise (Review Focus 4).
  - `test_bounded_groups_cut_whole_items_in_order_with_note`: 3 pages × 4
    items of 300 chars; budget fitting about 5 items: output contains the
    note with `showing 5 of 12 blocks from 2 of 3 pages`, the hint
    verbatim, `len(out) <= budget`, the first page header once, items 1–5's
    uids in order and not item 6's (Review Focus 1).
  - `test_partial_list_clips_multiline_text`: an item `"x" * 500 + "\nsecond"`
    appears as `- ` + 200 `x` + ` …[clipped]  ^uid`, and `"second"` is
    absent (Review Focus 2).
  - `test_bounded_changed_uses_payload_total`: `ChangedPayload` with
    `total=900` and 20 items, over budget: note says `of 900 blocks`, lines
    keep the `[HH:MM] new:` prefix (Review Focus 3).
  - `test_bounded_backlinks_note_and_uids`: over budget, first line is the
    unchanged `# Backlinks: T (N pages)`, the note follows, the hint names
    the title verbatim (use a title with a quote and parentheses, Review
    Focus 5), and every item line ends `^uid`.
  - `test_bounded_list_refuses_when_first_item_cannot_fit`:
    `pytest.raises(RenderError)` with a budget smaller than header + note.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_render.py` →
  new tests fail on import. Record the output.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → pass.
- [ ] **Step 5:** Commit `render: cut MCP list results at a character budget`.

### Task 2: Register the read set; list tools use the budget

**Files:**
- Modify: `server/src/pkm/mcp/tools.py` (`query`, `backlinks`, `todos`,
  `changed_blocks`, docstrings; a `READ_TOOL_NAMES` tuple)
- Modify: `server/src/pkm/mcp/server.py` (`build_server`)
- Test: `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: Task 1's three renderers.
- Produces: `READ_TOOL_NAMES: tuple[str, ...]` in `pkm.mcp.tools` (the eight
  read tools); `build_server` registers each with
  `structured_output=False` and the existing `_RESULT_META`, replacing the
  `fn in (get_page, get_block)` test.

- [ ] **Step 1: Write the failing tests:**
  - `test_read_tool_names_match_the_assistant_read_tools`:
    `set(tools.READ_TOOL_NAMES) == set(policy.READ_TOOLS)` (import
    `pkm.assistant.policy` in the test only).
  - `test_every_read_tool_is_plain_text_with_the_declared_size`: for each
    name, the registered tool on `build_server()` has structured output off
    and `meta == {"anthropic/maxResultSizeChars": MAX_RESULT_CHARS}`, read
    from FastMCP's tool manager the way the existing get_page/get_block
    registration test does; write tools are unchanged.
  - `test_query_backlinks_todos_changed_cut_at_the_budget(tools, pkm_client, monkeypatch)`:
    seed a page whose blocks all reference a fresh page title (enough
    ~1,000-char blocks to exceed a 6,000 budget), set `_max_chars` to 6,000:
    `query`, `backlinks`, `todos` (make them TODOs) and `changed_blocks`
    each return `<= 6000` characters containing `(Partial list:`.
  - `test_list_tools_under_default_budget_are_unchanged`: on the fixture
    data, each of the four equals its unbounded render.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_mcp_server.py` → fail.
- [ ] **Step 3:** Implement. Docstrings of the four gain one sentence: past
  a size limit the list is cut, says so, and says how to narrow it.
- [ ] **Step 4:** Same command → pass.
- [ ] **Step 5:** Commit `mcp: every read tool under the declared result size`.

### Task 3: Docs, harness check, perf

**Files:**
- Docs: `docs/architecture/cli-and-mcp.md`, `docs/troubleshooting.md` (the
  pkm-t44u row), `docs/architecture/assistant.md` only if it names the
  get_page/get_block-only registration
- Bean: `.beans/pkm-erii--*.md`

- [ ] **Step 1: Docs** (invoke `architecture-docs` first): widen the
  registration rule from get_page/get_block to the read set, and add the
  partial-list behaviour to the list tools' rows; widen the troubleshooting
  row's cause and add pkm-erii to its bean cell. Run
  `node /Users/arthur/code/llm/pkm/.claude/skills/architecture-docs/check-docs.mjs docs/architecture/cli-and-mcp.md docs/troubleshooting.md`
  from the worktree root.
- [ ] **Step 2: Full verification:** `cd server && uv run pytest -q`,
  `uv run pyrefly check`, `uv run ruff check` → clean.
- [ ] **Step 3: Harness check through the bundled CLI** (reads only):
  reuse the fake-API driver from pkm-t44u
  (`/private/tmp/claude-501/-Users-arthur-code-llm-pkm/484970d6-aec9-4e9c-95e6-b3463f38995c/scratchpad/cc/`,
  `run_pkm_head.sh`, `fakeapi*.py`) with this worktree's pkm-mcp at
  `--max-chars 75000` and `MAX_MCP_OUTPUT_TOKENS=40000`: `backlinks`
  "Paper", `query {and: [[Paper]]}`, `query {and: [[Meeting]]}`,
  `changed_blocks` since 2026-10-01. Each tool result the fake API receives
  is plain text `<= 75000` containing `(Partial list:` (Paper, Paper query)
  or the whole list (Meeting query, changed), never `<persisted-output>`.
  Record the table.
- [ ] **Step 4:** `perf/check.sh backend`; follow AGENTS.md on any result.
- [ ] **Step 5:** Tick the bean checklist; commit
  `docs: the read set's declared size and partial lists`.
