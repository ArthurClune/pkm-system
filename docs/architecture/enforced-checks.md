# Enforced checks

What fails mechanically in this repo, and when. Each row names the command
that runs it; the doc in the last column owns the detail. Anything not here
is convention plus review (the server-side FCIS boundary, for one).

## On every commit

Both hooks live in `.githooks/`; `git config core.hooksPath .githooks` once per
clone enables them. `--no-verify` bypasses both.

| Hook | Rejects | Owner |
|---|---|---|
| `commit-msg` | a Claude session URL or `Claude-Session:` trailer in the message | `AGENTS.md` § Git |
| `pre-commit` | in any staged source file or architecture doc: a bean id, a line number or a spec/plan pointer with no path in a comment; a comment line over 80 columns or any other line over 120 (`noqa: E501` exempts a line) | [backend.md](backend.md#testing), `server/tooling/commentlint` |
| `pre-commit` | in a staged `server/src` file: a parameter, field or key named like a brand and not carrying it (`uid: str`); a brand constructed or `cast` outside its registered sites; `model_construct`; raw `sqlite3` outside `pkm.database` | [Brand rules](#brand-rules), `server/tooling/brandlint` |

### Brand rules

`server/tooling/brandlint` runs inside `commentlint.run`, so the hook, the
`--all` sweep, `test_the_tracked_tree_is_clean` and `lint:comments` all apply
it. The data it reads is `server/src/pkm/brand_registry.py`, which is
import-free so the hook loads it under a bare `python3`. The hook needs
Python 3.12 or newer: an older interpreter cannot parse a file using PEP 695
syntax and reports `brand-parse` instead of skipping the file.

| Rule | Fails when | Registry data |
|---|---|---|
| `brand-name` | an annotation does not name one of the brands listed for that parameter, field or key name, or also allows its bare base type or `Any` in a union | `NAMES` |
| `brand-opt-out` | `# brand: untrusted -- <reason>` appears outside a route module, or has no reason | `OPT_OUT_FILES` |
| `brand-mint` | a `NewType` declared under `server/src/pkm` is constructed outside its sites | `MINT_SITES` |
| `brand-cast` | `typing.cast` is called outside `CAST_SITES` | `CAST_SITES` |
| `model-construct` | a pydantic model is built with `model_construct` | none |
| `raw-sqlite` | `sqlite3.connect`, a cursor or `.raw` is used outside `pkm.database` | none |
| `brand-parse` | a file cannot be parsed (usually Python older than 3.12) | none |

`server/src/pkm/test_data/` counts as test code and is exempt
(`TEST_SUPPORT`). The database side of the same vocabulary is in
[backend.md](backend.md#typed-database-access).

## On every test run

`cd server && uv run pytest -q`:

| Check | Fails when |
|---|---|
| branch coverage | under 95% (`--cov-fail-under` in `pyproject.toml`) |
| `test_the_tracked_tree_is_clean` | the whole checkout breaks a `pre-commit` rule, so a clone without the hook, or a merge commit, still fails |
| generated artifacts | `openapi.json`, `baseSchema.gen.ts` or a `shared/fixtures/*.json` parity file is stale — see the [table](backend.md#generated-artifacts-and-parity-fixtures) |
| `test_openapi_sync` | a JSON route has no `response_model` |
| `test_routes_models` | a route handler is annotated to return a bare `dict` |
| row check (`PKM_ROW_CHECK=1`, set by `conftest.py`) | a `Db.select` row has a column that is not a `Row` key, or a value that does not fit its key's type, nullability, `Literal` members or brand shape; raises `RowCheckError` |
| `test_rows_vocabulary` | a column of the DDL has no row key, a key's type disagrees with the DDL, a `NAMES` entry names an undeclared brand, or a declared server brand lacks a `SHAPES` or `MINT_SITES` entry |
| `test_brandlint_names`, `test_brandlint_mints` | a brand rule stops flagging its violation, or flags a registered site |
| `test_request_log` | a declared `pkm.*` logger resolves to no handler |
| `test_proptest_exclusion` | a property test runs in the default suite |

`cd web && pnpm verify` runs, in order: `typecheck`, `lint`, `lint:comments`
(the same tree sweep as the pytest row above), `check:fcis`, `test:coverage`,
`vite build`, Playwright.

| Step | Fails when |
|---|---|
| `lint` (`eslint.config.js`) | a hook dependency array drifts, a promise floats or is misused, a non-Error is thrown, a caught error is untyped, `apiFetch` is imported outside the transport boundary, an `any` flows through production code (written, assigned, returned, passed, called or member-accessed), or a disable directive is stale |
| `check:fcis` (`tooling/fcis.mjs`) | a Functional Core module imports an Imperative Shell one at runtime ([overview.md](overview.md#functional-core--imperative-shell)) |
| `test:coverage` | statements or lines under 95%, branches under 91%, functions under 89% (`vite.config.ts`) |
| `genTypes.drift.test.ts` | `types.d.ts` no longer matches `openapi.json` |
| `vite build` (`tooling/viteBudgetPlugin.ts`) | the bundle or precache manifest exceeds a limit in `tooling/budgets.json` |

Server type and lint checks are separate commands, not part of pytest:
`uv run pyrefly check` and `uv run ruff check` (ruff `E501` at 120 shares the
`noqa: E501` override with `pre-commit`). In `server/src`, pyrefly rejects an
implicit `Any` (`implicit-any-*`) and ruff rejects a missing annotation or a
bare `Any` (`ANN`); tests and tooling are exempt. The typing policy is in
[backend.md](backend.md#testing).

## Before a merge

| Gate | Command | Fails when | Owner |
|---|---|---|---|
| performance | `perf/check.sh` | a query, VM-work, full-scan, fetch or render count rises, or a timing clearly worsens against the committed baseline | [performance-checks.md](performance-checks.md) |
| properties | `proptest/check.sh` | a random sequence of ops or sync commands breaks an invariant the model states | [property-checks.md](property-checks.md) |

## Manual

| Check | Command | Catches |
|---|---|---|
| architecture docs | `node .claude/skills/architecture-docs/check-docs.mjs <doc>` | a mermaid block that does not parse, a broken link or anchor (inbound ones too), a bean id in prose |
| deploy guard | `~/.config/pkm/app/deploy/update.sh` | refuses to run from any other checkout ([deploy/README.md](../../deploy/README.md)) |
