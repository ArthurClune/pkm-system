# Web BlockUid / PageId / title brands Implementation Plan (pkm-thee)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the web carries `BlockUid`, `PageId`, `SidebarEntryId`, `NormalizedTitle` and `CanonicalTitle` as brands. The generated types bring them in from the server's `brand()`ed NewTypes, and web mint points and internal signatures are narrowed to them, so a swapped (title, uid) or (page id, sidebar id) argument fails tsc.

**Architecture:** the x-brand pipeline (pkm-85x3) already exists. Each task brands one family:

1. `brand()` it on the server.
2. Regenerate `openapi.json` and `types.d.ts`. Every directory sees the brand at once, because there is one `types.d.ts`.
3. Fix the places that write a plain value into a generated slot: op literals, replica row-to-response mappers, tombstone conversions and test fixtures.
4. Narrow the internal signatures that carry the value, so the swap shapes become type errors.

A brand is a subtype of its base type, so code that only reads a branded field into a `string`/`number` slot keeps compiling. That is why each task can land green.

**Tech Stack:**
- TypeScript (tsc, plus the `tsconfig.apitypes.json` pass) and vitest;
- the openapi-typescript transform in `web/tooling/genTypes-core.mjs`;
- Python with pydantic, pyrefly and ruff for the `brand()` and annotation changes.

**Spec:** the bean `pkm-thee` (types, mint points and swap shapes), the epic `pkm-7uxw` (the three title forms), and the research map `docs/superpowers/plans/2026-10-01-web-id-title-brands-map.md`, whose sections A–E (wire fields, mint points, usage counts, cross-directory dependencies, test blast radius) the tasks below cite as "the map". The x-brand mechanism is in `docs/superpowers/specs/2026-10-01-x-brand-gen-types-design.md`.

## Global Constraints

- **One branch:** `feat/pkm-thee-web-brands`, worktree `.claude/worktrees/pkm-thee`, branched from local main after pkm-s6q3 and pkm-bvad have merged. Tasks run sequentially; never fork helpers into the same worktree.
- **Every commit is green:** `pnpm typecheck` (both tsc passes) and `pnpm test:unit`, plus server pytest, pyrefly and ruff whenever server files change. Never commit with tsc red.
- **Clean checkers:** pyrefly 0 errors, with the suppressed and warning counts unchanged from main (11 and 7 at the time of writing). ruff and tsc clean.
- **No suppressions:** no new `# pyrefly: ignore`, `# type: ignore`, `@ts-ignore` or `eslint-disable`.
- **Casts only at mint points:** a cast (`as BlockUid`) is allowed only at a mint point, meaning a minting function, a SQLite row mapper, the worker RPC boundary, or a test fixture helper. A call site never casts. A swap probe is an `@ts-expect-error` line, which fails tsc if it stops catching the swap.
- **Brand shapes**, in `web/src/api/brands.ts`:
  - `BlockUid = string & { readonly __brand: "BlockUid" }`
  - `PageId = number & { readonly __brand: "PageId" }`
  - `SidebarEntryId = number & { readonly __brand: "SidebarEntryId" }`
  - `NormalizedTitle = string & { readonly __brand: "NormalizedTitle" }`
  - `CanonicalTitle = NormalizedTitle & { readonly __canonical: true }`
- **Server subtypes:** `brand()` every subtype explicitly. `CanonicalTitle` needs its own `brand(CanonicalTitle)`, or it inherits `NormalizedTitle`'s marker.
- **Raw titles stay plain `string`** and are never branded: URL path params, request bodies (`CreatePageRequest.title`, `RenamePageRequest.new_title`, `AddSidebarEntryRequest.title`), `paths.ts` `titleFromPathname`, `encodeTitle` and `pagePath`. **Op `page_title` also stays plain `string`:** it is raw inbound and canonical on the WS echo (`ops_apply._broadcast_op`), so a `CanonicalTitle` is assignable to it either way.
- **Dict keys stay `string` in TS.** The generator ignores `propertyNames` (`block_ref_texts`, `block_ref_counts`, `QueryPayload.ref_counts`), so code that indexes them with a brand is fine.
- **Perf:** no new DB statements.
- **Code and test comments carry no bean ids.**
- **Regen** after every server schema change:
  ```
  cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
  cd web && pnpm gen-types
  ```

## Review Focus

1. **Offline pages have negative `PageId`s** (`replica/localOps.ts` `getOrCreateLocalPage`). They must stay the same `PageId` type, with the sign carrying the meaning, and `reconcile.ts` must still remap them. Task 3 tests a negative id round-tripping through `remapLocalPage`.
2. **A parked title is transient but not canonical.** `replica/apply.ts` `parkedTitle` writes `"\u0001parked:<id>"` into `pages.title` inside a window transaction. Typing it `CanonicalTitle` would be a lie. Task 4 gives it its own type (`ParkedTitle`, or a plain `string` column write) and tests that `assertNoParkedTitles` still trips on one.
3. **Tombstone `entity_id` is one TEXT field for three kinds.** It stays plain `str` on the wire (no wire change). `applyWindow` mints `BlockUid`, `PageId` or `SidebarEntryId` per branch through the exhaustive dispatch pkm-38w9 added. Task 3 tests each kind's delete.
4. **A raw sidebar title becomes the outline key.** `components/EditableSidebarPanel.tsx` passes the requested title, not `payload.page.title`, to `<EditablePage title>`. `PageView` and `Journal` use the payload's title. Task 4 reproduces first: open a padded or non-canonical title in the sidebar and edit it, then compare outline session keys and replica lookups. If it misbehaves, write the failing test and file a troubleshooting row. Either way the fix is to pass `payload.page.title`.
5. **A URL hash is an unvalidated uid.** `views/PageView.tsx` passes `hash.slice(1)` to `useScrollFlashTarget`. It must go through `parseBlockUid` (Task 1), and a malformed hash must simply not flash. Task 2 tests that.

---

### Task 1: Brand definitions, mint helpers and fixture helpers (no regen)

**Files:**
- Modify: `web/src/api/brands.ts`, adding the five brands from Global Constraints with header comments in its existing style.
- Modify: `web/src/uid.ts`. `newUid(): BlockUid` mints a block uid, and `newRawUid(): string` is the unbranded id generator that `ClientId` / `BatchId` mint from. Update `sync/opQueue.ts`'s two casts (`newUid() as ClientId` / `as BatchId`) to cast `newRawUid()`.
- Create: `web/src/ids.ts` (Functional Core) with `parseBlockUid(raw: string): BlockUid | null`. It uses a full match of `grammar/scan.ts` `UID_TOKEN`, anchored, with no trailing-newline gap.
- Modify: `web/src/test-helpers.ts`. Add fixture helpers `uid(s: string): BlockUid`, `pageId(n: number): PageId`, `entryId(n: number): SidebarEntryId`, `normTitle(s: string): NormalizedTitle` and `title(s: string): CanonicalTitle`. Keep the parameters of `block(uid: string, …)` and `pagePayload(title: string, …)` as plain strings, and cast inside them, so their 870-odd call sites need no edits.
- Test: `web/src/ids.test.ts`.

**Interfaces:**
- Produces:
  - the brand types above;
  - `newUid(): BlockUid` and `newRawUid(): string`;
  - `parseBlockUid(raw: string): BlockUid | null`;
  - the test helpers `uid`, `pageId`, `entryId`, `normTitle` and `title`.

  Later tasks import exactly these names.

- [x] **Step 1: Write the failing tests** in `ids.test.ts`:
  - `parseBlockUid("abcdef")` is `"abcdef"`;
  - a 32-character uid parses, and a 33-character one is `null`;
  - `"abcde"` is `null`; `"abcdef\n"` is `null`; `"((abcdef))"` is `null`;
  - a type probe: `// @ts-expect-error a plain string is not a BlockUid` on `const u: BlockUid = "abcdef";`.
- [x] **Step 2:** `cd web && pnpm vitest run src/ids.test.ts`. Expect a FAIL because the module isn't found.
- [x] **Step 3: Implement** brands.ts, ids.ts, the uid.ts split, the opQueue casts and the test-helpers.
- [x] **Step 4:** `pnpm typecheck && pnpm test:unit`. Expect a PASS: no generated type changed, so nothing else moves.
- [x] **Step 5:** Commit: `feat(pkm-thee): web brand types, uid mint helpers and fixture helpers`.

### Task 2: BlockUid flip

**Files (production):**
- Server: `server/src/pkm/contracts/ops.py`. Add `brand(BlockUid)` after its declaration, and drop the "not brand()ed" sentence from its comment. Then regenerate.
- Web op builders, where uid parameters narrow to `BlockUid`. These are all the `(pageTitle, uid)` functions:
  - `outline/edits.ts`: `splitBlock`, `indentSelection`/`outdentSelection`, `indentBlock`/`outdentBlock`, the `move*` functions, `moveBlocksTo`, `groupMoveOps`, `deleteSelection`, `backspaceAtStart`, `setCollapsed`, `setHeading` and `setViewType`;
  - also `outline/history.ts`, `outline/paste.ts` (`planOutlinePaste`, and its `newUid: () => BlockUid` parameter), `outline/useOutline.ts`, `outline/outlineState.ts`, `outline/tree.ts`, `outline/dnd.ts`, `outline/handlers.ts`, `dnd/DndContext.tsx` and `components/UnlinkedSection.tsx`.
- Web callers that pass a uid into those builders: `components/EditableBlockTree.tsx`, `components/BlockInput.tsx`, `components/BacklinkGroupList.tsx` (`onNavigate(pageTitle, uid: BlockUid)`), `contexts.ts`/`App.tsx` (`openInSidebar(title, uid?: BlockUid)`) and `components/blockRefStore.ts`.
- Web uid producers:
  - `grammar/scan.ts`: the block-ref token's `uid` is a `BlockUid`, as are `grammar/refs.ts` `block_refs` and `replica/refs.ts` `blockRefs`;
  - `assistant/normalizeRefs.ts` (the regex captures, minted at the match);
  - `replica/localApi/router.ts` (uids validated through `parseBlockUid`, replacing its own `UID_RE` test);
  - `views/PageView.tsx` (the URL hash goes through `parseBlockUid`; on `null`, nothing is passed);
  - `useScrollFlashTarget.ts`.
- Web row mappers, where `uid` / `parent_uid` columns become `BlockUid` at the mapper: `replica/localApi/tree.ts` (`BlockRow` and the three ad-hoc row shapes), `localApi/pages.ts`, `localApi/search.ts`, `replica/localOps.ts` (`BlockInfo`, `parentChain`, `subtreeUids`) and `replica/queue.ts` (subtree pairs).
- Web tombstone: in `replica/apply.ts`'s `block` branch, `tomb.entity_id` is minted as a `BlockUid` there.
- Tests: every test file tsc then flags. Use `uid("…")` from test-helpers, or cast inside a per-file factory: the map lists 22 local factories, such as `replica/apply.test.ts` `block(uid, pageId)` and `sync/outbox.test.ts` `op(uid)`.

**Interfaces:**
- Consumes `BlockUid`, `newUid`, `parseBlockUid` and `uid` from Task 1.
- Produces: every outline command takes `(pageTitle: string, uid: BlockUid, …)`. Titles are still `string` until Task 4.

- [x] **Step 1: Write the failing probes.**
  - In `outline/edits.test.ts`: `// @ts-expect-error (title, uid) swapped` on `indentBlock(blocks, someUid, "Page")`, where `someUid = uid("abcdef")`.
  - In `components/BacklinkGroupList.test.tsx`: the same idea for `onNavigate`.
  - In `views/PageView.test.tsx`: a URL hash `#not a uid` flashes nothing, and `#abcdef` flashes block `abcdef`.
- [x] **Step 2:** `pnpm typecheck`. Expect it to FAIL on the unused `@ts-expect-error` directives, because the parameters are still `string`.
- [x] **Step 3:** Add `brand(BlockUid)`, regenerate, and confirm `git diff --no-ext-diff web/src/api/openapi.json` shows only `"x-brand": "BlockUid"` additions.
- [x] **Step 4:** Fix production write sites and narrow signatures as listed, directory by directory, in this order: replica, grammar/assistant, outline, dnd, components, views, root. Run `pnpm typecheck` after each directory, and keep a running count of errors that only ever goes down.
- [x] **Step 5:** Fix the test files. Then run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` and `cd web && pnpm typecheck && pnpm test:unit`. Everything must pass, and the probes must now be used.
- [ ] **Step 6:** Commit: `feat(pkm-thee): BlockUid reaches the web as a brand; outline commands take BlockUid`.

### Task 3: PageId and SidebarEntryId flip

**Files:**
- Server: add `brand(PageId)` and `brand(SidebarEntryId)` in `contracts/ops.py`, then regenerate. The path parameter of `DELETE /api/sidebar/{entry_id}` then becomes `Brands.SidebarEntryId`.
- Web:
  - `replica/localOps.ts`: `getOrCreateLocalPage` returns `PageId`, with the negative offline id minted there, and `pageIdByTitle` returns `PageId | null`.
  - `replica/reconcile.ts`: `remapLocalPage(db, { localId, targetId }: { localId: PageId; targetId: PageId })`. A named-object parameter guards the PageId/PageId swap, which branding can't.
  - `replica/apply.ts`:
    - the tombstone `page` branch becomes `Number(...)` → `PageId`, and the `sidebar` branch → `SidebarEntryId`;
    - `parkTakenTitles` and `assertNoParkedTitles` become generic over the id type (`<Id extends PageId | SidebarEntryId>`), so a pages call and a sidebar call can't mix.
  - Row mappers in `localApi/pages.ts`, `localApi/search.ts`, `localApi/router.ts` (`sidebarPayload`) and `reconcile.ts`.
  - `components/SidebarNav.tsx`: `removeEntry(id: SidebarEntryId)`, with the reorder ids taken from `entry.id`.
  - `components/groups.ts`: `mergeGroups` keyed by `page_id: PageId`.
- Tests flagged by tsc, using `pageId(n)` / `entryId(n)`.

**Interfaces:**
- Consumes `PageId`, `SidebarEntryId`, `pageId` and `entryId` from Task 1.
- Produces `remapLocalPage(db, { localId, targetId })`, which Task 4's title work leaves alone.

- [ ] **Step 1: Write the failing probes and tests.**
  - In `components/SidebarNav.test.tsx`: `// @ts-expect-error a PageId is not a SidebarEntryId` on `removeEntry(pageId(3))`.
  - In `replica/reconcile.test.ts`: a negative local `PageId` remaps to its server id (Review Focus 1).
  - In `replica/apply.test.ts`: one tombstone per kind deletes exactly its own row (Review Focus 3).
- [ ] **Step 2:** `pnpm typecheck`. Expect a FAIL on the unused directive.
- [ ] **Step 3:** Add the brands and regenerate. The openapi diff should show only `x-brand` additions.
- [ ] **Step 4:** Fix and narrow, replica first. Then run the full server and web unit checks, as in Task 2's Step 5.
- [ ] **Step 5:** Commit: `feat(pkm-thee): PageId and SidebarEntryId reach the web as brands`.

### Task 4a: Server title annotations (no brand yet)

**Files:**
- `server/src/pkm/contracts/responses.py`: change every response title field the map lists as canonical from `str` to `CanonicalTitle`:
  - `PageMeta.title`, `BacklinkGroup.page_title`, `BlockRefText.page_title`, `RenamePageResponse.title`, `BlockGroup.page_title`, `ChangedGroup.page_title`, `JournalDay.title`;
  - `CurrentWorkPage.title`, `SearchPageHit.title`, `SearchBlockHit.page_title`, `TitlesPayload.titles`, `SidebarNavEntry.title`, `AssetRef.page_title`, `LocalCheckProblem.page`, `GoodlinksCheckProblem.page`;
  - `SyncPage.title`, `SyncSidebarEntry.title`, `TitleMigrationPage.title`, `TitleMigrationBlocker.title`, `TitleMigrationGroup.canonical_title`;
  - `QueryPayload.ref_counts` keys;
  - `SkippedOp.note_page: CanonicalTitle | None`. Also type `ops_core.ConflictLanding.daily_title` as `CanonicalTitle`, minted where `title_for_date` produces it (the same argument as `_daily_title`).

  Leave request bodies and op `page_title` as `str`.
- Server producers that pyrefly then flags: mint only at genuine sources, meaning row reads, `read_title` / `title_reader`, the daily-title helpers, and `target_canonical_title` for the migration group. If pyrefly flags a raw title reaching one of these fields, that is a bug. Write a failing test first and report it.

- [ ] **Step 1:** Change the annotations, then run `uv run pyrefly check` and list every new error.
- [ ] **Step 2:** Resolve each error at its mint point, never by wrapping at the call site. Then run `uv run pytest -q && uv run pyrefly check && uv run ruff check`. Expect a PASS, with `openapi.json` unchanged because nothing is branded yet.
- [ ] **Step 3:** Commit: `feat(pkm-thee): server response titles are CanonicalTitle`.

### Task 4b: Title flip on the web

**Files:**
- Server: `brand(NormalizedTitle)` and `brand(CanonicalTitle)` in `refs.py`, in two separate statements. Then regenerate. The diff should show `x-brand` additions on exactly the fields from Task 4a, plus any already typed `NormalizedTitle`.
- Web mints:
  - `grammar/scan.ts`: `normalizeRefTitle(title: string): NormalizedTitle`. Page-ref, attribute and hashtag token titles are `NormalizedTitle`; hashtags are normalized by construction, so the mint is at the token.
  - `grammar/refs.ts` `Ref.title`, and `replica/refs.ts` `ExtractedRef.title`.
  - `replica/titles.ts`: `canonicalizeTitle(title, plainSpaceActive): NormalizedTitle`, matching the server, plus a new `canonicalTitle(db: ReplicaDb, title: string): CanonicalTitle` that reads `plainSpaceTitleCanonicalizationActive(db)` once. Use a `titleReader(db): (t: string) => CanonicalTitle` variant where a function canonicalises several titles. This mirrors `sync_meta.read_title` / `title_reader`.
  - `replica/daily.ts`: `titleForDate(): CanonicalTitle`.
  - Row mappers for every `pages.title` / `sidebar_entries.title` column read (map section B, CanonicalTitle).
  - `parkedTitle`: give it its own type and leave it out of `CanonicalTitle` (Review Focus 2).
  - `reconcile.ts`: replace its literal `true` with the flag-reading mint.
- Web signatures:
  - outline commands take `pageTitle: CanonicalTitle`;
  - `useOutline(title: CanonicalTitle, …)`, `EditablePage` `title: CanonicalTitle`;
  - `outline/outlineSessions.ts` session keys are `CanonicalTitle`;
  - `openInSidebar(title: string, …)` stays raw, because it navigates.
  - Fix `EditableSidebarPanel` to pass `payload.page.title`, reproducing first (Review Focus 4).
- Tests flagged by tsc, using `title("…")` / `normTitle("…")`.

**Interfaces:**
- Consumes `NormalizedTitle`, `CanonicalTitle`, `title` and `normTitle` from Task 1, and the Task 2 signatures, whose `pageTitle` now narrows.
- Produces `canonicalTitle(db, title)`, `titleReader(db)` and `normalizeRefTitle(): NormalizedTitle`.

- [ ] **Step 1: Write the failing probes and tests.**
  - `// @ts-expect-error a raw string is not a CanonicalTitle` on `indentBlock(blocks, "Page", someUid)`.
  - `// @ts-expect-error a NormalizedTitle is not a CanonicalTitle` on `useOutline(normTitle("Page"), …)`, in the `useOutline` test.
  - A `CanonicalTitle` passes wherever a `NormalizedTitle` is expected, shown by a plain assignment that compiles.
  - The `EditableSidebarPanel` reproduction test (Review Focus 4).
  - A `replica/apply.test.ts` case where a parked title still trips `assertNoParkedTitles` (Review Focus 2).
- [ ] **Step 2:** `pnpm typecheck`. Expect a FAIL on the unused directives. Run the reproduction test and record whether it fails today.
- [ ] **Step 3:** Add the brands and regenerate.
- [ ] **Step 4:** Fix and narrow in this order: replica, grammar, outline, components, views, root. Then fix the tests. Run the full server and web unit checks.
- [ ] **Step 5:** Commit: `feat(pkm-thee): titles reach the web as NormalizedTitle / CanonicalTitle brands`.

### Task 5: Docs, full verification, perf

**Files:**
- `docs/architecture/frontend.md`: the brands vocabulary, where each value is minted (`ids.ts`, `uid.ts`, `titles.ts`, `daily.ts`, the row mappers), and the rule that raw titles stay `string`.
- `docs/architecture/backend.md`: add the five types to the list of `brand()`ed NewTypes, and grep for any count or enumeration of branded types.
- `docs/architecture/sync-and-offline.md`: the per-kind tombstone mint, and negative offline `PageId`s.
- `docs/troubleshooting.md`: a row only if Review Focus 4 reproduced.
- `web/src/api/brands.ts` header: drop the "add the title types later" wording.

- [ ] **Step 1:** Make the edits. Invoke the `architecture-docs` skill and run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- [ ] **Step 2:** Run the full verification:
  - server: `uv run pytest -q && uv run pyrefly check && uv run ruff check`;
  - web: `pnpm build && CI=true pnpm verify`, with the e2e port assigned by the orchestrator.
- [ ] **Step 3:** Tick the pkm-thee bean checklist and commit: `docs(pkm-thee): document the web id and title brands`.

The orchestrator then runs `perf/check.sh` on a quiet machine, and dispatches an Opus whole-branch review before merge.
