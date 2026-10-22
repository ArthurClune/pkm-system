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
| `pre-commit` | in any staged code file (any tracked `.py`, `.ts`, `.tsx`, `.mjs`, `.js`, `.css`, `.sh` or `.swift`, or an extensionless script with a shell, Python or node shebang) or architecture doc: a bean id, a line number or a spec/plan pointer with no path in a comment; a comment line over 80 columns or any other line over 120 (`noqa: E501` exempts a line) | `AGENTS.md` § FCIS, `server/tooling/commentlint` |
| `pre-commit` | in any staged Python file: a regex with a bare `$` (`re.compile(r"^a$")`), which also matches before a trailing newline; use `\Z` or `fullmatch`. A pattern with `re.MULTILINE` or `(?m)` may use `$` | [Regex anchors](#regex-anchors), `server/tooling/regexlint` |
| `pre-commit` | in a staged `server/src`, `server/tooling` or `server/tests` file: a parameter, field or key named like a brand and not carrying it (`uid: str`, or no annotation); a brand constructed, held as a value or `cast` outside its registered sites; a function returning a brand while taking an unannotated or `Any` parameter; a model that is not strict (a direct `BaseModel` subclass, `strict=False`) or is built where pyrefly cannot check it (`model_validate` of a dict literal, `model_copy(update=)`, `model_construct`); raw `sqlite3` outside `SQLITE_SITES` | [Brand rules](#brand-rules), `server/tooling/brandlint` |

### Regex anchors

`server/tooling/regexlint` runs inside `commentlint.run` like brandlint, over
every tracked Python file (including `.claude/skills` and extensionless
scripts with a Python shebang), so the hook, the `--all` sweep,
`test_the_tracked_tree_is_clean` and `lint:comments` all apply it.

`$` matches at the end of the string and before a trailing newline, so
`pattern.match("abc\n")` passes a validation regex ending in `$`. The rule
`regex-dollar` reports an unescaped `$` outside a character class in a
pattern, and there is no opt-out: a pattern states that `$` means end of line
with `re.MULTILINE` / `re.M` (alone, or combined as `re.M | re.I`, or
`flags=`) or an inline `(?m)`, and the lint reads the flag.

| Sink | Followed through |
|---|---|
| `re.compile`, `match`, `search`, `fullmatch`, `findall`, `finditer`, `sub`, `subn`, `split` (module alias or `from re import`), with the pattern positional or `pattern=` | a str or bytes literal, implicit or `+` concatenation, an f-string's literal parts, `"".join([...])`, the format string of `.format()` or `%`, and a name assigned once in the file |
| a class attribute `regex` (Starlette convertors) | the same |

A `$` in a verbose pattern's `#` comment (`(?x)` or `re.X`) is not reported.
The lint does not follow a dict lookup, a name assigned twice, a parameter
default, an attribute (`self.P`) or a walrus, so a pattern reached that way
is not checked.

Two things are deliberately outside the rule. Pydantic's `Field(pattern=)`
runs on Rust's regex engine, where `$` has no newline case and `\Z` is
rejected, so `$` is correct there. The web needs no equivalent: a JS regex
without the `m` flag matches `$` only at the very end of the input.

### Brand rules

`server/tooling/brandlint` runs inside `commentlint.run`, so the hook, the
`--all` sweep, `test_the_tracked_tree_is_clean` and `lint:comments` all apply
it. The data it reads is `server/src/pkm/brand_registry.py`, which is
import-free so the hook loads it under a bare `python3`. The hook needs
Python 3.12 or newer: an older interpreter cannot parse a file using PEP 695
syntax and reports `brand-parse` instead of skipping the file.

In the hook the registry and the `NewType` declarations under
`server/src/pkm` are read from the index, as the files are, so a commit that
stages a registry change with the code it allows is judged against the staged
registry. `--all` reads the working tree.

| Rule | Fails when | Registry data |
|---|---|---|
| `brand-name` | the annotation of a parameter, field or key with a brand's name does not carry the brand: it must be the brand, `None`, a list, tuple or set of those, a mapping keyed by one, or a union of such (the shapes the web rule accepts), so `dict[str, BlockUid]`, `BlockUid \| Other` and `Box[BlockUid]` fail; or a function parameter with that name has no annotation (a lambda's is not checked). Checked sites are parameters, class fields at any depth under `if`, `try` or `with`, annotated attributes (`self.uid: str = ...`) and the fields of a functional `TypedDict` or `NamedTuple` | `NAMES` |
| `brand-opt-out` | `# brand: untrusted -- <reason>` appears outside a route module, or has no reason | `OPT_OUT_FILES` |
| `brand-opt-out-unused` | an allowed opt-out covers no site. An opt-out covers one site: the leftmost brand-named site on its lines that does not carry its brand. A second such site on the line is still reported | `OPT_OUT_FILES` |
| `brand-mint` | a `NewType` declared under `server/src/pkm` is constructed outside its sites, under its own name or an import alias (`BlockUid as U`), or held as a value: a call argument, an assignment, walrus or return value, or a container element (`map(BlockUid, xs)`, `U = BlockUid`). A subscript (`dict[str, BlockUid]`), the type slot of `cast`, `NewType`, `TypeAdapter`, `isinstance` and `assert_type`, a `TypeVar`'s constraints, `bound` and `default`, the field types of a functional `TypedDict` or `NamedTuple`, and the value of a `TypeAlias` annotation hold a type, not a value. Outside `server/src/pkm`, a `NewType` over a registered brand is a brand its own file may not mint | `MINT_SITES`, `TEST_MINT_SITES` |
| `brand-cast` | `typing.cast` is called outside `CAST_SITES` | `CAST_SITES` |
| `brand-launder` | a function whose return annotation carries a brand, outside that brand's mint sites, takes a parameter (not `self` or `cls`, `*args` and `**kwargs` included) with no annotation or an `Any` one, bare or in a union. The checker cannot see what flows through such a parameter, so returning it as the brand would mint it unseen. `dict[str, Any]` is not `Any`. The same message fires for a `return` in such a function, or an annotated assignment to a brand-typed name or attribute (`self.uid: BlockUid = x`), on a line carrying a type-check ignore (or under one on a line of its own): the ignore lets any value through as the brand. A `return` belongs to its innermost function | `MINT_SITES`, `TEST_MINT_SITES` |
| `brand-ignore` | a call whose lines carry a type-check ignore (or sits under one on a line of its own) passes anything but `None` or a call that produces the brand checked (a literal, a variable, `row["uid"]`, `str(x)`, or a list, tuple or set holding one) to a keyword named like a brand (`uid="uid_b2"`), in that call or a call inside it. The checked calls are the brand's test helper (`uid_of`), its forging helper (`malformed_uid`) and its own constructor in a file that may mint it; product code has no others, so the remedy is to drop the ignore. A positional value (`f("uid_b2")  # type: ignore`) is not seen: that needs the callee's signature | `NAMES` |
| `brand-file-ignore` | a comment silences or weakens the checker for the whole file: `# pyrefly: ignore-errors`, `# pyright: basic`, `# pyright: <rule>=false`, `=none`, `=warning` or `=information` anywhere, or a `# type: ignore` on a line of its own ahead of all code (including the docstring). `# pyright: strict` is not reported | none |
| `test-mint-import` | product code imports `pkm.test_data.ids`, by any spelling | `TEST_MINT_SITES` (what), `TEST_CODE` (who may) |
| `model-construct` | a pydantic model is built with `model_construct` (or the v1 `construct`): use the constructor with keyword arguments | none |
| `model-strict` | a class lists pydantic's `BaseModel` or `RootModel` (`Name`, `pydantic.X`, `X[...]`, or an import alias such as `BaseModel as BM`) among its bases, other than the `STRICT_BASE` class in its file; a `strict=` keyword (on a call, or on a class as in `class M(StrictModel, strict=False)`), a `Strict(...)` marker, or a `"strict"` dict key whose value is anything but the literal `True`; `create_model`; a `pydantic.dataclasses` import or attribute; `validate_call`. Every model inherits `StrictModel`, so pydantic never coerces and pyrefly checks constructors | `STRICT_BASE` |
| `model-unchecked` | `.model_validate`, `.model_validate_strings`, `.parse_obj`, `.validate_python` or `.validate_strings` whose data argument (first positional, or `obj=`, `object=`, `json_data=` or `data=`) is a dict literal, a dict comprehension or a `dict(...)` call; `.model_validate_json` or `.validate_json` of a `json.dumps(...)` call, which is the same dict built in place; `.model_copy(update=...)` or the v1 `.copy(update=...)`. pyrefly cannot check any of these, so build the model with keyword arguments, or decode a JSON string literal. A dict held in a variable is outside what the rule can see | none |
| `raw-sqlite` | `sqlite3.connect`, a cursor or `.raw` is used outside `SQLITE_SITES` | `SQLITE_SITES` |
| `brand-parse` | a file cannot be parsed (usually Python older than 3.12) | none |

`NAMES` registers the title names too. `title`, `page_title`, `new_title` and
`old_title` accept any title brand, because requests carry raw titles and
responses canonical ones under the same name. `raw_title`, `ref_title`,
`normalized_title`, `canonical_title`, `daily_title` and `src_page_title` take
one kind. The sanctioned renames for a name that is not a title: `text` for
an input that is not yet one (parsers, normalizers, title readers), and
`title_text` / `titleText` for a test helper that mints a literal.

The type-check ignores the rules recognise are `# pyrefly: ignore`, `# pyright: ignore` and `# type: ignore`, each with or without `[rule]`; one pattern in `brandlint/core.py` owns the match.

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
| `MALFORMED` | brands a negative test needs a deliberately bad value for, forged unchecked: `malformed_uid`, `malformed_sha`, `malformed_seq`, `malformed_canonical_title`; only the uid and canonical-title forgers accept null |
| `TEST_CODE` | files that are tests by location (`server/tests/`, `server/src/pkm/test_data/`, the web's `test-setup.ts`, `test-guards.ts`, `fcFilterCap.ts`, `orphanWatchdog.ts`, `test-helpers.ts`, `props/`, `replayArbs.ts`, `testDb.ts` and `memReplica.ts`): they may import the mint modules, and a violation there names the helper |

Each `<stem>_of` raises `ValueError` unless the value fits the brand's
`SHAPES` regex or base type (an integer brand refuses a `bool` or a float);
the web's `<stem>Of` throws the same way
([frontend.md](frontend.md#brands)).
`rawread.read`, the tests' reader for catalog tables, FTS tables and counts, raises when
a returned column may carry a brand: a `pkm.rows` key with a brand, or a raw
name `COLUMN_KEYS` maps to one (a bare `id`, the sidebar's `order_idx`). That
value is read with `Db.select`, whose row check validates it. The refusal
goes by returned name, so `SELECT uid AS u` passes; it returns an unbranded
value, so it mints nothing. An unbranded key read through it gets no type,
nullability or domain check, so a value under a `Row` key goes through
`Db.select` too.

#### Web side

`web/tooling/eslint-plugin-brands` is the same two rules over TypeScript
types (plus `no-brand-bypass` and the unrelated `select-keys-literal` and `ts-expect-error-in-probe`), run by `pnpm lint`. It reads `web/tooling/brandRegistry.gen.json`,
which `pkm.rows_dump` generates from the server registry, so one `NAMES` and
one `MINT_SITES` serve both languages. Tests and test support are linted
like product code. `test-helpers.ts` (`TEST_MINT_SITES`) may mint every
brand. In a test, by name (`*.test.*`) or by location (`TEST_CODE`), a report
names the helper instead of the product remedy: "use uidOf or malformedUid
from web/src/test-helpers.ts". Its exported `offType<T>` is the one assertion to a
type parameter allowed (it launders anywhere else, including any other
helper in that module): the declared way for a test to feed a runtime guard a
value its type forbids. A call whose `T` is itself a brand is reported, so
`offType` is no second route for forging brands.

| Rule | Fails when |
|---|---|
| `brands/name-carries-brand` | a parameter, property signature or class property named like a brand is not declared with that brand, or allows its base type in a union. The check is shallow: `null`, an array of the brand, and a `Set`, `Map` key or `Record` key of it are accepted. Parameters are read in every position: functions, arrows, methods, function and constructor types, method signatures, call and construct signatures, `declare` and overload signatures, constructor parameter properties and rest parameters |
| `brands/no-brand-assertion` | an `as` or `<T>` assertion, a type predicate (`x is B`, `asserts x is B`), an overload signature, or an ambient declaration (a `declare`d variable, function, class field or method, however deeply nested in `declare global` or `declare namespace`, or any declaration in a `.d.ts` file), or an interface merged with a class or a lib declaration, that mints a brand outside that brand's mint sites, or an assertion that launders (below). It walks the target's structure, including mapped types, index signature keys and values, `Row[K]` and a type parameter's constraint (`as T` with `T extends BlockUid`). A subtype brand (`CanonicalTitle`, `NormalizedTitle`) counts as its own brand rather than its parent's. It also reports an `offType<T>(...)` call, explicit or inferred, whose `T` is a brand, or a union, array, `Set`, `Map` key or index key of one (a brand nested in an object property does not count), naming the brand's `malformed*` helper or asking for one to be added. It also reports an `offType` argument with a brand-named property (the registry's `NAMES`) whose type is not that brand, found by walking the argument's type through nested objects, arrays, unions and intersections to a fixed depth, so a literal, a nested literal and a variable are judged alike (`offType<{ uid: BlockUid }>({ uid: "junk" })`); library types are not walked |
| `brands/no-brand-bypass` | `Reflect.apply` or `Reflect.construct`, or a write past the type: a brand-named key whose value is not already that brand, set by `Object.assign` (each object-literal property, and the properties of any other source's type, spread or not), `Object.defineProperty` and `Reflect.defineProperty` (a `{ value }` descriptor is judged by its value, a getter or non-literal descriptor is not), `Object.defineProperties` or `Reflect.set`. A key counts when it is a string literal, a template without expressions, or typed as a union of string literals. A use of `Object` or `Reflect` that is not a direct call of one of those functions is reported too: `const { assign } = Object`, `const R = Reflect`, `Object.assign.call(...)`; `globalThis.`, `window.` and `self.` count as `Object` and `Reflect`. `x instanceof Object` and stubbing a global (`Object.defineProperty(navigator, "clipboard", ...)`) are unaffected |
| `brands/select-keys-literal` | the keys argument of a call to `ReplicaDb.select` (found by the method's declaration, not the name) is neither an array literal whose elements are all string literals nor an array or tuple whose element type is a type parameter inside a method or property named `select` (a wrapper forwarding its generic `K`; a free generic helper is reported). A variable typed `(keyof Columns)[]` or a concrete union, a spread in the array, spread call arguments and a computed callee (`db["select"]`) are reported. Not a brand rule: it lives in the plugin as the type-aware rule home |
| `brands/ts-expect-error-in-probe` | a `@ts-expect-error` comment (line, or the last line of a block comment) is not inside the body of a function expression or arrow passed as the only argument of a call to `typeProbe` imported from `test-helpers`. A local function named `typeProbe`, a renamed import, a probe body passed by reference and a second argument are reported; a probe nested in an `it` is accepted. Product code can never import the helper, so any `@ts-expect-error` there is reported. Not a brand rule either |

What `no-brand-assertion` counts as minted:

| Construct | Mints | Clean | Reported |
|---|---|---|---|
| `as`, `<T>` | every brand of the target, whatever the operand, a guard type's predicate included (`Guard<BlockUid>` with `type Guard<T> = (v: string) => v is T`). An upcast never needs an assertion: write an annotated declaration (`const ys: readonly BlockUid[] = xs`, `const r: Record<BlockUid, number> = {}`) | `const ys: readonly BlockUid[] = xs`, `[...] as const` | `s as BlockUid`, `xs as readonly BlockUid[]`, `row as Row & { uid?: BlockUid }`, `g as Guard<BlockUid>` |
| type predicate | what the narrowing adds to the parameter's declared type, compared position by position: array and tuple elements, lib type arguments (`ReadonlySet` to `Set`), an own subclass's arguments where its base holds them (`class Index<K, V> extends Map<K, V>`, through any depth of own bases), properties and index signatures, each member of an intersection or union. A position the declared type does not declare (an optional property, a tuple element past its length, an index signature, a property of a union member a discriminant rules out) adds every brand there; a brand no compared position holds counts as added | `BlockUid \| null` to `BlockUid`, `readonly BlockUid[]` to `BlockUid[]`, `ReadonlyMap<BlockUid, V>` to `Index<BlockUid, V>`, `Record<string, BlockUid>` to `{ uid?: BlockUid }` | `BlockUid \| string` to `BlockUid`, `readonly (BlockUid \| string)[]` to `BlockUid[]`, `{ a: 1 }` to `{ a: 1; uid?: BlockUid }`, `Row` to `Row & { pageId?: PageId }` |
| function or constructor type | `as (s: string) => BlockUid`, `as new () => BlockUid` and `as { make(): BlockUid }` mint through the return, which every walk of a type's brands also reads. A predicate compares the returns signature by signature | `as (s: string) => string` | `as () => Promise<BlockUid>` |
| interface merge | an interface merged with a class, or with a lib or dependency declaration (`declare global { interface Window { ... } }`), mints what each added member carries. A method re-declared in the interface is an unchecked overload and mints what it adds over each declaration it overloads | `interface Q { label: string }` beside `class Q {}`, `make(): BlockUid` over a class method returning `BlockUid \| null` | `interface Q { uid: BlockUid }` beside `class Q {}`, `make(): BlockUid` over a class method returning `string` |
| overload signature | what its return type adds over the implementation's, compared the same way, member by member where the return is a union, so a member the implementation's return is exactly does not hide another member's undeclared brand property. A return that mentions a type parameter launders whatever the implementation (the launder row): write one generic signature instead of overloading | `BlockUid` over `BlockUid \| null`, `function first<T>(xs: readonly T[]): T \| undefined { return xs[0]; }` with no overload | `BlockUid[]` over `readonly (BlockUid \| string)[]`, `{ a: 1; uid?: BlockUid }` over `{ a: 1 }`, `{ k: 1 } \| { k: 2; uid?: BlockUid }` over `{ k: 1 }`, `f<T>(x: T): T` over any implementation |
| launder | an assertion, a predicate's narrowed type or an overload's return type that is `never`, `keyof T` (the caller picks the keys: `keyof Record<BlockUid, 1>` is a BlockUid), or a type parameter a caller can instantiate with a brand its constraint lacks, also inside the target (`T[]`, `{ v: T }`, `Promise<T>`, `ReturnType<F>`). That is no constraint, `string`, `number`, any object type, or a literal or template where the parameter stands for a value (`K extends "a"` admits `BlockUid & "a"`). A type parameter the predicate's declared parameter already holds at that position does not launder (`x: T \| null` narrowed to `x is T`: its members are a `T` already or nothing; `x: T \| string` launders, its string can become any `T`). A type parameter of a function type that one of its parameters mentions is the caller's own value and does not launder (`transaction<T>(fn: () => T): T`), and `never` in a return is a function that does not come back. An overload's return that mentions a type parameter launders whatever the implementation: nothing ties the overload's `T` to a value the caller passed (`mk<BlockUid>("junk", null!)`, or a re-typed parameter over an honest implementation), so a generic function is written as one signature with no overload. `any` in a predicate's declared type holds nothing (`MessageEvent["data"]`). A predicate on a function type (`type Guard<T> = (v: string) => v is T`) is a contract only another predicate can fulfil, and that one is judged instead | `K` as a key (`Record<K, number>`), `T extends BlockUid \| PageId` (judged as a brand), `f as keyof Shape` for a concrete `Shape`, `(v: string) => v is T` as a type, `notNull<T>(x: T \| null): x is T`, `isDefined<T>(x: T): x is NonNullable<T>`, `function first<T>(xs: readonly T[]): T \| undefined { return xs[0]; }` with no overload | `x as T`, `x as <T>(s: string) => T`, `declare function mk<T>(s: string): T`, `const parse: <T>(s: string) => T = JSON.parse` (a value that returns `any` where a generic-return function type is wanted, also as a class field implementing an interface method, an object property or an argument), `x as K`, `o[key as keyof T]`, `x is T` from `unknown`, `any` or `T \| string`, `asserts x is T` from `unknown`, and any overload returning `T`, `Partial<T>` or `T \| undefined`, over whatever implementation |

`// brand: untrusted -- <reason>` on a declaration opts a name out of
`name-carries-brand`, and on a laundering assertion (`as T`, `as never`) or
generic-return value opts it out of `no-brand-assertion`. Both work only inside
`OPT_OUT_FILES` (`viteBudgetPlugin.ts`, the HTTP response boundary
`api/client.ts` and the perf harness's `rebase.perf.ts`, which loads another
checkout's replica, on the web). An opt-out covers one site, the leftmost on
its line, or on the line below a comment that stands alone; the two rules pair
sites and comments together by position. One that covers none is reported
(`optOutUnused`), as `brand-opt-out-unused` does on the server. `satisfies` and the non-null `!` are not assertions toward a
brand. The fixtures in `web/tooling/eslint-fixtures` are linted by
`lintConfig.test.ts`, which pins each message. The database side of the
vocabulary is in [backend.md](backend.md#typed-database-access) and
[sync-and-offline.md](sync-and-offline.md#reading-rows).

Known limits, where TypeScript itself is unsound and no cheap lint closes it:

- A computed key typed `string` writes any field: `{ ...base, [field]: "junk" }`, or `Object.defineProperty(o, field, ...)` with `field: string`. An `Object.assign` source typed `Record<string, string>` is not read for brand names either.
- Method shorthand is bivariant: an interface method `m(x: string)` is implemented by `m(uid: BlockUid)` without an error.
- A value that returns `any` reaches a generic-return function type unseen where it has no contextual position the rule listens to: a branch of a conditional, a default parameter value, `satisfies`.

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
| `test_brandlint_registry` | a `MINT_SITES`, `CAST_SITES`, `SQLITE_SITES`, `TEST_MINT_SITES` or `TEST_CODE` path no longer exists, a server site no longer mints, casts or touches sqlite as registered, a test mint module lacks a helper, or an `OPT_OUT_FILES` pattern matches no file carrying an opt-out. Web mint sites are checked for existence only: they mint through generated types that do not name the brand |
| `test_request_log` | a declared `pkm.*` logger resolves to no handler |
| `test_proptest_exclusion` | a property test runs in the default suite |

`cd web && pnpm verify` runs, in order: `typecheck`, `lint`, `lint:comments`
(the same tree sweep as the pytest row above), `check:fcis`, `test:coverage`,
`vite build`, Playwright.

| Step | Fails when |
|---|---|
| `typecheck` | `tsc` fails on `src` (`tsconfig.json`), on the generated API types (`tsconfig.apitypes.json`) or on `tooling` (`tooling/tsconfig.typecheck.json`, which leaves out `tooling/eslint-fixtures` because their violations are intentional) |
| `lint` (`eslint.config.js`), over product code, tests and tooling alike | a hook dependency array drifts, a promise floats or is misused, a non-Error is thrown, a caught error is untyped, `apiFetch` is imported outside the transport boundary, `test-helpers`, `testDb` or `memReplica` is imported (also by `import()`, template literals included) outside a test, an `any` flows through the code (written, assigned, returned, passed, called or member-accessed), a name that means a brand does not carry it, the keys argument of `ReplicaDb.select` is not an array literal of string literals ([Web side](#web-side)), a brand is asserted outside its mint sites, or `Reflect.apply` or a brand-named `Object.assign` / `defineProperty` writes around that ([Web side](#web-side)), `@ts-ignore` or `@ts-nocheck` appears, `@ts-expect-error` has no description or sits outside a `typeProbe` block ([Web side](#web-side)), or a disable directive is stale |
| `check:fcis` (`tooling/fcis.mjs`) | a Functional Core module imports an Imperative Shell one at runtime ([overview.md](overview.md#functional-core--imperative-shell)) |
| `test:coverage` | statements or lines under 95%, branches under 91%, functions under 89% (`vite.config.ts`) |
| row check (vitest only, `ReplicaDb.select`) | the query's columns (an empty result too) differ from the `keys` argument as sets: missing, extra or duplicate; a selected row has a column that is not a `Columns` key, or a value that does not fit its key's base type, nullability, literals or brand shape; the error carries the SQL and the fix. `ReplicaDb.introspect` refuses a column that may carry a brand ([sync-and-offline.md](sync-and-offline.md#reading-rows)) |
| console guard (`src/test-setup.ts`) | a test, or a timer firing after a file's last test, calls `console.warn` or `console.error` without silencing it with `vi.spyOn(console, ...).mockImplementation`; teeth in `tooling/consoleGuard.test.ts` |
| filter cap (`src/fcFilterCap.ts`, installed by `src/test-guards.ts` in the unit and property suites) | a fast-check `.filter` rejects `MAX_FILTER_REJECTIONS` draws in a row. fast-check's own filter retries forever in synchronous code, which no vitest timeout interrupts; teeth in `src/fcFilterCap.test.ts` |
| `columns.test.ts` | a column of a client-only table (`CLIENT_DDL`) has no `Columns` key, or its key disagrees on base type or nullability |
| `genTypes.drift.test.ts` | `types.d.ts` no longer matches `openapi.json` |
| `vite build` (`tooling/viteBudgetPlugin.ts`) | the bundle or precache manifest exceeds a limit in `tooling/budgets.json` |

Server type and lint checks are separate commands, not part of pytest:
`uv run pyrefly check` and `uv run ruff check` (ruff `E501` at 120 shares the
`noqa: E501` override with `pre-commit`). In `server/src`, pyrefly rejects an
implicit `Any` (`implicit-any-*`) and ruff rejects a missing annotation or a
bare `Any` (`ANN`). Tests and tooling are exempt from the missing-annotation
rules but not from `ANN401`, which rejects an explicit `Any` parameter or
return: `def f(x: Any) -> BlockUid: return x` would launder a brand with no
mint. Data from outside the app is typed `object` and narrowed before use;
rows from our own schema are `Row` dicts
([backend.md](backend.md#typed-database-access)).

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
