---
# pkm-0fx3
title: Add timestamps and request durations to server logs
status: completed
type: feature
priority: normal
created_at: 2026-07-25T17:00:51Z
updated_at: 2026-07-25T17:06:57Z
---

Uvicorn access/error logs have no timestamps and no request durations, which made the 2026-07-25 'filter panel hang' on big pages ([[Politics]]/[[LLMs]]) undiagnosable after the fact. Add (a) timestamps to all server log lines and (b) per-request duration logging for HTTP requests, so the next slow-request incident has a timestamped record.

- [x] Timestamps on uvicorn log output (access + error loggers)
- [x] Per-request duration logging (method, path, status, elapsed ms)
- [x] Tests
- [x] Verify: pytest, pyrefly, ruff (650 passed, 95.67% coverage, clean)

## Summary of Changes

- `pkm/server/logfmt.py` (new, Functional Core): `uvicorn_log_config()` -- uvicorn dictconfig with `%(asctime)s` on every formatter, plus a `pkm.access` logger to stdout; `request_line()` -- access-line formatter (client "METHOD /path?query" status Nms).
- `pkm/server/request_log.py` (new, Imperative Shell): raw ASGI RequestLogMiddleware timing each HTTP request from entry to response-body completion; logs after the body finishes, unhandled exceptions log as 500 and propagate; non-http scopes (websockets, lifespan) pass through untouched.
- `app.py`: middleware wired in create_app().
- `run.py`: passes log_config=uvicorn_log_config() and access_log=False (middleware replaces uvicorn's duration-less access log; streams unchanged -- access to stdout, lifecycle to stderr).
- Smoke-verified on a real boot (port 8123): timestamped lines with durations in both logs.

Context: follow-up to the 2026-07-25 filter-panel hang investigation on big-page linked-refs ([[Politics]]/[[LLMs]]) -- server-side work measured ~4ms, so the hang was environmental; this logging makes the next incident diagnosable.
