// The one place a web brand is defined. A server NewType tagged with
// `brand()` reaches src/api/types.d.ts as `Brands.<Name>`, a reference to
// the export of the same name here; a marked name this file doesn't export
// fails tsc, and the fix is to add its definition.
//
// A brand is its base type intersected with a literal `__brand`. A subtype
// brand adds a second key instead of a second `__brand`, because two
// different `__brand` literals intersect to `never`:
//
//   export type RawTitle = string & { readonly __brand: "RawTitle" };
//   export type NormalizedTitle = RawTitle & { readonly __normalized: true };
//   export type CanonicalTitle =
//     NormalizedTitle & { readonly __canonical: true };
//
// A CanonicalTitle then passes wherever a NormalizedTitle is expected, and a
// NormalizedTitle wherever a RawTitle is, and not the reverse.

// A sha256 hex digest, distinct from a plain string so a text can never
// be passed where a hash belongs. Minted only by `sha256Hex` in
// replica/sha256.ts (and its server twin `text_hash`); a test mints one
// with `shaOf` (test-helpers.ts).
export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

// The changes-journal sequence number (server `changes.seq`), distinct
// from a plain number so a local lane seq or resync generation counter
// can never pass as a sync cursor. Crosses HTTP through this brand
// (ChangesPayload.next_since/latest_seq, SnapshotPayload.seq, OpsAck.seq);
// the WS notify frame (sync/socket.ts WsSeq.seq) sits outside OpenAPI and
// is narrowed to this type by hand at the one place that parses it.
export type SyncSeq = number & { readonly __brand: "SyncSeq" };

// The per-tab sync identity (sync/opQueue.ts `clientId`, minted once per
// tab through `newClientId`) and the replay-dedup key an OpBatch shares
// with the pending_ops row it came from (minted through `newBatchId`, both
// in uid.ts, and the server's client/workflows.py `_batch_id`). Both are
// bare uid-shaped strings placed next to each other in one request body
// (OpBatch.client_id/batch_id) -- distinct brands so the two, or a batch id
// and a row id, can never swap at a call site. Crosses HTTP through
// OpBatch; the WS notify frame (sync/socket.ts WsBatch.client_id) sits
// outside OpenAPI and is narrowed to this type by hand at the one place that
// parses it.
export type ClientId = string & { readonly __brand: "ClientId" };
export type BatchId = string & { readonly __brand: "BatchId" };

// A GoodLinks link id: exactly 32 lowercase hex characters, GoodLinks' own
// id shape. Crosses HTTP through GoodlinksLink.id and GoodlinksArticle.id;
// minted on the web only by `goodlinksIdFromHref` (components/goodlinks.ts),
// the one place a parsed href's id is checked against that shape.
export type GoodlinksId = string & { readonly __brand: "GoodlinksId" };

// The embedded assistant's conversation id, minted server-side
// (AssistantService.create) and opaque to the web, which only ever carries
// one around (assistant/useAssistant.ts). Crosses HTTP through
// AssistantConversation.id.
export type ConversationId = string & { readonly __brand: "ConversationId" };
// A pending tool confirmation's id, minted server-side per confirm
// (ClaudeConversation.can_use_tool) -- not the Claude Agent SDK's own
// tool_use id, a different value entirely. Crosses HTTP through the
// confirm_request SSE event and ConfirmRequestBody.confirm_id; the SSE
// event itself sits outside OpenAPI (see assistant/sse.ts) and is narrowed
// to this type by hand at the one place that parses it.
export type ConfirmId = string & { readonly __brand: "ConfirmId" };

// A block's uid, matching server/src/pkm/refs.py's BLOCK_REF_TOKEN shape.
// Minted by `newUid` (uid.ts) and `parseBlockUid` (ids.ts); a test mints
// one with `uidOf` (test-helpers.ts).
export type BlockUid = string & { readonly __brand: "BlockUid" };

// A page's row id. Offline pages mint a negative id (replica/localOps.ts)
// before reconciling with the server's row; the sign carries that meaning,
// not a separate type.
export type PageId = number & { readonly __brand: "PageId" };

// A sidebar entry's row id, distinct from PageId so the two kinds of row
// id can never swap at a call site even though both are plain numbers.
export type SidebarEntryId = number & { readonly __brand: "SidebarEntryId" };

// A title no check has run on: text as typed or received. The root of the
// title hierarchy. `asRawTitle` (replica/titles.ts) is the general mint, as
// `as_raw_title` is on the server; the other sites are in the brand
// registry's MINT_SITES. A test mints one with `rawTitleOf` (test-helpers.ts).
export type RawTitle = string & { readonly __brand: "RawTitle" };

// A RawTitle that has been through normalize_title / normalizeRefTitle:
// every run of TITLE_WHITESPACE folded to one U+0020 and, when that changed
// anything, edge U+0020 stripped; any other title is unchanged. Minted by
// `normalizeRefTitle` and the hashtag token (grammar/scan.ts) and by
// `canonicalizeTitle` (replica/titles.ts), which knows no live flag.
export type NormalizedTitle = RawTitle & { readonly __normalized: true };

// A title as stored in `pages.title` / `sidebar_entries.title`: normalized,
// and additionally canonical under the live plain-space-title flag. A
// CanonicalTitle passes wherever a NormalizedTitle is expected, not the
// reverse. Minted by the row types of every read of a title column, by
// `canonicalTitle`/`titleReader` (replica/meta.ts, which read the flag), by
// `titleReaderFor` (replica/titles.ts, the pure constructor they and the main
// thread's copy of the flag, sync/titleCanonicalization.ts, share) and by
// `titleForDate`/`dailyTitle` (replica/daily.ts, canonical by format).
export type CanonicalTitle = NormalizedTitle & { readonly __canonical: true };

// A block's sparse sibling order key (blocks.order_idx): where it sits
// among its siblings under its parent (or at the page's top level), not a
// dense array position -- a delete leaves a gap rather than renumbering, so
// two siblings' keys are never assumed adjacent. `sidebar_entries.order_idx`
// is `SidebarOrderIdx`, not this brand. Every
// arithmetic site goes through outline/orderIdx.ts; a test mints one with
// `orderIdxOf` (test-helpers.ts).
export type OrderIdx = number & { readonly __brand: "OrderIdx" };

// A sidebar entry's order key (`sidebar_entries.order_idx`): the server
// assigns it and the web reorders by array position, so it never meets block
// order code. Its own brand keeps a block's OrderIdx from standing in for it.
export type SidebarOrderIdx = number & { readonly __brand: "SidebarOrderIdx" };
