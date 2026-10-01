// The one place a web brand is defined. A server NewType tagged with
// `brand()` reaches src/api/types.d.ts as `Brands.<Name>`, a reference to
// the export of the same name here; a marked name this file doesn't export
// fails tsc, and the fix is to add its definition.
//
// A brand is its base type intersected with a literal `__brand`. A subtype
// brand adds a second key instead of a second `__brand`, because two
// different `__brand` literals intersect to `never`:
//
//   export type NormalizedTitle = string & { readonly __brand: "NormalizedTitle" };
//   export type CanonicalTitle = NormalizedTitle & { readonly __canonical: true };
//
// A CanonicalTitle then passes wherever a NormalizedTitle is expected, and
// not the reverse.

// A sha256 hex digest, distinct from a plain string so a text can never
// be passed where a hash belongs. Minted only by `sha256Hex` in
// replica/sha256.ts (and its server twin `text_hash`); a test literal
// standing in for a hash casts `as Sha256Hex`.
export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

// The changes-journal sequence number (server `changes.seq`), distinct
// from a plain number so a local lane seq or resync generation counter
// can never pass as a sync cursor. Crosses HTTP through this brand
// (ChangesPayload.next_since/latest_seq, SnapshotPayload.seq, OpsAck.seq);
// the WS notify frame (sync/socket.ts WsSeq.seq) sits outside OpenAPI and
// is narrowed to this type by hand at the one place that parses it.
export type SyncSeq = number & { readonly __brand: "SyncSeq" };

// The per-tab sync identity (sync/opQueue.ts `clientId`, minted once per
// tab with newUid()) and the replay-dedup key an OpBatch shares with the
// pending_ops row it came from (minted at sync/opQueue.ts,
// replica/workerHandlers.ts's newBatchId, and the server's
// client/workflows.py `_batch_id`). Both are bare uid-shaped strings placed
// next to each other in one request body (OpBatch.client_id/batch_id) --
// distinct brands so the two, or a batch id and a row id, can never swap at
// a call site. Crosses HTTP through OpBatch; the WS notify frame
// (sync/socket.ts WsBatch.client_id) sits outside OpenAPI and is narrowed to
// this type by hand at the one place that parses it.
export type ClientId = string & { readonly __brand: "ClientId" };
export type BatchId = string & { readonly __brand: "BatchId" };

// A GoodLinks link id: exactly 32 lowercase hex characters, GoodLinks' own
// id shape. Crosses HTTP through GoodlinksLink.id and GoodlinksArticle.id;
// minted on the web only by `goodlinksIdFromHref` (components/goodlinks.ts),
// the one place a parsed href's id is checked against that shape.
export type GoodlinksId = string & { readonly __brand: "GoodlinksId" };
