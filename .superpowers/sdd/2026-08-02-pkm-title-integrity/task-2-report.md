Status: DONE

Commit hash(es):
- 6bac8f6d9a21b20b578193b052310d4fb1a10490 `feat(pkm-2ilw): plan title migration deterministically`

Files changed:
- `.beans/pkm-2ilw--canonicalize-existing-space-padded-page-titles-dat.md`
- `server/src/pkm/title_migration.py`
- `server/src/pkm/rename.py`
- `server/tests/test_title_migration_core.py`
- `server/tests/test_rename.py`
- `.superpowers/sdd/2026-08-02-pkm-title-integrity/task-2-report.md`
- `.superpowers/sdd/2026-08-02-pkm-title-integrity/progress.md`

RED command and expected failure evidence:
- Planner grouping RED:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py`
  - Result: collection failed with `ModuleNotFoundError: No module named 'pkm.title_migration'`
- Digest RED:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py`
  - Result: `2 failed, 1 passed` with `assert '' == '17aecc5828a82c45c37a0ded91aa9ff1776534cc76cc1b4d42fdef24e7f143b7'` and `assert '' != ''`
- Simultaneous rewrite RED:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_rename.py`
  - Result: collection failed with `ImportError: cannot import name 'rewrite_title_refs_map' from 'pkm.rename'`

GREEN/final commands and exact result summaries:
- Planner grouping GREEN:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py`
  - Result: `1 passed in 0.01s`
- Digest GREEN:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py`
  - Result: `3 passed in 0.01s`
- Simultaneous rewrite GREEN:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_rename.py`
  - Result: `20 passed in 0.01s`
- Final focused suite:
  - Command: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py tests/test_rename.py tests/test_refs.py`
  - Result: `50 passed in 0.04s`
- Final type check:
  - Command: `cd server && uv run pyrefly check`
  - Result: `INFO 0 errors (11 suppressed, 3 warnings not shown)`
- Final lint:
  - Command: `cd server && uv run ruff check`
  - Result: `All checks passed!`

Bean updates:
- Appended a `pkm-2ilw` note recording that Task 2 landed the pure planner and simultaneous rewrite core while inventory/apply/API work remains pending.
- Left the top-level checklist items unchecked because Task 2 is only part of the broader migration item.

FCIS review:
- `server/src/pkm/title_migration.py` is new `# pattern: Functional Core`; it contains only deterministic grouping, counting, payload shaping, and SHA-256 digesting over supplied inventory rows.
- `server/src/pkm/rename.py` remains `# pattern: Functional Core`; the new map-based rewrite still performs pure text scanning/splicing with no I/O.
- No mixed-concern runtime files were introduced.

Self-review findings/fixes:
- Kept digest expectations independent in `server/tests/test_title_migration_core.py` by building the canonical JSON payload in the test rather than reusing production digest helpers.
- Verified only boundary U+0020 participates in grouping/blocking, so NBSP-padded titles stay untouched while all-space ASCII titles stay explicit blockers.
- The rewrite scanner skips nested inner spans when the outer title itself is remapped, avoiding overlapping-splice corruption while preserving the old single-map wrapper behavior.

Production-safety confirmation:
- Worked only in `/Users/arthur/code/llm/pkm/.worktrees/pkm-mk87-title-integrity` on branch `pkm-mk87-title-integrity`.
- Did not access, copy, audit, or mutate any production PKM database or production CLI config.
- Did not use port `8974`.
- All verification stayed inside the worktree test environment.

Concerns:
- None.
