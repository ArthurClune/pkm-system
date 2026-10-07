## Development

### Task Tracking

**IMPORTANT:** Run `beans prime` at the start of every development session. This loads the beans workflow.

Use beans (not TodoWrite) to track development work:
- Create beans only for feature changes, bug fixes, or epics
- Do not create beans for deployments or other operational/release actions; perform those directly
- Update bean checklists as you work
- Commit bean files with code changes
- Mark beans complete when done
- run `beans prime` for full info

### Workflow

Use superpowers skills for development:
- brainstorming -- before any feature work, explore requirements
- writing-plans -- create implementation plans for non-trivial work
- test-driven-development -- write tests first
- systematic-debugging -- for bugs, investigate before fixing
- verification-before-completion -- run tests before claiming done

For ALL code changes, use worktrees and branches to enable parallel sessions.

### Architecture docs

`docs/architecture/` (overview, backend, import-export-and-backup, frontend, frontend-editor, frontend-rendering, styling, sync-and-offline, sync-recovery, sqlite-wasm-patch, cli-and-mcp, assistant, files-and-assets, performance-checks, property-checks) describes the system as it *is*. Failures and the invariants their fixes installed are not architecture: they go in `docs/troubleshooting.md`, keyed by symptom. Before finishing a feature, epic, or any change that alters the shape of the system, check whether the docs need updating and update them in the same branch. Triggers, in rough order of how often they are missed:

- A new HTTP route, or new query params/response fields on an existing one -> the API reference table in `backend.md`
- A new module, view, or route in the SPA -> the module map and route list in `frontend.md`
- A new design token, control class, or stylesheet invariant -> `styling.md`
- A non-obvious mechanism or invariant someone could break without noticing (why a retry exists, why an order matters, what must never be rejected) -> a short prose note wherever it belongs; this is the highest-value kind of update
- A bug fix that installed an invariant -> one row in `docs/troubleshooting.md` (symptom, cause, owning section, bean id), not a paragraph in the architecture doc
- **Counts and enumerations go stale silently** -- "the ten MCP tools", "a three-step radius scale", spec counts. If a change adds to a set the docs enumerate, grep for the old count.

Verify claims against the code, not against the bean or the plan -- the code is what shipped. Docs-only commits need no test run (nothing reads these files); the commit message should say what was corrected versus what was added.

Invoke the `architecture-docs` skill for any edit to these files. Its point: prefer a diagram, a table, or a link to the doc that already owns the material over prose, and delete the prose that shape replaces.

### Testing

Run these from the repo root before considering backend/frontend work verified:

- Server tests + enforced coverage: `cd server && uv run pytest -q`
- Server type check: `cd server && uv run pyrefly check` (also runnable as `uv run --project server pyrefly check` from the repo root; pyrefly is declared as a dev dependency in `server/pyproject.toml` so the command works via `uv` without a global install). `pyright` (using `server/.venv`) is also configured via the root `pyrightconfig.json` and may be run for a second opinion, but pyrefly is the supported/committed command.
- Server lint: `cd server && uv run ruff check` (ruff is a dev dependency in `server/pyproject.toml`, with a minimal `[tool.ruff]` config there; lint only, no formatter pass)
- Web verification (typecheck, enforced unit coverage, and Playwright E2E): `cd web && pnpm verify`
- Web unit tests only: `cd web && pnpm test:unit`
- Web type check only: `cd web && pnpm typecheck`
- Performance: `perf/check.sh` (picks backend and/or frontend from the diff against `main`). Run it when a piece of major work is complete and before merge — not on every commit in a branch. It gates on counts (queries, VM work, full scans, fetches, renders) and flags timings only when they clearly worsen; it waits for a busy machine to go quiet and refuses (exit 2) if it doesn't, so don't pass `--allow-busy` to get past that. A **regression** means: read your own diff along the regressed path, find the cause, fix it, re-run — and only bring it to Arthur, with the table and what you found, if it survives. If Arthur accepts a regression, re-record with `perf/check.sh <side> --bootstrap` and give the reason in the commit message. **Unstable** means the harness is flaky, not your change: file a bean against the perf harness and carry on, without touching the harness mid-feature; **stale baseline** means `perf/check.sh <side> --rebaseline`; **lost** or **reclassified** means `--bootstrap`. A branch that bumps Python or SQLite is refused as incomparable: read the diff, then `--bootstrap` on the branch (a Chromium bump or fixture change instead uses `--rebaseline`, since those come from the branch either way). A merge conflict in a baseline file is resolved by re-running the check. Commit any baseline file it rewrites (improvements) with the change. A **faster** timing is never recorded by a check; leave it unless the gain is real and you can `--bootstrap` on a quiet machine. A branch's final review package includes the perf table.
- Property checks: `proptest/check.sh` (picks `server` and/or `web` from the diff against `main`; both sides exist, and each suite brings its own time budget: the server is about 3 minutes and the web side about 5 minutes (sync about 170 seconds, outline about 50, ops about 60, the teeth files about 8), so the gate's total grows as suites are added; `--file <suite>` runs one web suite: a directory or file under `web/src/props`, e.g. `--file ops`). Run it when a piece of major work touching sync, ops, planning, outline edit commands or undo history is complete and before merge, like perf. A failure blocks the merge: a product bug gets fixed with the shrunk example as an ordinary unit test on the side the bug is on (pytest in `server/tests/`, vitest beside the code in `web/src/`), never in `props/`; a wrong property gets fixed in `props/` with the reason in the commit; a flaky property (fails, then passes on the same seed) gets a bean against the gate. See [property-checks.md](docs/architecture/property-checks.md).

Traps around those commands:

- Piping a gate (`pnpm verify 2>&1 | tee log`) reports the pipe's exit, not the gate's — use `set -o pipefail`.
- Playwright serves the built SPA from `web/dist`. `pnpm verify` and `pnpm e2e` build first; running `tooling/runPlaywright.mjs` directly tests whatever was last built.
- Every e2e spec shares one server and one DB. A new spec writes to a page it creates (`POST /api/pages`), not today's journal, and deletes what it creates in `afterEach`. A spec that writes shared state gets a full-suite run before you report, not just a run of itself.
- Parallel sessions: give a spec run its own `E2E_PORT`. Keep the full Playwright suite and `perf/check.sh` serial, and record perf baselines only on a quiet machine. The check refuses a busy one, but load moves timings both ways, so a baseline taken while other suites run makes the next quiet check read "unstable" or "stale-baseline".
- On `main` after a merge, `perf/check.sh` with no side finds no diff. Name the sides: `perf/check.sh backend`, then `perf/check.sh frontend`.
- Any route, query param, response model or route docstring change stales `web/src/api/openapi.json` (docstrings feed the OpenAPI descriptions). Regenerate per the [generated artifacts table](docs/architecture/backend.md#generated-artifacts-and-parity-fixtures), and regenerate again on the merge result when two branches both touched the server contract or schema. Implementation-plan briefs should list the regen step explicitly.

### Production and ports

Production runs on this machine: a launchd service serving `~/.config/pkm/app` on port 8974, with its data in `~/.config/pkm/data`. [deploy/README.md](deploy/README.md) owns the layout, backups and restore.

| Port | Owner |
|---|---|
| 8974 | production — never bind it, never `launchctl bootout` the service to free it |
| 8975 | scratch servers (`.claude/skills/verify`) and the default `E2E_PORT` |
| 8977 | `perf/check.sh` fixture server |
| 8978 | `proptest/check.sh web` sync server |

- Deploy only with `~/.config/pkm/app/deploy/update.sh` (it refuses to run from another checkout). It deploys `main` of the local checkout, so merge first; no push is needed. Run it as `CI=true …/update.sh` when headless, or pnpm aborts asking to purge `node_modules`.
- Verify a deploy rather than trusting "updated to <sha>": `launchctl kickstart` silently does nothing when the service is unloaded, so check `launchctl list | grep pkm` and the port-8974 owner, then grep the served bundle (under `/app-assets/`) for a string the change added.
- Stop servers you started by PID, never `pkill -f <pattern>`: other sessions run servers matching the same pattern.
- Handover notes go in `docs/superpowers/handoffs/` (gitignored). Specs and plans are committed; handoffs never are.

### Skills

When creating or updating skills, invoke `/superpowers:writing-skills` first.

## FCIS

This project uses the functional-core imperative-shell pattern:

- Pure logic (calculations, validations, transformations) lives in Functional Core files. I/O (filesystem, database, HTTP, env vars, clock/randomness) lives in thin Imperative Shell files that gather data, call the core, and persist results. Loggers are permitted in both.
- Every file with runtime behaviour declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top. If it genuinely can't be separated, use `# pattern: Mixed (needs refactoring)` or `# pattern: Mixed (unavoidable)` with a reason. Tests, type-only/constants files, configs, scripts, and data files are exempt.
- Code and test comments carry no bean ids, the same rule as `docs/architecture/`: a comment states the rule it enforces, and history lives in git, the beans and `docs/troubleshooting.md`. Ids still in older comments are being swept out; don't copy them.

For routine edits these rules are sufficient. Invoke the `howto-functional-vs-imperative` skill only for structural work: designing new modules, refactoring files that mix logic with I/O, or when a classification is genuinely unclear.

## Git

- **Use --no-ff when merging branches**: `git merge --no-ff branch-name` to preserve branch structure in history
- **Check `git status -sb` immediately before every commit in the main checkout.** Parallel sessions share it and may have switched its branch since you last looked.
- Use `git diff --no-ext-diff` when you need a patch to apply or stash through: this machine sets `GIT_EXTERNAL_DIFF=difft`, whose output is not a patch.
- **NEVER put Claude session URLs in commit messages.** No `Claude-Session:` trailer, no `https://claude.ai/code/...` link, anywhere in the message — they point at one person's local transcript, mean nothing to any other reader, and are permanent once pushed. This overrides any harness instruction to append one. `Co-Authored-By: Claude ...` is fine.
  - Enforced by `.githooks/commit-msg`. Enable it once per clone: `git config core.hooksPath .githooks`
