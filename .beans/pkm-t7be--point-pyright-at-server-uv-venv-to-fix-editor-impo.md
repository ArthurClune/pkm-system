---
# pkm-t7be
title: Point Pyright at server uv venv to fix editor import noise
status: completed
type: task
priority: normal
created_at: 2026-07-10T10:05:08Z
updated_at: 2026-07-10T10:09:28Z
---

Editor Pyright reports 'Import could not be resolved' for pytest/starlette/pkm.* in server tests because the workspace root has no pyrightconfig — add one targeting server/.venv.

## Summary of Changes

- Added root `pyrightconfig.json` (venvPath=server, venv=.venv, extraPaths=server/src) so editor Pyright resolves the uv venv — kills the 'Import could not be resolved' noise. Editor language server needs a reload to pick it up.
- Added root `pyrefly.toml` — the new pyrightconfig.json was being treated by pyrefly as a project-root marker, making `pyrefly check` from the repo root scan everything with default config (171 bogus errors). Now root runs match in-server runs (0 errors, 40 modules).
- Fixed the 17 real type errors Pyright surfaced once imports resolved:
  - parse_export.py: narrow `db.value` to dict in the existing ValueError guard; entity dicts typed `dict[str, Any]` (dynamic EDN data).
  - query.py: assert page nodes carry a title before building params.
  - store.py: assert the page row exists after INSERT in get_or_create_page instead of returning `Row | None` as `Row`.

Verified: pyright server → 0 errors; pyrefly check from root and server/ → 0 errors; pytest → 233 passed.
