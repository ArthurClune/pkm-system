---
# pkm-kdsw
title: Add Python type checking to the verification suite; declare pydantic as a direct dependency
status: completed
type: task
priority: normal
created_at: 2026-07-10T10:57:25Z
updated_at: 2026-07-10T11:20:16Z
parent: pkm-m309
---

Remainder of review finding 6. The 17 Pyright errors it reported were already fixed in pkm-t7be (commit b1e27ee — root pyrightconfig.json + pyrefly.toml added, parse_export/query/store narrowed). Still outstanding: (a) there is no repository-supported type-check command in the normal verification workflow, so regressions can land unchecked; (b) server/pyproject.toml does not declare pydantic even though application code imports it directly (it currently arrives transitively via FastAPI).

## Checklist
- [x] Add a committed type-check command (pyright and/or pyrefly) to the standard verification suite and document it
- [x] Add pydantic to [project].dependencies in server/pyproject.toml with an appropriate bound
- [x] Verify: type check → 0 errors; uv run pytest → all pass

## Summary of Changes

- CLAUDE.md Testing section now documents the canonical verification commands (server pytest, `uv run pyrefly check`, web test/typecheck).
- pyrefly>=1.1 added to server dev deps; pydantic>=2 declared as a direct dependency; uv.lock updated.
- Two narrow `# pyrefly: ignore[bad-argument-type]` suppressions on the intentional out-of-range SetHeadingOp test lines.
- Verified: pyrefly 0 errors (2 suppressed), pyright 0 errors, pytest 233 passed. Merged to main 4408a09 (--no-ff).
