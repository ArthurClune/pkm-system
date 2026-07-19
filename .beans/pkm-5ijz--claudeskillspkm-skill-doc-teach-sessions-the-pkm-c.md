---
# pkm-5ijz
title: .claude/skills/pkm skill doc — teach sessions the pkm CLI/MCP
status: todo
type: task
created_at: 2026-07-19T18:09:00Z
updated_at: 2026-07-19T18:09:00Z
---

Write a project skill (.claude/skills/pkm/SKILL.md) so Claude Code sessions know to drive the PKM through the pkm CLI (and pkm-mcp where relevant) instead of poking the DB or HTTP by hand.

Content to cover:
- when to use: reading/writing PKM pages, blocks, TODOs from a session
- login/config: uv run pkm login (--password-stdin for scripts), PKM_CLI_CONFIG / PKM_URL overrides, ~/.config/pkm-cli/config.json
- read verbs: get (page/today/uid, --uids/--json), search, refs, query, todos
- write verbs: save (outline via stdin, --parent, --todo), update (-D/-T, base_text_hash safety), upload, batch (atomic JSON command array, as:/{{alias}} parents; NB heading parents are created once per command — create once with as:)
- pointers: README 'CLI and MCP access' section, uv run pkm <cmd> --help

Process: invoke /superpowers:writing-skills FIRST when writing the skill (CLAUDE.md requirement).

- [ ] Write skill doc
- [ ] Verify a fresh session picks it up and uses the CLI
