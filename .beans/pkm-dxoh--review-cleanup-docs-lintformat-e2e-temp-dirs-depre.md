---
# pkm-dxoh
title: 'Review cleanup: docs, lint/format, E2E temp dirs, deprecation and future-flag warnings'
status: in-progress
type: task
priority: low
created_at: 2026-07-10T10:57:44Z
updated_at: 2026-07-10T11:42:29Z
parent: pkm-m309
---

Review 'Consistency and documentation observations' — small independent cleanups.

## Checklist
- [ ] Update design/implementation docs: global search shortcut is Cmd/Ctrl-U (changed from Cmd-K in 87360cb4 for a Firefox conflict); tests already assert Cmd-K does not open search
- [x] Add a Python formatter/linter (e.g. ruff) to match the frontend's strict checks
- [ ] E2E server (server/tests/e2e_serve.py): clean up the tempfile.mkdtemp() directory instead of accumulating test graphs
- [ ] Opt into / test React Router v7 future flags to silence repeated warnings and reduce upgrade risk
- [ ] Migrate the backend TestClient integration off the deprecated Starlette/httpx path (httpx2 per the warning)
