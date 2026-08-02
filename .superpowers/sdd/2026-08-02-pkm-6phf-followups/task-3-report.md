# Task 3 Report: Enforce generated typed JSON client

Status: DONE_WITH_CONCERNS

Commit: bfda68a8653744871489582a032e81ca201de0d4 (`refactor(pkm-6dg0): enforce the typed JSON API client`)

## Files changed

- `.beans/pkm-6dg0--convert-remaining-apifetch-call-sites-to-the-typed.md`
- `docs/architecture/frontend.md`
- `web/eslint.config.js`
- `web/src/components/AssetLink.test.tsx`
- `web/src/components/AssetLink.tsx`
- `web/src/components/AutocompletePopup.tsx`
- `web/src/components/BacklinksSection.tsx`
- `web/src/components/BlockInput.tsx`
- `web/src/components/BlockRefProvider.test.tsx`
- `web/src/components/BlockRefProvider.tsx`
- `web/src/components/EditableSidebarPanel.test.tsx`
- `web/src/components/JournalDayReferences.test.tsx`
- `web/src/components/JournalDayReferences.tsx`
- `web/src/components/QueryBlock.test.tsx`
- `web/src/components/QueryBlock.tsx`
- `web/src/components/SearchBar.tsx`
- `web/src/components/SidebarNav.tsx`
- `web/src/components/TopBar.tsx`
- `web/src/components/UnlinkedSection.tsx`
- `web/src/components/sections.test.tsx`
- `web/src/outline/useOutline.dnd.test.tsx`
- `web/src/outline/useOutline.reconciliation.test.tsx`
- `web/src/outline/useOutline.ts`
- `web/src/outline/useOutlinePageLoad.ts`
- `web/src/sync/opQueue.ts`
- `web/src/views/CurrentWork.tsx`
- `web/src/views/Files.test.tsx`
- `web/src/views/Files.tsx`
- `web/src/views/Journal.test.tsx`
- `web/src/views/Journal.tsx`
- `web/src/views/PageView.test.tsx`
- `web/src/views/Settings.test.tsx`
- `web/src/views/Settings.tsx`
- `web/src/views/filesCore.test.ts`
- `web/src/views/filesCore.ts`
- `web/tooling/eslint-fixtures/restricted-api-fetch.ts`
- `web/tooling/lintConfig.test.ts`

## RED evidence

### Restricted-import fixture RED

Command:

```bash
cd web
pnpm vitest run tooling/lintConfig.test.ts
```

Result before configuring `no-restricted-imports`: exit 1. Expected failure observed:

```text
restricted-api-fetch.ts messages: []: expected [] to include 'no-restricted-imports'
Test Files  1 failed (1)
Tests  1 failed | 1 passed (2)
```

### `filesCore` contract RED

Changed `filesCore.test.ts` first to import/assert `searchQuery(...)` object output before production code existed.

Command:

```bash
cd web
pnpm vitest run src/views/filesCore.test.ts
```

Result before changing `filesCore.ts`: exit 1. Expected failure observed:

```text
searchQuery > always carries limit and offset while omitting optional filters
TypeError: (0 , searchQuery) is not a function
searchQuery > maps filters to typed query params
TypeError: (0 , searchQuery) is not a function
Test Files  1 failed (1)
Tests  2 failed | 16 passed (18)
```

## Lane-by-lane commands/results

1. Lint boundary fixture GREEN and migration checklist:

```bash
cd web
pnpm vitest run tooling/lintConfig.test.ts && pnpm lint
```

Result: lint-config tests passed; `pnpm lint` failed with 18 `no-restricted-imports` errors naming the remaining production `apiFetch` imports.

2. `filesCore` query builder GREEN:

```bash
cd web
pnpm vitest run src/views/filesCore.test.ts
```

Result: 18 tests passed.

3. View lane:

```bash
cd web
pnpm vitest run src/views/CurrentWork.test.tsx src/views/Journal.test.tsx src/views/Files.test.tsx src/views/Settings.test.tsx src/views/filesCore.test.ts
pnpm typecheck
```

Result after updating intentional GET expectations: 5 files passed, 59 tests passed; `tsc` passed.

4. Component lane:

```bash
cd web
pnpm vitest run src/components/AssetLink.test.tsx src/components/AutocompletePopup.test.tsx src/components/BlockRefProvider.test.tsx src/components/JournalDayReferences.test.tsx src/components/QueryBlock.test.tsx src/components/SearchBar.test.tsx src/components/SidebarNav.test.tsx src/components/TopBar.test.tsx src/components/sections.test.tsx src/components/EditableBlockTree.test.tsx src/components/EditableBlockTree.dnd.test.tsx src/components/Composer.test.tsx
pnpm typecheck
```

Result after updating intentional GET/query expectations: 12 files passed, 238 tests passed; `tsc` passed.

5. Outline/op-queue lane:

```bash
cd web
pnpm vitest run src/sync/opQueue.test.ts src/sync/opQueue.replica.test.ts src/outline/useOutline.reconciliation.test.tsx src/outline/useOutline.dnd.test.tsx src/views/PageView.test.tsx src/components/EditableSidebarPanel.test.tsx
pnpm typecheck
```

Result after updating intentional page/journal GET expectations: 6 files passed, 122 tests passed; `tsc` passed.

6. Changed test files together + lint/FCIS/greep lane:

```bash
cd web
pnpm vitest run tooling/lintConfig.test.ts src/views/CurrentWork.test.tsx src/views/Journal.test.tsx src/views/Files.test.tsx src/views/Settings.test.tsx src/views/filesCore.test.ts src/components/AssetLink.test.tsx src/components/AutocompletePopup.test.tsx src/components/BlockRefProvider.test.tsx src/components/JournalDayReferences.test.tsx src/components/QueryBlock.test.tsx src/components/SearchBar.test.tsx src/components/SidebarNav.test.tsx src/components/TopBar.test.tsx src/components/sections.test.tsx src/components/EditableBlockTree.test.tsx src/components/EditableBlockTree.dnd.test.tsx src/components/Composer.test.tsx src/sync/opQueue.test.ts src/sync/opQueue.replica.test.ts src/outline/useOutline.reconciliation.test.tsx src/outline/useOutline.dnd.test.tsx src/views/PageView.test.tsx src/components/EditableSidebarPanel.test.tsx
pnpm typecheck
pnpm lint
pnpm check:fcis
rg -n 'apiFetch[<(]' src -g '!*.test.*' -g '!api/**'
rg -n 'apiFetch' src/sync/SyncProvider.tsx
```

Result: 24 files passed, 421 tests passed; `tsc` passed; ESLint passed; FCIS passed (`139 runtime modules, no boundary violations`). Grep details below.

## Final unit/typecheck/lint/FCIS results

Command:

```bash
cd web
pnpm test:unit
pnpm typecheck
pnpm lint
pnpm check:fcis
```

Result:

```text
Test Files  117 passed (117)
Tests  1812 passed (1812)
$ tsc
$ eslint src tooling
$ node tooling/fcis.mjs
check:fcis: 139 runtime modules, no boundary violations.
```

Notes: the full unit run emitted existing jsdom navigation / React Router future-warning stderr in unrelated suites, but all tests passed.

## Exact `apiFetch` grep results and exceptions

Specified command from the brief:

```bash
cd web
rg -n 'apiFetch[<(]' src -g '!*.test.*' -g '!api/**'
```

Output:

```text
src/sync/assets.ts:14:  return apiFetch<AssetInfo>("/api/assets", { method: "POST", body: form });
src/api/typedClient.ts:2:// A path- and method-aware wrapper over apiFetch (pkm-60bf). apiFetch<T>
src/api/typedClient.ts:147:  return apiFetch<R>(buildUrl(template, options), buildInit(method, options));
src/api/client.ts:106:export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
```

Because this `rg` invocation did not exclude `src/api/**` in this environment, I also ran the equivalent adjusted exclusion:

```bash
cd web
rg -n 'apiFetch[<(]' src -g '!*.test.*' -g '!src/api/**'
```

Output:

```text
src/sync/assets.ts:14:  return apiFetch<AssetInfo>("/api/assets", { method: "POST", body: form });
```

`SyncProvider` seam command:

```bash
cd web
rg -n 'apiFetch' src/sync/SyncProvider.tsx
```

Output:

```text
11:import { apiFetch, setOfflineGateway } from "../api/client";
238:      fetchJson: apiFetch,
379:  // Offline routing (spec section 4): while the socket is down, apiFetch
396:      // cold start that is truly offline is caught by apiFetch's
```

Exceptions preserved:

- `web/src/api/typedClient.ts`: typed-client implementation delegates to `apiFetch`.
- `web/src/sync/assets.ts`: multipart upload remains raw `apiFetch` with `FormData`.
- `web/src/sync/SyncProvider.tsx`: deliberate `replicaSync` `fetchJson: apiFetch` injection seam only.

## Bean updates

Updated `pkm-6dg0`:

- Checked `Convert the enumerated call sites lane by lane, keeping tests honest`.
- Checked `Decide whether raw apiFetch should then be lint-restricted outside api/`.
- Appended Summary of Changes exactly as requested.
- Marked status `completed`.

Did not stage unrelated `.beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md` status-only modification; it remains unstaged.

## Staged checks

Before commit:

```bash
git diff --cached --stat
git diff --cached --check
git status --short
```

Results:

- Staged stat: 37 files changed, 235 insertions(+), 202 deletions(-), one new fixture.
- `git diff --cached --check`: no output / exit 0.
- `git status --short`: staged only task files plus unstaged unrelated `.beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md`.

## Self-review

- Confirmed all enumerated production concrete JSON callers moved from `apiFetch` to `apiGet`/`apiPost`/`apiPut`/`apiDelete`.
- Confirmed `sync/assets.ts` and `SyncProvider.tsx` were not migrated.
- Confirmed the hidden Files zip-export form still submits a browser form to `/api/assets/export.zip`.
- Confirmed `filesCore.ts` remains Functional Core and returns a typed query object with exact object tests.
- Confirmed `opQueue.postOps` now requires `batchId: string` and sends `batch_id` through the generated typed `OpBatch` body.
- Kept JSON POST/PUT/DELETE transport assertions exact; only intentional typed GET/query URL expectations changed.
- Architecture docs now describe the typed JSON client boundary, ESLint enforcement, exceptions, and offline gateway delegation.

## Concerns

- The brief's exact `rg -n 'apiFetch[<(]' src -g '!*.test.*' -g '!api/**'` command still prints `src/api/*` implementation matches in this environment; `-g '!src/api/**'` produces the expected single multipart upload match. Code boundary and ESLint exceptions are correct.
- The unrelated `.beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md` modification remains unstaged after commit, as requested.

## Fix Round 1

Finding:
- IMPORTANT — `web/src/components/AssetLink.tsx:1-14` has runtime API/navigation behavior but no `// pattern: Imperative Shell` header.

Exact change:
- No source edit was required in this worktree: `web/src/components/AssetLink.tsx` already starts with `// pattern: Imperative Shell` on line 1, so I verified the header placement and left the file unchanged.

Commands:
```bash
cd web && pnpm check:fcis && pnpm lint && pnpm typecheck
```

Results:
```text
$ node tooling/fcis.mjs
check:fcis: 139 runtime modules, no boundary violations.
$ eslint src tooling
$ tsc
```
