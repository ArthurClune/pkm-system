// @vitest-environment node
// Negative-id page reconciliation (spec section 3): when the feed delivers
// the authoritative row for a page created offline, children and refs are
// remapped inside the window transaction — never a cascade delete.
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, SyncSeq } from "../api/brands";
import { applyChanges, type Changes } from "./apply";
import { titleForDate } from "./daily";
import { applyLocalOps, getOrCreateLocalPage } from "./localOps";
import { setMeta } from "./meta";
import { deleteBatch, enqueueBatch, nextBatch } from "./queue";
import { remapLocalPage } from "./reconcile";
import { openTestDb, type TestDb } from "./testDb";
import { ord, pageId, title, uid } from "../test-helpers";

let t: TestDb;
let negId: number;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  setMeta(t.db, "generation", "gen-1");
  setMeta(t.db, "cursor", "10");
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
  // offline, still pending: create a page implicitly (via a link) and
  // explicitly add a block
  enqueueBatch(t.db, [
    { op: "create", uid: uid("uid_l1"), page_title: "Offline Page", parent_uid: null,
      order_idx: ord(0), text: "links back to [[AI]]" },
    { op: "create", uid: uid("uid_l2"), page_title: "Offline Page", parent_uid: uid("uid_l1"),
      order_idx: ord(0), text: "a child" },
  ], 50, "t" as BatchId);
  negId = t.db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = 'Offline Page'")[0].id;
  expect(negId).toBeLessThan(0);
});

/** The drain's delete of the batch at the head of the queue, on its ack. */
const ackNext = (): void => {
  const b = nextBatch(t.db)!;
  deleteBatch(t.db, b.id, b.batch_id);
};

const feed = (over: Partial<Changes>): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

describe("reconcile on feed page delivery", () => {
  test("remaps children and refs to the authoritative id, no cascade", () => {
    // simulate: another block on AI refs the offline page (negative target)
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'see [[Offline Page]]')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);

    applyChanges(t.db, feed({
      pages: [{ id: pageId(7), title: title("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    // negative row replaced by the authoritative one
    expect(t.db.select("SELECT id FROM pages WHERE title = 'Offline Page'"))
      .toEqual([{ id: 7 }]);
    // local-only blocks (feed hasn't delivered them yet) survived, remapped
    expect(t.db.select(
      "SELECT uid FROM blocks WHERE page_id = 7 ORDER BY uid"))
      .toEqual([{ uid: "uid_l1" }, { uid: "uid_l2" }]);
    // inbound ref follows
    expect(t.db.select(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_a1'"))
      .toEqual([{ target_page_id: 7 }]);
  });

  test("a colliding ref (block already refs the authoritative id) merges", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Placeholder')");
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'refs both')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', 7, 'link')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);
    applyChanges(t.db, feed({
      pages: [{ id: pageId(7), title: title("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    expect(t.db.select(
      "SELECT COUNT(*) AS n FROM refs WHERE src_block_uid = 'uid_a1'" +
      " AND target_page_id = 7")).toEqual([{ n: 1 }]);
  });

  test("positive-id pages upsert without reconcile side effects", () => {
    applyChanges(t.db, feed({
      pages: [{ id: pageId(1), title: title("AI"), created_at: 2, updated_at: 2 }],
    }));
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages WHERE id < 0"))
      .toEqual([{ n: 1 }]); // untouched offline page still negative
  });

  test("remapLocalPage moves a negative PageId's blocks and refs to the target, then drops it", () => {
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'see [[Offline Page]]')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);

    // remapLocalPage runs inside the caller's deferred-FK window transaction
    // (applyWindow/applySnapshot); a direct call needs the same deferral,
    // since it moves rows onto the target id before that row exists.
    t.db.transaction(() => {
      t.db.exec("PRAGMA defer_foreign_keys = ON");
      remapLocalPage(t.db, { localId: pageId(negId), targetId: pageId(7) });
      t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Offline Page')");
    });

    expect(t.db.select("SELECT id FROM pages WHERE id = ?", [negId])).toEqual([]);
    expect(t.db.select(
      "SELECT uid FROM blocks WHERE page_id = 7 ORDER BY uid"))
      .toEqual([{ uid: "uid_l1" }, { uid: "uid_l2" }]);
    expect(t.db.select(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_a1'"))
      .toEqual([{ target_page_id: 7 }]);
  });

  test("remapLocalPage moves the log's records and refs onto the target", () => {
    // acked batches: the window's rewind leaves their records frozen
    ackNext();
    applyLocalOps(t.db, [{ op: "update_text", uid: uid("uid_l2"), text: "edited" }],
                  60, { batchId: "u" as BatchId });
    t.db.transaction(() => {
      t.db.exec("PRAGMA defer_foreign_keys = ON");
      remapLocalPage(t.db, { localId: pageId(negId), targetId: pageId(7) });
      t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Offline Page')");
    });

    // the page t minted is the server's now, so its record goes; u's
    // pre-images name the server id
    expect(t.db.select(
      "SELECT batch_id, kind, key, pre_page_id FROM replay_log" +
      " ORDER BY batch_id, kind, key"))
      .toEqual([
        { batch_id: "t", kind: "block", key: "uid_l1", pre_page_id: null },
        { batch_id: "t", kind: "block", key: "uid_l2", pre_page_id: null },
        { batch_id: "u", kind: "block", key: "uid_l2", pre_page_id: 7 },
        { batch_id: "u", kind: "page", key: "7", pre_page_id: null },
      ]);
  });

  test("a settled batch's record on a reconciled local page restores onto the server id at the head window", () => {
    ackNext();
    // a row on the local page with no record of its own (its creating
    // batch's records already gone), which a later acked batch moves away
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_s', ?, NULL, 1, 'kept')", [negId]);
    applyLocalOps(t.db, [{ op: "move", uid: uid("uid_s"), parent_uid: null,
                           order_idx: ord(0), page_title: "AI" }],
                  60, { batchId: "u" as BatchId });

    // the server's page for the title arrives short of the head
    applyChanges(t.db, feed({
      next_since: 11 as SyncSeq, latest_seq: 12 as SyncSeq,
      pages: [{ id: pageId(7), title: title("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    expect(applyChanges(t.db, feed({ next_since: 12 as SyncSeq, latest_seq: 12 as SyncSeq })))
      .toEqual({ status: "applied", cursor: 12 });

    expect(t.db.select("SELECT page_id, parent_uid, order_idx FROM blocks WHERE uid = 'uid_s'"))
      .toEqual([{ page_id: 7, parent_uid: null, order_idx: 1 }]);
  });

  test("an acked page record re-keyed onto the page a window ships is dropped", () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    const daily = titleForDate(new Date(now));
    const local = getOrCreateLocalPage(t.db, daily, now); // a read, no record
    enqueueBatch(t.db, [{ op: "create", uid: uid("uid_d1"), page_title: daily,
                          parent_uid: null, order_idx: ord(0), text: "d" }],
                 now, "d" as BatchId);
    expect(t.db.select("SELECT key FROM replay_log WHERE batch_id = 'd' AND kind = 'page'"))
      .toEqual([{ key: String(local) }]);
    ackNext();
    ackNext();

    // the server's daily page and the block arrive short of the head
    applyChanges(t.db, feed({
      next_since: 11 as SyncSeq, latest_seq: 12 as SyncSeq,
      pages: [{ id: pageId(8), title: title(daily), created_at: 9, updated_at: 99 }],
      blocks: [{ uid: uid("uid_d1"), page_id: pageId(8), parent_uid: null,
                 order_idx: ord(0), text: "d", heading: null, view_type: null,
                 collapsed: 0, created_at: now, updated_at: now, refs: [] }],
    }), now);
    applyChanges(t.db, feed({ next_since: 12 as SyncSeq, latest_seq: 12 as SyncSeq }), now);

    // the server's updated_at stands; the local page's pre-image is not put on it
    expect(t.db.select("SELECT id, updated_at FROM pages WHERE id = 8"))
      .toEqual([{ id: 8, updated_at: 99 }]);
  });
});
