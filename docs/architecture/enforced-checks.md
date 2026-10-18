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
| `pre-commit` | in a staged `server/src`, `server/tooling` or `server/tests` file: a parameter, field or key named like a brand and not carrying it (`uid: str`, or no annotation); a brand constructed, held as a value or `cast` outside its registered sites; `model_construct`; raw `sqlite3` outside `SQLITE_SITES` | [Brand rules](#brand-rules), `server/tooling/brandlint` |

### Brand rules

`server/tooling/brandlint` runs inside `commentlint.run`, so the hook, the
`--all` sweep, `test_the_tracked_tree_is_clean` and `lint:comments` all apply
it. The data it reads is `server/src/pkm/brand_registry.py`, which is
import-free so the hook loads it under a bare `python3`. The hook needs
Python 3.12 or newer: an older interpreter cannot parse a file using PEP 695
syntax and reports `brand-parse` instead of skipping the file.

| Rule | Fails when | Registry data |
|---|---|---|
| `brand-name` | an annotation does not name one of the brands listed for that parameter, field or key name, or also allows its bare base type or `Any` in a union; or a function parameter with that name has no annotation (a lambda's is not checked) | `NAMES` |
| `brand-opt-out` | `# brand: untrusted -- <reason>` appears outside a route module, or has no reason | `OPT_OUT_FILES` |
| `brand-mint` | a `NewType` declared under `server/src/pkm` is constructed outside its sites, under its own name or an import alias (`BlockUid as U`), or held as a value: a call argument, an assignment, walrus or return value, or a container element (`map(BlockUid, xs)`, `U = BlockUid`). A subscript (`dict[str, BlockUid]`) and the type slot of `cast`, `NewType`, `TypeAdapter`, `isinstance` and `assert_type` hold a type, not a value. Outside `server/src/pkm`, a `NewType` over a registered brand is a brand its own file may not mint | `MINT_SITES`, `TEST_MINT_SITES` |
| `brand-cast` | `typing.cast` is called outside `CAST_SITES` | `CAST_SITES` |
| `brand-ignore` | a call whose lines carry `pyrefly: ignore` or `type: ignore` (or sits under one on a line of its own) passes a plain literal, or a list, tuple or set of them, to a keyword named like a brand (`uid="uid_b2"`), in that call or a call inside it. The ignore would let it through. A positional literal (`f("uid_b2")  # type: ignore`) is not seen: that needs the callee's signature | `NAMES` |
| `test-mint-import` | product code imports `pkm.test_data.ids`, by any spelling | `TEST_MINT_SITES` (what), `TEST_CODE` (who may) |
| `model-construct` | a pydantic model is built with `model_construct` | none |
| `raw-sqlite` | `sqlite3.connect`, a cursor or `.raw` is used outside `SQLITE_SITES` | `SQLITE_SITES` |
| `brand-parse` | a file cannot be parsed (usually Python older than 3.12) | none |

The rules cover `server/src`, `server/tooling` (perfcheck, proptest,
commentlint, brandlint) and `server/tests`. `SQLITE_SITES` names the
raw-sqlite sites, each with its reason: `pkm.database`;
`server/tooling/perfcheck/`, which measures SQLite itself (trace and progress
hooks, EXPLAIN plans); `server/tests/rawread.py`; and the few tests whose
subject is SQLite itself. Proptest goes through `Db`. The database side of the
same vocabulary is in [backend.md](backend.md#typed-database-access).

Tests are exempt from nothing. They mint through the checked helpers instead:

| Registry table | Says |
|---|---|
| `TEST_MINT_SITES` | the one module per side that may mint every brand: `server/src/pkm/test_data/ids.py` and `web/src/test-helpers.ts` |
| `TEST_HELPERS` | brand -> helper stem: `uid_of`, `page_id_of`, `sha_of` ... in Python, the camel `uidOf` ... on the web |
| `MALFORMED` | brands with a shape whose bad values a negative test forges unchecked: `malformed_uid`, `malformed_sha` |
| `TEST_CODE` | files that are tests by location (`server/tests/`, `server/src/pkm/test_data/`, the web's test support): they may import the mint modules, and a violation there names the helper |

Each `<stem>_of` raises `ValueError` unless the value fits the brand's
`SHAPES` regex or base type (an integer brand refuses a `bool` or a float).
`rawread.read`, the tests' reader for catalog tables and counts, raises when
a returned column may carry a brand: a `pkm.rows` key with a brand, or a raw
name `COLUMN_KEYS` maps to one (a bare `id`, the sidebar's `order_idx`). That
value is read with `Db.select`, whose row check validates it. The refusal
goes by returned name, so `SELECT uid AS u` passes; it returns an unbranded
value, so it mints nothing.

#### Web side

`web/tooling/eslint-plugin-brands` is the same two rules over TypeScript
types, run by `pnpm lint`. It reads `web/tooling/brandRegistry.gen.json`,
which `pkm.rows_dump` generates from the server registry, so one `NAMES` and
one `MINT_SITES` serve both languages. Test files and the registry's
`TEST_SUPPORT` paths are exempt.

| Rule | Fails when |
|---|---|
| `brands/name-carries-brand` | a parameter, property signature or class property named like a brand is not declared with that brand, or allows its base type in a union. The check is shallow: `null`, an array of the brand, and a `Set`, `Map` key or `Record` key of it are accepted. Parameters are read in every position: functions, arrows, methods, function and constructor types, method signatures, `declare` and overload signatures, constructor parameter properties and rest parameters |
| `brands/no-brand-assertion` | an `as` or `<T>` assertion, a type predicate (`x is B`, `asserts x is B`), an overload signature, or a `declare`d variable or function that mints a brand outside that brand's mint sites, or an assertion that launders (below). It walks the target's structure, including mapped types, index signature keys and values, `Row[K]` and a type parameter's constraint (`as T` with `T extends BlockUid`). A subtype brand (`CanonicalTitle`) counts as its own brand rather than its parent's |

What `no-brand-assertion` counts as minted:

| Construct | Mints | Clean | Reported |
|---|---|---|---|
| `as`, `<T>` | every brand of the target, unless the operand already fits it, holds no `any`, and declares every position where the target carries a brand (an optional property, optional tuple element, index signature or `Partial<T>` key the operand lacks may hold anything) | `xs as readonly T[]`, `[] as BlockUid[]`, `t as Partial<T>` | `s as BlockUid`, `row as Row & { uid?: BlockUid }`, `o as Partial<T>` from `object` |
| type predicate | what the narrowing adds to the parameter's declared type, compared position by position: array and tuple elements, lib type arguments (`ReadonlySet` to `Set`), properties, each member of an intersection. A brand no compared position holds counts as added | `BlockUid \| null` to `BlockUid`, `readonly BlockUid[]` to `BlockUid[]` | `BlockUid \| string` to `BlockUid`, `readonly (BlockUid \| string)[]` to `BlockUid[]` |
| overload signature | what its return type adds over the implementation's, compared the same way | `BlockUid` over `BlockUid \| null` | `BlockUid[]` over `readonly (BlockUid \| string)[]` |
| launder | an assertion to `never`, to `keyof T` (the caller picks the keys: `keyof Record<BlockUid, 1>` is a BlockUid), or to a type parameter a caller can instantiate with a brand its constraint lacks, also inside the target (`T[]`, `{ v: T }`, `Promise<T>`, `ReturnType<F>`). That is no constraint, `string`, `number`, any object type, or a literal or template where the parameter stands for a value (`K extends "a"` admits `BlockUid & "a"`) | `K` as a key (`Record<K, number>`), `T extends BlockUid \| PageId` (judged as a brand), `f as keyof Shape` for a concrete `Shape` | `x as T`, `x as K`, `o[key as keyof T]` |

`// brand: untrusted -- <reason>` on a declaration opts a name out of
`name-carries-brand`, and on a laundering assertion (`as T`, `as never`)
opts it out of `no-brand-assertion`; both only inside `OPT_OUT_FILES`
(`viteBudgetPlugin.ts` and the HTTP response boundary `api/client.ts` on the
web). `satisfies` and the non-null `!` are not assertions toward a
brand. The fixtures in `web/tooling/eslint-fixtures` are linted by
`lintConfig.test.ts`, which pins each message. The database side of the
vocabulary is in [backend.md](backend.md#typed-database-access) and
[frontend.md](frontend.md#replica-database-access).

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
| `lint` (`eslint.config.js`) | a hook dependency array drifts, a promise floats or is misused, a non-Error is thrown, a caught error is untyped, `apiFetch` is imported outside the transport boundary, an `any` flows through production code (written, assigned, returned, passed, called or member-accessed), a name that means a brand does not carry it, a brand is asserted outside its mint sites ([Web side](#web-side)), or a disable directive is stale |
| `check:fcis` (`tooling/fcis.mjs`) | a Functional Core module imports an Imperative Shell one at runtime ([overview.md](overview.md#functional-core--imperative-shell)) |
| `test:coverage` | statements or lines under 95%, branches under 91%, functions under 89% (`vite.config.ts`) |
| row check (vitest only, `ReplicaDb.select`) | a selected row has a column that is not a `Columns` key, or a value that does not fit its key's base type, nullability, literals or brand shape; the error carries the SQL and the fix ([frontend.md](frontend.md#replica-database-access)) |
| `columns.test.ts` | a column of a client-only table (`CLIENT_DDL`) has no `Columns` key, or its key disagrees on base type or nullability |
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
