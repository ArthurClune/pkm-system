# pkm-6phf Follow-up Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete all four remaining child beans under `pkm-6phf`: route metadata normalization, single-flight Files pagination, typed JSON API adoption, and BlockInput test ownership.

**Architecture:** Work in the existing `pkm-6phf-followups` worktree and keep each child bean as one reviewable commit. Apply the behavior fixes test-first, migrate JSON calls through the generated OpenAPI client while preserving the raw transport exceptions, then split the already-covered BlockInput tests without changing assertions.

**Tech Stack:** React 18.3, TypeScript 5.9, react-router-dom 6.30, Vitest/Testing Library, ESLint 10 flat config, generated OpenAPI `paths`, pnpm 11, beans.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.worktrees/pkm-6phf-followups` on branch `pkm-6phf-followups`.
- Use TDD for the trailing-slash and rapid-pagination behavior changes: observe each new test fail before implementation.
- Preserve `apiFetch` only for `api/typedClient.ts`, multipart upload in `sync/assets.ts`, and `SyncProvider.tsx`'s deliberate `replicaSync` transport-injection wiring.
- Do not route `sync/assets.ts` through the JSON-only typed client; do not change Files' hidden zip-export form.
- Keep every moved BlockInput test name and assertion unchanged; only imports and setup may change.
- Keep runtime FCIS headers correct; tests, config, type-only files, and data files remain exempt.
- Update `docs/architecture/frontend.md` in the same commit as each architecture/invariant change.
- Complete each bean only after all of its checklist items are checked and append a `## Summary of Changes` section before setting status to `completed`.
- Final web verification is `cd web && pnpm verify`.

---

## File Structure

### Route metadata

- Modify `web/src/routeMeta.ts`: normalize non-root trailing slashes at the static metadata lookup boundary.
- Modify `web/src/paths.ts`: consume `PAGE_ROUTE_PREFIX` when constructing page links.
- Modify `web/src/routeMeta.test.ts`: core normalization coverage.
- Modify `web/src/useRouteTitle.test.tsx`: integration coverage for the title effect.
- Modify `docs/architecture/frontend.md`: document canonical/trailing-slash equivalence.
- Modify `.beans/pkm-9jma--route-metadata-follow-ups-pathsts-prefix-trailing.md`: completion record.

### Files pagination

- Modify `web/src/views/Files.tsx`: synchronous single-flight ref plus visible loading state.
- Modify `web/src/views/Files.test.tsx`: deferred rapid-invocation regression.
- Modify `docs/architecture/frontend.md`: document the pagination invariant.
- Modify `.beans/pkm-ow62--files-debouncedisable-load-more-against-double-cli.md`: completion record.

### Typed API boundary

- Modify 18 production modules containing the 29 concrete JSON calls listed in Task 3.
- Modify `web/src/views/filesCore.ts` and `web/src/views/filesCore.test.ts`: replace a prebuilt search query string with a typed-client-compatible query object.
- Modify request-observing tests listed in Task 3: account for explicit GET init and URLSearchParams encoding.
- Create `web/tooling/eslint-fixtures/restricted-api-fetch.ts`: intentional restricted-import violation.
- Modify `web/tooling/lintConfig.test.ts`: prove the new lint rule and corrected form.
- Modify `web/eslint.config.js`: enforce the typed API boundary with narrow exceptions.
- Modify `docs/architecture/frontend.md`: replace “prefer” guidance with the enforced invariant and exceptions.
- Modify `.beans/pkm-6dg0--convert-remaining-apifetch-call-sites-to-the-typed.md`: completion record and corrected 29-call count.

### BlockInput tests

- Create `web/src/components/BlockInput.test.tsx`: 70 focused-input tests using a direct component harness.
- Modify `web/src/components/EditableBlockTree.test.tsx`: retain 42 tree-owned tests.
- Modify `.beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md`: completion record and corrected 112-test baseline.

---

### Task 1: Normalize route metadata and share the page prefix (`pkm-9jma`)

**Files:**
- Modify: `web/src/routeMeta.test.ts`
- Modify: `web/src/useRouteTitle.test.tsx`
- Modify: `web/src/routeMeta.ts`
- Modify: `web/src/paths.ts`
- Modify: `docs/architecture/frontend.md`
- Modify: `.beans/pkm-9jma--route-metadata-follow-ups-pathsts-prefix-trailing.md`

**Interfaces:**
- Consumes: `PAGE_ROUTE_PREFIX: "/page/"`, `ROUTE_META`, and `ROUTES` from `routeMeta.ts`.
- Produces: `routeMetaFor(pathname: string): RouteMeta | undefined`, treating one or more trailing slashes on static non-root paths as canonical.

- [ ] **Step 1: Add failing core and title-effect tests**

Add to `routeMeta.test.ts`:

```ts
it.each([
  ["/files/", { label: "Files", title: "Files — pkm" }],
  ["/settings///", { label: "Settings", title: "Settings — pkm" }],
])("normalizes trailing slashes for static route %s", (pathname, expected) => {
  expect(routeMetaFor(pathname)).toEqual(expected);
});

it("keeps root canonical and dynamic/unmatched paths undefined", () => {
  expect(routeMetaFor("/")).toEqual(ROUTE_META[ROUTES.journal]);
  expect(routeMetaFor("/page/Paper/")).toBeUndefined();
  expect(routeMetaFor("/definitely/not/a/route/")).toBeUndefined();
});
```

Add `['/files/', 'Files — pkm']` and `['/settings/', 'Settings — pkm']` to the existing `it.each` table in `useRouteTitle.test.tsx`.

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cd web
pnpm vitest run src/routeMeta.test.ts src/useRouteTitle.test.tsx
```

Expected: the trailing-slash cases fail because `routeMetaFor` performs an exact lookup.

- [ ] **Step 3: Implement minimal normalization and shared prefix use**

Change `routeMetaFor` to:

```ts
export function routeMetaFor(pathname: string): RouteMeta | undefined {
  const canonical = pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
  return ROUTE_META[canonical];
}
```

Change `paths.ts` to import the prefix and construct page links from it:

```ts
import { PAGE_ROUTE_PREFIX } from "./routeMeta";

export function pagePath(title: string): string {
  return `${PAGE_ROUTE_PREFIX}${encodeTitle(title)}`;
}
```

Do not change `titleFromPathname`; it parses dynamic page paths and is outside the static metadata lookup.

- [ ] **Step 4: Document and verify the route behavior**

In `docs/architecture/frontend.md`'s Views/navigation section, state that `routeMetaFor` removes trailing slashes from non-root static paths so hand-typed `/files/` and `/settings/` receive canonical labels/titles, while `/page/*` remains dynamic.

Run:

```bash
cd web
pnpm vitest run src/routeMeta.test.ts src/useRouteTitle.test.tsx src/paths.test.ts
pnpm typecheck
pnpm lint
pnpm check:fcis
```

- [ ] **Step 5: Complete the bean and commit**

Check both bean items, append a summary covering prefix reuse, normalization semantics, tests, and docs, then mark it completed:

```bash
beans update pkm-9jma --body-replace-old "- [ ] paths.ts consumes PAGE_ROUTE_PREFIX" --body-replace-new "- [x] paths.ts consumes PAGE_ROUTE_PREFIX"
beans update pkm-9jma --body-replace-old "- [ ] Trailing-slash pathname handling in routeMetaFor (or document as accepted)" --body-replace-new "- [x] Trailing-slash pathname handling in routeMetaFor (or document as accepted)"
printf '%s\n' '## Summary of Changes' '' 'paths.ts now consumes PAGE_ROUTE_PREFIX. routeMetaFor canonicalizes trailing slashes for non-root static routes while leaving dynamic and unmatched paths undefined. Added core/title-effect coverage and documented the invariant.' | beans update pkm-9jma --body-append -
beans update pkm-9jma --status completed
git add web/src/routeMeta.ts web/src/paths.ts web/src/routeMeta.test.ts web/src/useRouteTitle.test.tsx docs/architecture/frontend.md .beans/pkm-9jma--route-metadata-follow-ups-pathsts-prefix-trailing.md
git commit -m "fix(pkm-9jma): normalize static route metadata paths"
```

---

### Task 2: Make Files pagination single-flight (`pkm-ow62`)

**Files:**
- Modify: `web/src/views/Files.test.tsx`
- Modify: `web/src/views/Files.tsx`
- Modify: `docs/architecture/frontend.md`
- Modify: `.beans/pkm-ow62--files-debouncedisable-load-more-against-double-cli.md`

**Interfaces:**
- Consumes: existing `generation` stale-response guard and `fetchPage(filters, offset)`.
- Produces: at most one active `loadMore()` request; `Load more` is disabled until its request settles.

- [ ] **Step 1: Add the rapid-invocation regression test**

Add beside the stale `loadMore` test in `Files.test.tsx`:

```tsx
it("runs only one Load more request for two clicks before rerender (pkm-ow62)",
   async () => {
  const first = Array.from({ length: 50 }, (_, i) =>
    item({ sha256: String(i).padStart(64, "0"), filename: `f${i}.png` }));
  const pending = deferred<AssetSearchPayload>();
  const last = item({ sha256: "ef".repeat(32), filename: "last.png" });
  mockFetch
    .mockResolvedValueOnce(payload(first, 51))
    .mockReturnValueOnce(pending.promise);
  render(<Files />);
  const button = await screen.findByRole("button", { name: "Load more" });

  act(() => {
    button.click();
    button.click();
  });

  expect(mockFetch).toHaveBeenCalledTimes(2); // initial page + one pagination call
  expect(button).toBeDisabled();
  await act(async () => {
    pending.resolve(payload([last], 51));
    await pending.promise;
  });
  expect(await screen.findByText("51 of 51 files")).toBeInTheDocument();
  expect(screen.getAllByText("last.png")).toHaveLength(1);
});
```

Native `button.click()` calls inside one outer `act` are intentional: both handlers run before React's state rerender, proving a synchronous ref guard rather than merely a disabled-state rerender.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
cd web
pnpm vitest run src/views/Files.test.tsx -t "runs only one Load more request"
```

Expected: two pagination calls start (three mock calls total), or the second call consumes an undefined mock result and fails.

- [ ] **Step 3: Add the ref guard and visible state**

In `Files`, add:

```ts
const loadMoreInFlight = useRef(false);
const [loadingMore, setLoadingMore] = useState(false);
```

Wrap `loadMore` as follows, preserving its existing generation and notice logic:

```ts
const loadMore = async () => {
  if (loadMoreInFlight.current) return;
  loadMoreInFlight.current = true;
  setLoadingMore(true);
  const gen = generation.current;
  try {
    const p = await fetchPage(filters, items.length);
    if (isStale(generation, gen)) return;
    setItems((cur) => [...cur, ...p.assets]);
    setTotal(p.total);
  } catch {
    if (!isStale(generation, gen)) setNotice("Could not load more files.");
  } finally {
    loadMoreInFlight.current = false;
    setLoadingMore(false);
  }
};
```

Set the button to `disabled={busy || loadingMore}`. Keep `loadingMore` separate from the toolbar-wide `busy` state; coordinating all Files actions is outside this bug.

- [ ] **Step 4: Verify focused Files behavior and document the invariant**

Add to the Files paragraph in `docs/architecture/frontend.md`: pagination has a synchronous single-flight lock (not only disabled state), while generation guards discard responses made stale by filter changes.

Run:

```bash
cd web
pnpm vitest run src/views/Files.test.tsx
pnpm typecheck
pnpm lint
pnpm check:fcis
```

Expected: all 19 Files tests pass and static checks are clean.

- [ ] **Step 5: Complete the bean and commit**

```bash
beans update pkm-ow62 --body-replace-old "- [ ] Guard Load more against concurrent invocations (busy flag like Select all)" --body-replace-new "- [x] Guard Load more against concurrent invocations (busy flag like Select all)"
beans update pkm-ow62 --body-replace-old "- [ ] Add a double-click regression test" --body-replace-new "- [x] Add a double-click regression test"
printf '%s\n' '## Summary of Changes' '' 'Load more now uses a synchronous ref lock plus disabled UI state, releases the lock in finally, and retains the existing generation/error policy. A same-render double-click regression proves only one page request and one append occur. Documented the single-flight invariant.' | beans update pkm-ow62 --body-append -
beans update pkm-ow62 --status completed
git add web/src/views/Files.tsx web/src/views/Files.test.tsx docs/architecture/frontend.md .beans/pkm-ow62--files-debouncedisable-load-more-against-double-cli.md
git commit -m "fix(pkm-ow62): make Files pagination single-flight"
```

---

### Task 3: Enforce the generated typed JSON client (`pkm-6dg0`)

**Files:**
- Modify: `web/src/views/CurrentWork.tsx`
- Modify: `web/src/views/Journal.tsx`
- Modify: `web/src/views/Files.tsx`
- Modify: `web/src/views/Settings.tsx`
- Modify: `web/src/views/filesCore.ts`
- Modify: `web/src/views/filesCore.test.ts`
- Modify: `web/src/sync/opQueue.ts`
- Modify: `web/src/outline/useOutlinePageLoad.ts`
- Modify: `web/src/outline/useOutline.ts`
- Modify: `web/src/components/BacklinksSection.tsx`
- Modify: `web/src/components/JournalDayReferences.tsx`
- Modify: `web/src/components/SearchBar.tsx`
- Modify: `web/src/components/AssetLink.tsx`
- Modify: `web/src/components/BlockInput.tsx`
- Modify: `web/src/components/TopBar.tsx`
- Modify: `web/src/components/SidebarNav.tsx`
- Modify: `web/src/components/UnlinkedSection.tsx`
- Modify: `web/src/components/QueryBlock.tsx`
- Modify: `web/src/components/BlockRefProvider.tsx`
- Modify: `web/src/components/AutocompletePopup.tsx`
- Modify: request-observing tests named below
- Create: `web/tooling/eslint-fixtures/restricted-api-fetch.ts`
- Modify: `web/tooling/lintConfig.test.ts`
- Modify: `web/eslint.config.js`
- Modify: `docs/architecture/frontend.md`
- Modify: `.beans/pkm-6dg0--convert-remaining-apifetch-call-sites-to-the-typed.md`

**Interfaces:**
- Consumes: `apiGet`, `apiPost`, `apiPut`, and `apiDelete` from `api/typedClient.ts`; request/response types derive from generated `paths`.
- Produces: no concrete production JSON request can import `apiFetch`; raw transport remains only in typedClient, multipart upload, and `SyncProvider`'s explicit injected transport seam.

- [ ] **Step 1: Add the failing restricted-import fixture**

Create `web/tooling/eslint-fixtures/restricted-api-fetch.ts`:

```ts
import { apiFetch } from "../../src/api/client";

export function load() {
  return apiFetch("/api/current-work");
}
```

Add this case to `tooling/lintConfig.test.ts`:

```ts
{
  file: "restricted-api-fetch.ts",
  rule: "no-restricted-imports",
  corrected:
    'import { apiGet } from "../../src/api/typedClient";\n' +
    "export function load() {\n" +
    '  return apiGet("/api/current-work");\n' +
    "}\n",
},
```

- [ ] **Step 2: Run the lint-config test and verify RED**

Run:

```bash
cd web
pnpm vitest run tooling/lintConfig.test.ts
```

Expected: `restricted-api-fetch.ts` does not report `no-restricted-imports` because the rule is not configured.

- [ ] **Step 3: Configure the import boundary and verify the fixture turns GREEN**

Add to the main production/tooling rules in `eslint.config.js`:

```js
"no-restricted-imports": ["error", {
  patterns: [{
    group: ["**/api/client"],
    importNames: ["apiFetch"],
    message:
      "Use apiGet/apiPost/apiPut/apiDelete from api/typedClient; " +
      "raw apiFetch is reserved for transport boundaries.",
  }],
}],
```

Append a flat-config override:

```js
{
  files: [
    "src/api/typedClient.ts",
    "src/sync/assets.ts",
    "src/sync/SyncProvider.tsx",
  ],
  rules: {
    "no-restricted-imports": "off",
  },
},
```

Update the config's header from “exactly two rule families” to three and name API-boundary import control. `SyncProvider.tsx` is allowed only because it passes `apiFetch` as `replicaSync`'s injected `fetchJson`; it does not issue a concrete call at that site.

Run `pnpm vitest run tooling/lintConfig.test.ts`; expected: both lint-config tests pass. Run `pnpm lint`; expected at this point: failures identify every remaining production `apiFetch` import, providing the migration checklist.

- [ ] **Step 4: Convert Files' pure query builder from string to object**

Rename `searchParams` to `searchQuery` in `filesCore.ts` and return:

```ts
export function searchQuery(f: FileFilters, offset: number) {
  return {
    q: f.q.trim() || undefined,
    type: f.type || undefined,
    from_ms: f.fromDate ? localMs(f.fromDate, false) : undefined,
    to_ms: f.toDate ? localMs(f.toDate, true) : undefined,
    linked: f.linked === "all" ? undefined : f.linked,
    limit: PAGE_SIZE,
    offset,
  };
}
```

Change `filesCore.test.ts` from parsing a query string to exact object assertions, including trimmed `q`, local start/end timestamps, omitted optional filters (`undefined`), `limit: 50`, and the supplied offset. Run:

```bash
cd web
pnpm vitest run src/views/filesCore.test.ts
```

- [ ] **Step 5: Convert all view calls using this exact map**

Replace imports from `api/client` with helpers from `api/typedClient`; remove now-unused payload generic imports.

| File | Exact typed call |
|---|---|
| `views/CurrentWork.tsx` | `apiGet("/api/current-work")` |
| `views/Journal.tsx` page read | `apiGet("/api/page/{title}", { path: { title } })` |
| `views/Journal.tsx` journal read | `apiGet("/api/journal", { query: { days: want, before: oldest } })` |
| `views/Journal.tsx` cleanup | `apiPost("/api/journal/cleanup")` |
| `views/Files.tsx` search | `apiGet("/api/assets/search", { query: searchQuery(f, offset) })` |
| `views/Files.tsx` delete | `apiDelete("/api/assets/{sha256}", { path: { sha256: item.sha256 } })` |
| `views/Files.tsx` scan | `apiPost("/api/assets/scan")` |
| `views/Settings.tsx` | `apiGet("/api/assets/describe-status")` |

Run:

```bash
cd web
pnpm vitest run src/views/CurrentWork.test.tsx src/views/Journal.test.tsx src/views/Files.test.tsx src/views/Settings.test.tsx src/views/filesCore.test.ts
pnpm typecheck
```

Adjust only transport expectations described in Step 8.

- [ ] **Step 6: Convert all component calls using this exact map**

| File | Exact typed call |
|---|---|
| `components/BacklinksSection.tsx` | `apiGet("/api/page/{title}", { path: { title }, query: { bl_offset: offset, bl_limit: limit } })` |
| `components/JournalDayReferences.tsx` | `apiGet("/api/page/{title}", { path: { title }, query: { bl_limit: PREVIEW_LIMIT } })` |
| `components/SearchBar.tsx` search | `apiGet("/api/search", { query: { q: query } })` |
| `components/SearchBar.tsx` create | `apiPost("/api/pages", { body: { title: row.title } })` |
| `components/AssetLink.tsx` | `apiGet("/api/search", { query: { q: sha, exact: true } })` |
| `components/BlockInput.tsx` | `apiPost("/api/pages", { body: { title } })` |
| `components/TopBar.tsx` | `apiDelete("/api/page/{title}", { path: { title } })` |
| `components/SidebarNav.tsx` initial/refresh reads | `apiGet("/api/sidebar")` |
| `components/SidebarNav.tsx` add | `apiPost("/api/sidebar", { body: { title } })` |
| `components/SidebarNav.tsx` delete | `apiDelete("/api/sidebar/{entry_id}", { path: { entry_id: id } }).then(() => undefined)` |
| `components/SidebarNav.tsx` reorder | `apiPut("/api/sidebar", { body: { order: ids } })` |
| `components/UnlinkedSection.tsx` | `apiGet("/api/unlinked", { query: { title, limit: PAGE_SIZE, offset: from } })` |
| `components/QueryBlock.tsx` | `apiGet("/api/query", { query: { expr } })` |
| `components/BlockRefProvider.tsx` | `apiGet("/api/block-refs", { query: { uids: batch.join(",") } })` |
| `components/AutocompletePopup.tsx` | `apiGet("/api/titles", { query: { q: query } })` |

Run the component suites affected by these modules plus `pnpm typecheck`.

- [ ] **Step 7: Convert outline and queue calls using this exact map**

| File | Exact typed call |
|---|---|
| `outline/useOutlinePageLoad.ts` (both reads) | `apiGet("/api/page/{title}", { path: { title } })` |
| `outline/useOutline.ts` (both reads) | `apiGet("/api/page/{title}", { path: { title: pageTitle } })` |
| `sync/opQueue.ts` | `apiPost("/api/ops", { body: { client_id: clientId, batch_id: batchId, ops } })` |

In `opQueue.ts`, tighten `postOps`'s `batchId?: string` parameter to `batchId: string` and always send it. All three callers already provide a batch id; generated `OpBatch` requires it.

Do not modify `sync/assets.ts` or `SyncProvider.tsx`.

Run:

```bash
cd web
pnpm vitest run src/sync/opQueue.test.ts src/sync/opQueue.replica.test.ts src/outline/useOutline.reconciliation.test.tsx src/outline/useOutline.dnd.test.tsx src/views/PageView.test.tsx src/components/EditableSidebarPanel.test.tsx
pnpm typecheck
```

- [ ] **Step 8: Update only intentional transport-observation changes**

Typed GET calls pass `{ method: "GET" }`; change exact two-argument expectations that formerly expected `undefined`. Update these suites:

- `views/Journal.test.tsx`: exact journal/page GET expectations.
- `views/Files.test.tsx`: URL expectations for search/pagination now include `{ method: "GET" }`.
- `views/Settings.test.tsx`: describe-status GET includes `{ method: "GET" }`.
- `outline/useOutline.reconciliation.test.tsx`, `outline/useOutline.dnd.test.tsx`, `views/PageView.test.tsx`, `components/EditableSidebarPanel.test.tsx`: page GET expectations.
- `components/sections.test.tsx`, `components/JournalDayReferences.test.tsx`: page/unlinked GET expectations.
- `components/QueryBlock.test.tsx`: GET init plus spaces encoded as `+`, using `new URLSearchParams({ expr }).toString()` rather than `encodeURIComponent` constants.
- `components/AssetLink.test.tsx`: `exact=1` becomes `exact=true`.
- `components/BlockRefProvider.test.tsx`: comma-separated UIDs become `uids=ref_cc3%2Cref_dd4`.
- `components/sections.test.tsx`: `Machine%20Learning` in query values becomes `Machine+Learning`.

POST/PUT/DELETE JSON bodies remain byte-equivalent and must not be loosened. Run all changed test files together, then:

```bash
cd web
pnpm typecheck
pnpm lint
pnpm check:fcis
rg -n 'apiFetch[<(]' src -g '!*.test.*' -g '!api/**'
```

Expected grep output: only `sync/assets.ts`'s multipart call. Separately, `rg -n 'apiFetch' src/sync/SyncProvider.tsx` shows only the deliberate function injection.

- [ ] **Step 9: Document the enforced boundary and run the complete unit gate**

In `docs/architecture/frontend.md`:

- Change State management's server-payload wording from components fetching with `apiFetch` to the typed client.
- In API layer, say JSON requests must use `apiGet`/`apiPost`/`apiPut`/`apiDelete`; ESLint enforces this.
- Enumerate the raw transport exceptions: typedClient implementation, multipart `sync/assets.ts`, and `SyncProvider`'s `replicaSync` injection seam.
- Remove the stale paragraph saying remaining callers still need mechanical conversion.
- Keep the offline gateway explanation: typedClient still delegates to `apiFetch`.

Run:

```bash
cd web
pnpm test:unit
pnpm typecheck
pnpm lint
pnpm check:fcis
```

- [ ] **Step 10: Complete the bean and commit**

```bash
beans update pkm-6dg0 --body-replace-old "- [ ] Convert the enumerated call sites lane by lane, keeping tests honest" --body-replace-new "- [x] Convert the enumerated call sites lane by lane, keeping tests honest"
beans update pkm-6dg0 --body-replace-old "- [ ] Decide whether raw apiFetch should then be lint-restricted outside api/" --body-replace-new "- [x] Decide whether raw apiFetch should then be lint-restricted outside api/"
printf '%s\n' '## Summary of Changes' '' 'Converted the 29 concrete JSON apiFetch calls remaining at current HEAD to generated path/method-aware helpers. Preserved multipart upload and the replicaSync transport-injection seam, added an enforced restricted-import rule with fixture coverage, updated intentional GET/query transport expectations, tightened op batches to require batch_id, and documented the API invariant.' | beans update pkm-6dg0 --body-append -
beans update pkm-6dg0 --status completed
git add web/src web/tooling web/eslint.config.js docs/architecture/frontend.md .beans/pkm-6dg0--convert-remaining-apifetch-call-sites-to-the-typed.md
git commit -m "refactor(pkm-6dg0): enforce the typed JSON API client"
```

Before committing, inspect `git diff --cached --stat` and `git diff --cached --check`; do not accidentally stage unrelated bean files still marked in-progress.

---

### Task 4: Move focused-input tests to `BlockInput.test.tsx` (`pkm-mlbh`)

**Files:**
- Create: `web/src/components/BlockInput.test.tsx`
- Modify: `web/src/components/EditableBlockTree.test.tsx`
- Modify: `.beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md`

**Interfaces:**
- Consumes: `BlockInput` props `{ node: BlockNode; cursor: number; handlers: OutlineHandlers; readOnly: boolean; onRequestUpload(uid, at): void }`.
- Produces: 70 collected direct BlockInput tests and 42 collected EditableBlockTree tests, preserving all 112 names/assertions.

- [ ] **Step 1: Capture the pre-move test inventory**

Run:

```bash
cd web
pnpm vitest list src/components/EditableBlockTree.test.tsx > /tmp/pkm-mlbh-before.txt
wc -l /tmp/pkm-mlbh-before.txt
pnpm vitest run src/components/EditableBlockTree.test.tsx
```

Expected: 112 collected tests pass. Keep `/tmp/pkm-mlbh-before.txt` for the post-move name comparison.

- [ ] **Step 2: Create the direct BlockInput harness**

Start `BlockInput.test.tsx` with the moved imports, duplicate the existing complete `handlers(): OutlineHandlers` factory, and use this harness:

```tsx
const NODE = block("u1", "hello [[World]]", { order_idx: 0 });

function inputElement(
  h: OutlineHandlers,
  node = NODE,
  cursor = 0,
  readOnly = false,
) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BlockInput
        node={node}
        cursor={cursor}
        handlers={h}
        readOnly={readOnly}
        onRequestUpload={vi.fn()}
      />
    </MemoryRouter>
  );
}

function mount(
  h: OutlineHandlers,
  cursor = 0,
  readOnly = false,
  node = NODE,
) {
  return render(inputElement(h, node, cursor, readOnly));
}

function focusedTextarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}
```

For adoption/IME tests, replace tree rerenders with `view.rerender(inputElement(h, updatedNode, 0))`. For page navigation, retain the existing `MemoryRouter`/`Routes` and `SidebarContext.Provider`, but render `BlockInput` directly.

- [ ] **Step 3: Move the 70 input-owned tests without assertion changes**

Move these current contiguous ranges from `EditableBlockTree.test.tsx` (line numbers are from the pre-move file):

- Lines 58–100: focused textarea/cursor/heading classes — 5 collected tests.
- Lines 149–155: draft reporting — 1.
- Lines 171–278: focused input keyboard policy — 9.
- Lines 374–661: slash commands, autocomplete, live caret, IME, remote adoption — 19.
- Lines 692–904: Ctrl-O/sidebar navigation, key edits, auto-pairs, flush-held refs/tags — 16; move and adapt `mountWithPageRoute`.
- Lines 956–1027: selection commands originating in the textarea — 6.
- Lines 1454–1649: paste policy and `/date` picker — 14; move `pressPasteChord`.

Do not move the four `/upload` tests: their unchanged assertions require the upload input and pending target owned by `EditableBlockTree`, even though `/upload` command parsing begins in BlockInput.

- [ ] **Step 4: Keep exactly the tree-owned tests and clean imports**

The 42 retained tests cover:

- Unfocused/read-side rendering and focus transitions — 6.
- Bullets, collapse, TODO controls, and fallback — 6.
- Tree-owned upload input — 4.
- Already-active multi-block selection — 13.
- Bullet/block menu — 9.
- Numbered children and rendered table behavior — 4.

Retain `handlers`, `BLOCKS`, tree `mount`, `focusedTextarea`, `mountSelected`, and `bullet`. Remove now-unused `waitFor`, `Route`, `Routes`, `describe`, `SidebarContext`, `titleForDate`, and `stubFetch` imports from the tree suite. No runtime file changes belong in this task.

- [ ] **Step 5: Compare names/counts and run both suites**

Run:

```bash
cd web
pnpm vitest list src/components/EditableBlockTree.test.tsx src/components/BlockInput.test.tsx > /tmp/pkm-mlbh-after.txt
wc -l /tmp/pkm-mlbh-after.txt
pnpm vitest run src/components/EditableBlockTree.test.tsx src/components/BlockInput.test.tsx
pnpm typecheck
```

Expected: 112 listed/passing tests total, with 42 in `EditableBlockTree.test.tsx` and 70 in `BlockInput.test.tsx`. Compare the test-name suffixes in the before/after files; every pre-move name must appear exactly once after the split.

- [ ] **Step 6: Complete the bean and commit**

```bash
beans update pkm-mlbh --body-replace-old "- [ ] Move the BlockInput-facing tests, no assertion changes" --body-replace-new "- [x] Move the BlockInput-facing tests, no assertion changes"
printf '%s\n' '## Summary of Changes' '' 'Moved 70 focused textarea, draft, autocomplete, keyboard, navigation, paste, and date-picker tests into a direct BlockInput suite. Retained 42 tree-owned rendering, upload-input, selection, menu, fallback, and table tests. All 112 test names/assertions remain covered.' | beans update pkm-mlbh --body-append -
beans update pkm-mlbh --status completed
git add web/src/components/BlockInput.test.tsx web/src/components/EditableBlockTree.test.tsx .beans/pkm-mlbh--split-blockinput-tests-out-of-editableblocktreetes.md
git commit -m "test(pkm-mlbh): give BlockInput its own suite"
```

---

### Task 5: Final integrated verification

**Files:**
- Verify: all files changed by Tasks 1–4
- Verify: `docs/architecture/frontend.md`
- Verify: all four child bean files

**Interfaces:**
- Consumes: four completed, independently committed deliverables.
- Produces: a fully verified branch ready for review/integration.

- [ ] **Step 1: Audit beans, architecture, and repository state**

Run:

```bash
beans show --json pkm-ow62 pkm-6dg0 pkm-mlbh pkm-9jma
git status --short
git log --oneline --decorate -6
rg -n 'apiFetch[<(]' web/src -g '!*.test.*' -g '!web/src/api/**'
```

Expected: all four beans are `completed` with no unchecked items and summaries; only the multipart call appears in the concrete-call grep; the worktree is clean except for the implementation plan if it was not committed earlier.

- [ ] **Step 2: Run the full web verification gate**

Run:

```bash
cd web
pnpm verify
```

Expected: typecheck, lint, FCIS, coverage thresholds, production build/budgets, and all Playwright tests pass.

- [ ] **Step 3: Inspect the final diff against main**

Run:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short --branch
```

Confirm the architecture documentation matches the shipped code, the old “remaining apiFetch callers” wording is gone, and no count/enumeration says 32 or 111 for the now-current sets.
