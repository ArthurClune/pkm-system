---
# pkm-bymy
title: 'MCP/CLI fast-follows: batch heading memoization, atomic config write, update-stdin newline'
status: completed
type: task
priority: normal
created_at: 2026-07-19T18:02:50Z
updated_at: 2026-07-19T18:23:09Z
---

Follow-ups from the pkm-w05j final whole-branch review (branch worktree-pkm-w05j-mcp-cli, review 2026-07-19):

- [x] cli/build.py: memoize headings created by _Planner per (page, level, text) so a batch that repeats a missing '## Heading' parent spec reuses the created heading instead of duplicating it (Important finding; docstring workaround shipped in bfc8294)
- [x] client/api.py save_config: write the config file atomically with 0600 from creation (os.open with mode) instead of write-then-chmod TOCTOU; the file holds a year-long session token
- [x] cli/main.py: strip trailing newline(s) when 'pkm update <uid> -' reads text from stdin (currently sends 'text\n', a shape the editor never produces)
- [x] docs: note in README/spec that --json exists on read verbs only (spec said 'every verb')

## Summary of Changes

- `server/src/pkm/cli/build.py`: `_Planner` now caches missing `'## Heading'`
  parents by `(page, level, text)`. `creates()` reuses the cached uid on a
  repeat spec instead of appending a second heading-create op; updated the
  class docstring to describe the memoization.
- `server/src/pkm/client/api.py` `save_config`: writes to a `.{name}.{token}.tmp`
  file in the same directory via `os.open(..., O_WRONLY|O_CREAT|O_EXCL, 0o600)`,
  then `os.replace`s it over the target — no window where the file exists with
  default permissions, and no partial file lands at the real path.
- `server/src/pkm/cli/main.py` `cmd_update`: when text comes from stdin (`-`
  or omitted-then-stdin), trailing `\n` characters are stripped after read;
  other trailing whitespace is left untouched.
- Docs: `server/src/pkm/mcp/server.py`'s `batch` docstring and README's batch
  example no longer describe the "heading created once per command, use an
  alias" workaround (the memoization fix removes the need for it); the
  `docs/superpowers/specs/2026-07-19-mcp-cli-design.md` spec's "`--json` on
  every verb" line is corrected to name the read verbs (`get`, `search`,
  `refs`, `query`, `todos`) — it already matched in README.

All new tests were written first and confirmed to fail against the
pre-fix code (TDD), then implementations added: `test_cli_build.py::
test_plan_batch_reuses_repeated_missing_heading`, `test_client_api.py::
test_save_config_creates_via_atomic_exclusive_tempfile`, `test_cli_main_write.py::
test_update_stdin_strips_trailing_newline` and
`test_update_stdin_strips_multiple_trailing_newlines_only`.

Verification (from worktree root): `cd server && uv run pytest -q` → 601
passed, 95.27% coverage (gate is 95%); `uv run pyrefly check` → 0 errors;
`uv run ruff check` → all checks passed.
