---
# pkm-5g3d
title: Configure production logging through a parent package logger
status: completed
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:13:10Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 25).

## Context

**References:** logger declarations in `server/src/pkm/server/routes_assets.py:34`, `server/src/pkm/assistant/claude_engine.py:50`, and `server/src/pkm/assistant/service.py:16`; `server/src/pkm/server/logfmt.py:34-57`

Production logging explicitly configures only pkm.access and pkm.describe. New pkm.assets and pkm.assistant loggers can lose intended INFO lifecycle output and project formatting, repeating the logger-registration drift previously fixed for describe.

**Direction:** Configure a parent pkm logger once, with explicit stream/format overrides only where required.

## Tasks

- [x] Add a test enumerating pkm.* loggers and asserting effective handlers/levels
- [x] Replace the open-ended logger allowlist with a parent policy

## Summary of Changes

- `server/src/pkm/server/logfmt.py`: `uvicorn_log_config()` now wires a
  parent `"pkm"` logger (default/stderr handler, level INFO,
  `propagate: False`) instead of listing `pkm.describe` individually.
  Every `pkm.*` child (`pkm.assets`, `pkm.assistant`, `pkm.describe`, and
  any logger added later) inherits handlers/level/format by propagation
  with no entry of its own. `pkm.access` keeps its own explicit override
  (stdout, bare request-line format) since it is genuinely different from
  lifecycle logging - the docstring spells out why.
- Behavior change: `pkm.describe` lines move from stdout (the old
  `pkm.access`-shaped override) to stderr with the level-prefixed
  `default` format, same as `pkm.assets`/`pkm.assistant`/uvicorn's own
  lifecycle logs. Its messages are lifecycle logs ("described %s: %s"),
  not pre-formatted access-style lines, so this is the correct bucket for
  it now that a general policy exists instead of a stdout override copied
  from `pkm.access`.
- `server/tests/test_request_log.py`: replaced the pkm.describe-specific
  config-shape test with one asserting the parent `pkm` entry, added a
  regression test locking in that `pkm.describe` is no longer listed
  individually, and added
  `test_every_declared_pkm_logger_has_an_effective_info_handler`, which
  scans `src/pkm` for every `logging.getLogger("pkm...")` declaration,
  applies `uvicorn_log_config()` via `logging.config.dictConfig` in a
  context manager that snapshots/restores affected loggers afterward (so
  the process-global mutation doesn't leak into other tests), and asserts
  each declared logger resolves to a real handler at INFO via a
  propagation walk mirroring `Logger.callHandlers`. This is the guard
  against the next new `pkm.*` logger repeating the drift silently.
- `docs/architecture/backend.md` § Logging and observability: rewritten
  to describe the parent-logger policy and point at the new enumeration
  test, replacing the stale "any new pkm.* logger must be added here"
  instruction (which was the trap this task removes).

### Verification

- `cd server && uv run pytest -q` — 1040 passed, coverage 96.36% (>= 95%
  required).
- `cd server && uv run pyrefly check` — 0 errors.
- `cd server && uv run ruff check` — all checks passed.

### TDD evidence

RED (`uv run pytest -q tests/test_request_log.py --no-cov`, before the
`logfmt.py` change): 3 failed — `KeyError: 'pkm'`,
`AssertionError: assert 'pkm.describe' not in {...}`, and
`AssertionError: pkm.assistant would drop INFO lifecycle logs (assert 30
<= 20)`, i.e. WARNING effective level for an unconfigured child logger.

GREEN (same command, after the `logfmt.py` change): 12 passed.
