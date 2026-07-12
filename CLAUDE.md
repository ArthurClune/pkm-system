## Development

### Task Tracking

**IMPORTANT:** Run `beans prime` at the start of every development session. This loads the beans workflow.

Use beans (not TodoWrite) to track development work:
- Create beans for bugs, features, and tasks
- Update bean checklists as you work
- Commit bean files with code changes
- Mark beans complete when done
- run `beans prime` for full info

For general assistant tasks (research, calendar, email, etc.), just do them directly.

### Workflow

Use superpowers skills for development:
- brainstorming -- before any feature work, explore requirements
- writing-plans -- create implementation plans for non-trivial work
- test-driven-development -- write tests first
- systematic-debugging -- for bugs, investigate before fixing
- verification-before-completion -- run tests before claiming done

Use worktrees and branches to enable parallel sessions.

### Testing

Run these from the repo root before considering backend/frontend work verified:

- Server tests + enforced coverage: `cd server && uv run pytest -q`
- Server type check: `cd server && uv run pyrefly check` (also runnable as `uv run --project server pyrefly check` from the repo root; pyrefly is declared as a dev dependency in `server/pyproject.toml` so the command works via `uv` without a global install). `pyright` (using `server/.venv`) is also configured via the root `pyrightconfig.json` and may be run for a second opinion, but pyrefly is the supported/committed command.
- Server lint: `cd server && uv run ruff check` (ruff is a dev dependency in `server/pyproject.toml`, with a minimal `[tool.ruff]` config there; lint only, no formatter pass)
- Web verification (typecheck, enforced unit coverage, and Playwright E2E): `cd web && pnpm verify`
- Web unit tests only: `cd web && pnpm test:unit`
- Web type check only: `cd web && pnpm typecheck`

### Skills

When creating or updating skills, invoke `/superpowers:writing-skills` first.

## FCIS

This project uses the functional-core imperative-shell pattern:

- Pure logic (calculations, validations, transformations) lives in Functional Core files. I/O (filesystem, database, HTTP, env vars, clock/randomness) lives in thin Imperative Shell files that gather data, call the core, and persist results. Loggers are permitted in both.
- Every file with runtime behaviour declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top. If it genuinely can't be separated, use `# pattern: Mixed (needs refactoring)` or `# pattern: Mixed (unavoidable)` with a reason. Tests, type-only/constants files, configs, scripts, and data files are exempt.

For routine edits these rules are sufficient. Invoke the `howto-functional-vs-imperative` skill only for structural work: designing new modules, refactoring files that mix logic with I/O, or when a classification is genuinely unclear.

## Git

- Always push after committing -- don't leave commits unpushed
- **Use --no-ff when merging branches**: `git merge --no-ff branch-name` to preserve branch structure in history
