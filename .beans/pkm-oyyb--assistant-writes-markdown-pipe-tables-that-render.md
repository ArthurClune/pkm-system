---
# pkm-oyyb
title: Assistant writes markdown pipe tables that render nowhere
status: completed
type: bug
created_at: 2026-09-25T15:55:10Z
updated_at: 2026-09-25T15:55:10Z
---

The in-app assistant got confused about table format: it wrote markdown pipe tables, which render nowhere. Neither the chat panel nor note blocks have a pipe-table rule, because the chat panel renders replies through the same `tokenizeBlock` inline renderer as notes. Its system prompt said nothing about tables and told it to "answer in plain markdown", which invites pipe tables. The MCP tool docstrings said nothing about tables either. The only guidance lived in the Claude Code `pkm` skill, which the in-app assistant never sees.

## Fix
- [x] `SYSTEM_PROMPT` (`assistant/policy.py`) gains a Tables section:
  - pipe tables render nowhere, so chat answers use lists;
  - notes use the `{{table}}` macro: rows are children, cells are a chain of single children, and a second child anywhere collapses the table to a plain outline;
  - worked `save_note` example;
  - placeholder for blank interior cells;
  - offer `Attribute:: value` for wide tables.
- [x] The style line says "no pipe tables".
- [x] `save_note` MCP docstring carries the short `{{table}}` rule, so external MCP clients get it too.
