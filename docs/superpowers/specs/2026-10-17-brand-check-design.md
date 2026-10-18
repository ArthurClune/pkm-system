# Brand check: names carry their brand, rows arrive branded

Bean: pkm-zv2s. Follow-up for titles: pkm-hc95.

## Why

The type checker cannot catch a `GoodlinksId` passed through a `str`
parameter: once a branded value enters a loosely typed signature, the brand
is gone and any string is accepted where the brand belonged. That is how the
GoodLinks 500s happened. The strict-typing gates (implicit `Any`, `ANN`,
`no-unsafe-*`) stop untyped values; they do not stop *under-typed* ones.

Arthur's aim is long-term maintainability: a codebase in which the right
thing is the easy thing. Concretely, writing `def f(uid: str)` is blocked
outright, and there is no existing loose code to copy, because this work
converts every existing site rather than allow-listing them.

## Goals

1. **Names carry their brand.** A parameter or field whose name is
   registered for a brand must be annotated with that brand (alone, or
   inside a container/union: `list[BlockUid]`, `BlockUid | None`). Applies
   to function parameters, TypedDict fields, dataclass fields and pydantic
   fields, on server and web.
2. **Brands are minted only at declared sites.** Outside its declared mint
   modules and the two test mint modules, nothing constructs a brand
   (`BlockUid(x)`), or casts to a brand or to any type that contains one
   (enforcement point 2). Tests and tooling are not exempt (see "Tests,
   test support and tooling").
3. **Rows arrive branded.** A value read from our own database is already
   typed by its column: `r["uid"]` is a `BlockUid` with no wrapping at the
   read. Database data then has one mint site, and every other mint is a
   genuine parse point: the wire contracts, or an explicit parser.
4. **No allow-list, no baseline.** Every existing violation on both sides is
   fixed in this work: roughly 70 server and 40 web parameter sites, every
   route handler still returning `dict[str, object]`, and every row read.
5. **Every failure says how to fix it**, naming the helper to use.

## Non-goals

- **Titles.** `title` is ambiguous today (raw user text, `NormalizedTitle`,
  `CanonicalTitle`; about 99 `title: string` on the web alone). It is not
  registered for rule 1 here; pkm-hc95 covers it. Columns named `title`
  still get a type in the row vocabulary (goal 3), since a column's kind is
  not ambiguous.
- **Parsing SQL strings in lint** to check aliases. The runtime row check
  (enforcement point 4) catches the same mistakes more reliably.
- **Shape validation on the wire.** The contracts mint brands without
  checking shape (see rule 2); adding validators would change which ops the
  server accepts and is a separate decision.

## Anti-goals (it would be a failure even if the gates passed)

- An allow-list or baseline file of existing violations.
- A gate that a cast walks straight through.
- Lint doing a job the type checker can do: where a wrong call can be made
  impossible by types, it is.
- A production slowdown: the runtime row check runs only under tests.
- Error messages that say what is wrong but not what to write instead.

## Design

### The vocabulary (single source of truth)

A hand-written Python module next to the DDL declares the **schema row
type**: a `TypedDict` with `total=False`, one key per name a query can
return, each typed with its brand or plain type (`uid: BlockUid`,
`parent_uid: BlockUid | None`, `page_id: PageId`, `order_idx: OrderIdx`,
`seq: SyncSeq`, `title: CanonicalTitle`, `text: str`, `n: int`, ...). It
replaces today's `SchemaRow = Mapping[str, Any]` in `pkm/schema.py`.

Checked with pyrefly 1.1.1 (default preset) on a `total=False` TypedDict:
reading a declared key gives its type with no not-required-access error; an
undeclared key or `row[0]` is `bad-typed-dict-key`; `BlockUid | None`
assigned to `BlockUid` is rejected.

**One name, one meaning.** A key has exactly one type, nullability
included. The vocabulary also maps every table's columns to keys; a column
reads under its own name by default, and under a distinct alias key when
its meaning differs from the key's (my call). Known cases:

- `sidebar_entries.order_idx` is not a block's `OrderIdx`: it gets its own
  brand, `SidebarOrderIdx` (int), and reads as `sidebar_order_idx`. The
  wire field `SyncSidebarEntry.order_idx` keeps its name and becomes
  `SidebarOrderIdx`, so rule 1 lets the name `order_idx` carry either
  brand.
- `changes.page_id` is nullable where `blocks.page_id` is not; likewise
  `block_rewrites.created_at` is NOT NULL where others are nullable. Each
  differing column gets its own key.
- Bare `id` is never a key: `pages.id` reads as `page_id`,
  `sidebar_entries.id` as `sidebar_entry_id`, the client's `pending_ops.id`
  and `replay_log.id` as their own keys.
- Polymorphic or setting-name columns (`replay_log.key`, holding a uid or a
  page id by `kind`; `sync_meta.key`) get plain-typed keys of their own.

Queries alias accordingly (`SELECT order_idx AS sidebar_order_idx ...`).
SQLite's FTS shadow tables (`*_data`, `*_idx`, `*_config`, `*_docsize`,
`*_content`) are SQLite internals, excluded by that pattern; FTS virtual
table columns that queries read are in the vocabulary like any other.

The same module (or a sibling) declares the **rule-1 name registry**: for
each brand, the names that must carry it: the vocabulary's branded keys
plus non-column names (`block_uid`, `target_uid`, plural `uids`, ...).
camelCase forms for the web are derived (`page_id` -> `pageId`), not listed
twice. A name in the vocabulary whose type is plain (`sidebar_order_idx`)
is not a rule-1 name.

Consequences Arthur accepted:

- **Aliases are vocabulary.** `SELECT x AS uid` is trusted to produce a
  uid; a computed column (`COUNT(*) AS n`) needs a registered key.
- **Bare `id` is not a key**, so queries alias it.

The web gets a generated `Columns` type from the vocabulary, produced and
drift-tested the same way as `baseSchema.gen.ts` (see the generated
artifacts table in `docs/architecture/backend.md`). Web brand declarations
stay in `web/src/api/brands.ts` (and the generated `x-brand` types); the
generator maps names to them. The client-only tables' DDL lives in
TypeScript (`replica/clientSchema.ts`, with `pending_ops` declared again in
`replica/carryStore.ts`); their keys are declared in the Python vocabulary
too, and a web test checks them against the client DDL (see point 3).

### Server: a typed connection (enforcement point 1)

Feature code stops holding a `sqlite3.Connection`. A small `Db` class in the
db module wraps it and exposes only:

- `select(sql, params) -> list[Row]` and `select_one(sql, params) ->
  Row | None`, where `Row` is the schema row type. Rows are **converted to
  real dicts**, not cast: `sqlite3.Row` has no `.get` and its `in`/`items`
  differ from a dict's, so a cast would let `r.get("x")` type-check and then
  crash. The conversion cost on hot paths (tree build, sync feed) is
  measured by the perf gate.
- a write-only `execute` returning what writers need (`rowcount`,
  `lastrowid`), never rows;
- `executemany`, `executescript` where needed, and transaction control
  (`commit`, `rollback`, `BEGIN IMMEDIATE` as `routes_ops` uses it today).

A read-only variant serves backup and export (`backup/__main__.py` opens
the database read-only; `export/writer.py export_graph` reads the
snapshot). Every `sqlite3.connect` site opens our own schema (the Roam
import is EDN, not SQLite), so all of them go through `Db`, except the
backup's copy target, which only receives the sqlite backup API.

`get_db` yields a `Db`; every `db: sqlite3.Connection` parameter in
`server/src` (129 mentions across 23 files) becomes `db: Db`. Because
`fetchone`/`fetchall`/iteration do not exist on `Db`, pyrefly rejects an
untyped read before any lint runs. The existing reads (93 fetch calls, 24
`for r in db.execute(...)` loops, including tuple-unpacking ones like
`for uid, text in con.execute(...)`) move to `select`; the 16 positional
reads (`fetchone()[0]`) gain a named alias.

Catalog reads in the db module's own migrations (`PRAGMA table_info`,
`sqlite_master`) return SQLite's columns, not ours: they stay inside the
db module on the raw connection, outside `select` and the vocabulary.

**Connection rule (lint):** `sqlite3.connect` and `.cursor()` appear only
in the db module.

### Web: column-named selects

`ReplicaDb.select<T>(sql)` is today an unchecked cast at 67 call sites in 18
files: every caller writes its own `T`, so `{ uid: BlockUid }` is a
self-mint. It becomes `select<K extends keyof Columns>(sql, params):
Pick<Columns, K>[]`: the caller names columns, the types come from the
vocabulary. Raw `selectObjects` stays confined to `replica/db.ts`, as now.

### Rule 1: names carry their brand

- Server: a Python AST rule in the commentlint framework
  (`server/tooling/commentlint`, stdlib only, runnable under system
  `python3`). It runs from the pre-commit hook, the `--all` sweep, and
  therefore `pytest` (`test_the_tracked_tree_is_clean`) and `pnpm verify`
  (`lint:comments`). Whether it lives in the commentlint package or a
  sibling package wired into the same entry points is the builder's call;
  either way it runs from all three places.
- Web: ESLint rules generated from the registry, each with a fixture in
  `web/tooling/eslint-fixtures` asserted by `lintConfig.test.ts`.
- Request models and route parameters are included: a request field or path
  param named `uid` is typed `BlockUid`. Pydantic validates it as a plain
  string, which is how the contracts mint (rule 2).

### Rule 2: mint only at declared sites

Each brand declares its mint modules in the registry:

- the brand's home and genuine parse points, e.g. `web/src/ids.ts
  parseBlockUid`, `web/src/uid.ts newUid`, `client/api.py new_uid`;
- **the wire contracts** (Arthur): pydantic models and FastAPI parameters
  are the parse boundary for untrusted input, so a branded field there is a
  declared mint. What the server accepts does not change: an op addressing
  a uid that no longer exists is still skipped, not rejected, and sync and
  the proptests are untouched;
- the `Db` row conversion (server) and `select` (web) for row data.

Anywhere else in production code, constructing or casting to a brand
fails. Today's server mints sit in one to seven files per brand; the
row-read mints among them (about 17) disappear once rows arrive branded.

Test code is not exempt; it mints through named helpers (next section).

### Tests, test support and tooling (amended 2026-10-18)

The first version of this spec exempted test code from rules 1 and 2.
Arthur reversed that (pkm-78r0): agents copy what they read, and tests,
fixture builders and harnesses are what they read most. A blanket
exemption leaves the loose pattern (`s as BlockUid`, `BlockUid("a")`,
`uid: str`) in exactly the code future agents imitate. The aim: the code
in an agent's context is already right, and the rule is enforced.

**Scope.** Rules 1 and 2 apply to every test and test-support file:
`*.test.*`, `web/src/test-setup.ts`, `web/src/test-helpers.ts`,
`web/src/props/**`, `replica/replayArbs.ts`, `replica/testDb.ts`,
`sync/memReplica.ts`,
`server/tests/**`, `server/src/pkm/test_data/**` and the tests under
`web/tooling/**`. The registry's `TEST_SUPPORT` exemption is deleted;
its successor `TEST_CODE` only says which files are tests by location
(they may import the test mint modules, and messages there name the
helpers) and exempts nothing. Every
rule of the two lints applies there, not only rules 1 and 2: on the
server the `cast` limit, the `model_construct` ban and the raw-sqlite
rule; on the web the whole type-aware block (see walk-around 1). The
Playwright specs in `web/e2e/**` stay out: they use no brand, talk to the
server over JSON, and sit outside the TypeScript project the type-aware
rules need. Server tooling (`server/tooling/**`) and
the web perf harness (`web/tooling/perf/`) are under the rules too; the
perf harness reads its values from real mints, and `perfcheck` is the one
tooling site allowed raw `sqlite3` (registry `SQLITE_SITES`).

**The helpers.** Each side has one test mint module, listed in a new
registry key `TEST_MINT_SITES`, which may mint every brand:

| Side | Module | Imported by |
|---|---|---|
| web | `web/src/test-helpers.ts` | vitest files, `props/`, `replayArbs`, `memReplica` |
| server | `server/src/pkm/test_data/ids.py` | `server/tests`, `pkm.test_data` builders |

- **One helper per brand, `<name>Of` / `<name>_of`**, named from the
  brand's rule-1 name: `uidOf`, `pageIdOf`, `seqOf`, `orderIdxOf`,
  `clientIdOf`, `batchIdOf` ... (`uid_of`, `page_id_of` ... in Python).
  Brands with no rule-1 name use the brand: `canonicalTitleOf`,
  `normalizedTitleOf`. The `Of` suffix keeps them clear of the `pageId`,
  `seq` and `title` locals tests use everywhere. A brand gets a helper
  when a test needs one.
- **Everyday helpers check the brand's shape** and throw on a mismatch,
  so a fixture value is always one the product could have produced: a
  brand with a `SHAPES` regex (`BlockUid`, `Sha256Hex`) must match it; an
  integer brand takes an integer (not a bool, not a float).
- **Malformed values are spelled differently** (Arthur):
  `malformedUid("")`, `malformedSha("zz")` / `malformed_uid("")` return
  the value unchecked, so a negative test says on its face that it forges
  a bad id. A forger exists for each brand a negative test needs, accepting
  null where the test needs a missing value; an integer brand's shape is
  "an integer" (`malformedSeq(NaN)`). They cannot be used to make
  a fixture "work": the runtime row check rejects a malformed value the
  moment it reaches a test database.
- **The helpers replace today's.** The web's `uid(s)` (any string),
  `pageId`, `entryId`, `ord`, `sidebarOrd`, `title`, `normTitle` and the
  tag-deriving `uidOf(tag)` go; tests write the real value through the
  checked helper. Short tags become uid-shaped by prefixing `tuid-` (the
  convention replica fixtures already use: `"a"` becomes `"tuid-a"`), and
  the same tag is rewritten wherever that test spells it inside expected
  text (`"((a))"`). Scale: about 1,355 `uid("...")` calls in 77 web files,
  of which about 940 carry a short tag (94 distinct); about 580 `as Brand`
  casts in 65 web test files; about 715 brand constructor calls in 45
  server test files, of which about 65 carry a malformed literal (most
  test rejection and become `malformed_uid`).
- **Production may not import a test mint module.** The lint reports an
  import of `test-helpers` or `pkm.test_data.ids` from any file outside
  the test scope above.
- **Lint messages in tests name the helper**: "`as PageId` in a test:
  use `pageIdOf` from test-helpers".

**Reads.** Test reads that return a brand-carrying column use `select`
(web) / `Db.select` (server) under row vocabulary keys. The untyped
readers, `introspect` on the web and `rawread.read` in server tests, keep
catalog and count reads; under tests each throws when a returned column
name is a key that carries a brand ("read it with select"), so the
convention is enforced. The refusal wins over convenience: a journal
snapshot such as `SELECT * FROM changes` becomes an explicit column list
under the row vocabulary's aliases (`page_id AS change_page_id`) read with
`select`. On the server, `rawread.py` is the test-side raw-sqlite site;
a test that exercises SQLite itself (backup, corruption, integrity)
either reads through it or gets its own `SQLITE_SITES` entry with the
reason beside it; any other raw access moves to `Db`. A row seeded by raw SQL and read back through
`select` is not a hole: the row check validates its shape.

**Walk-arounds closed with the scope change.** Tests lose more than the
cast rule when they come under it, so these land in the same work:

1. **The web lint config covers tests.** Today the type-aware block in
   `web/eslint.config.js` ignores `*.test.*`, `test-setup.ts` and
   `test-helpers.ts`, so removing the plugin's own exemption alone would
   lint nothing. The block's file set takes them in, with all its rules
   (measured without the brand rules: about 175 reports in 24 files,
   mostly `no-unsafe-*` and `no-floating-promises`). A test of the
   transport layer that must import `apiFetch` joins the existing
   per-file override for that import ban.
2. **`any` stops carrying values into branded slots**: `no-explicit-any`
   and the `no-unsafe-*` rules, on for production already, run on tests
   too (measured: 46 reports in 13 files). On the server, a `resp.json()`
   value is `Any` and pyrefly passes it anywhere; that is accepted, since
   those values are what the server minted.
3. **Type-suppression comments do not launder.** Web: `@ts-ignore` and
   `@ts-nocheck` are banned (`@ts-expect-error` with a description stays;
   the existing ones are type probes that fail when they stop being
   needed). Server: a line carrying a `pyrefly: ignore` or `type: ignore`
   may not also pass a plain literal to a keyword argument with a rule-1
   name (`SetHeadingOp(uid="uid_b2", heading=5)  # pyrefly: ignore[...]`
   lets the uid through along with the heading it was meant for); the
   literal goes through a helper.
4. **An unannotated rule-1 name passes anything.** Rule 1 checks an
   annotation only when one is present, and pyrefly's
   `implicit-any-parameter` is on only for `server/src`, so a test
   helper `def make(uid): ...` takes any string. Brandlint reports a
   rule-1-named parameter with no annotation, everywhere (measured: 74 in
   29 server test files; none in `server/src`, where pyrefly already
   requires one).
5. **Server lint walk-arounds that test idioms reach**: a brand imported
   under another name (`BlockUid as U`), a brand constructor passed as a
   value (`map(BlockUid, xs)`), and `NewType` declared through
   `typing.NewType`, annotated or indented. (From pkm-e9q8's server list.)

**Left as is, on purpose.** `model_validate` in tests: the wire contracts
are a declared mint, and the tests that use it (about 40) feed wire-shaped
input to the parse boundary on purpose (idempotency hashes of a wire
batch, contract parse tests). Pretending to be the wire is honest there.

### The six enforcement points

1. **Types, not lint**, for row reads: the `Db` wrapper above, and the
   web's column-named `select`.
2. **Escape hatches closed** (my call on how):
   - Web: a type-aware ESLint rule (a small local plugin using the type
     checker, since `no-restricted-syntax` selectors cannot see through
     aliases) flags any type assertion whose target type contains a brand
     anywhere in its structure: `as BlockUid`, `as unknown as BlockUid`,
     `<BlockUid>x`, `as { uid: BlockUid }[]`, `JSON.parse(x) as PendingOp`.
     Outside mint modules, such a value is parsed, not asserted.
   - Server: `typing.cast` is allowed only in declared modules (four uses
     today) and `model_construct` (which skips validation) is banned in
     `server/src`.
3. **Every column registered**: a server test reads `PRAGMA table_info`
   for every table in `BASE_DDL` and `SERVER_DDL`, and a web test does the
   same for the client-only tables against the generated `Columns`. Each
   fails if a column maps to no key or its key's type disagrees with the
   DDL's (base type and nullability). A new column therefore forces a
   decision about whether it is a brand.
4. **Runtime row check under tests only**: in every test suite, `select`
   checks each returned row: every column name is a vocabulary key, and
   each branded value has its brand's shape (a uid matches `UID_RE`, a page
   id is an int, ...). This catches `SELECT text AS uid` whenever a test
   runs that query. Off in production. **Test fixtures are fixed to look
   like real data** (Arthur): the web tests' short uids (`'a'`, `'x'`; about
   366 short uid literals) are rewritten, via a helper or codemod, to
   uid-shaped values.
5. **Opt-out fenced**: the line-level opt-out for "untrusted input, parsed
   here" is allowed only in route modules (server `routes_*.py` and the
   equivalent web boundary modules) and must carry a reason; anywhere else
   the hook rejects it.
6. **Messages name the fix**, e.g. "`uid` must be `BlockUid`: read it from
   a `select()` row, or parse it with `parse_block_uid()`".

### Route handlers

18 handlers return `dict[str, object]` beside a `response_model` (15 in
`pkm/server/routes_*`, plus `list_models`, `create_conversation` and
`confirm_tool` in `assistant/routes.py`); all return their model. Further
handlers return `dict[str, object]` with no `response_model`
(`routes_sidebar` x3, `routes_assets`, `routes_sync.client_diagnostics`,
`auth.py`, `healthz`): each gets a model, or a precise TypedDict where it
is not a JSON API route. Response or docstring changes regenerate
`openapi.json`.

### Order of work

One bean, two phases, server landing before web:

1. Server: vocabulary and name registry, `Db` wrapper, migrate every read
   and signature, the route handlers, rules 1/2 and the connection rule,
   enforcement points 2-6.
2. Web: generated `Columns`, column-named `select`, migrate the 67 selects
   and ~40 parameter sites, rewrite test uids, ESLint rules (including the
   type-aware plugin) with fixtures.

## Verification

- Each rule is mutation-checked: reinsert the bug class (a `uid: str`
  parameter, a stray `BlockUid(x)`, a `cast`, an `as unknown as`, an
  `as { uid: BlockUid }`, a `fetchone()` on a raw connection, an
  unregistered column, a wrong alias) and confirm the gate fails with the
  intended message.
- The usual gates per AGENTS.md: pytest, pyrefly, ruff, `pnpm verify`.
- The change touches ops, sync and every query path, so `proptest/check.sh`
  and `perf/check.sh` run before merge. The `Db` layer must not raise query
  counts; a timing regression on hot paths is investigated, not accepted by
  default.
- Docs: `docs/architecture/enforced-checks.md` gains the new rules;
  `backend.md` (testing/typing policy, generated artifacts table) and
  `frontend.md` (replica db access) are updated in the same branch.

## Decided by Arthur

- Fix the full set; a new `def f(uid: str)` is blocked outright.
- Row reads use one schema-wide row type keyed by column name, with
  aliases as vocabulary and bare `id` aliased.
- Leave `title` out of rule 1; follow-up bean filed (pkm-hc95).
- All six enforcement points.
- The wire contracts are a declared mint; no shape validators added.
- The test-time row check is the full shape check; test fixtures are
  rewritten to realistic uids.
- (2026-10-18) No exemption for code agents copy: tests mint only through
  named helpers in one test mint module per side; tooling and the perf
  harness are under the rules.
- (2026-10-18) A malformed id in a test goes through a visibly different
  helper (`malformedUid`); the everyday helpers check shape.
- (2026-10-18) Seeding by raw SQL and reading back through `select` stays
  allowed; the row check covers it.

## Calls I made (Arthur to check while reading)

- A connection rule (`connect`/`cursor` confined to the db module), now
  mostly carried by the `Db` type.
- The server's Python vocabulary is the source of truth; the web type is
  generated from it.
- One name, one meaning: a column whose meaning differs from its name's key
  reads under a distinct alias key (sidebar `order_idx`, nullable
  `changes.page_id`, every `id`).
- A new brand, `SidebarOrderIdx`, for the sidebar's order, so the wire
  field name `order_idx` need not change and need not stay a plain int.
  A rule-1 name may therefore allow more than one brand.
- `Db` converts rows to dicts rather than casting `sqlite3.Row`.
- Rule-1 names = the vocabulary's branded keys plus registered non-column
  names; camelCase derived. An annotation passes if the brand appears in
  it.
- Escape hatches: a type-aware ESLint plugin on the web; `cast` confined
  and `model_construct` banned on the server.
- (2026-10-18) The server's test mint module lives in
  `pkm/test_data/ids.py`, so both `server/tests` and the `test_data`
  builders can import it.
- (2026-10-18) Short tags become uid-shaped as `tuid-<tag>`, the existing
  replica-fixture convention, rather than a derived value.
- (2026-10-18) `introspect`/`rawread` refuse brand-carrying columns under
  tests, enforcing the read convention.
- (2026-10-18) `model_validate` stays allowed in tests (wire-shaped input
  to a declared mint).
- (2026-10-18) Every rule of both lints applies to tests, not only rules
  1 and 2; the web's whole type-aware block covers them.
- (2026-10-18) Brandlint requires an annotation on a rule-1-named
  parameter, closing the unannotated-parameter route in tests.
- (2026-10-18) Journal snapshots in tests become aliased column lists read
  with `select`; `rawread` refuses brand-carrying columns.
- (2026-10-18) `web/e2e/**` stays outside the lints (no brands, no typed
  project).
- Every dict-returning handler converted, with or without a
  `response_model`.
- One bean, server phase then web phase.

## Left to the builder

- Module names and file layout for the vocabulary, registry and `Db`.
- Whether the AST rule lives inside `commentlint` or a sibling package.
- How the runtime row check is switched on under tests.
- How the ESLint rules are generated (config-time import vs generated file)
  and how the type-aware plugin is packaged, as long as fixtures prove each
  fires.
- Alias key names for the differing columns.
