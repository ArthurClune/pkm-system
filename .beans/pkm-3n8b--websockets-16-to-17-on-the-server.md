---
# pkm-3n8b
title: websockets 16 to 17 on the server
status: completed
type: task
priority: normal
created_at: 2026-11-18T11:18:26Z
updated_at: 2026-11-18T11:30:12Z
parent: pkm-tcca
---

Part of pkm-tcca. Lift the <17 bound in server/pyproject.toml. Only uvicorn's WebSocket transport uses websockets (its auto mode picks the sans-I/O protocol), which pytest does not reach.

- [x] Lift the bound and lock websockets 17
- [x] uvicorn's sans-I/O protocol imports and serves /api/ws against 17
- [x] Full Playwright suite and a live sync session pass
- [x] Server gates green

## Summary of Changes

websockets 16.0 to 17.4; server/pyproject.toml now says websockets>=17. uvicorn 0.54's ws="auto" resolves to WebSocketsSansIOProtocol (the new API, not websockets.legacy), and the app does not pick an implementation, so nothing else changed. The e2e server serves through serve_as_production, so Playwright drove the real transport: 130 passed, including 'edits broadcast live to a second client', with no exception or deprecation in the server log. pytest 6204 passed (98.17%), pyrefly and ruff clean, pip-audit clean.
