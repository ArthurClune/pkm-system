// @vitest-environment node
// Negative-id page reconciliation (offline-editing-design.md §3): when the feed
// delivers the authoritative row for a page created offline, children and refs
// are remapped inside the window transaction — never a cascade delete.
import { beforeEach, describe, expect, test } from "vitest";
import { applyChanges, type Changes } from "./apply";
import { titleForDate } from "./daily";
import { applyLocalOps, getOrCreateLocalPage } from "./localOps";
import { setMeta } from "./meta";
import { deleteBatch, enqueueBatch, nextBatch } from "./queue";
import { remapLocalPage } from "./reconcile";
import { openTestDb, type TestDb } from "./testDb";
import { batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf } from "../test-helpers";

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
    { op: "create", uid: uidOf("uid_l1"), page_title: "Offline Page", parent_uid: null,
      order_idx: orderIdxOf(0), text: "links back to [[AI]]" },
    { op: "create", uid: uidOf("uid_l2"), page_title: "Offline Page", parent_uid: uidOf("uid_l1"),
      order_idx: orderIdxOf(0), text: "a child" },
  ], 50, batchIdOf("t"));
  negId = t.db.select(
    "SELECT id AS page_id FROM pages WHERE title = 'Offline Page'", ["page_id"])[0].page_id;
  expect(negId).toBeLessThan(0);
});

/** The drain's delete of the batch at the head of the queue, on its ack. */
const ackNext = (): void => {
  const b = nextBatch(t.db)!;
  deleteBatch(t.db, b.id, b.batch_id);
};

const feed = (over: Partial<Changes>): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: seqOf(11), latest_seq: seqOf(11),
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

describe("reconcile on feed page delivery", () => {
  test("remaps children and refs to the authoritative id, no cascade", () => {
    // simulate: another block on AI refs the offline page (negative target)
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'see [[Offline Page]]')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);

    applyChanges(t.db, feed({
      pages: [{ id: pageIdOf(7), title: canonicalTitleOf("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    // negative row replaced by the authoritative one
    expect(t.db.select("SELECT id AS page_id FROM pages WHERE title = 'Offline Page'", ["page_id"]))
      .toEqual([{ page_id: 7 }]);
    // local-only blocks (feed hasn't delivered them yet) survived, remapped
    expect(t.db.select(
      "SELECT uid FROM blocks WHERE page_id = 7 ORDER BY uid", ["uid"]))
      .toEqual([{ uid: "uid_l1" }, { uid: "uid_l2" }]);
    // inbound ref follows
    expect(t.db.select(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_a1'", ["target_page_id"]))
      .toEqual([{ target_page_id: 7 }]);
  });

  test("a colliding ref (block already refs the authoritative id) merges", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Placeholder')");
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'refs both')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', 7, 'link')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);
    applyChanges(t.db, feed({
      pages: [{ id: pageIdOf(7), title: canonicalTitleOf("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    expect(t.db.select(
      "SELECT COUNT(*) AS n FROM refs WHERE src_block_uid = 'uid_a1'" +
      " AND target_page_id = 7", ["n"])).toEqual([{ n: 1 }]);
  });

  test("positive-id pages upsert without reconcile side effects", () => {
    applyChanges(t.db, feed({
      pages: [{ id: pageIdOf(1), title: canonicalTitleOf("AI"), created_at: 2, updated_at: 2 }],
    }));
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages WHERE id < 0", ["n"]))
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
      remapLocalPage(t.db, { localId: pageIdOf(negId), targetId: pageIdOf(7) });
      t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Offline Page')");
    });

    expect(t.db.select("SELECT id AS page_id FROM pages WHERE id = ?", ["page_id"], [negId])).toEqual([]);
    expect(t.db.select(
      "SELECT uid FROM blocks WHERE page_id = 7 ORDER BY uid", ["uid"]))
      .toEqual([{ uid: "uid_l1" }, { uid: "uid_l2" }]);
    expect(t.db.select(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_a1'", ["target_page_id"]))
      .toEqual([{ target_page_id: 7 }]);
  });

  test("remapLocalPage moves the log's records and refs onto the target", () => {
    // acked batches: the window's rewind leaves their records frozen
    ackNext();
    // a ref to the local page by hand, so u's record of uid_l2 holds one
    t.db.exec("INSERT INTO refs VALUES ('uid_l2', ?, 'link')", [negId]);
    applyLocalOps(t.db, [{ op: "update_text", uid: uidOf("uid_l2"), text: "edited" }],
                  60, { batchId: batchIdOf("u") });
    t.db.transaction(() => {
      t.db.exec("PRAGMA defer_foreign_keys = ON");
      remapLocalPage(t.db, { localId: pageIdOf(negId), targetId: pageIdOf(7) });
      t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Offline Page')");
    });

    // the page t minted is the server's now, so its record goes; u's
    // pre-images name the server id
    expect(t.db.select(
      "SELECT batch_id, kind AS replay_kind, key AS replay_key, pre_page_id FROM replay_log" +
      " ORDER BY batch_id, kind, key", ["batch_id", "replay_kind", "replay_key", "pre_page_id"]))
      .toEqual([
        { batch_id: "t", replay_kind: "block", replay_key: "uid_l1", pre_page_id: null },
        { batch_id: "t", replay_kind: "block", replay_key: "uid_l2", pre_page_id: null },
        { batch_id: "u", replay_kind: "block", replay_key: "uid_l2", pre_page_id: 7 },
        { batch_id: "u", replay_kind: "page", replay_key: "7", pre_page_id: null },
      ]);
    expect(t.db.select(
      "SELECT l.key AS replay_key, r.target_page_id, r.kind AS ref_kind" +
      " FROM replay_log_refs r JOIN replay_log l ON l.id = r.log_id", ["replay_key", "target_page_id", "ref_kind"]))
      .toEqual([{ replay_key: "uid_l2", target_page_id: 7, ref_kind: "link" }]);
  });

  test("a settled batch's record on a reconciled local page restores onto the server id at the head window", () => {
    ackNext();
    // a row on the local page with no record of its own (its creating
    // batch's records already gone), which a later acked batch moves away
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('tuid-s', ?, NULL, 1, 'kept')", [negId]);
    applyLocalOps(t.db, [{ op: "move", uid: uidOf("tuid-s"), parent_uid: null,
                           order_idx: orderIdxOf(0), page_title: "AI" }],
                  60, { batchId: batchIdOf("u") });

    // the server's page for the title arrives short of the head
    applyChanges(t.db, feed({
      next_since: seqOf(11), latest_seq: seqOf(12),
      pages: [{ id: pageIdOf(7), title: canonicalTitleOf("Offline Page"), created_at: 9, updated_at: 9 }],
    }));
    expect(applyChanges(t.db, feed({ next_since: seqOf(12), latest_seq: seqOf(12) })))
      .toEqual({ status: "applied", cursor: 12 });

    expect(t.db.select("SELECT page_id, parent_uid, order_idx FROM blocks WHERE uid = 'tuid-s'",
      ["page_id", "parent_uid", "order_idx"]))
      .toEqual([{ page_id: 7, parent_uid: null, order_idx: 1 }]);
  });

  test("an acked page record re-keyed onto the page a window ships is dropped", () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    const daily = titleForDate(new Date(now));
    const local = getOrCreateLocalPage(t.db, daily, now); // a read, no record
    enqueueBatch(t.db, [{ op: "create", uid: uidOf("uid_d1"), page_title: daily,
                          parent_uid: null, order_idx: orderIdxOf(0), text: "d" }],
                 now, batchIdOf("d"));
    expect(t.db.introspect("SELECT key FROM replay_log WHERE batch_id = 'd' AND kind = 'page'"))
      .toEqual([{ key: String(local) }]);
    ackNext();
    ackNext();

    // the server's daily page and the block arrive short of the head
    applyChanges(t.db, feed({
      next_since: seqOf(11), latest_seq: seqOf(12),
      pages: [{ id: pageIdOf(8), title: canonicalTitleOf(daily), created_at: 9, updated_at: 99 }],
      blocks: [{ uid: uidOf("uid_d1"), page_id: pageIdOf(8), parent_uid: null,
                 order_idx: orderIdxOf(0), text: "d", heading: null, view_type: null,
                 collapsed: 0, created_at: now, updated_at: now, refs: [] }],
    }), now);
    applyChanges(t.db, feed({ next_since: seqOf(12), latest_seq: seqOf(12) }), now);

    // the server's updated_at stands; the local page's pre-image is not put on
    // it
    expect(t.db.select(
      "SELECT id AS page_id, updated_at FROM pages WHERE id = 8", ["page_id", "updated_at"]))
      .toEqual([{ page_id: 8, updated_at: 99 }]);
  });
});
