---
# pkm-bymy
title: 'MCP/CLI fast-follows: batch heading memoization, atomic config write, update-stdin newline'
status: todo
type: task
created_at: 2026-07-19T18:02:50Z
updated_at: 2026-07-19T18:02:50Z
---

Follow-ups from the pkm-w05j final whole-branch review (branch worktree-pkm-w05j-mcp-cli, review 2026-07-19):

- [ ] cli/build.py: memoize headings created by _Planner per (page, level, text) so a batch that repeats a missing '## Heading' parent spec reuses the created heading instead of duplicating it (Important finding; docstring workaround shipped in bfc8294)
- [ ] client/api.py save_config: write the config file atomically with 0600 from creation (os.open with mode) instead of write-then-chmod TOCTOU; the file holds a year-long session token
- [ ] cli/main.py: strip trailing newline(s) when 'pkm update <uid> -' reads text from stdin (currently sends 'text\n', a shape the editor never produces)
- [ ] docs: note in README/spec that --json exists on read verbs only (spec said 'every verb')
