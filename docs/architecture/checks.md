# Checks

What fails mechanically in this repo, when, and what a maintainer of each
check could break without noticing. Each check's code holds its rules,
scenarios and suites. [`AGENTS.md` § Testing](../../AGENTS.md#testing) says
how to run each gate and what to do with its verdicts.
Anything not listed here, such as the server-side FCIS boundary, is
convention plus review.

## Every check

| Check | Guarantees | Runs | Code | A failure |
|---|---|---|---|---|
| commit message | no Claude session URL or `Claude-Session:` trailer | `commit-msg` hook | `.githooks/commit-msg` | [`AGENTS.md` § Git](../../AGENTS.md#git) |
| comment lint | no bean id, line number or pathless spec pointer in a comment or in `docs/architecture`; widths | `pre-commit` hook, pytest, `pnpm verify` (`lint:comments`) | `server/tooling/commentlint` | names rule, file and line |
| regex lint | no Python regex anchors with a bare `$` | as comment lint | `server/tooling/regexlint` | use `\Z` or `fullmatch` |
| brand lint, server | brands minted only at registered sites; strict models; raw `sqlite3` only in `SQLITE_SITES` | as comment lint | `server/tooling/brandlint` | the message names the remedy |
| pytest | the server suite passes over `--cov-fail-under` branch coverage | `uv run pytest -q` | `addopts` in `server/pyproject.toml` | |
| contract tests | generated artifacts are fresh; routes declare a `response_model`; row keys match the DDL; registry paths exist and still mint; the property suite stays out of `pytest -q` | pytest | `test_openapi_sync.py`, `test_routes_models.py`, `test_rows_vocabulary.py`, `test_brandlint_registry.py`, `test_proptest_exclusion.py`, parity tests | regenerate per [backend.md](backend.md#generated-artifacts-and-parity-fixtures) |
| row check | every `Db.select` row fits its `Row` keys and brand shapes | pytest (`PKM_ROW_CHECK=1`) | `pkm.database`, `pkm.rows` | `RowCheckError` names the column |
| pyrefly, ruff | server types; no implicit `Any` in `server/src`; `ANN`, `ANN401`, `E501` | `uv run pyrefly check`, `uv run ruff check` | `pyrefly.toml`, `[tool.ruff]`, whose comments give the policy | |
| typecheck | `tsc` on `src`, the generated API types, all of `tooling`, and `web/e2e` with `playwright.config.ts` | `pnpm verify`, `pnpm build` | `typecheck` in `web/package.json`, which names each tsconfig | |
| eslint | hooks, promises, no `any`, import bans, web brand rules, no unchecked `@ts-` suppression; `web/e2e` and `playwright.config.ts` too, without the hooks rules | `pnpm verify` (`lint`) | `web/eslint.config.js`, `web/tooling/eslint-plugin-brands` | fixtures in `web/tooling/eslint-fixtures`, pinned by `lintConfig.test.ts` |
| FCIS check | a Functional Core web module never imports an Imperative Shell or Mixed one, and every runtime module carries a valid header | `pnpm verify` (`check:fcis`) | `web/tooling/fcis.ts` | [overview.md](overview.md#functional-core--imperative-shell) |
| vitest | unit tests pass over `coverage.thresholds` | `pnpm verify` (`test:coverage`) | `web/vite.config.ts` | |
| unit-test guards | replica rows fit `Columns`; no unsilenced `console.warn`/`error`; no runaway fast-check filter; no orphaned vitest worker; `types.d.ts` matches `openapi.json` | every vitest run (the console guard: unit suite only) | `replica/rowCheck.ts`, `src/test-setup.ts` (the console guard), `src/fcFilterCap.ts` and `src/orphanWatchdog.ts` (wired by `src/test-guards.ts`), `genTypes.drift.test.ts` | each guard's test shows its teeth |
| bundle budgets | the build stays under its caps | `vite build` | `viteBudgetPlugin.ts`, `budgets.json` | |
| Playwright | the built SPA works against a real server | last in `pnpm verify` | `web/e2e` | any 5xx or server exception fails |
| performance gate | no count rises; no timing clearly worsens | `perf/check.sh`, before merge | `server/tooling/perfcheck`, `web/tooling/perf/check.ts` | [Performance gate](#performance-gate) |
| property gate | random batches and commands keep the invariants | `proptest/check.sh`, before merge | `server/tests/props`, `web/src/props` | [Property gate](#property-gate) |
| architecture docs | mermaid parses; links and anchors resolve | by hand | `.claude/skills/architecture-docs/check-docs.mjs` | |

`tsconfig.node.json` checks `web/tooling` as node's type stripping loads it,
with no build step; its `//` comment says what that refuses. The perf payloads (`instrument.js`, `react-commits.js`)
stay JavaScript because `harness.ts` sends their text to the browser, and
`tsconfig.payload.json` checks their JSDoc.

## Comment and regex lint

[`AGENTS.md` § FCIS](../../AGENTS.md#fcis) lists the comment rules and where
they run. The hook judges the whole staged copy of a touched file, so an old
violation is fixed the next time its file changes. Every lint inside
`commentlint.run` is stdlib only, because the hook runs under the system
`python3` and must not depend on a synced venv.

`regex-dollar` has no opt-out. A pattern that means end of line says so with
`re.MULTILINE` or `(?m)`, and the lint reads the flag. Pydantic's
`Field(pattern=)` is exempt: Rust's engine has no newline case for `$` and
rejects `\Z`. The web needs no twin, because a JS regex without the `m` flag
matches `$` only at the end.

## Brand rules

**A value of a brand type is made only at a declared mint site.** A name
that means a brand (`uid`, `page_id`, `pageId`) must carry it. Together these
let the type checker prove that every `BlockUid` came from a parser, a checked
row or a contract model. [backend.md](backend.md#wire-models-and-brands) and
[frontend.md](frontend.md#brands) own the vocabulary.

`server/src/pkm/brand_registry.py` holds the registry for both languages.
`pkm.rows_dump` writes it to `web/tooling/brandRegistry.gen.json` for the
eslint plugin, so one `NAMES` and one `MINT_SITES` serve both sides. The
hook reads the registry and the `NewType` declarations from the index. A
commit that adds a mint site with the code it allows is therefore judged
against the staged registry.

The rules apply to tests too. Tests mint through the checked helpers in
`TEST_MINT_SITES`, which raise unless a value fits the brand's `SHAPES`. A
bad value for a negative test comes from a `MALFORMED` helper. Product code may
import neither. The web's mint module, `test-mint.ts`, imports no vitest, so
the Playwright specs mint there; `test-helpers.ts` re-exports it, and imports
vitest, so the specs may not import it.

The one opt-out is `brand: untrusted -- <reason>` in a comment, allowed only
in the files `OPT_OUT_FILES` lists, each with its reason. It
covers one site, the leftmost on its line, and one that covers nothing is
reported.

The rules and their messages are `RULES` in `brandlint/core.py` and the
header of each rule module under `eslint-plugin-brands/`.

### Known limits

| Side | Not seen |
|---|---|
| server | a positional argument on a line with a type-check ignore (`f("uid_b2")  # type: ignore`): it needs the callee's signature |
| server | `model_validate` of a dict held in a variable |
| web | a computed key typed `string` (`{ ...base, [field]: "junk" }`), or an `Object.assign` source typed `Record<string, string>` |
| web | method shorthand is bivariant: `m(x: string)` in an interface is implemented by `m(uid: BlockUid)` |
| web | a value returning `any` that reaches a generic-return function type through a conditional branch, a default parameter value or `satisfies` |

## Performance gate

`perf/check.sh` measures fixed backend and frontend scenarios against a
synthetic prod-shaped fixture and compares them with baselines in `perf/`. The
[design spec](../superpowers/specs/2026-09-26-perf-regression-checks-design.md)
holds the rationale. The frontend half's files and the caveats for reading
its numbers are in
[`web/tooling/perf/README.md`](../../web/tooling/perf/README.md).

| Class | Fails when | On improvement |
|---|---|---|
| `exact` | the count rises | ratchets down |
| `band` | the count exceeds the recorded `max` | lowers `min` only |
| `timing` | the value is clearly slower than the baseline | reported as `faster`, never recorded |

A timing is clearly slower (`_clearly_slower`) when it passes
`TIMING_FACTOR` times the other value and exceeds it by more than
`TIMING_FLOOR_MS`. The floor exists because scheduling noise alone doubles a
median of a few milliseconds. The counts still catch more SQL work or
bytes on such a small path. A Python-side slowdown that stays under the floor
goes unseen.

The check that measures a metric declares its class, so a reclassification is
a reviewed change. A worse value is a candidate until `confirm()` has re-run
it on the branch and run it at the merge base:

| Class | Re-run on the branch | Merge-base run | Verdict |
|---|---|---|---|
| any | the baseline accepts it | not run | `unstable` |
| `exact`, `band` | still worse | also worse than the baseline | `stale-baseline` |
| `exact`, `band` | still worse | not worse | `regression` |
| `timing` | still worse | missing, or the re-run is clearly slower than it | `regression` |
| `timing` | still worse | the re-run is not clearly slower than it, and also worse than the baseline | `stale-baseline` |
| `timing` | still worse | the re-run is not clearly slower than it, and not worse than the baseline | `unstable` |

A reproduced timing is judged against that merge-base run, not the baseline,
because the two runs share the machine's load.

Rules a change to the gate must keep:

- **Only a passing check rewrites a baseline**, from
  `Comparison.new_baseline`. Only a recording run (`--bootstrap`, or
  `--rebaseline`, which records at the merge base) lowers a band's `max` or a
  timing, so one lucky run cannot tighten the baseline until ordinary runs
  fail.
- Load moves timings both ways: a paced handler can run faster on a busy
  machine whose cores stay clocked up. So every measuring run waits for a
  quiet machine (`wait_until_quiet`) and is refused if load rose during it
  (`ensure_still_quiet`).
- A merge-base run measures the base's product with the branch's harness, so
  a harness change reads as `stale-baseline`. The harness may import only
  `pkm` names the base has (`missing_pkm_import`). The base's SPA must still
  emit the `pkm:replica-ready` mark.
- Counts are deterministic or the run fails. Backend counts are taken twice
  (`UnstableCountError`) and scenario R measures two passes. Clocks, timezone,
  fixture copies, typing paces and browser context groups
  (`CONTEXT_GROUPS` in `contextGroups.ts`, which `check.ts --only`
  expands) are pinned beside the code that needs them. Metrics that stay
  noisy under these controls are classed `band` or `timing`.
- `cache_key` (`fixture.py`, `build.py`, the DDL, the product source) decides
  when the cached fixture is rebuilt. `fixture_hash` (`fixture.py` only)
  decides comparability, so a schema or query change is measured rather than
  excused. A result whose `env` (`python`, `sqlite`, `chromium`) differs is
  refused. The sqlite-wasm build is pinned by the measured tree's lockfile,
  not `env`, so the merge-base run attributes a bump to the branch.
- The cache dir, the merge-base worktrees and port 8977 are shared by every
  session, and are touched only under `cache_lock`.

## Property gate

`proptest/check.sh` drives random input through several modules at once. A
property of one pure module is an ordinary unit test instead
(`*.props.test.ts`, `server/tests/test_*_props.py`), run on every commit. Design
specs: [server](../superpowers/specs/2026-10-02-property-checks-server-design.md),
[web sync](../superpowers/specs/2026-10-03-property-checks-sync-harness-design.md).

A web suite's `PROPERTY_LIMIT_MS` only guards against hangs. `numRuns` is
sized to the quiet-machine time and the limit sits at about three times it,
because other suites sharing the machine stretch a run several times over.
An overrun reports as a budget problem, never as a finding.

Each suite states its invariants in its module docstring or file header.

| Suite | Checks against |
|---|---|
| `test_ops_state.py` | `props/model.py`, through `POST /api/ops` |
| `test_planner_props.py` | sibling order from `positions_after` |
| `test_unlink_props.py` | the page-delete rewriter's anti-goals; a second pass is inert |
| `test_assistant_turn_props.py` | [the turn phase](assistant.md#the-turn-phase), on a virtual clock (`props/virtual_loop.py`) |
| `sync/` | `sync/oracle.ts`, over clients that run `createSyncSession`; `queue.prop.ts` checks `sync/queueModel.ts` without a server |
| `outline/` | a reading-view model and undo to the start (`checks.ts`). Commands go through `command.ts`, as `useOutline.run` and the undo dispatch do, and the commands the editor refuses are modelled too (`unguardedBatches` for the ops suite) |
| `outline/draft.prop.ts` | `draftModel.ts`, driving the real editor in jsdom (`draftHarness.tsx`) |
| `ops/` | what the server stores, in the replica and the in-memory trees; `enqueueBatch` refuses a batch exactly when the server does |
| `assistant/` | [the chat machine](frontend.md#the-chat-machine) (`assistant/run.ts`) |
| `journal/` | [the Journal's paging](frontend.md#the-journal) (`journalPaging`) |
| `files/` | [the `/files` browser](frontend.md#the-files-browser)'s generation rules (`filesPaging`) |
| `backlinks/` | `backlinksPaging`'s epoch and walk rules (`backlinks.prop.ts`); `withStatus` against the Link lifecycle table in `unlinkedStatus.ts` (`unlinked.prop.ts`) |

Rules a change to the gate must keep:

- **A model is written from the docs, not from the code**, so it can
  disagree with the code where the code is wrong. `props/model.py` encodes
  write-path.md, backend.md and sync-and-offline.md and never imports
  `pkm.server`, `pkm.planning` or `pkm.batch`
  (`test_model_imports_no_server_code`). The outline model imports outline
  code as types only.
- A new property shows it fails. Server: `tests/props/test_teeth.py` runs
  each gate suite's property against a mutant and expects the invariant that
  mutant breaks to fail. Web: each suite's `teeth.prop.ts` breaks a rule (a
  mutant, a broken transport mode, a `/__proptest/*/teeth` route) through
  `expectMutantsCaught` (`props/gate.ts`), which must see a problem line
  naming one of the mutant's `catches`. A clean run must pass. A mutant names
  every invariant its bug breaks, since which one fires first depends on the
  seed; sweep a few `PROPTEST_SEED` values before trusting a teeth test.
- A property that must keep reaching a case asserts it with a floor: a share
  of an example count that a label must exceed. Without one, a property that
  stopped drawing a case stays green on the cases it still draws. On the
  server, `merge_floors` (`tests/props/harness.py`) arms `with_floors`
  (`tests/hostile.py`) under the `merge` profile only, with labels from
  `hostile.event`. On the web, `checkGateProperty` (`props/gate.ts`) judges
  a `Reach` (`props/reach.ts`) after a passing run. The `with_floors`
  docstring owns the recipe for setting a floor (`PKM_FLOOR_LOG`, or
  `PROPTEST_REACH_LOG` on the web).
- A generator draws only from Hypothesis or fast-check. A draw steered by
  other state, such as the reach tally, no longer replays from its seed.
- Each web suite prints one `fault warnings` line, and an `UNEXPECTED` entry
  under it fails the suite's file (`unexpectedFailure`,
  `props/warnings.ts`). An `UNEXPECTED` entry means a recovery path fired
  with no fault injected: fix the cause, or add a kind to `EXPECTED_KINDS`
  if a fault is meant to provoke it.
- A web example that depends on timing may not replay from its seed. It is
  still a finding: pin it as a fixed scenario, as `sync.prop.ts` does.
- The sync harness runs the recovery lease on real timers, shortened to
  `HARNESS_LEASE_MS` (`props/sync/harnessClient.ts`), with renewal and stall
  scaled in the real constants' proportions. A `lease held` failure whose
  counterexample has no paced fault is first a load question: rerun it alone
  on a quiet machine.
- A web property is an `fc.asyncProperty`; `props/setup.ts` says why and
  makes fast-check refuse a synchronous `fc.property`.
