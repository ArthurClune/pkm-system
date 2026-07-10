---
# pkm-kdsw
title: Add Python type checking to the verification suite; declare pydantic as a direct dependency
status: todo
type: task
priority: normal
created_at: 2026-07-10T10:57:25Z
updated_at: 2026-07-10T10:57:50Z
parent: pkm-m309
---

Remainder of review finding 6. The 17 Pyright errors it reported were already fixed in pkm-t7be (commit b1e27ee — root pyrightconfig.json + pyrefly.toml added, parse_export/query/store narrowed). Still outstanding: (a) there is no repository-supported type-check command in the normal verification workflow, so regressions can land unchecked; (b) server/pyproject.toml does not declare pydantic even though application code imports it directly (it currently arrives transitively via FastAPI).

## Checklist
- [ ] Add a committed type-check command (pyright and/or pyrefly) to the standard verification suite and document it
- [ ] Add pydantic to [project].dependencies in server/pyproject.toml with an appropriate bound
- [ ] Verify: type check → 0 errors; uv run pytest → all pass
