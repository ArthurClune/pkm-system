# Outline on Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `get_page`/`get_block` return an outline with uids and sizes when
their result is over a character budget, and the in-app assistant's MCP cap
rises to 40,000 tokens.

**Architecture:** Pure bounded renderers in `pkm/render.py` decide full
render vs outline; `pkm/mcp/tools.py` calls them with a module-level budget
that `pkm-mcp --max-chars` sets; the assistant's harness passes 75,000 and
sets `MAX_MCP_OUTPUT_TOKENS=40000`.

**Tech Stack:** Python 3.12, FastMCP, pytest, uv.

**Spec:** `docs/superpowers/specs/2026-11-05-mcp-page-outline-design.md`
(bean pkm-t44u)

## Global Constraints

- Default budget `45_000` characters; assistant budget `75_000`; assistant
  `MAX_MCP_OUTPUT_TOKENS` `"40000"`, on both the Claude and z.ai routes.
- The budget is measured on the exact string the tool returns (after
  `resolve_refs`), with Python `len()`.
- A result that fits (`len <= max_chars`) is byte-identical to today's
  `render_page`/`render_block(..., include_uids=True)`.
- No silent truncation: every outline says it is one, the full size, and
  to fetch parts with `get_block(uid)`; every clipped text says so.
- AGENTS.md comment rules (80-col comments, no bean ids in code/tests),
  FCIS headers unchanged (`render.py` Functional Core, `tools.py` and
  `server.py` Imperative Shell, `harness_env.py` Functional Core).

## Review Focus

1. A page with so many top-level blocks that even the depth-1 outline is
   over budget: an explicit `RenderError`, never an over-budget outline.
2. Multi-line or very long block text in an outline: first line only,
   clipped at 200 characters, marked, so indentation never breaks.
3. `resolve_refs=True` pushing a page over budget: measured after
   resolution, so it outlines.
4. A result exactly `max_chars` long: returned in full.
5. A heading block clipped in an outline keeps its `##` marker and `^uid`.

Each has a test in Task 1.

---

### Task 1: Bounded renderers in `pkm/render.py`

**Files:**
- Modify: `server/src/pkm/render.py` (after `render_block`)
- Test: `server/tests/test_render.py`

**Interfaces:**
- Produces:
  - `OUTLINE_TEXT_CHARS = 200`
  - `render_page_bounded(payload: PagePayload, max_chars: int, resolve_refs: bool = False) -> str`
  - `render_block_bounded(payload: BlockPayload, max_chars: int, resolve_refs: bool = False) -> str`
  - Both raise `RenderError` when even a depth-1 outline is over `max_chars`.

**Behaviour (the algorithm the tests pin):**

1. `full = render_page(payload, include_uids=True, resolve_refs=...)`
   (`render_block` for blocks). If `len(full) <= max_chars`, return `full`.
2. Otherwise compute each block's subtree size: the `len` of the lines
   `_bullets` would emit for that block and its descendants, joined with
   `"\n"` plus one per line (so the root sizes sum to the body of `full`).
3. Outline line for a block at depth `d`:
   `'  ' * d + '- ' + ('#' * heading + ' ' if heading else '') + text + '  ^' + uid + size`
   where `text` is the (ref-resolved) text's first line, cut to
   `OUTLINE_TEXT_CHARS`, with ` …[clipped]` appended when either cut
   happened; `size` is `f"  ({n:,} chars)"` when the block's subtree is
   not shown in full (children cut by the depth limit, or text clipped),
   else empty.
4. Header, then a blank line, then the outline body:
   - page: `# {title}`, blank, then
     `(Outline only: the full page is {len(full):,} characters, over this tool's {max_chars:,}-character limit. Shown {d} levels deep; "(N chars)" marks a block not shown in full. Fetch one with get_block(uid).)`
   - block: the `(in: crumbs)` line, blank, then the same note with
     "page" replaced by "block".
5. Choose the largest `d` in `1..tree depth` whose whole string is
   `<= max_chars`. If `d = 1` is already over, raise
   `RenderError(f"... is {len(full):,} characters and even its top-level outline is over the {max_chars:,}-character limit; use search instead")`
   (`"the page"` / `"block {uid}"`).

6. `render_block_bounded` only: when the root block has no children and is
   over budget (its own text is the problem, like the spec's
   258,000-character block), raise
   `RenderError(f"block {uid} alone is {len(full):,} characters, over the {max_chars:,}-character limit, and cannot be split; use search to find the passage")`
   rather than returning a one-line outline. In a page outline that
   block is just a clipped, annotated line.

- [ ] **Step 1: Write the failing tests** in `test_render.py`, building
  payloads with the existing `_node`/`_meta` helpers:
  - `test_bounded_page_that_fits_is_the_full_render`: for `PAGE`,
    `render_page_bounded(PAGE, len(full))` `== render_page(PAGE, True)`
    (exactly at the limit, Review Focus 4).
  - `test_bounded_page_over_budget_outlines_to_the_deepest_fitting_level`:
    three levels, the leaf text 500 chars; with a budget between the
    depth-2 and depth-3 outline sizes, output starts with
    `"# T\n\n(Outline only: the full page is "`, contains `"Shown 2 levels deep"`,
    each shown uid as `^uid`, the depth-2 parent annotated
    `f"({size:,} chars)"`, and not the leaf uid.
  - `test_outline_clips_long_and_multiline_text_and_keeps_heading`:
    a heading-2 block with text `"A" * 300 + "\nsecond"` under a tiny
    budget: its line is `"- ## " + "A" * 200 + " …[clipped]  ^" + uid + "  (… chars)"`,
    and `"second"` is absent (Review Focus 2, 5).
  - `test_outline_measures_after_resolve_refs`: a page that fits without
    `resolve_refs` but not with it outlines only when `resolve_refs=True`
    (Review Focus 3).
  - `test_outline_refuses_when_top_level_alone_is_over_budget`: 50 short
    top-level blocks, budget smaller than their depth-1 outline:
    `pytest.raises(RenderError, match="use search")` (Review Focus 1).
  - `test_bounded_block_refuses_a_leaf_too_big_by_itself`: a childless
    block of 1,000 chars, budget 300:
    `pytest.raises(RenderError, match="alone is .* cannot be split")`.
  - `test_bounded_block_outlines_with_breadcrumbs`: a `BlockPayload` over
    budget starts with `"(in: Machine Learning > Papers)\n\n(Outline only: the full block is "`.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_render.py`
  → the new tests fail on import.
- [ ] **Step 3:** Implement the two functions and a shared private helper.
- [ ] **Step 4:** Same command → all pass.
- [ ] **Step 5:** Commit `render: outline a page or block over a character budget`.

### Task 2: MCP tools use the budget; `pkm-mcp --max-chars`

**Files:**
- Modify: `server/src/pkm/mcp/tools.py` (`get_page`, `get_block`, new
  setter beside `require_expect`)
- Modify: `server/src/pkm/mcp/server.py` (`main`)
- Test: `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `render_page_bounded`, `render_block_bounded` (Task 1).
- Produces: `DEFAULT_MAX_CHARS = 45_000`, `set_max_chars(n: int) -> None`
  in `pkm.mcp.tools`; `pkm-mcp --max-chars N` (int, must be > 0, else
  `parser.error`).

- [ ] **Step 1: Write the failing tests:**
  - `test_get_page_outlines_over_the_budget(tools, monkeypatch)`:
    `monkeypatch.setattr(tools, "_max_chars", 60)`;
    `tools.get_page("Machine Learning")` contains `"(Outline only:"` and `"^uid_b2"`.
  - `test_get_block_outlines_over_the_budget`: same for `get_block("uid_b2")`.
  - `test_get_page_under_default_budget_is_unchanged`: default budget,
    `get_page("Machine Learning")` equals today's
    `render_page(..., include_uids=True)` of the same payload.
  - `test_main_passes_max_chars_through(monkeypatch)`: patch
    `FastMCP.run`; `main(["--max-chars", "1234"])` leaves
    `mcp_tools._max_chars == 1234` (restore it via monkeypatch).
  - `test_main_rejects_a_non_positive_max_chars`: `main(["--max-chars", "0"])`
    raises `SystemExit`.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_mcp_server.py` → new tests fail.
- [ ] **Step 3:** Implement. Module global `_max_chars = DEFAULT_MAX_CHARS`.
  Rewrite the `get_page` and `get_block` docstrings (the model's only
  description) to add: past a size limit the tool returns an outline
  instead, headed "(Outline only: ...)", whose `^uid`s fetch the parts
  with `get_block`; pick the part that answers the question rather than
  fetching them all.
- [ ] **Step 4:** Same command → pass.
- [ ] **Step 5:** Commit `mcp: get_page/get_block outline past --max-chars`.

### Task 3: Assistant harness, docs, live check

**Files:**
- Modify: `server/src/pkm/assistant/harness_env.py` (constants +
  `resolve_harness_env`)
- Modify: `server/src/pkm/assistant/claude_engine.py`
  (`create_conversation` server args)
- Test: `server/tests/test_assistant_harness_env.py` (the four
  `env == {"ENABLE_TOOL_SEARCH": "false"}` asserts and the zai test),
  `server/tests/test_claude_engine.py` (`opts.env` and the args assert)
- Docs: `docs/architecture/assistant.md`, `docs/architecture/cli-and-mcp.md`
- Bean: `.beans/pkm-t44u--*.md`

**Interfaces:**
- Produces in `harness_env.py`: `MCP_OUTPUT_TOKENS = 40_000`,
  `MCP_MAX_CHARS = 75_000`. The comment on them states the coupling:
  Claude Code passes a result on its `chars / 4` estimate when that is at
  most half the token cap, so `MCP_MAX_CHARS` must stay under
  `2 * MCP_OUTPUT_TOKENS` or a bounded result can still reach the
  harness's overflow file, which the assistant cannot read.

- [ ] **Step 1: Update the tests first:** expected env becomes
  `{"ENABLE_TOOL_SEARCH": "false", "MAX_MCP_OUTPUT_TOKENS": "40000"}`
  (Claude and z.ai routes); the engine args end
  `[..., "--require-expect", "--max-chars", "75000"]`; add
  `test_mcp_max_chars_stays_under_the_always_pass_bound`:
  `assert MCP_MAX_CHARS < 2 * MCP_OUTPUT_TOKENS`.
- [ ] **Step 2:** `cd server && uv run pytest -q tests/test_assistant_harness_env.py tests/test_claude_engine.py` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → pass.
- [ ] **Step 5: Docs** (invoke the `architecture-docs` skill):
  `cli-and-mcp.md` — `get_page`/`get_block` rows mention the outline, and
  one sentence in the owning section: the budget, `--max-chars`, the
  45,000 default and why (under Claude Code's default cap's always-pass
  bound). `assistant.md` — the Environment/Tool surface row gains
  `MAX_MCP_OUTPUT_TOKENS` and the coupling rule above, with its reason.
- [ ] **Step 6: Full verification:** `cd server && uv run pytest -q`,
  `uv run pyrefly check`, `uv run ruff check` → all clean.
- [ ] **Step 7: Live read-only check against production** (reads only):
  a short `uv run --project server python -c` that sets
  `pkm.mcp.tools._max_chars` and calls `get_page`: `"Rugit"` at 75,000 →
  full (no "Outline only"); `"Rugit"` at 45,000 → outline that includes
  `"[[University of York]] ERP"`; `"Prompt Jailbreaking"` at 75,000 →
  outline; `get_block` on its 258,000-character block → the "cannot be
  split" error; `"Unlinked Papers"` at 75,000 → outline. Every result
  `<= max_chars`.
- [ ] **Step 8:** `perf/check.sh backend`; follow AGENTS.md on any result.
- [ ] **Step 9:** Tick the bean checklist, commit
  `assistant: 40k MCP output cap and a 75k get_page budget`.
