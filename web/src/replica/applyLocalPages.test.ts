// @vitest-environment node
// Offline-created pages (negative ids) after a feed window. The feed
// reconciles a local page only by title (reconcilePage), so a local page
// the server never made under that title -- it was renamed before the pull,
// or the op that made it was skipped -- would otherwise outlive everything
// that needed it. The window at the journal head drops a local page once
// nothing keeps it: no block on it, no ref to it, no replay-log record of a
// pending batch naming it. Server pages are never dropped, however empty.
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, BlockUid, CanonicalTitle, PageId, SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import { titleForDate } from "./daily";
import type { ReplicaDb } from "./db";
import { getOrCreateLocalPage } from "./localOps";
import { deleteBatch, enqueueBatch, markPoisoned, nextBatch } from "./queue";
import { openTestDb, type TestDb } from "./testDb";
import { ord, uid } from "../test-helpers";

const bid = (s: string): BatchId => s as BatchId;

/** The drain's delete of the batch at the head of the queue, on its ack. */
const ackNext = (db: ReplicaDb): void => {
  const b = nextBatch(db)!;
  deleteBatch(db, b.id, b.batch_id);
};

const block = (rawUid: string, rawPageId: number,
               over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid: rawUid as BlockUid, page_id: rawPageId as PageId, parent_uid: null,
  order_idx: ord(0), text: `text of ${rawUid}`, heading: null,
  view_type: null, collapsed: 0, created_at: 1, updated_at: 1, refs: [],
  ...over,
});

const page = (rawId: number, rawTitle: string) =>
  ({ id: rawId as PageId, title: rawTitle as CanonicalTitle, created_at: 1,
     updated_at: 1 });

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false,
  seq: 10 as SyncSeq,
  pages: [page(1, "Proptest"), page(2, "Second")],
  blocks: [block("uid_b1", 1), block("uid_b2", 1, { order_idx: ord(1) })],
  sidebar: [],
};

const window = (over: Omit<Partial<Changes>, "next_since" | "latest_seq"> &
  { next_since?: number; latest_seq?: number } = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 11, latest_seq: 11,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
} as Changes);

const NOW = new Date(2026, 0, 15, 12).getTime();

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  applySnapshot(t.db, SNAP, NOW);
});

const titles = (): string[] =>
  t.db.select<{ title: string }>("SELECT title FROM pages ORDER BY title")
    .map((r) => r.title);

const enqueue = (ops: BlockOp[], name: string): void => {
  enqueueBatch(t.db, ops, NOW, bid(name));
};

const createOn = (rawUid: string, pageTitle: string): BlockOp =>
  ({ op: "create", uid: uid(rawUid), page_title: pageTitle, parent_uid: null,
     order_idx: ord(0), text: `text of ${rawUid}` });

describe("applyChanges: a local page nothing keeps is dropped", () => {
  test("a create's page renamed on the server before the pull", () => {
    enqueue([createOn("uid_n1", "Fourth")], "b-create");
    expect(titles()).toContain("Fourth");
    ackNext(t.db);

    // the server made Fourth for the create, then another device renamed it
    expect(applyChanges(t.db, window({
      pages: [page(3, "Third")], blocks: [block("uid_n1", 3)],
    }), NOW)).toEqual({ status: "applied", cursor: 11 });

    expect(titles()).toEqual(["Proptest", "Second", "Third"]);
    expect(t.db.select("SELECT uid, page_id FROM blocks WHERE uid = 'uid_n1'"))
      .toEqual([{ uid: "uid_n1", page_id: 3 }]);
  });

  test("a top-level move to a new title, skipped by the server", () => {
    enqueue([{ op: "move", uid: uid("uid_b1"), parent_uid: null,
               order_idx: ord(0), page_title: "Third" }], "b-move");
    expect(titles()).toContain("Third");
    ackNext(t.db);

    // another device deleted the block first; the skipped move made no page
    applyChanges(t.db, window({
      tombstones: [{ kind: "block", entity_id: "uid_b1" }],
    }), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
  });

  // The pending move no longer keeps its page: the window rewinds the move,
  // and its replay skips it on the deleted block, as a first apply would.
  test("a pending move's page goes in the window that deletes its block", () => {
    enqueue([{ op: "move", uid: uid("uid_b1"), parent_uid: null,
               order_idx: ord(0), page_title: "Third" }], "b-move");
    applyChanges(t.db, window({
      tombstones: [{ kind: "block", entity_id: "uid_b1" }],
    }), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
  });

  // The pending link no longer keeps its page: its replay skips the update
  // on the deleted block, so no page is made.
  test("a pending link on a block the window deletes makes no page", () => {
    enqueue([{ op: "update_text", uid: uid("uid_b2"),
               text: "see [[Linked]]" }], "b-link");

    applyChanges(t.db, window({
      tombstones: [{ kind: "block", entity_id: "uid_b2" }],
    }), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
  });

  // The head window rewinds an acked batch's records: by then every journal
  // row of its commit has arrived, so the server made no such block.
  test("an acked create the head window does not ship takes its block and page with it", () => {
    enqueue([createOn("uid_n1", "Fourth")], "b-create");
    ackNext(t.db);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
    expect(t.db.select("SELECT uid FROM blocks WHERE uid = 'uid_n1'")).toEqual([]);
  });

  // Likewise for an acked link: the head window puts the old text back.
  test("an acked link the head window does not ship reverts and its page goes", () => {
    enqueue([{ op: "update_text", uid: uid("uid_b2"),
               text: "see [[Linked]]" }], "b-link");
    ackNext(t.db);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b2'"))
      .toEqual([{ text: "text of uid_b2" }]);
  });

  test("a poisoned batch names nothing: it is not replayed", () => {
    enqueue([{ op: "create_page", page_title: "Draft" }], "b-page");
    const b = nextBatch(t.db)!;
    markPoisoned(t.db, b.id, "rejected", b.batch_id);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
  });
});

describe("applyChanges: a local page something keeps stays", () => {
  test("a pending create_page page with nothing on it survives the head window", () => {
    enqueue([{ op: "create_page", page_title: "Draft" }], "b-page");
    const [before] = t.db.select<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Draft'");

    applyChanges(t.db, window(), NOW);

    expect(t.db.select("SELECT id FROM pages WHERE title = 'Draft'"))
      .toEqual([before]);
  });

  test("a pending create_page of a local page that already exists keeps it", () => {
    getOrCreateLocalPage(t.db, "Draft", NOW); // a read made it, no op behind it
    enqueue([{ op: "create_page", page_title: "Draft" }], "b-page");

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain("Draft");
  });

  test("a pending op names it by a title that canonicalizes to it", () => {
    applySnapshot(t.db, { ...SNAP, plain_space_title_canonicalization: true },
                  NOW);
    enqueue([{ op: "create_page", page_title: "  Draft  " }], "b-page");

    applyChanges(t.db, window({ plain_space_title_canonicalization: true }),
                 NOW);

    expect(titles()).toContain("Draft");
  });

  test("a pending batch's record names it, after the block moved off it", () => {
    enqueue([createOn("uid_n1", "Fourth"),
             { op: "move", uid: uid("uid_n1"), parent_uid: null,
               order_idx: ord(0), page_title: "Proptest" }], "b-made");

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain("Fourth");
  });

  test("a pending batch's recorded refs name it, after its link was removed", () => {
    // a page a read made, linked by a row whose own batch's records are gone
    const linked = getOrCreateLocalPage(t.db, "Linked", NOW);
    t.db.exec("INSERT INTO refs VALUES ('uid_b2', ?, 'link')", [linked]);
    enqueue([{ op: "update_text", uid: uid("uid_b2"), text: "plain" }], "b-unlink");

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain("Linked");
  });

  test("it still has a block", () => {
    const fourth = getOrCreateLocalPage(t.db, "Fourth", NOW);
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_n1', ?, NULL, 0, 'n1')", [fourth]);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain("Fourth");
  });

  test("its block's tombstone waits for the window at the journal head", () => {
    enqueue([{ op: "move", uid: uid("uid_b1"), parent_uid: null,
               order_idx: ord(0), page_title: "Third" }], "b-move");
    ackNext(t.db);

    applyChanges(t.db, window({
      next_since: 11, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "uid_b1" }],
    }), NOW);
    expect(titles()).toContain("Third");

    applyChanges(t.db, window({ next_since: 12, latest_seq: 12 }), NOW);
    expect(titles()).toEqual(["Proptest", "Second"]);
  });

  test("a block links to it", () => {
    const linked = getOrCreateLocalPage(t.db, "Linked", NOW);
    t.db.exec("INSERT INTO refs VALUES ('uid_b2', ?, 'link')", [linked]);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain("Linked");
  });

  test("it is today's daily page, made on read", () => {
    const today = titleForDate(new Date(NOW));
    getOrCreateLocalPage(t.db, today, NOW);

    applyChanges(t.db, window(), NOW);

    expect(titles()).toContain(today);
  });

  test("a server page is never dropped, however empty", () => {
    applyChanges(t.db, window({ pages: [page(5, "Empty")] }), NOW);

    expect(titles()).toEqual(["Empty", "Proptest", "Second"]);
  });
});

describe("applyChanges: a local page an acked batch's frozen record names", () => {
  // B and its child D are made on a new title, then B moves to Proptest. A
  // later batch deletes B (and D). Once both are acked, only their frozen
  // records name Fourth, until the head window rewinds them.
  const strandFourth = (): void => {
    enqueue([
      createOn("uid_n1", "Fourth"),
      { op: "create", uid: uid("uid_n2"), page_title: "Fourth",
        parent_uid: uid("uid_n1"), order_idx: ord(0), text: "child" },
      { op: "move", uid: uid("uid_n1"), parent_uid: null, page_title: "Proptest",
        order_idx: ord(0) },
    ], "b-made");
    enqueue([{ op: "delete", uid: uid("uid_n1") }], "b-delete");
    ackNext(t.db);
    ackNext(t.db);
  };

  test("a local page a frozen record names stays short of the head", () => {
    strandFourth();

    applyChanges(t.db, window({ next_since: 11, latest_seq: 12 }), NOW);

    expect(titles()).toContain("Fourth");
  });

  test("it goes in the head window, which rewinds the record", () => {
    strandFourth();
    applyChanges(t.db, window({ next_since: 11, latest_seq: 12 }), NOW);
    expect(titles()).toContain("Fourth");

    applyChanges(t.db, window({ next_since: 12, latest_seq: 12 }), NOW);

    expect(titles()).toEqual(["Proptest", "Second"]);
    expect(t.db.select("SELECT COUNT(*) AS n FROM replay_log")).toEqual([{ n: 0 }]);
  });
});

describe("applyChanges: dropping stranded local pages waits for the head window", () => {
  test("an acked batch's page survives a window short of the head", () => {
    enqueue([{ op: "create_page", page_title: "Draft" }], "b-page");
    ackNext(t.db);

    applyChanges(t.db, window({ next_since: 11, latest_seq: 12 }), NOW);
    expect(titles()).toContain("Draft");

    applyChanges(t.db, window({ next_since: 12, latest_seq: 12 }), NOW);
    expect(titles()).toEqual(["Proptest", "Second"]);
  });

  test("the server's page for the acked batch replaces it at the head", () => {
    enqueue([{ op: "create_page", page_title: "Draft" }], "b-page");
    ackNext(t.db);

    applyChanges(t.db, window({ next_since: 11, latest_seq: 12 }), NOW);
    applyChanges(t.db, window({
      next_since: 12, latest_seq: 12, pages: [page(7, "Draft")],
    }), NOW);

    expect(t.db.select<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Draft'")).toEqual([{ id: 7 }]);
  });
});
