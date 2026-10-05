// Test-only helper (coverage-excluded like testDb.ts): fast-check arbitraries
// for a small server state and the pending batches a replica queues over
// it, shared by the rewind and replay properties.
import fc from "fast-check";
import type { BatchId, BlockUid, CanonicalTitle, OrderIdx, PageId,
              SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { Snapshot, SyncBlock, SyncPage } from "./apply";

export type ReplicaState = { pages: SyncPage[]; blocks: SyncBlock[] };
export type DrawnBatch = { batchId: BatchId; ops: BlockOp[] };

// Six characters at least, so a ((uid)) in a text parses as a block ref.
const stateUid = (i: number): BlockUid => `blk00${i}` as BlockUid;
const NEW_UIDS = ["newb00", "newb01", "newb02", "newb03"] as BlockUid[];

const page = (id: number, title: string): SyncPage => ({
  id: id as PageId, title: title as CanonicalTitle, created_at: 1, updated_at: 1,
});

/** One or two server pages (ids 1 and 2) and up to eight blocks as a
 * forest: each block sits at the top of a page or under an earlier block,
 * after its siblings so far. */
export const replicaStateArb: fc.Arbitrary<ReplicaState> = fc.record({
  twoPages: fc.boolean(),
  blocks: fc.array(fc.record({
    parent: fc.nat(), onSecond: fc.boolean(), text: fc.nat({ max: 3 }),
    collapsed: fc.boolean(),
  }), { maxLength: 8 }),
}).map(({ twoPages, blocks }) => {
  const pages = twoPages ? [page(1, "Page One"), page(2, "Page Two")]
                         : [page(1, "Page One")];
  const out: SyncBlock[] = [];
  blocks.forEach((drawn, i) => {
    const choice = drawn.parent % (i + 1);
    const parent = choice < i ? out[choice] : null;
    const pageId = parent?.page_id
      ?? (drawn.onSecond && twoPages ? 2 : 1) as PageId;
    const parentUid = parent?.uid ?? null;
    const siblings = out.filter((b) => b.page_id === pageId
                                    && b.parent_uid === parentUid).length;
    const texts: [string, SyncBlock["refs"]][] = [
      [`plain ${i}`, []],
      ["see [[Page One]]", [{ target_page_id: 1 as PageId, kind: "link" }]],
      [`about ((${stateUid((i + 1) % 8)}))`, []],
      ["", []],
    ];
    const [text, refs] = texts[drawn.text];
    out.push({
      uid: stateUid(i), page_id: pageId, parent_uid: parentUid,
      order_idx: siblings as OrderIdx, text, refs,
      heading: drawn.text === 3 ? 2 : null,
      view_type: drawn.text === 2 ? "numbered" : null,
      collapsed: drawn.collapsed ? 1 : 0, created_at: 1, updated_at: 1 + i,
    });
  });
  return { pages, blocks: out };
});

const OP_TEXTS = ["typed", "see [[Page Two]]", "new [[Fresh Page]] [[Page One]]",
                  `about ((${stateUid(1)}))`, ""];

/** One to three batches of one to four ops over the state's uids and new
 * ones: creates, moves with and without a page_title (one names no page),
 * text and field edits, deletes and create_page. */
export const batchesArb = (state: ReplicaState): fc.Arbitrary<DrawnBatch[]> => {
  const anyUid = fc.constantFrom(...state.blocks.map((b) => b.uid), ...NEW_UIDS);
  const parentUid = fc.option(anyUid, { nil: null });
  const orderIdx = fc.integer({ min: 0, max: 3 }).map((n) => n as OrderIdx);
  const text = fc.constantFrom(...OP_TEXTS);
  const op: fc.Arbitrary<BlockOp> = fc.oneof(
    fc.record({ uid: fc.constantFrom(...NEW_UIDS), parent_uid: parentUid,
                order_idx: orderIdx, text,
                page_title: fc.constantFrom("Page One", "Page Two", "Fresh Page") })
      .map((o): BlockOp => ({ op: "create", ...o })),
    fc.record({ uid: anyUid, parent_uid: parentUid, order_idx: orderIdx,
                title: fc.constantFrom(null, "Page One", "Page Two", "No Such Page") })
      .map(({ title, ...o }): BlockOp => ({
        op: "move", ...o, ...(title !== null ? { page_title: title } : {}),
      })),
    fc.record({ uid: anyUid, text })
      .map((o): BlockOp => ({ op: "update_text", ...o })),
    anyUid.map((uid): BlockOp => ({ op: "delete", uid })),
    fc.record({ uid: anyUid, collapsed: fc.boolean() })
      .map((o): BlockOp => ({ op: "set_collapsed", ...o })),
    fc.record({ uid: anyUid, heading: fc.constantFrom(1 as const, 2 as const, 3 as const, null) })
      .map((o): BlockOp => ({ op: "set_heading", ...o })),
    fc.record({ uid: anyUid,
                view_type: fc.constantFrom("numbered" as const, "document" as const) })
      .map((o): BlockOp => ({ op: "set_view_type", ...o })),
    fc.constantFrom("Page One", "Fresh Page", "Made Page")
      .map((title): BlockOp => ({ op: "create_page", page_title: title })),
  );
  return fc.array(fc.array(op, { minLength: 1, maxLength: 4 }),
                  { minLength: 1, maxLength: 3 })
    .map((batches) => batches.map((ops, i) => ({
      batchId: `batch${i}` as BatchId, ops,
    })));
};

export const snapshotOf = (state: ReplicaState, seq: number): Snapshot => ({
  generation: "gen-1", plain_space_title_canonicalization: false,
  seq: seq as SyncSeq, pages: state.pages, blocks: state.blocks, sidebar: [],
});
