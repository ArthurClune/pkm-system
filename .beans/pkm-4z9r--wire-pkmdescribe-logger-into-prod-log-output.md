---
# pkm-4z9r
title: wire pkm.describe logger into prod log output
status: todo
type: bug
priority: normal
created_at: 2026-07-28T07:33:36Z
updated_at: 2026-07-28T10:15:06Z
---

pkm.describe INFO lines (described <sha>: ok/error) never appear in ~/.config/pkm/logs/server.out.log — uvicorn_log_config() doesn't configure that logger, so backfill/describe activity is invisible in prod. Wire it like pkm.access. Found 2026-07-28 while monitoring the pkm-zc0c backfill.

## Summary of Changes

Added a `pkm.describe` logger entry to `uvicorn_log_config()` in `server/src/pkm/server/logfmt.py`, wired identically to `pkm.access`: `{"handlers": ["access"], "level": "INFO", "propagate": False}`. This routes pkm.describe INFO records to the same stdout access handler/formatter instead of silently dropping via root-logger propagation. Updated the function docstring to describe both loggers instead of claiming only pkm.access is added.

TDD: added `test_uvicorn_log_config_routes_pkm_describe_to_stdout` in `server/tests/test_request_log.py` mirroring the existing pkm.access test; confirmed it failed with `KeyError: 'pkm.describe'` before the fix, passed after.

Verification (from server/): `uv run pytest -q` — 822 passed, coverage 95.88% (>=95% required); `uv run pyrefly check` — 0 errors; `uv run ruff check` — all checks passed.
