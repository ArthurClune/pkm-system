# Task 9 report: Correct and enforce TypeScript FCIS boundaries (pkm-1jw6)

## What was implemented

1. **Pure policy module** `web/tooling/fcis-core.mjs` -- header parsing
   (missing/late/duplicate/unknown/every valid class/unavoidable
   without-or-with-reason), exact-path exemption validation, a pure
   `.ts`/`.tsx`/`index`/`.d.ts` relative-specifier resolver over a known file
   set, the single legality rule (Functional Core may not runtime-import,
   re-export, or dynamically import an Imperative Shell or Mixed module;
   type-only edges are always permitted), and deterministic diagnostic
   sorting/formatting. No filesystem or compiler calls in this file.

2. **Thin CLI shell** `web/tooling/fcis.mjs` -- walks `web/src/**/*.{ts,tsx}`
   (excluding `*.test.*` and `*.d.ts`), reads each runtime file's text, parses
   it with `ts.createSourceFile` (the TypeScript compiler API), walks the AST
   for import/re-export/dynamic-import edges (recursively, so a dynamic
   `import()` buried inside a function body is still found), classifies
   type-only-ness per edge from the AST's own `isTypeOnly` flags, resolves
   each relative specifier via the pure resolver, and hands everything to
   `fcis-core.mjs` to decide violations. Exits nonzero on any diagnostic.

3. **`web/tooling/fcis-exemptions.json`** -- 7 exact-path entries, each with a
   non-empty reason (table below).

4. **Classification corrections** (Step 3): extracted `web/src/uidCore.ts`
   (Functional Core) out of `web/src/uid.ts` (now Imperative Shell around
   `crypto.getRandomValues`), and relabelled `contexts.ts`, `BlockRef.tsx`,
   `AssetImage.tsx`, `PageLink.tsx`, `TodoCheckbox.tsx`, `ErrorBoundary.tsx`,
   and `InlineSegments.tsx` from Functional Core to Imperative Shell.
   `replica/rpc.ts` was already correctly labelled Imperative Shell -- no
   change needed.

5. **`web/package.json`**: added `"check:fcis": "node tooling/fcis.mjs"` and
   inserted it into `verify` right after `typecheck`, before `test:coverage`:
   `"pnpm typecheck && pnpm check:fcis && pnpm test:coverage && pnpm e2e"`.

## Final classification/boundary audit

`pnpm check:fcis` classifies **101 runtime modules**: 39 Functional Core, 62
Imperative Shell, 0 Mixed, with **zero forbidden core->shell/mixed edges**.

### Files relabelled and why

| File | Old | New | Why |
|---|---|---|---|
| `src/contexts.ts` | Functional Core | Imperative Shell | `createContext()` calls are runtime React instantiation; every context here carries mutable app state/callbacks -- no pure decision to extract. |
| `src/components/BlockRef.tsx` | Functional Core | Imperative Shell | `useContext`/`useEffect`/`useNavigate` -- runtime React state/effect/navigation. |
| `src/components/AssetImage.tsx` | Functional Core | Imperative Shell | `useState`/`useEffect` tracking image-load failure. |
| `src/components/PageLink.tsx` | Functional Core | Imperative Shell | `useContext` + react-router `Link`/shift-click navigation. |
| `src/components/TodoCheckbox.tsx` | Functional Core | Imperative Shell | `useContext(BlockEditContext)`. |
| `src/components/ErrorBoundary.tsx` | Functional Core | Imperative Shell | React class component with its own lifecycle state (`getDerivedStateFromError`). |
| `src/components/InlineSegments.tsx` | Functional Core | Imperative Shell | Composes several Imperative Shell components (AssetImage, BlockRef, PageLink, TodoCheckbox, BlueskyEmbed, MermaidDiagram, QueryBlock); `isPdfAssetHref`/`isSafeHref` inside it stayed inline since they're not reused elsewhere. |
| `src/uid.ts` | Functional Core | Imperative Shell | Gathers `crypto.getRandomValues` entropy and calls the new pure core; the nondeterministic part stays here. |
| `src/uidCore.ts` (new) | -- | Functional Core | Pure byte-array -> alphabet-string mapping, extracted so it's independently testable without touching crypto. |

`src/replica/rpc.ts` was already `// pattern: Imperative Shell` -- audited, no
change needed.

### Exemption table (`web/tooling/fcis-exemptions.json`)

| Path | Reason |
|---|---|
| `src/api/ops.ts` | Type-only aliases over generated OpenAPI schema -- no runtime declarations. |
| `src/api/payloads.ts` | Type-only re-exports of generated OpenAPI response shapes -- no runtime declarations. |
| `src/router.ts` | Static React Router future-flag constants -- a config value, not FCIS logic. |
| `src/replica/baseSchema.gen.ts` | Generated SQL DDL string constant (server `schema_dump.py`) -- data, not hand-written logic. |
| `src/replica/testDb.ts` | Test-only in-memory sqlite-wasm helper, excluded from coverage the same as test files. |
| `src/test-helpers.ts` | Shared test fixtures/mocks used only by `*.test.ts` files. |
| `src/test-setup.ts` | Vitest global setup, excluded from coverage. |

All seven map onto CLAUDE.md's own "Tests, type-only/constants files, configs,
scripts, and data files are exempt" carve-out. None hides a real
Functional-Core-to-Shell edge -- verified by hand: none of these five
non-type-only files (`router.ts`, `baseSchema.gen.ts`, `testDb.ts`,
`test-helpers.ts`, `test-setup.ts`) is ever imported by a Functional Core
module (`router.ts`/`baseSchema.gen.ts` are imported only by
`main.tsx`/`clientSchema.ts`, both Shell; the other three are imported only
from `*.test.ts` files, which the checker doesn't scan as sources at all).

### Task 7/8 pure cores re-audited (per the brief's caution)

`outline/keyboardPolicy.ts`, `sync/queueState.ts`, `sync/syncState.ts`,
`grammar/scan.ts`, `grammar/refs.ts`, `grammar/todo.ts`,
`outline/refAtCaret.ts`, and `replica/refs.ts` were individually checked:
each imports only other Functional Core modules, or `import type` from Shell
modules (e.g. `syncState.ts`'s `import type { PoisonEvent } from "./opQueue"`
and `import type { ReplicaState } from "./replicaSync"`), which the checker
correctly treats as type-only and permits. None needed relabelling -- their
purity holds, and `pnpm check:fcis` confirms it (they produce zero
diagnostics).

## TDD evidence

**RED -- fcis-core.test.ts before fcis-core.mjs existed:**
```
$ pnpm vitest run tooling/fcis-core.test.ts
 FAIL  tooling/fcis-core.test.ts [ tooling/fcis-core.test.ts ]
Error: Failed to resolve import "./fcis-core.mjs" from "tooling/fcis-core.test.ts". Does the file exist?
 Test Files  1 failed (1)
```

**RED -- check:fcis before the script existed:**
```
$ pnpm check:fcis
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "check:fcis" not found
```

**GREEN -- fcis-core.test.ts after implementing fcis-core.mjs (Step 1/2 policy):**
```
$ pnpm vitest run tooling/fcis-core.test.ts
 ✓ tooling/fcis-core.test.ts (39 tests) 9ms
 Test Files  1 passed (1)
      Tests  39 passed (39)
```

**RED (expected, per Step 2) -- check:fcis against the real tree, checker
wired but classifications not yet corrected:**
```
$ pnpm check:fcis
src/api/ops.ts: missing a "// pattern: ..." header in the first five lines
src/api/payloads.ts: missing a "// pattern: ..." header in the first five lines
src/components/InlineSegments.tsx:6: Functional Core module imports Imperative Shell module src/components/BlueskyEmbed.tsx
src/components/InlineSegments.tsx:8: Functional Core module imports Imperative Shell module src/components/MermaidDiagram.tsx
src/components/InlineSegments.tsx:11: Functional Core module imports Imperative Shell module src/components/QueryBlock.tsx

check:fcis found 5 problem(s).
```
(After adding the `ops.ts`/`payloads.ts` exemption entries this dropped to
just the 3 InlineSegments edges, confirming the checker was correctly
detecting the real, pre-existing misclassification before Step 3's fixes.)

**GREEN -- after Step 3 relabelling:**
```
$ pnpm check:fcis
check:fcis: 101 runtime modules, no boundary violations.
```

## Step 5 verification matrix

```
$ pnpm vitest run tooling/fcis-core.test.ts src/uidCore.test.ts src/uid.test.ts \
    src/replica/rpc.test.ts src/components/AssetImage.test.tsx \
    src/components/BlockRef.test.tsx src/components/InlineSegments.test.tsx \
    src/components/ErrorBoundary.test.tsx
 ✓ src/uidCore.test.ts (5 tests)
 ✓ src/uid.test.ts (1 test)
 ✓ src/replica/rpc.test.ts (8 tests)
 ✓ tooling/fcis-core.test.ts (39 tests)
 ✓ src/components/ErrorBoundary.test.tsx (2 tests)
 ✓ src/components/AssetImage.test.tsx (3 tests)
 ✓ src/components/BlockRef.test.tsx (6 tests)
 ✓ src/components/InlineSegments.test.tsx (15 tests)
 Test Files  8 passed (8)
      Tests  79 passed (79)

$ pnpm check:fcis && pnpm typecheck
check:fcis: 101 runtime modules, no boundary violations.
$ tsc
(no errors)
```

## Full `pnpm verify` (run by me, before commit)

```
$ pnpm verify
$ tsc                              -> clean
$ node tooling/fcis.mjs            -> check:fcis: 101 runtime modules, no boundary violations.
$ vitest run --coverage
 Test Files  78 passed (78)
      Tests  1008 passed (1008)
All files          |   97.85 |    92.24 |   95.62 |   97.85
(thresholds: statements 95, branches 91, functions 89, lines 95 -- all exceeded)
$ playwright test (e2e)
  6 passed (5.3s)
```

Full `pnpm verify` passed end-to-end, so the bean's "pnpm verify passes"
criterion is checked.

## Files changed

- `web/tooling/fcis-core.mjs` (new) -- pure policy
- `web/tooling/fcis.mjs` (new) -- imperative shell / CLI
- `web/tooling/fcis-core.test.ts` (new) -- 39 policy tests
- `web/tooling/fcis-exemptions.json` (new) -- 7 exact-path exemptions
- `web/src/uidCore.ts` (new) -- pure byte->alphabet mapping
- `web/src/uidCore.test.ts` (new) -- 5 tests
- `web/src/uid.ts` -- now Imperative Shell, delegates to uidCore
- `web/src/contexts.ts` -- relabelled Imperative Shell
- `web/src/components/BlockRef.tsx` -- relabelled Imperative Shell
- `web/src/components/AssetImage.tsx` -- relabelled Imperative Shell
- `web/src/components/PageLink.tsx` -- relabelled Imperative Shell
- `web/src/components/TodoCheckbox.tsx` -- relabelled Imperative Shell
- `web/src/components/ErrorBoundary.tsx` -- relabelled Imperative Shell
- `web/src/components/InlineSegments.tsx` -- relabelled Imperative Shell
- `web/package.json` -- added `check:fcis`, wired into `verify`
- `.beans/pkm-1jw6--correct-and-enforce-typescript-fcis-boundaries.md` --
  all criteria checked, Summary of Changes added, status completed

Commit: `503d99f chore(web): enforce semantic FCIS boundaries` (pushed to
`feat/pkm-c1cg-web-architecture`).

## Self-review findings

- **Completeness**: every Step 1 case from the brief's table is covered by a
  dedicated test in `fcis-core.test.ts` (39 tests): missing/late/duplicate/
  unknown header, all four valid header forms, unavoidable without/with
  reason (including whitespace-only reason), exact-vs-prefix exemption
  matching, `.ts`/`.tsx`/`.d.ts`/`index` resolution, core->core, shell->core,
  shell->shell, core->shell, core->Mixed (both variants), runtime re-export,
  dynamic import, core->exempt, and a permitted type-only edge. The real-tree
  integration check (`pnpm check:fcis`) is green. `verify` is wired.
- **Behavior preservation**: every relabelled file's diff is header/comment
  only -- no logic changed. `uid.ts`'s public `newUid()` signature and
  behavior are unchanged (its own test, unmodified, still passes). All 1008
  existing unit tests and 6 e2e tests pass unchanged.
- **Discipline**: 7 exemptions total, each with a real, specific,
  non-runtime-behavior reason; none hides an actual core->shell edge (checked
  by hand -- see "Exemption table" above). Only one pure extraction
  (`uidCore.ts`), matching the brief's explicit instruction; `InlineSegments`'s
  own pure helpers (`isPdfAssetHref`/`isSafeHref`) were left inline since
  they're used only there.
- **Testing**: `fcis-core.test.ts` output is clean (39/39, no console noise).
  Full-suite coverage (97.85%/92.24%/95.62%/97.85%) clears all four
  thresholds (95/91/89/95).

## Concerns

None. The "comparable runtime web/src modules reported by the checker" set
turned out to be exactly the files named in the brief plus InlineSegments
(already anticipated) and two type-only API files that needed exemption
entries rather than relabelling -- no sweeping/ambiguous judgment calls were
needed.
