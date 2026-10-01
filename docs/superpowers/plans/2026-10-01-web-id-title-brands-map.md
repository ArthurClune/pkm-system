# Branding map: BlockUid / PageId / SidebarEntryId / NormalizedTitle / CanonicalTitle

Repo state: main @ 290ca572 (after the pkm-9km9 merge). All paths are relative to /Users/arthur/code/llm/pkm.

## 0. Constraints already in the tree (read these first)

- `server/src/pkm/contracts/brands.py` provides `brand(NT)`, which adds `"x-brand": "<Name>"` to the schema.
  - A NewType of a branded NewType inherits its parent's marker, so `CanonicalTitle` (a NewType of `NormalizedTitle`) needs its own `brand(CanonicalTitle)`.
  - A `PlainValidator` on a field silently drops the marker.
- `web/tooling/genTypes-core.mjs` turns the marker into `Brands.<Name>` from `web/src/api/brands.ts`. Four rules matter here:
  - It accepts only `string` or `integer` schemas, and rejects `nullable`, `enum` and `const`. `X | None` works, because it becomes `anyOf[{x-brand}, null]`; see `UpdateTextOp.base_text_hash` at openapi.json, which already works this way.
  - **A marker under `propertyNames` is ignored.** So `dict[BlockUid, ...]` keys (`block_ref_texts`, `block_ref_counts`) stay `Record<string, ...>` in TS, even after branding.
  - Brands go through `$ref`. Only the component carrying the marker is branded.
  - The `transform` hook also runs on **parameter schemas**. Once `SidebarEntryId` is branded, the path param `DELETE /api/sidebar/{entry_id}` (routes_sidebar.py:61 already types it `SidebarEntryId`) becomes `Brands.SidebarEntryId`.
- `web/src/api/brands.ts` already documents the subtype pattern (lines 6-14):
  `NormalizedTitle = string & {__brand:"NormalizedTitle"}`; `CanonicalTitle = NormalizedTitle & {__canonical:true}`.
- `server/src/pkm/contracts/ops.py:52-61` explicitly says `BlockUid` / `PageId` / `SidebarEntryId` are **not brand()ed yet**. The generated TS sees them as plain string/number. Today only these are branded: `Sha256Hex`, `SyncSeq`, `ClientId`, `BatchId`, plus `PendingRowId`, which is web-only at replica/client.ts:25.
- Existing test precedent: tests cast brands inline (`10 as SyncSeq`). There are 322 such casts across 35 test files, and no brand fixture helpers yet.

## A. Server wire fields

Legend: `type-now -> proposed`. "[NT]" means the Python annotation is already the NewType. "[str]" or "[int]" means it is still plain.

### A1. contracts/ops.py (request models; the same classes are also re-used outbound, see the dual-use note)

| Field | Now -> proposed | Notes |
|---|---|---|
| CreateOp.uid (ops.py:87) | BlockUid [NT] -> BlockUid | |
| CreateOp.page_title (ops.py:91) | str [str] -> **raw str** | Client-supplied; get_or_create canonicalises it server-side (store.py:42-56). |
| CreateOp.parent_uid (ops.py:92) | BlockUid \| None [NT] -> BlockUid \| None | |
| UpdateTextOp.uid (ops.py:101) | BlockUid [NT] | |
| UpdateTextOp.page_title (ops.py:114) | str \| None -> **raw str** | Conflict label hint only, never validated. |
| MoveOp.uid / parent_uid (ops.py:119-120) | BlockUid [NT] | |
| MoveOp.page_title (ops.py:125) | str \| None -> **raw str** | |
| DeleteOp.uid (ops.py:130) | BlockUid [NT] | |
| SetCollapsedOp.uid / SetHeadingOp.uid / SetViewTypeOp.uid (ops.py:145,151,157) | BlockUid [NT] | |
| CreatePageOp.page_title (ops.py:166) | str -> **raw str** | |
| OpBatch.ops (ops.py:181) | list[BlockOp] | Carries all of the above. |

**Dual-use (request AND outbound):** the op models are also echoed on the WebSocket frame. In ops_apply.py:401-411, `_broadcast_op` calls `op.model_dump()` and then overwrites `page_title` with the **stored page row's title**, which is canonical. routes_ops.py:95-99 broadcasts it, and web reads it as `WsBatch.ops: BlockOp[]` (web/src/sync/socket.ts:26-30).

So `page_title` on an op is raw inbound but canonical outbound. Keep it as plain `string`: a `CanonicalTitle` is assignable to it, so nothing breaks. The ops are also persisted in the replica (`pending_ops.ops_json`) and re-read with `JSON.parse(...) as BlockOp[]` (replica/queue.ts:124,171).

### A2. contracts/responses.py

| Field | Now -> proposed | Producer / evidence |
|---|---|---|
| PageMeta.id (responses.py:44) | PageId [NT] | |
| PageMeta.title (responses.py:45) | str -> **CanonicalTitle** | `store.fetch_page` SELECTs pages.title (store.py:36-39). Routes: routes_pages.py:212 (get_block, row["title"]), :240 (get_page), :267 (POST /api/pages returns the get_or_create_page row). |
| BlockNode.uid (responses.py:51) | BlockUid [NT] | build_tree over blocks rows (server/tree.py). |
| BacklinkItem.uid (:73) | BlockUid [NT] | |
| BacklinkItem.breadcrumbs (:75) | list[str] | Block texts, not titles. Leave as is. |
| BacklinkGroup.page_id (:79) | PageId [NT] | |
| BacklinkGroup.page_title (:80) | str -> **CanonicalTitle** | grouping.py:66-67 from `p.title AS src_page_title` (routes_pages.py:140, :182). |
| BlockRefText.page_title (:100) | str -> **CanonicalTitle** | routes_pages.py:88-92 (`p.title AS page_title`). |
| BlockRefsPayload.block_ref_texts (:105) | dict[BlockUid, BlockRefText] [NT key] | The key stays `string` in TS (propertyNames rule). |
| PagePayload.block_ref_texts / block_ref_counts (:112-113) | dict[BlockUid, ...] [NT key] | Same: TS key stays `string`. |
| RenamePageResponse.title (:121) | str -> **CanonicalTitle** | routes_pages.py:295-300 `title_reader(db)(body.new_title)`, returned at :343. |
| GroupItem.uid (:125) | BlockUid [NT] | |
| BlockGroup.page_id (:130) | PageId [NT] | |
| BlockGroup.page_title (:131) | str -> **CanonicalTitle** | grouping.py:24 from `p.title AS page_title`: routes_pages.py:364 (unlinked), routes_search.py:110 (todos), query_exec.py:79 (query). |
| QueryPayload.ref_counts (:144) | dict[str,int] -> dict[**CanonicalTitle**, int] | Keys are `page_operands(node)` of the canonical node (routes_search.py:59-71; query.py:112 returns list[str]). The TS key stays `string` either way. |
| ChangedItem.uid (:148) | BlockUid [NT] | |
| ChangedGroup.page_id / page_title (:156-157) | PageId [NT] / str -> **CanonicalTitle** | grouping.py:44 from routes_search.py:146 `p.title AS page_title`. |
| JournalDay.title (:179) | str -> **CanonicalTitle** | routes_pages.py:478 `page["title"]` (fetch_page row). |
| JournalDay.date (:178) | str | ISO date, not a title. |
| JournalPayload.block_ref_texts / counts (:187-188) | dict[BlockUid,...] | TS key stays `string`. |
| CurrentWorkPage.id (:192) | PageId [NT] | |
| CurrentWorkPage.title (:193) | str -> **CanonicalTitle** | routes_pages.py:388-398 `SELECT id, title ... FROM pages`. |
| CurrentWorkSection.id / title (:198-199) | str | Section slug and label, **not** page ids or titles. Leave. |
| SearchPageHit.id (:208) | PageId [NT] | |
| SearchPageHit.title (:209) | str -> **CanonicalTitle** | routes_search.py:35-39. |
| SearchBlockHit.uid (:213) | BlockUid [NT] | |
| SearchBlockHit.page_title (:214) | str -> **CanonicalTitle** | routes_search.py:40-46. |
| TitlesPayload.titles (:224) | list[str] -> list[**CanonicalTitle**] | routes_search.py:86-93 (`SELECT title FROM pages`). |
| SidebarNavEntry.id (:228) | SidebarEntryId [NT] | |
| SidebarNavEntry.title (:229) | str -> **CanonicalTitle** | routes_sidebar.py:33-35 (`SELECT id, title FROM sidebar_entries`). |
| AssetRef.uid / page_title (:246-247) | BlockUid [NT] / str -> **CanonicalTitle** | routes_assets.py:86-93. |
| LocalCheckProblem.uid (:280) | BlockUid [NT] | Value comes from an untyped row. |
| LocalCheckProblem.page (:281) | str -> **CanonicalTitle** | routes_local.py:107-121 (`p.title`). |
| GoodlinksCheckProblem.uid / page (:324-325) | BlockUid [NT] / str -> **CanonicalTitle** | routes_goodlinks.py:91-112 (`p.title`). |
| SyncRef.target_page_id (:340) | PageId [NT] | |
| SyncBlock.uid / page_id / parent_uid (:345-347) | BlockUid / PageId / BlockUid\|None [NT] | |
| SyncPage.id (:359) | PageId [NT] | |
| SyncPage.title (:360) | str -> **CanonicalTitle** | routes_sync.py:193-195 (changes) and :302-303 (snapshot), `SyncPage(**dict(row))`. |
| SyncSidebarEntry.id (:366) | SidebarEntryId [NT] | |
| SyncSidebarEntry.title (:367) | str -> **CanonicalTitle** | routes_sync.py:207-209 and :304-305. |
| **SyncTombstone.entity_id** (:387) | str [str] -> **cannot take one brand** | A block uid, `str(page id)` or `str(sidebar id)` depending on `kind` (routes_sync.py:277-283; sync_core.py:105-115). Options: leave it `str` and mint at web apply.ts:329-334, or split into a discriminated union per kind (wire change). |
| BlockPayload.page / block / block_ref_texts (:404-407) | via PageMeta / BlockNode | |
| BlockPayload.breadcrumbs (:406) | list[str] | Texts. |
| TitleMigrationPage.page_id (:440) | PageId [NT] | |
| TitleMigrationPage.title (:441) | str -> **CanonicalTitle** | It is the stored pages.title. pkm/title_migration.py:17 already types InventoryPage.title as CanonicalTitle (row read at server/title_migration.py:122), and routes_migrations.py:37-45 serialises it. Caveat: this is canonical under the **live** (pre-migration) flag, not the target flag. |
| TitleMigrationBlocker.page_id / title (:445-446) | PageId [NT] / str -> **CanonicalTitle** | title_migration.py:59 (CanonicalTitle); routes_migrations.py:50-55. |
| TitleMigrationGroup.canonical_title (:451) | str -> **CanonicalTitle** | title_migration.py:64 and :189 via `target_canonical_title` (refs.py:97, the documented exception: canonical under the target flag). |
| SkippedOp.uid (:507) | BlockUid [NT] | |
| SkippedOp.note_page (:511) | str \| None -> CanonicalTitle \| None (or leave str) | ops_core.py:460-461 `ctx.landing.daily_title`, built at ops_apply.py:197/212 as `title_for_date(date.today())`. It is canonical by format, the same argument as `_daily_title` (routes_pages.py:49-53), but `ConflictLanding.daily_title` is typed `str` (ops_core.py:270). |
| OpsAck.skipped (:529) | list[SkippedOp] | |

Not ids or titles (leave): `GoodlinksLink.id/title`, `GoodlinksArticle.id/title` (GoodLinks objects), `AssistantConversation.id`, `ClientDiagnosticsRequest.*`.

### A3. Models outside contracts/ that reach openapi.json

| Field | Now -> proposed | |
|---|---|---|
| AddSidebarEntryRequest.title (routes_sidebar.py:24) | str -> **raw str** | Request body; canonicalised at routes_sidebar.py:42 `read_title(db, body.title)`. |
| ReorderSidebarEntriesRequest.order (routes_sidebar.py:28) | list[SidebarEntryId] [NT] -> list[SidebarEntryId] | Request **containing ids**. The web builds it from `entry.id` (components/SidebarNav.tsx:99-101). |
| CreatePageRequest.title (routes_pages.py:41) | str -> raw str | |
| RenamePageRequest.new_title (routes_pages.py:45) | str -> raw str | |
| LoginBody, ConfirmRequestBody, CreateConversationRequest, SendMessageRequest | none | |

Untyped responses: `POST /api/sidebar` returns `{"id", "title"}` (canonical) at routes_sidebar.py:57 with no response_model, so the web sees `unknown`.

### A4. Path and query params (all raw unless noted)

- `/api/page/{title}` (GET, DELETE, `/rename`), `/api/export/page/{title}`, `?title=` (unlinked), `?page=` (todos, changed), `?q=` (titles, search): raw str.
- `/api/block/{uid}` and `/api/block/{uid}/backlinks`: the route signature is `uid: str` (routes_pages.py:171, :194). It is shape-checked, then used. `?uids=` is checked and wrapped `BlockUid(u)` at routes_pages.py:166.
- `/api/sidebar/{entry_id}`: already `SidebarEntryId` (routes_sidebar.py:61). It **will** become `Brands.SidebarEntryId` in TS once branded. The web caller is components/SidebarNav.tsx:89-90 (`removeEntry(id: number)`), fed from `entry.id` at :141.

## B. Web mint points (where plain string/number becomes each kind)

### BlockUid
- web/src/uid.ts:7 `newUid(): string` (bytes via uidCore.ts:16 `bytesToUid`).
  - Callers: outline/useOutline.ts:366 (splitBlock arg), :474 (passes `newUid` fn to planOutlinePaste), :561, :571; outline/paste.ts:109 (`newUid: () => string` param) and :130.
  - **sync/opQueue.ts:33 `newUid() as ClientId` and :642 `newUid() as BatchId`.** If newUid returns BlockUid, these casts become brand-to-brand casts. TS2352 will flag them ("conversion may be a mistake"), so they need a `string` hop or a separate raw minter.
  - replica/workerHandlers.ts:261 mints BatchId via `crypto.randomUUID()` (not a uid).
- Regex validation then uid:
  - grammar/scan.ts:62 `UID_TOKEN`; :63 BLOCK_REF_RE; :180 the `block-ref` token `uid: m[1]` (the type is at scan.ts:31).
  - replica/localApi/router.ts:33 `UID_RE`. Validated at :81 (`/api/block-refs` uids from the query) and :112 (path uid via decodeURIComponent at :111).
  - assistant/normalizeRefs.ts:9-11 `CARET_BLOCK_REF_RE` (uids out of assistant text).
- Text to uid lists:
  - grammar/refs.ts:31 `block_refs.push(t.uid)` (the ParsedRefs.block_refs type is at :18).
  - replica/refs.ts:23-25 adapter (`blockRefs: string[]`).
  - replica/localApi/tree.ts:80 `collectBlockRefUids`.
- URL hash to uid: views/PageView.tsx:35 `hash.slice(1)` goes into useScrollFlashTarget (useScrollFlashTarget.ts:22). Unvalidated, so treat it as raw.
- SQLite rows typed `uid: string`:
  - replica/localApi/tree.ts:13-23 `BlockRow` (uid, parent_uid; used at pages.ts:146, journal.ts:76).
  - tree.ts:107 `{uid,text,page_title}`; :129 `{target_block_uid,n}`; :144 `{start_uid,...}`.
  - pages.ts:46-51 `BacklinkRow` (uid, src_page_id, src_page_title), used at :83, :121; pages.ts:176 `{uid,text,page_id,page_title}`.
  - search.ts:21 `{uid,page_title,snippet}`.
  - localOps.ts:113-117 `BlockInfo` (page_id, parent_uid); :139 parentChain `{uid}`; :150 subtreeUids `{uid}`.
  - queue.ts:44 `{uid,text}` (subtree pairs).
- Tombstone: replica/apply.ts:329 `tomb.entity_id` is used directly as a block uid (no conversion).

### PageId
- Offline negative ids: replica/localOps.ts:77-82 (`MIN(0, COALESCE(MIN(id),0)) - 1`), inside getOrCreateLocalPage (localOps.ts:70-84, returns `number`). Lookup: localOps.ts:58-62 `pageIdByTitle` → `number | null`.
- Reconcile: replica/reconcile.ts:15 `remapLocalPage(db, localId: number, targetId: number)`; :28 `{id:number}`; :42 `{id,title}`; :47 `{id}`.
- Tombstones: replica/apply.ts:331 `Number(tomb.entity_id)` for page deletes and :333-334 `Number(tomb.entity_id)` for sidebar deletes.
- Other rows typed `id/page_id: number`:
  - apply.ts:285-299 `parkTakenTitles(..., incoming: {id:number; title:string}[])`. Shared by pages **and** sidebar_entries, so it needs a generic or a union.
  - apply.ts:289 `{id}`.
  - pages.ts:25-30 `PageRow`; :74 `{page_id}`; :176; :206 `{id,title,updated_at}`.
  - search.ts:17 `{id,title}`; router.ts:126 `{id,title}` (sidebar).
  - localOps.ts:113 BlockInfo.page_id.
- Upserts read SyncPage.id / SyncBlock.page_id from generated types (apply.ts:44-73). They pick up the brand automatically.

### SidebarEntryId
- replica/localApi/router.ts:124-129 `sidebarPayload` (row `{id:number,title:string}`, mapped into a SidebarNavEntry literal).
- apply.ts:333-334 (tombstone `Number(...)`) and :345-351 (upsert from SyncSidebarEntry).
- components/SidebarNav.tsx:89 `removeEntry(id: number)` and :99 `ids = current.map(e => e.id)`.
- Not a SidebarEntryId: App.tsx:72-75 `idRef.current` (the right-sidebar stack key, a local counter; entry.id at App.tsx:225-228).

### NormalizedTitle
- grammar/scan.ts:50 `normalizeRefTitle(title: string): string`. Token producers:
  - :155-159 page-ref title.
  - :239 attribute title.
  - :196 hashtag `title: m[0]`. Not passed through normalizeRefTitle, but TAG_CHARS_RE (:66) excludes whitespace, so it is normalized by construction.
  - The token types are at scan.ts:29-33, mirrored in grammar/tokenize.ts:21-23.
- grammar/refs.ts:12-15 `Ref.title`, then replica/refs.ts:12-15 `ExtractedRef.title` (equivalent to server `Ref.title: NormalizedTitle`, refs.py:135).
- replica/titles.ts:12-18 `titleSyntaxReason` (normalizes internally). OpTitleViolation.title (titles.ts:23) holds a mix of raw page_title and normalized ref titles.

### CanonicalTitle
- replica/titles.ts:52-56 `canonicalizeTitle(title, plainSpaceActive): string`. Like server `canonicalize_title`, it is canonical only when the caller passes the live flag.
  - Callers that pass the live flag: localOps.ts:50-55 `localPageTitle` (adds the "Untitled" fallback); localApi/pages.ts:31-32 `localTitle`; router.ts:88-91 (POST /api/pages).
  - reconcile.ts:45 passes a literal `true`, after the :41 active check.
- replica/daily.ts:19 `titleForDate` (canonical by format; server twin is routes_pages.py:49-53). Used at pages.ts:131, journal.ts:53-54, :73; outline/slashCommands.ts:16; components/BlockInput.tsx:27.
- Rows read from pages.title or sidebar_entries.title (all `title: string` today):
  - localApi/pages.ts:37 (PageRow), :83/:121 (src_page_title), :176 (page_title), :206.
  - tree.ts:107 (page_title).
  - search.ts:17, :21.
  - router.ts:126 (sidebar), :139 (titles).
  - journal.ts:59, :62 (`{title}` for daily detection).
  - queue.ts:31-36 `currentPageTitle` (feeds the UpdateTextOp.page_title stamp).
  - reconcile.ts:42.
- **Non-canonical value written into pages.title:** apply.ts:271 `parkedTitle(id)` = `"\u0001parked:<id>"`. It is transient inside the window transaction, and any brand-typed reader inside that window would be wrong. Worth an explicit cast with a comment.

### Raw titles (never branded)
- paths.ts:15 `titleFromPathname` → raw. Callers: views/PageView.tsx:18, components/TopBar.tsx:25 (then TopBar.tsx:55 `apiDelete("/api/page/{title}", {path:{title}})`).
- router.ts:52 `decodeURIComponent(path.slice(...))` (shim `/api/page/{title}`); router.ts:58 `q.get("title")`; router.ts:89 POST body title.
- **Raw-to-canonical leak today:** components/EditableSidebarPanel.tsx:23-34. It passes the **requested** `title` (from openInSidebar, which can be a URL-derived raw title from TopBar.tsx:120 or a ref title) to `<EditablePage title={title}>` at :34. PageView.tsx:43 and Journal.tsx:217 pass the payload's `page.title` instead. Branding EditablePage's `title` as CanonicalTitle will flag this site.
- paths.ts:7 `encodeTitle(title: string)` and :11 `pagePath(title: string)` accept any form. Keep them `string`.

## C. Web usage counts (non-test, non-generated)

Method: grep of explicit annotations `<name containing uid|Uid>: string`, `<name containing title>: string`, `<pageId|page_id|localId|targetId|...>: number`. This is a lower bound: most values arrive through generated types (BlockNode, PagePayload, ...) and are inferred, so they flip automatically.

| dir | uid-annot | title-annot | page-id-annot | bare `id: number` | page_id/page.id refs | Notes |
|---|---|---|---|---|---|---|
| outline | 74 | 59 | 0 | 0 | 0 | edits.ts 43, handlers.ts 23, tree.ts 12, outlineState.ts 9, dnd.ts 9, outlineSessions.ts 8 (title-keyed sessions), history.ts 4 |
| components | 32 | 19 | 1 | 1 | 6 | EditableBlockTree.tsx 13, blockRefStore.ts 5, SearchBar.tsx 3 |
| replica | 30 | 29 | 12 | 22 | 64 | localOps.ts 14, localApi/pages.ts 11, localApi/tree.ts 8, queue.ts 5 |
| views | 2 | 7 | 0 | 0 | 1 | filesCore.ts 4 (uid/page_title), Journal.tsx, EditablePage.tsx |
| sync | 0 | 1 | 0 | 0 | 0 | Carries BlockOp[] only; SyncProvider.tsx:95 title |
| grammar | 2 | 8 | 0 | 0 | 0 | scan.ts 5, tokenize.ts 2, linkReference.ts 2 (`canonicalTitle: string` param at :92), refs.ts 1 |
| assistant | 0 | 0 | 0 | 0 | 0 | normalizeRefs.ts mints uid tokens only |
| dnd | 3 | 2 | 0 | 0 | 0 | DndContext.tsx 3 |
| api | 0 hand-written | 0 | 0 | 0 | | api/types.d.ts (generated) has 23 uid, 33 title, 7 page-id fields |
| root (src/*.ts) | 6 | 8 | 0 | 0 | | App.tsx 2+2, contexts.ts 2+1, paths.ts 2, routeMeta.ts 1, useScrollFlashTarget.ts 1, test-helpers.ts 1+2 |

Op-literal construction sites (where a uid or page_title is **written** into a generated type, so they break on branding):
- outline/edits.ts 26, history.ts 7, useOutline.ts 5, paste.ts 3, outlineState.ts 2.
- dnd/DndContext.tsx 1, components/UnlinkedSection.tsx 1, replica/localApi/router.ts 1.

Payload-literal construction (replica shim mappers writing generated response types from `string`/`number` rows): localApi/pages.ts (4 page_title sites plus PageMeta, groups, CurrentWorkPage), search.ts (2), tree.ts (2: BlockRefText plus the BlockNode build at buildTree), router.ts (SidebarNavEntry), journal.ts.

### Positional swap shapes

(title, uid) / (pageTitle, uid):
- outline/edits.ts:80 `splitBlock(blocks, pageTitle, uid, cursor, newUid)` (two uids plus a title).
- edits.ts:143 indentSelection(pageTitle, uids); :167 outdentSelection; :191 indentBlock(pageTitle, uid); :227 outdentBlock.
- edits.ts:245 moveBlockUp; :258 moveBlockDown; :276 moveSubtreeUp; :300 moveSubtreeDown.
- edits.ts:367 moveSelection; :399 moveSelectionUp; :404 moveSelectionDown.
- edits.ts:424 `moveBlocksTo(blocks, pageTitle, uids, parentUid, ...)`; :438 deleteSelection; :453 backspaceAtStart.
- edits.ts:490 setCollapsed; :497 setHeading; :503 setViewType.
- outline/paste.ts:107-110 `planOutlinePaste(blocks, pageTitle, uid, selStart, selEnd, text, newUid)`.
- App.tsx:72 / contexts.ts:15 `openInSidebar(title, uid?)`.
- components/BacklinkGroupList.tsx:24 `onNavigate(pageTitle, uid)`.
- components/EditableSidebarPanel.tsx:23 `{title, uid}` (object props, so lower risk).

(uid, uid):
- edits.ts:415 `groupMoveOps(uids, parentUid, ...)`; edits.ts:80 (uid, newUid); outline/tree.ts:297 (…, parentUid) helper.

(localId, targetId):
- replica/reconcile.ts:15 `remapLocalPage(db, localId: number, targetId: number)`. This is the one PageId/PageId swap. Branding doesn't help here (both are PageId); a named-object param would.

(PageId vs SidebarEntryId sharing a signature):
- replica/apply.ts:285 `parkTakenTitles(db, table, incoming: {id:number; title:string}[])` and :301 `assertNoParkedTitles(..., parked: readonly number[])`. Both serve pages and sidebar_entries.

## D. Cross-directory dependencies

Directory import edges (non-test files, `from "./..."` relative imports; count = import statements):
- api ← everyone: components 38, outline 34, sync 21, replica 20, views 11, assistant 4, dnd 3, root 3. Every directory consumes `components["schemas"]` through api/payloads.ts, api/ops.ts, or replica/apply.ts:33-37 (SyncBlock, SyncPage, Snapshot, Changes).
- components → outline 22: EditableBlockTree.tsx:12-21 (edits FocusTarget, handlers, tree `ancestorChain`/`findNode`); BlockInput.tsx:16-25; EditableSidebarPanel.tsx:18-19; UndoRedoKeys.tsx:12.
- views → outline 7: EditablePage.tsx:8-9 (`useOutline(title, ...)`, `selectionDragUids`); PageView.tsx:11-12; Journal.tsx:8-15.
- dnd → outline 4: DndContext.tsx:10-11 (`groupMoveOps` from edits.ts, the `outline/dnd` types).
- outline ↔ sync: outline/useOutline.ts:14-15, outlineSessions.ts:14-15, undoManager.ts:13 import sync. sync/SyncProvider.tsx:14-15 imports outline/outlineSessions and outlineState. This is a **cycle at directory level**.
- outline → replica 6: daily.ts (titleForDate/dateForTitle/MONTHS), sha256, subtreeHash.
- components → replica 3: daily.ts, sha256.
- replica → grammar 3: titles.ts:7 normalizeRefTitle; refs.ts:10 extractRefs; localApi/router.ts:10 UID_TOKEN.
- sync → replica 12 (worker client, queue types).

### Verdict

**Flipping the generated types is all-or-nothing.** Adding `brand(BlockUid)` (and the others) and regenerating changes `BlockNode`, `PagePayload`, `SyncBlock`, `CreateOp`, etc. in api/types.d.ts for every directory at once. There is one types.d.ts, so it can't be staged per directory.

**The break is narrower than the annotation counts suggest.** A brand is a subtype of string/number, so code that only *reads* a branded field into a `uid: string` or `title: string` slot stays green. That covers most of components/views/dnd and the outline readers.

What fails at the flip is every place a plain `string`/`number` is **written into** a generated slot:
1. Op literals with `uid` / `parent_uid` (outline/edits.ts, history.ts, paste.ts, useOutline.ts, outlineState.ts, dnd/DndContext.tsx, components/UnlinkedSection.tsx). Their uid params are `string`, so they must narrow or cast. `page_title` stays raw string on ops, so no change there.
2. Replica shim mappers writing response literals from `string`/`number` row types (localApi/pages.ts, tree.ts, search.ts, journal.ts, router.ts) plus the apply.ts tombstone `Number()` sites. This is self-contained in replica/.
3. `apiDelete("/api/sidebar/{entry_id}")` at SidebarNav.tsx:89-90, once SidebarEntryId is branded.
4. All test literals (section E).

**Recommended order, keeping tsc green at every step:**
- (i) Introduce the web brand types plus mint helpers in api/brands.ts. Nothing breaks.
- (ii) Narrow the replica mappers and grammar/uid mint functions to return brands. Still green, because brands flow into `string` slots.
- (iii) Narrow the outline/edits/history/paste uid params to BlockUid (and update their callers in components/views/dnd, which already get BlockNode-derived values).
- (iv) Flip server `brand()` and regenerate.

Steps (ii)-(iii) can go directory by directory **before** the generated flip. After the flip there is no per-directory option.

The outline↔sync directory cycle and the components/views/dnd → outline/edits.ts edges mean that narrowing edits.ts signatures (step iii) touches components/EditableBlockTree.tsx, dnd/DndContext.tsx and views/EditablePage.tsx in the same change.

Title branding is independent of uid/page-id branding (different fields), so it can be its own flip. Its write sites are the replica mappers (title columns), replica/daily.ts titleForDate, and the EditableSidebarPanel.tsx:34 raw→canonical leak if EditablePage's `title` is narrowed.

## E. Test blast radius

- Test files: 191 total (components 57, outline 30, replica 29, sync 24, root 19, views 11, grammar 7, assistant 6, api 3, dnd 3, help 2).
- **94 test files** contain uid/title literals (`uid: "..."`, `page_title: "..."`, `title: "..."`, `block("...")`, `pagePayload("...")`). By dir: components 30, outline 22, replica 14, sync 9, views 8, root 3, dnd 3, api 2, grammar 2, assistant 1.
  - About 1078 `...uid: "` occurrences and about 338 `page_title: "` occurrences.
- BlockNode literals (`uid:` plus `children: [`): 18 files.
- SyncBlock-like literals (`page_id:` plus `parent_uid:`): 10 files.
- PageMeta/SyncPage-like (`id: N, title:`): 14 files.
- Files referencing Sync*/Snapshot/Changes types: 14.
- Op literals (`op: "create"|...` with uid): 50 files. `page_title: "` literal: 46 files.
- Direct calls to outline uid/title-taking functions with string literals: 7 files (outline/baseTextHash, dnd, edits, outlineState, paste, tree, useOutline.dnd tests).
- The shared helper web/src/test-helpers.ts:66 `block(uid: string, text, over)` is called **748 times in 42 files**. test-helpers.ts:90 `pagePayload(title: string, blocks, over)` is called **123 times**.
  - If these keep `string` params and cast internally, the bulk of BlockNode/PagePayload fixtures stay green with no edits.
  - test-helpers.ts:13 `reserveOutlineEditor(title: string)` is title-keyed.
- Local per-file fixture factories that would each need the same treatment (22 found):
  - replica/apply.test.ts:21 `block(uid, pageId, over): SyncBlock` and :27 `page(id, title)`.
  - replica/applyFkHazards.test.ts:28, :34 (same pair); replica/blockRefs.test.ts:35 `block(uid, over): SyncBlock`.
  - replica/localOps.test.ts:22 `blockRow(uid)`; replica/localApi/tree.test.ts:32 `insertPage(pageId, title)`.
  - components/EditableBlockTree.focus.test.tsx:32 `table(uid): BlockNode`; components/backlinkFilter.test.ts:6 `item(uid, text)`; components/TableOfContents.test.tsx:10 `entry(uid, ...)`.
  - sync/outbox.test.ts:16, sync/memReplica.test.ts:7, sync/opQueue.replica.test.ts:16 `op(uid): BlockOp`.
- Natural homes for `uid("abcdef")` / `pageId(1)` / `title("Foo")` / `canonicalTitle("Foo")` fixture helpers:
  - **web/src/test-helpers.ts**, beside `block` / `pagePayload` / `backlinks`.
  - **web/src/replica/testDb.ts** for replica-only helpers; it currently holds openTestDb/openRawTestDb/fakeCarryFiles/withDamagedFreelist/failingOnce.
  - web/e2e/fixtures.ts is Playwright and probably unaffected.
  - Precedent to reconcile with: brands.ts:19-20 says a test "casts `as Sha256Hex`", and tests currently do inline casts (322 casts across 35 files).
