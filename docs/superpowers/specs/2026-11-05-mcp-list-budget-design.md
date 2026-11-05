# MCP list tools under Claude Code's result size

Bean: pkm-erii. Follows pkm-t44u
(`2026-11-05-mcp-page-outline-design.md`). A small change; the short design.

## Why

Claude Code saves an MCP result to a file once it passes its result-size
threshold (50,000 characters unless the tool declares
`anthropic/maxResultSizeChars`). The in-app assistant cannot open that file.
pkm-t44u fixed `get_page`/`get_block`; the list tools still go through the
default threshold, measured on FastMCP's JSON-wrapped text. Production today:
`backlinks` Paper 94,800 characters, `query {and: [[Paper]]}` 98,700,
`query {and: [[Meeting]]}` 63,300, `changed_blocks` since 1 October 63,800,
`backlinks` Meeting 54,800. Hub pages only grow.

## Goals

- No read tool's result is ever diverted to the harness's file.
- A list that fits comes back exactly as today.
- A list that does not fit says so, says how much was left out, and says how
  to narrow the request. Nothing is cut silently.

## Non-goals

- Server-side paging or new route parameters. The cut is made in the MCP
  shell's renderer, on what the route already returns.
- The CLI. `pkm refs`/`query`/`changed`/`todos` keep printing everything.

## Approaches

1. **Declare the size and bound the lists (picked, Arthur: "do both").**
   Every read tool is registered plain text with the declared result size;
   `backlinks`, `query`, `todos` and `changed_blocks` cut at the
   `--max-chars` budget with a partial-list note.
2. **Declare the size only.** A few lines, covers today's worst case (98,700)
   by a hair, and fails again as hub pages grow.
3. **Server-side paging with an offset parameter.** The model then has to
   page through a list it usually wants narrowed instead; more routes and
   contract changes for no better answer.

## Decided

- **Registration.** Every tool in the read set (`get_page`, `get_block`,
  `search`, `query`, `backlinks`, `todos`, `changed_blocks`,
  `search_assets`) is registered with `structured_output=False` and the
  `anthropic/maxResultSizeChars` meta `get_page` already uses. The set
  lives in `pkm.mcp`; a test pins it equal to the assistant's
  `policy.READ_TOOLS`, so a read tool added to one and not the other fails.
  Write tools keep their current registration.
- **Bounded lists.** `backlinks`, `query`, `todos` and `changed_blocks`
  render through bounded variants. When the full render fits `max_chars`,
  the result is byte-identical to today's MCP output. Otherwise:
  - Items are taken in the payload's order, whole, until the next one would
    not fit. No item is skipped to fit a later one. A group's `## page`
    header appears with its first shown item.
  - In a partial list every item line is clipped like an outline line (first
    line, at most `OUTLINE_TEXT_CHARS`, ` …[clipped]` when cut) and carries
    `^uid`, so `get_block(uid)` reaches its full text. Backlink lines gain
    `^uid` in this mode.
  - A note goes right under the tool's own header line (the first line of
    the output; `render_groups` and `render_changed` have none, so it is the
    first line):
    `(Partial list: showing {shown} of {total} blocks from {pages_shown} of {pages_total} pages; the full result is {full:,} characters, over this tool's {max_chars:,}-character limit. {hint})`
  - Hints, per tool:
    - query: `Narrow it with another operand, e.g. {and: [[A]] [[B]]}.`
    - backlinks: `Narrow it with query, e.g. {and: [[<title>]] [[Other]]}.`
      with the real title.
    - todos: `Narrow it with page=.`
    - changed_blocks: `Narrow it with a shorter window or page=.`
  - `total`: `GroupsPayload.total` / `ChangedPayload.total` (which may already
    exceed the items the route returned under `limit`); for backlinks, the
    items returned. `pages_total`: groups returned, or
    `Backlinks.total_pages`.
  - `query`'s per-operand counts line is unchanged (it only appears on an
    empty result, which always fits).
  - If not even the header, note and first item fit, raise `RenderError`
    naming the size and the hint (practically unreachable: a clipped line is
    about 250 characters).
- **Docstrings.** The four tools' docstrings gain one sentence: a partial
  list says so and how to narrow it.

## Left to the builder

- One shared private helper over a neutral (page title, rendered lines)
  shape, so the four tools share the greedy cut; names and placement in
  `render.py`.
- Docs: the cli-and-mcp.md rule that names `get_page`/`get_block` widens to
  the read set; the pkm-t44u troubleshooting row's cause widens to name the
  list tools, with pkm-erii added.
