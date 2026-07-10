---
# pkm-dxoh
title: 'Review cleanup: docs, lint/format, E2E temp dirs, deprecation and future-flag warnings'
status: completed
type: task
priority: low
created_at: 2026-07-10T10:57:44Z
updated_at: 2026-07-10T11:59:41Z
parent: pkm-m309
---

Review 'Consistency and documentation observations' — small independent cleanups.

## Checklist
- [x] Update design/implementation docs: global search shortcut is Cmd/Ctrl-U (changed from Cmd-K in 87360cb4 for a Firefox conflict); tests already assert Cmd-K does not open search
- [x] Add a Python formatter/linter (e.g. ruff) to match the frontend's strict checks
- [x] E2E server (server/tests/e2e_serve.py): clean up the tempfile.mkdtemp() directory instead of accumulating test graphs
- [x] Opt into / test React Router v7 future flags to silence repeated warnings and reduce upgrade risk
- [x] Migrate the backend TestClient integration off the deprecated Starlette/httpx path (httpx2 per the warning)

## Summary of Changes

- Durable design spec now documents Cmd/Ctrl-U search (historical dated docs left as-is).
- ruff added as lint-only dev dep (line-length=120), flagged issues fixed, command documented in CLAUDE.md.
- e2e_serve.py cleans its mkdtemp dir via atexit + custom SIGINT/SIGTERM handlers (uvicorn's capture_signals re-raise defeats plain atexit); verified with real signals; .server.log path unaffected.
- React Router v7 future flags via shared ROUTER_FUTURE_FLAGS constant across app + all MemoryRouter test sites; no more warnings.
- TestClient deprecation silenced by swapping dev dep httpx→httpx2 (no code imports httpx directly).
- Server 272 passed/0 warnings, ruff + pyrefly clean; web 255 passed/0 router warnings, tsc clean. Merged to main (--no-ff).
- Deferred minor: signal-handler comment claims Unix killed-by-signal exit semantics but handler exits 0; tighten comment or exit 128+signum.
