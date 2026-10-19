// @vitest-environment node
// A feed window rewinds the pending batches, applies the server's rows and
// replays the batches as a first apply. So the replica after a window equals
// a fresh replica that bootstraps from the window's resulting server state
// and enqueues the same batches at the same time.
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BatchId, BlockUid } from "../api/brands";
import type { BlockOp, MoveOp } from "../api/ops";
import { applyChanges, applySnapshot, type Changes, type SyncBlock,
         type SyncTombstone } from "./apply";
import type { ReplicaDb } from "./db";
import { deleteBatch, enqueueBatch, markPoisoned, nextBatch } from "./queue";
import { batchesArb, type DrawnBatch, replicaStateArb, type ReplicaState,
         snapshotOf } from "./replayArbs";
import { openTestDb, type TestDb } from "./testDb";
import { batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf, rawTitleOf } from "../test-helpers";

const NOW = 500;
const bid = (s: string): BatchId => batchIdOf(s);
const u = (s: string): BlockUid => uidOf(s);

const page = (id: number, title: string) => ({
  id: pageIdOf(id), title: canonicalTitleOf(title), created_at: 1, updated_at: 1,
});
const block = (rawUid: string, over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid: u(rawUid), page_id: pageIdOf(1), parent_uid: null, order_idx: orderIdxOf(0),
  text: rawUid, heading: null, view_type: null, collapsed: 0, created_at: 1,
  updated_at: 1, refs: [], ...over,
});
const at = (order: number): Partial<SyncBlock> => ({ order_idx: orderIdxOf(order) });
const create = (rawUid: string, order: number,
                parent: string | null = null): BlockOp => ({
  op: "create", uid: u(rawUid), page_title: rawTitleOf("Page One"), parent_uid: parent ? u(parent) : null,
  order_idx: orderIdxOf(order), text: rawUid,
});
const move = (rawUid: string, order: number, over: Partial<MoveOp> = {}): BlockOp => ({
  op: "move", uid: u(rawUid), parent_uid: null, order_idx: orderIdxOf(order), ...over,
});
const batch = (id: string, ...ops: BlockOp[]): DrawnBatch => ({ batchId: bid(id), ops });

/** A window that ships every page and block of `server`, plus `tombstones`. */
const window = (server: ReplicaState, rawSeq: number,
                { tombstones = [], latest = rawSeq }:
                  { tombstones?: SyncTombstone[]; latest?: number } = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: seqOf(rawSeq), latest_seq: seqOf(latest), pages: server.pages,
  blocks: server.blocks, sidebar: [], tombstones,
});
const headWindow = (server: ReplicaState, rawSeq: number,
                    tombstones: SyncTombstone[] = []): Changes =>
  window(server, rawSeq, { tombstones });
const blockTomb = (rawUid: string): SyncTombstone => ({ kind: "block", entity_id: rawUid });

/** Pages by title and blocks with their page's title, so local page ids
 * minted in another order still compare equal. */
const dump = (db: ReplicaDb) => ({
  pages: db.select("SELECT title, created_at, updated_at FROM pages ORDER BY title",
    ["title", "created_at", "updated_at"]),
  blocks: db.select(
    "SELECT b.uid, p.title AS page_title, b.parent_uid, b.order_idx, b.text, b.heading," +
    " b.collapsed, b.created_at, b.updated_at, b.view_type" +
    " FROM blocks b JOIN pages p ON p.id = b.page_id ORDER BY b.uid",
      ["uid", "page_title", "parent_uid", "order_idx", "text", "heading", "collapsed", "created_at", "updated_at",
       "view_type"]),
  refs: db.select(
    "SELECT r.src_block_uid, p.title, r.kind AS ref_kind FROM refs r" +
    " JOIN pages p ON p.id = r.target_page_id ORDER BY 1, 2, 3", ["src_block_uid", "title", "ref_kind"]),
  blockRefs: db.select(
    "SELECT src_block_uid, target_block_uid FROM block_refs ORDER BY 1, 2", ["src_block_uid", "target_block_uid"]),
});

/** Every column, local page ids and the log included. */
const exactDump = (db: ReplicaDb) => ({
  pages: db.select("SELECT id AS page_id, title, created_at, updated_at FROM pages ORDER BY id",
    ["page_id", "title", "created_at", "updated_at"]),
  blocks: db.select(
    "SELECT uid, page_id, parent_uid, order_idx, text, heading, collapsed," +
    " created_at, updated_at, view_type FROM blocks ORDER BY uid",
      ["uid", "page_id", "parent_uid", "order_idx", "text", "heading", "collapsed", "created_at", "updated_at",
       "view_type"]),
  refs: db.select(
    "SELECT src_block_uid, target_page_id, kind AS ref_kind FROM refs ORDER BY 1, 2, 3",
      ["src_block_uid", "target_page_id", "ref_kind"]),
  blockRefs: db.select(
    "SELECT src_block_uid, target_block_uid FROM block_refs ORDER BY 1, 2", ["src_block_uid", "target_block_uid"]),
  log: db.select(
    "SELECT batch_id, kind AS replay_kind, key AS replay_key, pre_json, pre_page_id FROM replay_log" +
    " ORDER BY batch_id, kind, key", ["batch_id", "replay_kind", "replay_key", "pre_json", "pre_page_id"]),
  logRefs: db.select(
    "SELECT l.batch_id, l.key AS replay_key, r.target_page_id, r.kind AS ref_kind FROM replay_log_refs r" +
    " JOIN replay_log l ON l.id = r.log_id ORDER BY 1, 2, 3, 4",
      ["batch_id", "replay_key", "target_page_id", "ref_kind"]),
  batches: db.select("SELECT batch_id, enqueued_ms FROM replay_batches ORDER BY 1", ["batch_id", "enqueued_ms"]),
  meta: db.introspect("SELECT key, value FROM sync_client_meta ORDER BY key"),
});

const opened: TestDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const t of opened.splice(0)) t.close();
});

const replicaOf = async (server: ReplicaState,
                         batches: readonly DrawnBatch[]): Promise<ReplicaDb> => {
  const t = await openTestDb();
  opened.push(t);
  applySnapshot(t.db, snapshotOf(server, 10), 1);
  for (const b of batches) enqueueBatch(t.db, b.ops, NOW, b.batchId);
  return t.db;
};

/** What a first apply of `batches` over `server` gives. */
const firstApply = async (server: ReplicaState,
                          batches: readonly DrawnBatch[]) =>
  dump(await replicaOf(server, batches));

const order = (db: ReplicaDb, parent: string | null = null): string[] =>
  (db.select(
    "SELECT uid FROM blocks WHERE page_id = 1 AND parent_uid IS ?" +
    " ORDER BY order_idx, uid", ["uid"], [parent])).map((r) => r.uid);

describe("a window replays pending batches as a first apply", () => {
  test("order: create X at 0 then move it to 1, over a window that ships another device's Y at 0", async () => {
    const before = { pages: [page(1, "Page One")], blocks: [block("tuid-a")] };
    const after = { pages: before.pages, blocks: [block("tuid-y"), block("tuid-a", at(1))] };
    const batches = [batch("b1", create("tuid-x", 0), move("tuid-x", 1))];
    const db = await replicaOf(before, batches);

    expect(applyChanges(db, headWindow(after, 11), NOW + 100))
      .toEqual({ status: "applied", cursor: 11 });

    expect(order(db)).toEqual(["tuid-x", "tuid-y", "tuid-a"]);
    expect(dump(db)).toEqual(await firstApply(after, batches));
  });

  test("phantom create: create C under P then move C to the top, over a window that deletes P", async () => {
    const before = { pages: [page(1, "Page One")], blocks: [block("tuid-p"), block("tuid-q", at(1))] };
    const after = { pages: before.pages, blocks: [block("tuid-q", at(1))] };
    const batches = [batch("b1", create("tuid-c", 0, "tuid-p"), move("tuid-c", 0))];
    const db = await replicaOf(before, batches);

    applyChanges(db, headWindow(after, 11, [blockTomb("tuid-p")]), NOW + 100);

    expect(db.select("SELECT uid FROM blocks ORDER BY uid", ["uid"])).toEqual([{ uid: "tuid-q" }]);
    expect(dump(db)).toEqual(await firstApply(after, batches));
  });

  test("phantom page: a move of B to the top of a title no page holds, over a window that deletes B", async () => {
    const before = { pages: [page(1, "Page One")], blocks: [block("tuid-b"), block("tuid-a", at(1))] };
    const after = { pages: before.pages, blocks: [block("tuid-a", at(1))] };
    const batches = [batch("b1", move("tuid-b", 0, { page_title: rawTitleOf("Ops Four") }))];
    const db = await replicaOf(before, batches);
    expect(db.select("SELECT title FROM pages WHERE id < 0", ["title"]))
      .toEqual([{ title: "Ops Four" }]);

    applyChanges(db, headWindow(after, 11, [blockTomb("tuid-b")]), NOW + 100);

    expect(db.select("SELECT title FROM pages ORDER BY title", ["title"]))
      .toEqual([{ title: "Page One" }]);
    expect(dump(db)).toEqual(await firstApply(after, batches));
  });

  test("a batch moving one block twice, over two windows that lack it", async () => {
    const before = { pages: [page(1, "Page One")],
                     blocks: [block("tuid-a"), block("tuid-s", at(1)), block("tuid-b", at(2))] };
    const batches = [batch("b1", move("tuid-s", 0), move("tuid-s", 1))];
    const db = await replicaOf(before, batches);
    const orderIdx = () => db.select(
      "SELECT uid, order_idx FROM blocks WHERE page_id = 1 ORDER BY uid", ["uid", "order_idx"]);
    const enqueued = orderIdx();
    // each window ships only another device's new block on another page
    const z1 = block("tuid-z1", { page_id: pageIdOf(2) });
    const z2 = block("tuid-z2", { page_id: pageIdOf(2), order_idx: orderIdxOf(1) });
    const afterOne = { pages: [...before.pages, page(2, "Page Two")],
                       blocks: [...before.blocks, z1] };
    const afterTwo = { pages: afterOne.pages, blocks: [...afterOne.blocks, z2] };

    applyChanges(db, window({ pages: [page(2, "Page Two")], blocks: [z1] }, 11,
                            { latest: 12 }), NOW + 100);
    expect(dump(db)).toEqual(await firstApply(afterOne, batches));
    applyChanges(db, headWindow({ pages: [], blocks: [z2] }, 12), NOW + 200);
    expect(dump(db)).toEqual(await firstApply(afterTwo, batches));
    // the siblings keep the slots the first apply gave them
    expect(orderIdx()).toEqual(enqueued);
  });

  test("a page another device edited after the enqueue keeps the server's later updated_at", async () => {
    const before = { pages: [page(1, "Page One")], blocks: [block("tuid-a")] };
    const after = { pages: [{ ...page(1, "Page One"), updated_at: NOW + 50 }],
                    blocks: [block("tuid-y"), block("tuid-a", at(1))] };
    const batches = [batch("b1", { op: "update_text", uid: u("tuid-a"), text: "edited" })];
    const db = await replicaOf(before, batches);

    applyChanges(db, headWindow(after, 11), NOW + 100);

    expect(db.select("SELECT updated_at FROM pages WHERE id = 1", ["updated_at"]))
      .toEqual([{ updated_at: NOW + 50 }]);
    expect(dump(db)).toEqual(await firstApply(after, batches));
  });

  test("an empty head window leaves the database exactly as it was", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fc.assert(fc.asyncProperty(
      replicaStateArb.chain((state) => fc.tuple(fc.constant(state), batchesArb(state))),
      async ([state, batches]) => {
        const db = await replicaOf(state, batches);
        const before = exactDump(db);

        expect(applyChanges(db, headWindow({ pages: [], blocks: [] }, 10), NOW + 1000))
          .toEqual({ status: "applied", cursor: 10 });

        expect(exactDump(db)).toEqual(before);
        for (const t of opened.splice(0)) t.close();
      }), { numRuns: 150 });
    // The generated batches collide on purpose (a create of an existing uid);
    // the engine logs each failed statement, and nothing else may be logged.
    for (const call of warn.mock.calls) {
      expect(call.slice(0, 3)).toEqual(
        ["sqlite3_step() rc=", expect.any(Number), "SQLITE_CONSTRAINT_PRIMARYKEY"]);
    }
  });
});

describe("the log across acks, poison and upgrades", () => {
  test("a server row under a block an acked batch created survives the head window that ships the block", async () => {
    const before = { pages: [page(1, "Page One")], blocks: [block("tuid-a")] };
    const db = await replicaOf(before, [batch("b1", create("tuid-x", 0))]);
    const acked = nextBatch(db)!;
    deleteBatch(db, acked.id, acked.batch_id);

    // another device adds y under x; x's own row arrives at the head
    applyChanges(db, window({ pages: [], blocks: [
      block("tuid-y", { parent_uid: u("tuid-x") }),
    ] }, 11, { latest: 12 }), NOW + 100);
    applyChanges(db, headWindow({ pages: [], blocks: [
      block("tuid-x", { created_at: NOW, updated_at: NOW }), block("tuid-a", at(1)),
    ] }, 12), NOW + 200);

    expect(db.select("SELECT uid, parent_uid, order_idx FROM blocks ORDER BY uid", ["uid", "parent_uid", "order_idx"]))
      .toEqual([{ uid: "tuid-a", parent_uid: null, order_idx: 1 },
                { uid: "tuid-x", parent_uid: null, order_idx: 0 },
                { uid: "tuid-y", parent_uid: "tuid-x", order_idx: 0 }]);
    expect(db.select("SELECT COUNT(*) AS n FROM replay_log", ["n"])).toEqual([{ n: 0 }]);
  });

  test("a poisoned middle batch's effects leave at the next window "
    + "and the later batch's dependent op is skipped alone", async () => {
    const server = { pages: [page(1, "Page One")], blocks: [block("tuid-a"), block("tuid-b", at(1))] };
    const b1 = batch("b1", { op: "update_text", uid: u("tuid-a"), text: "edited a" });
    const b3 = batch("b3", create("tuid-c", 0, "tuid-p2"),
                     { op: "update_text", uid: u("tuid-b"), text: "edited b" });
    const db = await replicaOf(server, [b1, batch("b2", create("tuid-p2", 0)), b3]);
    expect(order(db, "tuid-p2")).toEqual(["tuid-c"]);
    const poisoned = db.select(
      "SELECT id AS pending_row_id FROM pending_ops WHERE batch_id = 'b2'", ["pending_row_id"])[0];
    markPoisoned(db, poisoned.pending_row_id, "rejected", bid("b2"));

    expect(applyChanges(db, window({ pages: [], blocks: [] }, 11, { latest: 12 }),
                        NOW + 100))
      .toEqual({ status: "applied", cursor: 11 });

    expect(db.select("SELECT uid, text FROM blocks ORDER BY uid", ["uid", "text"]))
      .toEqual([{ uid: "tuid-a", text: "edited a" }, { uid: "tuid-b", text: "edited b" }]);
    expect(dump(db)).toEqual(await firstApply(server, [b1, b3]));
  });

  test("a batch with no replay_batches row keeps the stamps of its first replay", async () => {
    const server = { pages: [page(1, "Page One")], blocks: [block("tuid-a")] };
    const db = await replicaOf(server, [batch("b1", create("tuid-x", 0),
      { op: "update_text", uid: u("tuid-a"), text: "edited" })]);
    // queued before the log existed, or imported by a rebuild
    db.exec("DELETE FROM replay_batches");
    const stamps = () => db.select(
      "SELECT uid, created_at, updated_at FROM blocks ORDER BY uid", ["uid", "created_at", "updated_at"]);

    applyChanges(db, headWindow({ pages: [], blocks: [] }, 10), 600);
    expect(stamps()).toEqual([{ uid: "tuid-a", created_at: 1, updated_at: 600 },
                              { uid: "tuid-x", created_at: 600, updated_at: 600 }]);
    applyChanges(db, headWindow({ pages: [], blocks: [] }, 10), 700);
    expect(stamps()).toEqual([{ uid: "tuid-a", created_at: 1, updated_at: 600 },
                              { uid: "tuid-x", created_at: 600, updated_at: 600 }]);
    expect(db.select("SELECT batch_id, enqueued_ms FROM replay_batches", ["batch_id", "enqueued_ms"]))
      .toEqual([{ batch_id: "b1", enqueued_ms: 600 }]);
  });
});
