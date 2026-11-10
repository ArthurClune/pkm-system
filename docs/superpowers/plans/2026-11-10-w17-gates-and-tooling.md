# W17 Gates and Tooling: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** Close the gate holes and side copies the 2026-11-09 maintainability review found in its gates report: unchecked `web/e2e` and `.mjs` tooling, property reach and teeth that only a human reading the log enforces, a one-file eslint plugin, an append-only budgets file, a perf toolkit that shares the gate's port, a dozen regeneration commands, and small duplicated helpers.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W17 and its Global Constraints. Branch `chore/gates-and-tooling`. Read at `main` @ `9812bed8` (W6 and W16 merged).

**Tech stack:** vitest + fast-check + Playwright + typescript-eslint (web), pytest + Hypothesis (server), the repo's Python tooling under `server/tooling/`.

---

## Where the code disagrees with W17

The code wins in each case; the tasks below are written to the code.

| W17 says | The code says | Consequence |
|---|---|---|
| "The five `*.prop.ts` drivers" | Six share the driver shape: `assistant`, `journal`, `ops`, `outline`, `outline/draft`, `sync/sync` (`draft.prop.ts` splits "a budget problem" across lines, so a grep misses it). `sync/queue.prop.ts` uses `fc.assert` plus a tally. | Task 4 converts all six; `queue.prop.ts` moves to the gate too, so its tally can carry floors. |
| `lintConfig.test.ts` passes unmodified through the split, and two rules move to `eslint-plugin-repo` | The test asserts the rule ids `brands/select-keys-literal` and `brands/ts-expect-error-in-probe` (cases array and two `it` blocks). A second plugin renames them to `repo/...`. | Task 8 splits with ids unchanged and the test untouched; Task 9 moves the two rules and edits only those id strings. |
| `with_floors` on the four server gate suites | The suites import `event` from `hypothesis`, not `hostile.event`, so `hostile.TALLY` sees nothing. `test_ops_state.py` and `test_assistant_turn_props.py` are state machines exposed as `TestOps = OpsMachine.TestCase`, which a decorator cannot wrap. `test_unlink_props.py` has no `event()` labels at all. Under any profile but `merge`, `props.harness.examples()` caps runs at 20, which no floor survives. | Task 2 swaps the import, wraps the machines in test functions, designs labels for unlink, and arms floors only under `merge`. |
| e2e under the eslint config | Brand rules apply to every linted file. e2e cannot import `src/test-helpers.ts`, because that module imports `vitest`. | Task 7 needs a route for e2e brand values (see Questions). |
| `harness.mjs` consumers other than `check.mjs` default to 8976 | `check.mjs` reads `PORT` from `harness.mjs` too, but `perfcheck/run.py` always sets `E2E_PORT=8977` when it launches it. `seed.mjs`, `ws-probe.mjs` and `offline-probe.mjs` each carry their own `BASE` copy with `?? "8977"`. | Task 13 changes the one default in `harness.mjs` and makes the three scripts import `BASE`. |
| The AGENTS.md trap W6 rewrote | It now reads "The `.mjs` files under `web/tooling/` and all of `web/e2e/` are neither type-checked nor linted". The stash trap says "`pnpm build` typechecks them" only of unit tests under `src/`. | Task 7 drops the e2e half and widens the stash trap (e2e specs are then type-checked by `pnpm build`); Task 12 drops the `.mjs` half. |
| checks.md divergences D1 to D7 | W6 already corrected them (`47aad661`, `f78a0867`). | Nothing to redo; Task 17 changes only what W17 makes newly true. |

## Measured fallout

Measured in this worktree by trying each change and reverting it.

**e2e under `tsc`** (an `e2e/tsconfig.json` extending the root config, `types: ["node"]`): three errors in `.ts` files. `files.spec.ts` has two untyped `page` parameters (TS7006) and `undo.spec.ts` an unused `PASSWORD` (TS6133). `sahpool-tool.worker.mjs` adds 14 implicit-any errors under `checkJs`.

**e2e under the eslint config:** 88 findings plus one parse error.

| Rule | Count | Where |
|---|---|---|
| `brands/name-carries-brand` | 40 | `title`/`pageTitle`/`page_title` (26), `uid`/`parent_uid` (13), `base_subtree_hash` (1), across 22 files: helper parameters and local wire interfaces |
| `no-unsafe-*` | 39 | 33 in `files.spec.ts` (all from its two untyped `page` parameters), the rest from untyped `res.json()` reads |
| `no-explicit-any` | 3 | `files.spec.ts` (`window as any`) |
| `react-hooks/rules-of-hooks` | 4 | Playwright's fixture `use` callback in `fixtures.ts` and `ownPage.ts`: a false positive, since e2e holds no React |
| `brands/no-brand-assertion` | 2 | `sahpool-tool.ts` (`reply.result as T`), `toc.spec.ts` (`as never`) |
| parse error | 1 | `playwright.config.ts` is in no `tsconfig.json` the project service finds |

**Tooling `.mjs` under `checkJs`:** about 630 errors (681 lines with overload continuations). Kinds: TS7006 implicit-any parameter 446, TS2339 86 (mostly `window.__perf*`/`__react*` globals that `instrument.js` installs, and `{}` accumulators in `perf.mjs`), TS7053 22, TS7005 13, TS18047 13, and a tail. By file:

| File | tsc errors | eslint findings (untyped) |
|---|---|---|
| `eslint-plugin-brands/index.mjs` | 311 | 1,740 |
| `perf/check.mjs` | 131 | 406 |
| `perf/perf.mjs` | 108 | 201 |
| `fcis-core.mjs`, `fcis.mjs` | 20, 16 | 68, 52 |
| `perf/ws-probe`, `seed`, `offline-probe`, `summarize`, `harness` | 10, 9, 9, 3, 7 | 17, 25, 55, 97, 40 |
| `genTypes-core.mjs`, `genTypes.mjs` | 4, 0 | 8, 1 |

The eslint column was taken with `checkJs` off, where everything is `any`, so most of it is `no-unsafe-*` that typing removes. The findings that typing does not remove: 3 `no-floating-promises` (`perf.mjs`, `ws-probe.mjs`), 5 `use-unknown-in-catch-callback-variable`, and 6 `brands/no-brand-bypass` in the plugin itself (aliasing `Object`). The investigation toolkit (`perf.mjs`, `ws-probe`, `offline-probe`, `seed`, `summarize`) accounts for 139 tsc errors and about 400 lint findings.

## Tasks

Each task is one reviewable commit series in its own worktree off `chore/gates-and-tooling`, merged back with `--no-ff`. "Web gates" means the brief's list (`pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build`). "Server gates" means `uv run pytest -q`, `uv run pyrefly check` and `uv run ruff check` from `server/`.

### Task 1: Every server property file is marked or allowed

**Implementer:** sonnet (one test, fully specified).

**Files:** `server/tests/test_proptest_exclusion.py`.

- Replace the hard-coded `PROPERTY_FILES` with an enumeration of `tests/props/test_*.py`. Each file must carry `pytestmark = pytest.mark.proptest` or be named in `UNMARKED = {"test_model.py": "<why>"}`. Read the marker by parsing the module (`ast`), not by importing it.
- Keep the two existing collection tests. Have the first assert, against the enumerated set, that `pytest --collect-only` without `-m` collects nothing from a marked file.
- **Red:** delete `pytestmark` from `test_unlink_props.py` in the working tree. The new test fails, naming the file. The old test passed, because the file was not in its tuple. Restore the marker.
- **Done:** server gates green. A new `tests/props/test_*.py` with no marker and no allow-list entry fails `pytest -q`.

### Task 2: Server gate suites assert reach

**Implementer:** opus (choosing which labels are stable, labels for unlink, and the floor measurement).

**Files:** `server/tests/props/test_ops_state.py`, `test_planner_props.py`, `test_unlink_props.py`, `test_assistant_turn_props.py`, `server/tests/props/harness.py`, and possibly `server/tests/hostile.py`. Leave `checks.md` to Task 17.

- Import `event` and `count` from `hostile` in the four suites in place of `hypothesis.event`, so `TALLY` counts what Hypothesis reports.
- Count one `per` label once per example: `count("example")` in the machines' `@initialize` rule and at the top of each `@given` body.
- Replace `TestOps = OpsMachine.TestCase` (and `TestTurnPhase`) with a test function that calls `hypothesis.stateful.run_state_machine_as_test(Machine, settings=...)` with the same settings. Decorate it with the floors.
- Floors are asserted only under the `merge` profile, as `examples()` already decides. Add `merge_floors(floors, per)` to `props/harness.py`: it returns `hostile.with_floors(floors, per)` under `merge` and the identity decorator otherwise. A `dev` run of `pytest -m proptest` stays green.
- `test_unlink_props.py` has no labels. Add `event()` labels for the cases its properties exist to reach, then measure them. Candidates are a source holding the target by alias, an inlined block copy, a blocker kept, and a stale unlink with nothing left to strip; read the module docstring for the full list.
- **Measuring:** add the labels and `merge_floors({}, "example")` first, so `PKM_FLOOR_LOG` records the tallies. Then the orchestrator runs 30 unseeded `merge` runs serially (see Final gates, and Questions 5): `for i in $(seq 30); do HYPOTHESIS_PROFILE=merge PKM_FLOOR_LOG=$LOG uv run pytest -m proptest --no-cov -q tests/props/test_ops_state.py tests/props/test_planner_props.py tests/props/test_unlink_props.py tests/props/test_assistant_turn_props.py; done`. Set each floor by `with_floors`' docstring recipe: half the lowest share, rounded down to three decimals, and no floor for a label whose lowest count was under about five.
- **Red:** with a floor in place, make the generator stop drawing its case: for example, pin `race` to 0 in `test_cli_batch_positions`, so `concurrent delete` never happens. The `merge` run fails on that floor. Revert.
- **Done:** server gates green; `proptest/check.sh server` green. Each suite's floors are in its file next to the test, with a comment naming the measurement (the number of runs and the date). A label left without a floor carries a one-clause reason (a heavy tail, or under five events).

### Task 3: Server teeth

**Implementer:** opus (choosing a mutant per suite, and the invariant each must break).

**Files:** `server/tests/props/test_teeth.py` (new, `pytestmark = pytest.mark.proptest`), and `props/harness.py` only if it needs a teeth example count.

- One mutant per suite, applied with pytest `monkeypatch` on a production module global. Each test runs the suite's property under reduced settings and asserts that it fails in the named invariant. Starting candidates; confirm that production calls each through its module global, or the patch is silent:

| Suite | Candidate mutant | Must break |
|---|---|---|
| `test_ops_state.py` | `pkm.server.ops_core.find_op_text_limit_violation` returns `None` (the server takes over-limit text) | the machine's text-limit refusal check |
| `test_planner_props.py` | `pkm.planning.order_idx_at_position` off by one | sibling order against `positions_after` |
| `test_unlink_props.py` | `pkm.unlink.unlink_title_refs` (or `_unlink_pass`) returns its input | "no rewritten source references the page" |
| `test_assistant_turn_props.py` | `ClaudeConversation._interrupt` sends twice | `one_interrupt_per_turn` |

- Interface: `def expect_caught(run: Callable[[], None], invariant: str) -> None`. It runs `run` under `pytest.raises(Exception)` and asserts that `invariant` names a frame in `excinfo.traceback` (`entry.name`). A frame name outlives message wording; assertion messages in these suites are not uniform.
- Settings for a teeth run: `database=None`, so a mutant's failing example is never saved and replayed into the clean run's test key; `report_multiple_bugs=False`, so the result is one exception and not an `ExceptionGroup`; `phases=(Phase.explicit, Phase.generate)`, so it does not spend time shrinking; and an example count large enough to catch the mutant across several `--hypothesis-seed` values.
- `unlink`'s test module imports `apply_delete_rewrite` by name. Patch a callee inside `pkm.unlink` (looked up through module globals), not the imported name.
- **Red:** each teeth test passes with its mutant applied. Removing the monkeypatch makes it fail with "mutant survived", which shows that the assertion is real.
- **Done:** `proptest/check.sh server` green, with the teeth inside it; sweep three seeds (`--seed`). `pytest -q` still collects none of it (Task 1 enforces the marker).

### Task 4: One web gate driver

**Implementer:** opus (seed replay must survive; the sync driver's settle step; per-run tallies).

**Files:** `web/src/props/gate.ts` (new, Imperative Shell), `web/src/props/reach.ts` and `reach.test.ts` (new, Functional Core). The six drivers (`assistant/assistant.prop.ts`, `journal/journal.prop.ts`, `ops/ops.prop.ts`, `outline/outline.prop.ts`, `outline/draft.prop.ts`, `sync/sync.prop.ts`), `sync/queue.prop.ts`, and the seven teeth files (`assistant/teeth`, `journal/teeth`, `outline/teeth`, `outline/draftTeeth`, `outline/imeTeeth`, `ops/teeth`, `sync/queueTeeth`). `sync/teeth.prop.ts` is a different mechanism (transport modes and teeth routes) and stays as it is.

Interfaces (signatures only; the bodies are the code each driver already repeats):

```ts
export type Tally = Map<string, number>;
export interface Reach { per: string; floors: Readonly<Record<string, number>> }

export function checkGateProperty<Ts extends unknown[]>(p: {
  suite: string;            // "journal property", used in every message
  file: string;             // the --file value in the replay line
  arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> };
  predicate: (...args: Ts) => Promise<void>;   // throws on a finding
  numRuns: number;
  limitMs: number;
  show: (counterexample: Ts) => string;        // the report body
  settle?: () => Promise<void>;                // after fc.check, before judging
  tally?: Tally;                               // printed; checked by Task 5
}): Promise<fc.RunDetails<Ts>>;

export function expectMutantsCaught<Ts extends unknown[], M>(p: {
  suite: string;
  mutants: Readonly<Record<string, M & { catches: readonly string[] }>>;
  arbs: { [K in keyof Ts]: fc.Arbitrary<Ts[K]> };
  problems: (mutant: M, ...args: Ts) => Promise<readonly string[]>;
  numRuns: number;
  limitMs: number;
}): void;  // registers one vitest test per mutant

// reach.ts
export function reachProblems(tally: ReadonlyMap<string, number>, reach: Reach): string[];
```

- `checkGateProperty` passes `...arbs` to `fc.asyncProperty` in the same order, with `{ numRuns, seed: SEED, path: PATH, interruptAfterTimeLimit: limitMs, markInterruptAsFailure: false }`, and keeps the three-branch judgement, the report lines and the replay-line format byte for byte. `expectMutantsCaught` keeps `endOnFailure: true`, the `PropertyReport` class, the "mutant survived" / "caught by a thrown error" / "not by <catches>" messages, and the `cutOff` wording where a file has it.
- Fixed scenarios, `beforeAll`/`afterAll` server setup, `captureFaultWarnings` and the per-file constants stay in the driver files. Only the repeated property loop moves.
- `ops/teeth.prop.ts` arms server faults per mutant (its `afterSeed` and seam). If `problems` cannot carry that, give the mutant record an optional `arm?: () => Promise<void>` rather than leaving the file unconverted.
- **Red:** `reach.test.ts` tables `reachProblems` (under a floor, at a floor, a missing label, a zero `per`), plus one test that the replay line `checkGateProperty` builds matches the format the drivers print today.
- **Replay check:** before converting each driver, run it once with `PROPTEST_SEED=<n>` and record the `numRuns` it reports and a counterexample `path` from a teeth run. After converting, the same seed must report the same; for a teeth file, the same seed must fail on the same example. Record the seeds in the commit message.
- **Done:** web gates green, and each converted suite passes alone with `proptest/check.sh web --file <suite>`, one at a time (port 8978 is one per machine). Commits: `gate.ts` plus `reach.ts` first, then one commit per driver or teeth family.

### Task 5: Web reach floors

**Implementer:** opus (choosing floors on stable labels only, and where each tally is taken).

**Files:** the drivers from Task 4 and `gate.ts`.

- `checkGateProperty` gains `reach?: Reach`. After a passing run, and only when `PATH` is unset (a path replays one counterexample, so its tally means nothing), it throws the `reachProblems` lines. When `PROPTEST_REACH_LOG` is set, it appends `{suite, per, tally}` as one JSON line, the web twin of `PKM_FLOOR_LOG`.
- Tallies must count only the drawn examples. Today `sync.prop.ts`'s module-level `tally` also counts the fixed scenarios that run before the property (`count` and `countSkipsWith`), and `assistant`, `ops`, `draft` and `queue` count inside the property under test. That is safe only because a passing run never shrinks. Give each property run a fresh `Tally` from `checkGateProperty`; do not assert on a tally the fixed scenarios also wrote.
- `journal.prop.ts` takes its tally from a separate reach run (`NUM_RUNS / 10`, same seed). Keep that test and give its tally to `reachProblems`.
- Measure as in Task 2. The orchestrator runs 30 unseeded `PROPTEST_REACH_LOG=$LOG proptest/check.sh web --file <suite>` runs per suite, serially. Set floors by the same half-of-lowest-share recipe (`hostile.with_floors`' docstring; `reach.ts` names it rather than restating it). For `sync`, the reach signal is each `Fault <kind> fired` against `examples`. A fault armed far more often than it fired is the case the floor must catch.
- **Red:** with floors set, make one generator stop reaching a label (in a scratch change, give an arbitrary a weight of zero). That suite fails on the floor. Revert.
- **Done:** web gates green. Every suite passes `proptest/check.sh web --file <suite>` three times unseeded with floors in place.

### Task 6: An unexpected fault warning fails the gate

**Implementer:** sonnet (pure function plus a one-line shell change).

**Files:** `web/src/props/warnings.ts`, `warnings.test.ts`, `warningsCapture.ts`.

- Add `unexpectedFailure(tally: WarningTally): string | null` to `warnings.ts`. It returns the failure text, naming each unknown warning's context and text, or `null` when there are none. In `captureFaultWarnings`' `afterAll`, print the summary as now, then `throw new Error(...)` when it is non-null. A throwing `afterAll` fails the file in vitest.
- **Red:** a `warnings.test.ts` case with one unknown warning expects a non-null message naming its context.
- **Check before merging:** run each web suite once (`proptest/check.sh web`, the whole side, serially on 8978). Any suite that prints an `UNEXPECTED` line today now fails. Fix its cause or add a kind to `EXPECTED_KINDS`, with the reason; never silence it.
- **Done:** web gates green; the full web side of the property gate green.

### Task 7: `web/e2e` and `playwright.config.ts` are type-checked and linted

**Implementer:** opus (the e2e brand route; see Questions 3).

**Files:** `web/e2e/tsconfig.json` (new), `web/package.json` (`typecheck` gains `&& tsc -p e2e/tsconfig.json`; `lint` becomes `eslint src tooling e2e playwright.config.ts`), `web/eslint.config.js`, the e2e files with findings, the registry (`server/src/pkm/brand_registry.py`, regenerated `web/tooling/brandRegistry.gen.json` via `uv run python -m pkm.rows_dump`), a vitest-free test mint module if Question 3 is answered yes, `AGENTS.md` (two traps), and `checks.md`'s typecheck and eslint rows.

- `e2e/tsconfig.json` extends `../tsconfig.json` with `types: ["node"]`, `allowJs` and `checkJs` (for `sahpool-tool.worker.mjs`, which takes JSDoc types), and includes `**/*.ts` and `**/*.mjs`. The DOM lib stays, since `page.evaluate` bodies run in the page.
- `playwright.config.ts`: the project service looks only at the nearest `tsconfig.json`, `web/tsconfig.json`, whose `include` is `src`. Use `parserOptions.projectService: { allowDefaultProject: ["playwright.config.ts"], defaultProject: "e2e/tsconfig.json" }` (check the option names against the installed typescript-eslint), and have `tsc -p e2e/tsconfig.json` include it.
- The e2e config block lints `e2e/**/*.{ts,mjs}` with every rule except `react-hooks/*`. e2e holds no React, and the fixture parameter Playwright names `use` is not a hook. Do not rename `use` to get past the rule.
- Brand findings: no parameter renames to dodge the rule. Type wire data with the generated API types (type-only imports from `src/api`), mint literal values through the test mint route, and read server JSON through one boundary helper (for example `e2e/serverJson.ts`) listed in `OPT_OUT_FILES`, with one `brand: untrusted -- <reason>` line. Add `web/e2e/` to `TEST_CODE`, so remedies name the test helpers. `test_brandlint_registry.py` proves each new entry is live.
- AGENTS.md: delete "and all of `web/e2e/`" from the unchecked-code trap. In the stash trap, say that `pnpm build` type-checks e2e specs too, so a red-check stash takes its new specs with it.
- **Red:** `pnpm typecheck` and `pnpm lint` exit non-zero once the configs are in, with the counts above. They reach zero with the fixes. A deliberate `const x: number = "a"` in any spec fails `pnpm typecheck`.
- **Done:** web gates green, and each changed spec passes alone on its own `E2E_PORT` (`E2E_PORT=<task port> pnpm exec playwright test e2e/<spec>` after `pnpm build`). The orchestrator runs the full Playwright suite after merge, since most specs change.

### Task 8: Split the brands plugin, behaviour unchanged

**Implementer:** sonnet (a move with module boundaries given here; `lintConfig.test.ts` pins behaviour).

**Files:** `web/tooling/eslint-plugin-brands/` (`index.mjs` stays as the entry), `docs/architecture/checks.md` (§ Brand rules' pointer to the header).

| New module | Takes from `index.mjs` |
|---|---|
| `registry.mjs` | `registry` load, `pathMatcher`, `repoPath`, `isTestCode`, `isMintSite`, `testFileGlobs`, `TEST_FILE`, mint-site maps |
| `types.mjs` | type analysis: `brandsOf`, `launders`, `mintedBrands`, `unbackedLaunder`, `declaresBrand`, `overlaps`, `shallowBrands`, `ownBrand`, `undeclaredBrands`, `elementOf`, `instantiatedBases`, `genericReturn`, `holdsAny`, `anyReturning`, the caches and their constants (`SUBTYPES`, `BRAND_TAGS`, ...) |
| `optOut.mjs` | `optOutKind`, `ledgers`, `joinLedger`, `settleOptOuts`, `OPT_OUT_UNUSED` |
| `remedy.mjs` | `testRemedy`, `remedy`, `brandText`, `PARSERS`, `MODULES_SHOWN`, `webTestMints` |
| `nameCarriesBrand.mjs`, `noBrandAssertion.mjs`, `noBrandBypass.mjs`, `selectKeysLiteral.mjs`, `tsExpectErrorInProbe.mjs` | one rule each, with its paragraph of the header comment moved to the top of its module |

- `index.mjs` keeps the default export `{ rules: {...} }` under the same five ids and re-exports `isMintSite, isTestCode, pathMatcher, repoPath, testFileGlobs`, which `eslint.config.js` and `lintConfig.test.ts` import.
- Module-level state (`caches`, `ledgers`) must stay one instance shared by every rule. Export it from the one module that owns it; never copy it into two modules.
- Each new module carries `// pattern: Imperative Shell`, as `index.mjs` does. `check:fcis` and the comment lint judge every file.
- **Check:** `git diff --no-ext-diff --stat` shows `lintConfig.test.ts` untouched; the full `lintConfig.test.ts` and `pnpm lint` pass before and after.
- **Done:** web gates green, and the move is one commit per extracted module or a single commit whose diff is pure moves.

### Task 9: The two non-brand rules get their own plugin

**Implementer:** sonnet (fully specified rename).

**Files:** `web/tooling/eslint-plugin-repo/index.mjs` (new; the two rule modules move here), `web/tooling/eslint-plugin-brands/index.mjs`, `web/eslint.config.js` (register `repo`; ids `repo/select-keys-literal`, `repo/ts-expect-error-in-probe`; the header's policy list), and `web/tooling/lintConfig.test.ts`, where only the four id strings change.

- **Done:** web gates green; `git grep -n 'brands/select-keys-literal\|brands/ts-expect-error-in-probe'` finds only plans and beans.

### Task 10: Fixtures become `x.bad.ts` / `x.ok.ts` pairs

**Implementer:** sonnet (mechanical, with the rules below).

**Files:** `web/tooling/eslint-fixtures/**`, `web/tooling/lintConfig.test.ts`, and checks.md's eslint row if it names the fixture shape.

- Rename each case's fixture to `<name>.bad.ts(x)`, and write its `corrected` string to `<name>.ok.ts(x)` beside it. `FixtureCase` loses `corrected`. The "corrected variant" test lints each `.ok` file from disk at its own path, and asserts that the `.ok` file exists for every `.bad`.
- The two cases with `correctedAs: "src/paths.test.ts"` need a test-file path to import the test helpers. Keep them as `lintText` of the `.ok` file's contents at that path (`correctedAs` stays for exactly these), or name the `.ok` file so that `testFileGlobs` covers it. State which in the commit.
- `.ok` files sit in the tooling lint project, so they must type-check as written. They stay out of `pnpm typecheck` through `tsconfig.typecheck.json`'s `exclude`, as the bad ones do.
- The inline `lintText` cases under "brands plugin judgement" stay; W17 names only the `cases[].corrected` strings.
- **Done:** web gates green, with the same number of `it` results before and after. No `corrected:` remains in `lintConfig.test.ts`.

### Task 11: One registry path matcher on both sides

**Implementer:** sonnet (semantics fully given by the JS matcher).

**Files:** `server/tooling/brandlint/core.py` (`_site_allowed` and `_glob_to_regex` become one `registry_path_matches(pattern, path)` with the JS `pathMatcher` semantics: a trailing `/` is a prefix, `**/` is zero or more directories, a bare `**` crosses directories, `*` does not), `server/tests/test_brandlint_registry.py` (uses it), `shared/fixtures/registry_paths.json` (new, hand-edited: `[{pattern, path, matches}]`, covering the prefix, `**/`, a bare `**`, `*`, an exact path and a dot in a name), a pytest reading it, a vitest beside `eslint-plugin-brands/registry.mjs` reading it, and `pathMatcher`'s comment in `registry.mjs`. Add a row to backend.md's generated-artifacts table: hand-edited, its two tests, and what it pins.

- **Red:** the fixture's case of a glob used as a mint site (`web/src/**/x.ts`) fails the Python test before the change, which is the latent F9 bug, and passes after.
- **Done:** server and web gates green.

### Task 12: Tooling `.mjs` is type-checked and linted

**Implementer:** opus (JSDoc for the TypeScript compiler API, and where `window` globals get declared). After Tasks 8, 9, 11, 13 and 14, because it types the files they change.

**Files:** `web/tooling/tsconfig.json`, `web/eslint.config.js` (`files` gains `tooling/**/*.mjs`), every `.mjs` under `web/tooling/` that remains after Question 4, `AGENTS.md` (drop the trap's `.mjs` half), and checks.md's typecheck row.

- Stage it so each commit is green. Commit 1 adds `"**/*.mjs"` to the tooling `include` with `checkJs` still false: tsc reports nothing for unchecked JS. Each later commit adds `// @ts-check` to one file group and fixes it: the plugins, then `fcis*`, then `genTypes*`, then `perf/check.mjs` and `harness.mjs`, then the toolkit if it stays. The last commit sets `checkJs: true`, removes the pragmas, adds the `.mjs` glob to eslint's `files`, and fixes what lint reports.
- `window.__perf*`, `__react*`, `__marks` and the others are globals that `instrument.js` and `react-commits.js` install. Declare them once in a `perf/globals.d.ts`, rather than casting at each read.
- TypeScript API types in JSDoc: `/** @param {import("typescript").Type} type */`. No `@type {any}`, and no `@ts-ignore` or `@ts-expect-error` (eslint already bans them).
- The real findings above (floating promises, catch variables, the plugin's own `Object` aliasing) get fixed, not suppressed.
- If Question 1 is answered "convert to `.ts`": same staging, renaming each file to `.ts`. Add `allowImportingTsExtensions` and `erasableSyntaxOnly` to the tooling tsconfig, and an `engines.node` floor to `web/package.json`. Update every invoker: `package.json` scripts, `eslint.config.js`'s import, `perfcheck/run.py`'s `check.mjs` path and its tests, and `vitest` imports. The existing `tooling/**/*.{ts,tsx}` lint glob then covers them.
- **Done:** web gates green; `pnpm typecheck` covers every tooling script; `perf/check.sh frontend` still runs (the orchestrator's perf run shows it).

### Task 13: The perf investigation toolkit gets its own port

**Implementer:** sonnet (fully specified). If Question 4 is answered "retire", this task deletes `perf.mjs`, `ws-probe.mjs`, `offline-probe.mjs`, `seed.mjs` and `summarize.mjs` instead. It keeps `harness.mjs`, `instrument.js`, `react-commits.js`, `rebase*`, `sqlcount*` and `baselines/`, and the README says the gate superseded the toolkit, with `baselines/` as the record.

**Files:** `web/tooling/perf/harness.mjs` (`PORT` default `"8976"`), `seed.mjs`, `ws-probe.mjs`, `offline-probe.mjs` (import `BASE` from `harness.mjs`, dropping their copies), `perf.mjs`'s header comment, `README.md` (start the server on 8976, note its PID with `$!`, and stop it with `kill <pid>`), the AGENTS.md ports table (an 8976 row), and `FORBIDDEN_PORTS` in `.claude/skills/ipad-simulator/scripts/simpad.py` (add 8976).

- **Check:** `git grep -n '8977' web/tooling/perf` finds only `check.mjs`'s header, which describes the gate.
- **Done:** web gates green. This task does not touch `check.mjs`'s behaviour, since `perfcheck/run.py` passes `E2E_PORT=8977`.

### Task 14: Orchestrator cleanups

**Implementer:** sonnet (each item is named to the symbol).

**Files:** `server/tooling/proptest/sides.py`, `proptest/run.py`, `server/tooling/perfcheck/run.py`, `run_core.py`, `compare.py`, `web/tooling/perf/check.mjs`, a new `server/tooling/repo_git.py` (Imperative Shell), and their tests (`test_proptest_sides.py`, `test_perfcheck_run.py`, `test_perfcheck_compare.py` and the `run_core` tests).

- Delete `sides._AVAILABLE`, `available()`, `run.main`'s "no properties yet" branch, and `test_both_sides_available`.
- `web_command(file: str | None = None)`, without the unused `seed`. Update `test_web_command*`.
- Move `changed_paths(repo)` and `_git` to `repo_git.py`. `perfcheck.run` and `proptest.run` both import them. The `changed_paths` tests in `test_perfcheck_run.py` move to `test_repo_git.py`.
- `check.mjs` owns its context groups: a `CONTEXT_GROUPS` constant beside the contexts `main()` builds. `--only` expands each letter to its whole group before running. Python passes letters through: `frontend_letters` loses `_CONTEXT_GROUPS` and keeps only the letter extraction. Its test changes to expect the letters unexpanded. Fix checks.md's `_CONTEXT_GROUPS` mention (§ Performance gate, "Counts are deterministic").
- `compare.reproduced(baseline, f, rerun) -> bool`: true when the re-run is still worse than the baseline (today's `_still_worse`). `run.do_check` selects survivors with it. `test_confirm_without_merge_base_means_regression` stays, since `confirm(..., None)` is still reachable.
- **Red:** a `reproduced` unit test; a `check.mjs` `--only H` dry-run assertion if `check.mjs` gains a testable `expandOnly` export (move it into a small core module with a vitest if the file has no seam).
- **Done:** server and web gates green.

### Task 15: One regeneration command

**Implementer:** sonnet (fully specified).

**Files:** `server/src/pkm/regen.py` (new, Imperative Shell), `server/tests/test_regen.py` (new), backend.md § Generated artifacts and parity fixtures.

- `python -m pkm.regen` runs, in order: `openapi_dump` → `web/src/api/openapi.json`, then `pnpm gen-types`; `schema_dump`; `rows_dump` (writes its own files); `preview_keys_dump`; `tag_chars_dump` (plain mode only); `title_whitespace_dump`; `refs_parity_dump`; `title_parity_dump`; `text_limits_parity_dump`; `shim_parity_dump`; then the three `UPDATE_*=1 pnpm vitest run <file>` fixtures. Each writes its target file itself (no shell redirect) and prints the path. It exits non-zero on the first failure, naming the step.
- `tag_chars_dump --table` stays out: it rewrites the source it imports, and only a Unicode move calls for it.
- Order matters only for `openapi.json` before `gen-types`. Keep a `STEPS` table in the module so the order is data.
- **Red:** `test_regen.py` enumerates every `pkm/**/*_dump.py` and asserts that each is a step, `tag_chars_dump` in plain mode. It also asserts that each `UPDATE_*` fixture named in backend.md's table is a step. Adding a dump without a step fails.
- backend.md: the "Regenerate with" column says `uv run python -m pkm.regen` once, in the section's lead paragraph, and the column keeps only the exception (`tag_chars --table`).
- **Done:** server gates green. `uv run python -m pkm.regen` on a clean tree leaves `git status` clean.

### Task 16: Budgets carry one sentence per limit

**Implementer:** sonnet (fully specified).

**Files:** `web/tooling/budgets.json`.

- `rationale` keeps `policy` and one sentence per limit, saying what it guards and why: the first sentence of each entry, trimmed of measurements and dates. The history leaves the file. It is in git (`git log -p -- web/tooling/budgets.json`), and the commit message says so. `measuredOn` is dropped.
- `limits` is unchanged. Confirm that nothing reads `rationale` or `measuredOn` (`git grep -n 'rationale\|measuredOn' web/tooling web/vite.config.ts`).
- **Done:** web gates green; `pnpm build` passes the budgets.

### Task 17: Docs say what W17 made true

**Implementer:** sonnet (each sentence is specified; skill edits per `superpowers:writing-skills`; docs per `architecture-docs`).

**Files:** `AGENTS.md` § Testing, `.claude/skills/verify/SKILL.md` § Performance, `docs/architecture/checks.md` § Property gate and § Every check, `.claude/skills/architecture-docs/check-docs.mjs` (`checkBeans`).

- AGENTS.md Performance bullet keeps what the tool cannot print. Never pass `--allow-busy`. A regression that survives your fix goes to Arthur with the table; if he accepts it, `--bootstrap` with the reason in the commit. `unstable` exits 1, and that is expected: file a bean against the harness and carry on. A faster timing is never recorded by a check. A branch's review package includes the perf table. Everything else becomes "follow the `next:` lines".
- verify skill § Performance: replace its verdict list with a link to that bullet.
- checks.md § Property gate: server suites now have teeth (`tests/props/test_teeth.py`) and asserted floors (`merge_floors`). Web reach is asserted by `checkGateProperty` (`props/gate.ts`), and its floors follow `with_floors`' recipe. An `UNEXPECTED` fault warning fails its file. The "read the tally" advice becomes how to set a floor (`PKM_FLOOR_LOG`, `PROPTEST_REACH_LOG`). AGENTS.md's "Label the new path with `event()` and read its rate" becomes "and give it a floor".
- `check-docs.mjs`: delete `checkBeans` and its call; the comment lint already judges every line of `docs/architecture/*.md` on every commit. checks.md's architecture-docs row drops "no bean id in prose" and the comment-lint row gains `docs/architecture`.
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `lint:comments` green.

## Order and parallel lanes

```
Lane S (server props):   T1 -> { T2 , T3 }                       T2 and T3 disjoint
Lane P (web props):      T4 -> T5 ;  T6 alongside T4             one web proptest run at a time
Lane L (web lint):       { T7 , T8 } -> T9 -> { T10 , T11 }
Lane O (other tooling):  T13 , T14 , T15 , T16                   all disjoint
Then:                    T12 after T8, T9, T11, T13, T14
Last:                    T17 after everything it describes
```

Shared files and who edits them:

| File | Tasks | Rule |
|---|---|---|
| `web/eslint.config.js` | T7, T9, T12 | serial in that order |
| `web/tooling/lintConfig.test.ts` | T9, T10 | serial |
| `web/tooling/eslint-plugin-brands/*` | T8, T9, T11, T12 | serial |
| `web/tooling/perf/check.mjs`, `harness.mjs` | T13 (`harness`), T14 (`check`), T12 (both) | T12 last |
| `AGENTS.md` | T7 (traps), T12 (trap), T13 (ports row), T17 (perf, property) | distinct paragraphs; rebase on merge |
| `docs/architecture/checks.md` | T7, T12 (table rows), T8 (§ Brand rules pointer), T14 (§ Performance gate), T17 (§ Property gate, two rows) | § Property gate is T17's alone |
| `server/src/pkm/brand_registry.py`, `brandRegistry.gen.json` | T7 | regenerate on the merge result if T11 also touched the registry |

Machine-wide serial resources: port 8978 (any `proptest/check.sh web`: T4, T5, T6 and the floor runs), the floor measurement loops (T2, T5), `perf/check.sh` and the full Playwright suite. A floor loop must not overlap perf, because the perf check refuses a busy machine. It should not overlap another property run either: load pushes suites into their `PROPERTY_LIMIT_MS` budget failures.

## Traps

- **Seeds must still replay after `gate.ts`.** Pass the arbitraries to `fc.asyncProperty` exactly as each driver does today. Do not wrap them in a new `fc.tuple`, add an arbitrary, or reorder them (`sync.prop.ts`'s comment: "an arbitrary's place fixes what a seed and path replay"). Do not draw anything before `fc.check`. Prove it per driver with a recorded seed (Task 4).
- **A floor on an unstable label makes the gate flaky.** Floors come only from 30 or more unseeded runs as the gate makes them, never from a seeded run (it repeats its draws) or a handful of runs. A label whose lowest count was under about five gets no floor. A rare label that matters is fixed in the generator, or becomes a pytest parameter on the server.
- **A tally that counts shrinks, fixed scenarios or a replayed path is not reach.** Assert only after a passing run, with `PATH` unset, on a tally only the drawn examples wrote.
- **Server floors under the `dev` profile always fail**, since `examples()` caps runs at 20. Gate them on `merge`.
- **Teeth that write to Hypothesis's example database** replay the mutant's failure into the clean test's key. Use `database=None`. Use `report_multiple_bugs=False` too, or a mutant that breaks two invariants raises an `ExceptionGroup`.
- **A monkeypatch on a name the caller imported directly does nothing.** The unlink test imports `apply_delete_rewrite`; patch a callee inside `pkm.unlink` that it looks up through module globals. The same caution holds for every server mutant.
- **`lintConfig.test.ts` must pass unmodified through Task 8.** That holds only if the rule ids stay `brands/...` and `index.mjs` keeps re-exporting the five helpers. Moving `caches` or `ledgers` into two modules splits shared state, and opt-outs stop settling across rules.
- **Turning on `checkJs` for the whole tooling tree in one commit** leaves about 630 errors and a red tree. Stage it per file group with `// @ts-check` (Task 12).
- **e2e and `react-hooks`:** do not rename Playwright's `use`. Scope the hooks rules to code that has React.
- **e2e cannot import `src/test-helpers.ts`**, because it imports `vitest`, which fails inside Playwright. Type-only imports from `src/api` are erased and safe.
- **`playwright.config.ts` and the project service:** listing it in `e2e/tsconfig.json` is not enough, because the service looks only at the nearest `tsconfig.json`.
- **Red-checking an e2e fix after Task 7:** `pnpm build` now type-checks e2e, so a stashed fix must take its new specs with it, or the build fails and leaves the old `dist`.
- **`check.mjs` and the merge base:** a merge-base perf run measures the base's product with the branch's harness. Changing `--only` expansion (T14) or typing `check.mjs` (T12) must not change what a scenario measures, or the frontend check reads `stale-baseline`. If it does, explain it before any `--rebaseline`.
- **The UNEXPECTED switch (T6) can turn the gate red on day one**, if any suite prints an unknown warning today. Run the whole web side once before merging.
- **The comment lint judges each whole staged file.** Moving code out of `index.mjs` (T8) re-judges every comment in the new modules, so old over-width lines must wrap.

## Final gates

| Gate | Who |
|---|---|
| Server gates (`pytest -q`, `pyrefly check`, `ruff check`) | each implementer, and the orchestrator on the merged branch |
| Web gates per the brief | each implementer |
| `pnpm verify` including the full Playwright suite | orchestrator, after T7 merges and again at the end |
| Floor measurement loops for T2 and T5 | orchestrator, serially, on a quiet machine |
| `perf/check.sh backend`, then `perf/check.sh frontend` | orchestrator, serially, on the branch before merge (T13, T14 and T12 touch the perf harness) |
| `proptest/check.sh` in full, both sides | orchestrator, after T2 to T6 merge, and on the final branch |

## Questions for Arthur

1. **`.mjs` to `.ts`?** W17 says JSDoc plus `checkJs`. Node 26 on this machine runs `.ts` by stripping types, so the plugin, `fcis*`, `genTypes*` and `perf/check.mjs`/`harness.mjs` could become `.ts`, with `erasableSyntaxOnly` and an `engines.node` floor. Recommendation: convert. That gives one type syntax across tooling, the existing `tooling/**/*.{ts,tsx}` lint glob covers the files with no config change, and JSDoc for the TypeScript compiler API is verbose. The plan defaults to W17's JSDoc route until you say otherwise.
2. **Lint the tooling scripts as well as type-check them?** W17 names only `checkJs`. Recommendation: yes, under the same rules as `.ts` tooling, per "whole set, no exemptions". With conversion (Question 1) this comes free.
3. **The e2e brand route.** Recommendation: e2e stays under the brand rules. Add a vitest-free test mint module, re-exported by `test-helpers.ts` and registered in `TEST_MINT_SITES`, one e2e JSON boundary file in `OPT_OUT_FILES` with a single opt-out line, and `web/e2e/` in `TEST_CODE`. The alternative, turning brand rules off for `e2e/**`, is an exemption for code agents copy.
4. **Retire the perf investigation toolkit** (`perf.mjs`, `ws-probe`, `offline-probe`, `seed`, `summarize`; `baselines/` kept as the record), instead of moving it to 8976 and typing it? Recommendation: retire, unless you still run it. It is untested, unchanged since September, and accounts for about 140 tsc errors and 400 lint findings of Task 12. The plan defaults to W17's "keep, port 8976".
5. **Floor measurement cost:** 30 unseeded runs of each gate suite is about 2¼ hours for the server side and 3¼ hours for the web side, serial, with port 8978 held throughout. Recommendation: accept it, run as one unattended job by the orchestrator. The alternative, floors only on the pure web suites (`assistant`, `journal`, `outline`, `draft`, `queue`), leaves `sync`'s "armed but never fired" signal advisory.
