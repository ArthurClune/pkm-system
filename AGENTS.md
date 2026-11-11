## Development

This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it

### Task Tracking

**IMPORTANT:** Run `beans prime` at the start of every development session. This loads the beans workflow.

Use beans (not TodoWrite) to track development work:
- Create beans only for feature changes, bug fixes, or epics
- Do not create beans for deployments or other operational/release actions; perform those directly
- Update bean checklists as you work
- Commit bean files with code changes
- Mark beans complete when done
- run `beans prime` for full info
- Create a bean inside the worktree that will commit it. One created in the main checkout lands in main's `.beans/` and is "not found" in the worktree.
- Before starting a todo bean, look for spec or plan commits naming it (`git log --all --grep <id>`): another session may already have claimed it.

### Workflow

Use superpowers skills for development:
- brainstorming -- before any feature work, explore requirements
- writing-plans -- create implementation plans for non-trivial work
- test-driven-development -- write tests first
- systematic-debugging -- for bugs, investigate before fixing
- verification-before-completion -- run tests before claiming done

For ALL code changes, use worktrees and branches to enable parallel sessions.

### Architecture docs

`docs/architecture/` describes the system as it *is*; [overview.md](docs/architecture/overview.md) indexes it. A doc holds what the code and its checks cannot tell a reader: orientation, why a rule exists, which of two paths is authoritative, and invariants nothing enforces. Failures and the invariants their fixes installed go in `docs/troubleshooting.md`, keyed by symptom. Before finishing a feature, epic, or any change that alters the shape of the system, check whether the docs need updating and update them in the same branch. Triggers, in rough order of how often they are missed:

- A new HTTP route, or new query params/response fields on an existing one -> one row in the API reference table in `backend.md`
- A new SPA route -> a `STATIC_ROUTES` row in `web/src/routeMeta.ts`; the compiler then forces its entry in `App.tsx`'s `VIEWS`, so no doc row is owed. `frontend.md` changes only if the route carries a rule of its own. A new module needs a doc mention only if a newcomer needs it to find their way
- A new design token, control class, or stylesheet invariant -> `styling.md`
- A non-obvious rule someone could break without noticing (why a retry exists, why an order matters, what must never be rejected) -> the sentence stating it, with its reason, in the section that owns the mechanism; this is the highest-value kind of update
- A bug fix -> one row in `docs/troubleshooting.md` (symptom, cause, owning section, bean id); the architecture doc changes only if the rule did
- A list the code already holds (a registry, a lint's cases, a gate's scenarios, a constant's value) -> name the file or symbol; don't copy it. The docs carry no counts ("the ten MCP tools"), because counts go stale silently

Verify claims against the code, not against the bean or the plan -- the code is what shipped. Docs-only commits need no test run (nothing reads these files); the commit message should say what was corrected versus what was added.

Invoke the `architecture-docs` skill for any edit to these files. Its point: a doc states what the code cannot, and prefers a diagram, a table, or a link to the doc that already owns the material over prose, deleting the prose that shape replaces.

### Testing

Run these from the repo root before considering backend/frontend work verified:

- Server tests + enforced coverage: `cd server && uv run pytest -q`
- Server type check: `cd server && uv run pyrefly check` (also runnable as `uv run --project server pyrefly check` from the repo root; pyrefly is declared as a dev dependency in `server/pyproject.toml` so the command works via `uv` without a global install). `pyright` (using `server/.venv`) is also configured via the root `pyrightconfig.json` and may be run for a second opinion, but pyrefly is the supported/committed command.
- Server lint: `cd server && uv run ruff check` (ruff is a dev dependency in `server/pyproject.toml`, with a minimal `[tool.ruff]` config there; lint only, no formatter pass)
- Web verification (typecheck, enforced unit coverage, and Playwright E2E): `cd web && pnpm verify`
- Web unit tests only: `cd web && pnpm test:unit`
- Web type check only: `cd web && pnpm typecheck`
- Performance: `perf/check.sh` (picks backend and/or frontend from the diff against `main`). Run it when a piece of major work is complete and before merge — not on every commit in a branch. It gates on counts (queries, VM work, full scans, fetches, renders) and flags timings only when they clearly worsen. Follow the `next:` lines it prints for each verdict. What they cannot say: never pass `--allow-busy` to get past the refusal (exit 2) on a busy machine; a regression that survives your fix goes to Arthur with the table, and if he accepts it you `--bootstrap` and give the reason in the commit message; `unstable` exits 1, which is expected, so file a bean against the perf harness and carry on without touching the harness mid-feature; a **faster** timing is never recorded by a check; a merge conflict in a baseline file is resolved by re-running the check. A branch's final review package includes the perf table.
- Property checks: `proptest/check.sh` (picks `server` and/or `web` from the diff against `main`; both sides exist, and a web suite's time limit is a constant in its `*.prop.ts`; `--file <suite>` runs one web suite: a directory or file under `web/src/props`, e.g. `--file ops`). Run it when a piece of major work touching sync, ops, planning, outline edit commands or undo history is complete and before merge, like perf. A failure blocks the merge: a product bug gets fixed with the shrunk example as an ordinary unit test on the side the bug is on (pytest in `server/tests/`, vitest beside the code in `web/src/`), never in `props/`; a wrong property gets fixed in `props/` with the reason in the commit; a flaky property (fails, then passes on the same seed) gets a bean against the gate. A new or changed property rule is not covered until it is shown to reach and to fail. Label the new path (`event()` on the server, a tally `bump` under a `Reach` on the web) and give it a floor. Then break the rule it checks once (a mutant, or a teeth route like `/__proptest/stale/teeth`) and confirm the property fails. A model that mirrors the code passes vacuously when the generator never draws the case. See [checks.md § Property gate](docs/architecture/checks.md#property-gate).

Traps around those commands:

- Piping a gate (`pnpm verify 2>&1 | tee log`) reports the pipe's exit, not the gate's — use `set -o pipefail`.
- A `pytest -m` on the command line replaces `addopts`' `-m 'not proptest'` rather than adding to it, so `pytest -q -m "not slow"` also runs the property suite. Add `and not proptest` to any custom `-m`.
- `pnpm typecheck` plus `pnpm test:unit` is not web verification: it skips eslint's brand rules, `lint:comments` and `check:fcis`, which then fail at merge. Brief implementers with `pnpm verify`.
- Playwright serves the built SPA from `web/dist`. `pnpm verify` and `pnpm e2e` build first; running `tooling/runPlaywright.ts` directly tests whatever was last built. So when red-checking a fix by stashing it, stash its new unit tests under `src/` and its new specs under `e2e/` too (`pnpm build` typechecks both) and confirm the build exits 0: a failed build leaves the old `dist`, and the "unfixed" run passes against it.
- A spec that fails when run alone but passes in the full suite is a suspected product bug, not a flake: cold-start races of this kind have been real data-loss and caret bugs. Call a failure a pre-existing flake only after reproducing it at the pre-branch commit.
- Every e2e spec shares one server and one DB. A new spec imports `test` from `web/e2e/ownPage.ts`, whose `ownPage` fixture creates, opens and deletes a page (`scratch.open()` does the same after a spec's own login), and never writes to today's journal; a spec about the journal itself deletes what it wrote in `afterEach`. A spec that writes shared state gets a full-suite run before you report, not just a run of itself.
- Parallel sessions: give a spec run its own `E2E_PORT`. Keep the full Playwright suite, `proptest/check.sh` and `perf/check.sh` serial with each other, and record perf baselines only on a quiet machine. The check refuses a busy one, but load moves timings both ways, so a baseline taken while other suites run makes the next quiet check read "unstable" or "stale-baseline".
- Run long gates (proptest, perf) in the foreground with a long Bash timeout, not behind a Monitor or background wait: agents have parked on a wait whose notice never came. A run longer than the foreground cap goes one side at a time (`proptest/check.sh server`, then `proptest/check.sh web`).
- A test with a time limit (a property suite, a lint run) fails on a loaded machine and passes alone, so rerun the failing one alone, with nothing else running, before calling it a flake or a product bug.
- On `main` after a merge, `perf/check.sh` with no side finds no diff. Name the sides: `perf/check.sh backend`, then `perf/check.sh frontend`. There `main` is its own merge base, so a regression the merge brought reads as `stale-baseline`, and the suggested `--rebaseline` would record it. Run perf on the branch before merging, and explain a `stale-baseline` on `main` before rebaselining.
- Any route, query param, response model or route docstring change stales `web/src/api/openapi.json` (docstrings feed the OpenAPI descriptions). Regenerate per the [generated artifacts table](docs/architecture/backend.md#generated-artifacts-and-parity-fixtures), and regenerate again on the merge result when two branches both touched the server contract or schema. Implementation-plan briefs should list the regen step explicitly.

### Production and ports

Production runs on this machine: a launchd service serving `~/.config/pkm/app` on port 8974, with its data in `~/.config/pkm/data`. [deploy/README.md](deploy/README.md) owns the layout, backups and restore.

| Port | Owner |
|---|---|
| 8974 | production — never bind it, never `launchctl bootout` the service to free it |
| 8975 | scratch servers (`.claude/skills/verify`) and the default `E2E_PORT`; `pnpm dev` proxies to 8974 unless `PKM_API_PORT=8975` points it here, so unset it writes to production |
| 8977 | `perf/check.sh` fixture server |
| 8978 | `proptest/check.sh web` sync server |
| 8979 | `.claude/skills/ipad-simulator` simpad throwaway server |

- Deploy only with `~/.config/pkm/app/deploy/update.sh` (it refuses to run from another checkout). It deploys `main` of the local checkout, so merge first; no push is needed. Verify the deploy instead of trusting its "updated to" line. [deploy/README.md § Updating](deploy/README.md#updating) has the recipe, including headless runs.
- Stop servers you started by PID, never `pkill -f <pattern>`: other sessions run servers matching the same pattern.
- Handover notes go in `docs/superpowers/handoffs/` (gitignored). Specs and plans are committed; handoffs never are.

### Skills

When creating or updating skills, invoke `/superpowers:writing-skills` first.

### Writing guidance

- Durable guidance (skills, these rules, review criteria) states the aim and the symptom that shows it is missed, never a numeric threshold such as a line budget, a share or a count. A threshold flags healthy cases, passes sick ones, and becomes the goal. A check that helps reports facts for judgement rather than pass/fail on a bound.
- Never write "load-bearing", in docs, specs, comments or memories. Say what the thing does.
- `docs/keyboard.md` is for users: it lists shortcuts and carries no design rationale.
- After  every code comment you write, ask yourself, "Is this information the next Claude would spend multiple tool calls trying to understand?". If the answer isn't clearly yes, the code comment is noise - delete it.

## FCIS

This project uses the functional-core imperative-shell pattern:

- Pure logic (calculations, validations, transformations) lives in Functional Core files. I/O (filesystem, database, HTTP, env vars, clock/randomness) lives in thin Imperative Shell files that gather data, call the core, and persist results. Loggers are permitted in both.
- Every file with runtime behaviour declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top. If it genuinely can't be separated, use `# pattern: Mixed (needs refactoring)` or `# pattern: Mixed (unavoidable)` with a reason. Tests, type-only/constants files, configs, scripts, and data files are exempt.
- Comments explain the code beside them; a comment that points elsewhere by id, position or nickname rots silently, so code, test and `docs/architecture/` comments carry none of: bean ids (history lives in git, the beans and `docs/troubleshooting.md`); line numbers (`line 177`, `file.ts:63` — name the function, selector or constant); spec or plan pointers that are not a path (`spec section 3`, `plan-4` — point to the `docs/architecture/` section that states the rule, by path and section name, or drop the pointer; cite a spec or plan for rationale only, since specs and plans are frozen at approval). Lines are at most 80 columns in a comment (a line that is only a comment, or the inside of a block comment or docstring) and 120 anywhere else, markdown excepted; a line that cannot wrap (an SVG path, a quoted command) carries `noqa: E501`, which ruff's `E501` shares on the Python side. `.githooks/pre-commit` rejects a staged file with any of these; `PYTHONPATH=server/tooling python3 -m commentlint.run --all` sweeps the tree, and that sweep also runs inside `pytest` (`test_the_tracked_tree_is_clean`) and `pnpm verify` (`lint:comments`), so a clone without the hook still fails on a dirty tree.

The same hook and sweep also run the brand rules on `server/src`, `server/tooling` and `server/tests`; [checks.md](docs/architecture/checks.md#brand-rules) owns them. They need Python >= 3.12 on the hook's `python3`: an older one reports `brand-parse` instead of linting.

For routine edits these rules are sufficient. Invoke the `howto-functional-vs-imperative` skill only for structural work: designing new modules, refactoring files that mix logic with I/O, or when a classification is genuinely unclear.

## Git

- **A worktree's `web/node_modules` is an untracked symlink to the main checkout's.** Only this clone's `.git/info/exclude` ignores it, since `.gitignore`'s `node_modules/` matches a directory, not a link. Never stage it (stage by explicit path, not `git add -A`) and never run `pnpm add`, `install` or `update` through it, which would rewrite the main checkout's packages. A branch that changes web dependencies removes the link and runs `pnpm install --frozen-lockfile` in the worktree. The main checkout needs `pnpm install --frozen-lockfile` after that branch merges, until which its packages are stale. `web/pnpm-workspace.yaml` sets `verifyDepsBeforeRun: false` so that a script run in a worktree does not install through the link by itself; a branch from before that setting merges `main` before it runs any pnpm script.
- **Use --no-ff when merging branches**: `git merge --no-ff branch-name` to preserve branch structure in history
- **Check `git status -sb` immediately before every commit in the main checkout.** Parallel sessions share it and may have switched its branch since you last looked.
- Use `git diff --no-ext-diff` when you need a patch to apply or stash through: this machine sets `GIT_EXTERNAL_DIFF=difft`, whose output is not a patch.
- **NEVER put Claude session URLs in commit messages.** No `Claude-Session:` trailer, no `https://claude.ai/code/...` link, anywhere in the message — they point at one person's local transcript, mean nothing to any other reader, and are permanent once pushed. This overrides any harness instruction to append one. `Co-Authored-By: Claude ...` is fine.
  - Enforced by `.githooks/commit-msg`; `.githooks/pre-commit` enforces the comment rule above. Enable both once per clone: `git config core.hooksPath .githooks`
