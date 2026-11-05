# Pages too big for one tool result: outline on overflow

Bean: pkm-t44u. A small change; this is the short design.

## Why

The in-app assistant could not read the Rugit page. `get_page` rendered
58,423 characters, Claude Code's MCP output check (`MAX_MCP_OUTPUT_TOKENS`,
default 25,000 tokens) refused it, and the harness saved the result to a file
the assistant has no tool to open (it runs with `tools=[]`). The model got
there in the end by paging `changed_blocks` by date, which is luck, not
design.

How Claude Code 2.1.301 applies the cap L: a result estimated at
`chars / 4 <= L / 2` always passes; over `4 * L` estimated tokens it always
fails; in between it asks the API for an exact count. `^uid` markers make
page text token-dense: Rugit counted over 25,000 tokens at 58k characters.

Rendered page sizes in production (4,518 pages): 99% are under 14,400
characters, 7 are over 50,000, 2 over 100,000 (Prompt Jailbreaking and
Unlinked Papers, about 280,000 each).

## Goals

- The assistant reads any page whole when it fits, and otherwise sees
  the page's shape and fetches the part it needs, without ever hitting
  Claude Code's opaque overflow file.
- Every read of a normal-sized page costs exactly what it does today.

## Non-goals

- Paging inside one block's text. Exactly one block in the PKM is over the
  limit (a 258,000-character block on Prompt Jailbreaking).
- Size guards on `search`, `changed_blocks`, `query`, `todos` or
  `backlinks`. `changed_blocks` already has `limit`.
- A `section` parameter. `get_block(uid)` already fetches a subtree, and a
  uid cannot be ambiguous the way duplicate heading text can.

## Anti-goals

- Silent truncation. An outline says plainly that it is an outline, how big
  the full result was, and how to get the rest.

## Approaches

1. **Outline on overflow (picked).** `get_page` and `get_block` render as
   now; past a character budget they return an outline instead. No new
   tool, no extra call for normal pages, and the model never meets Claude
   Code's file-saving error. Costs a budget that has to sit below each
   client's cap.
2. **A separate `page_outline` tool.** The model learns a page is too big
   only from a failed `get_page`, or must outline every page first: an
   extra call per read either way.
3. **A `depth` parameter only.** Says nothing about where a page's bulk is;
   Unlinked Papers at depth 2 is still 94,000 characters.

Arthur picked 1, and asked that the model go straight to the right part
when it can identify it.

## Decided

- **Assistant cap.** `resolve_harness_env` adds
  `MAX_MCP_OUTPUT_TOKENS=40000` to the harness env, on both the Claude and
  z.ai routes. Results up to 80,000 characters then pass on the estimate
  alone.
- **Budget.** `pkm-mcp` takes a `--max-chars` flag. The assistant passes
  75,000 (under the 80,000 always-pass bound, leaving room for JSON
  escaping and the `{"result": ...}` wrapper). The default, for Claude
  Desktop, claude.ai and Claude Code sessions, is 45,000: under the 50,000
  always-pass bound of Claude Code's default cap. The budget is measured
  on the rendered string the tool returns, after `resolve_refs`.
- **Outline shape (Claude's call).** Header lines first: that this is an
  outline, the full size in characters, and "fetch a part with
  get_block(uid)". Then the blocks as the normal `^uid` outline, to the
  deepest level whose outline fits the budget, each block annotated with
  its subtree's rendered size. Expanding by whole levels gives the model
  content to choose by, not just headings: under the 45,000 default,
  Rugit's outline reaches depth 5 (33,000 characters), which includes the
  topic lines under each `### [[date]]` meeting ("[[University of York]]
  ERP"). Under the assistant's 75,000, Rugit (58,000) now loads whole.
- **Recursion.** `get_block` on a subtree over budget returns the same kind
  of outline of that subtree.
- **A block too big by itself.** `get_block` on a block whose own text is
  over the budget returns an explicit refusal naming its size, suggesting
  `search`. Never part of it.
- **Docstrings.** The `get_page` and `get_block` docstrings (the model's
  only description of the tools) say what an outline is and what to do
  with one.

## Left to the builder

- Where the outline renderer lives (`pkm/render.py` beside
  `render_page`/`render_block` is the natural home; it is Functional Core).
- How the outline annotates size and clips very long block text (a long
  first line in an outline must still say it is clipped).
- The exact header wording.
- Whether the assistant's system prompt (`policy.py`) needs a line beyond
  the docstrings; add one only if a live check shows the model
  mishandling an outline.
- Docs: `docs/architecture/cli-and-mcp.md` (the tool table and the budget
  rule) and `docs/architecture/assistant.md` (the harness env and why 40k).
