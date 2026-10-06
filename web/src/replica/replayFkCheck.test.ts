// @vitest-environment node
// The replay's targeted FK pre-check (targetedFkHit) stands in for a
// whole-database foreign_key_check diff around each batch. This pins its one
// claim: when it reports no hit, the batch added no violation key. States
// include dangling baselines, FKs on (deferred) and off, NULL and
// comma-bearing uids, and a batch id shared with earlier records.
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { targetedFkHit } from "./apply";
import type { ReplicaDb, SqlValue } from "./db";
import { applyLocalOps } from "./localOps";
import { openTestDb, type TestDb } from "./testDb";

const fkKeys = (db: ReplicaDb): Set<string> =>
  new Set(db.select<{ table: string; rowid: SqlValue; parent: string; fkid: number }>(
    "PRAGMA foreign_key_check")
    .map((v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid])));

class Undo extends Error {}
/** Run inside the wrapper's transaction (so applyLocalOps joins it), then roll back. */
const inTxn = (db: ReplicaDb, fn: () => void): void => {
  try { db.transaction(() => { fn(); throw new Undo(); }); }
  catch (e) { if (!(e instanceof Undo)) throw e; }
};

/** The replay's first pass: each op under its own savepoint, a throw rolls it back. */
const replay = (db: ReplicaDb, ops: BlockOp[], batchId: string): void => {
  for (const op of ops) {
    db.exec("SAVEPOINT replay_op");
    try {
      applyLocalOps(db, [op], 5, { batchId: batchId as BatchId });
    } catch {
      db.exec("ROLLBACK TO replay_op");
    }
    db.exec("RELEASE replay_op");
  }
};

const UIDS = ["u_aaaaa1", "u_aaaaa2", "u_aaaaa3", "u_aaaaa4", "u_aaaaa5",
              "u_aaaaa6", "u_aaaaa7", "x,u_aaaaa2", "u_aaaaa3,y"];
const TITLES = ["A", "B", "C", "D", "E"];

const uidArb = fc.oneof(
  { weight: 19, arbitrary: fc.constantFrom(...UIDS) },
  { weight: 1, arbitrary: fc.constant(null) });
const parentArb = fc.oneof(fc.constant(null), fc.constantFrom(...UIDS, "u_gone01"));
const textArb = fc.constantFrom("plain", "see [[A]]", "[[D]] and ((u_aaaaa1))",
                                "#B ((u_aaaaa3))", "[[C]]", "[[E]]");
const orderArb = fc.integer({ min: 0, max: 2 });
const titleArb = fc.constantFrom(...TITLES);

const opArb: fc.Arbitrary<BlockOp> = fc.oneof(
  fc.record({ op: fc.constant("create"), uid: uidArb, page_title: titleArb,
              parent_uid: parentArb, order_idx: orderArb, text: textArb }),
  fc.record({ op: fc.constant("move"), uid: uidArb, parent_uid: parentArb,
              order_idx: orderArb }, { requiredKeys: ["op", "uid", "parent_uid", "order_idx"] }),
  fc.record({ op: fc.constant("move"), uid: uidArb, parent_uid: parentArb,
              page_title: titleArb, order_idx: orderArb }),
  fc.record({ op: fc.constant("delete"), uid: uidArb }),
  fc.record({ op: fc.constant("update_text"), uid: uidArb, text: textArb }),
  fc.record({ op: fc.constant("create_page"), page_title: titleArb }),
  fc.record({ op: fc.constant("set_collapsed"), uid: uidArb, collapsed: fc.boolean() }),
) as unknown as fc.Arbitrary<BlockOp>;

const baseBlockArb = fc.record({
  uid: fc.constantFrom(...UIDS),
  page: fc.constantFrom(1, 2, 3, 4, 9),
  parent: fc.option(fc.constantFrom(...UIDS, "u_gone01"), { nil: null }),
  order: orderArb,
  ref: fc.option(fc.constantFrom(1, 2, 3, 9), { nil: null }),
  bref: fc.option(fc.constantFrom(...UIDS), { nil: null }),
});

const scenarioArb = fc.record({
  fksOff: fc.boolean(),
  pageD: fc.boolean(),
  dangling: fc.boolean(),
  blocks: fc.array(baseBlockArb, { maxLength: 8 }),
  ghost: fc.boolean(),
  prior: fc.array(opArb, { maxLength: 3 }),
  priorShared: fc.array(opArb, { maxLength: 1 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 4 }),
});

let t: TestDb;
beforeAll(async () => { t = await openTestDb(); });
afterAll(() => t.close());
afterEach(() => { vi.restoreAllMocks(); });

describe("targetedFkHit is a sound pre-check for the whole-database comparison", () => {
  test("no hit implies the batch added no foreign_key_check key", () => {
    // the engine logs every constraint failure the random ops provoke
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = t.db;
    fc.assert(fc.property(scenarioArb, (s) => {
      if (s.fksOff) db.exec("PRAGMA foreign_keys=OFF");
      try {
        inTxn(db, () => {
          db.exec("PRAGMA defer_foreign_keys = ON");
          db.exec("INSERT INTO pages(id,title) VALUES (1,'A'),(2,'B'),(3,'C')");
          if (s.pageD) db.exec("INSERT INTO pages(id,title) VALUES (4,'D')");
          const seen = new Set<string>();
          for (const b of s.blocks) {
            if (seen.has(b.uid)) continue;
            seen.add(b.uid);
            // a dangling baseline is a window the feed itself left incomplete
            const page = !s.dangling && b.page === 9 ? 1 : b.page;
            const parent = !s.dangling && b.parent === "u_gone01" ? null : b.parent;
            db.exec("INSERT INTO blocks(uid,page_id,parent_uid,order_idx,text) VALUES (?,?,?,?,'t')",
                    [b.uid, page, parent, b.order]);
            if (b.ref !== null) db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,'link')", [b.uid, b.ref]);
            if (b.bref !== null) db.exec("INSERT OR IGNORE INTO block_refs VALUES (?,?)", [b.uid, b.bref]);
          }
          if (s.ghost && s.dangling) {
            db.exec("INSERT OR IGNORE INTO refs VALUES ('u_ghost1',1,'tag')");
            db.exec("INSERT OR IGNORE INTO block_refs VALUES ('u_ghost1','x')");
          }
          replay(db, s.prior, "b0");
          replay(db, s.priorShared, "b1");
          const before = fkKeys(db);
          db.exec("SAVEPOINT replay_batch");
          replay(db, s.ops, "b1");
          const after = fkKeys(db);
          if (!targetedFkHit(db, "b1" as BatchId)) {
            const added = [...after].filter((k) => !before.has(k));
            expect(added).toEqual([]);
          }
        });
      } finally {
        if (s.fksOff) db.exec("PRAGMA foreign_keys=ON");
      }
    }), { numRuns: 3000 });
  });
});
