// @vitest-environment node
// The replay's targeted FK pre-check (targetedFkHit) stands in for a
// whole-database foreign_key_check diff around each batch. This pins its one
// claim: when it reports no hit, the batch added no violation key. States
// include dangling baselines, FKs on (deferred) and off, NULL and
// comma-bearing uids, and a batch id shared with earlier records.
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { BlockUid } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { targetedFkHit } from "./apply";
import type { ReplicaDb, SqlValue } from "./db";
import { applyLocalOps } from "./localOps";
import { openTestDb, type TestDb } from "./testDb";
import { batchIdOf, malformedUid, orderIdxOf, uidOf } from "../test-helpers";

const fkKeys = (db: ReplicaDb): Set<string> =>
  new Set((db.introspect(
    "PRAGMA foreign_key_check") as { table: string; rowid: SqlValue; parent: string; fkid: number }[])
    .map((v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid])));

class Undo extends Error {}
/** Run inside the wrapper's transaction (so applyLocalOps joins it), then roll
 * back. */
const inTxn = (db: ReplicaDb, fn: () => void): void => {
  try { db.transaction(() => { fn(); throw new Undo(); }); }
  catch (e) { if (!(e instanceof Undo)) throw e; }
};

/** The replay's first pass: each op under its own savepoint, a throw rolls it
 * back. */
const replay = (db: ReplicaDb, ops: BlockOp[], rawBatchId: string): void => {
  for (const op of ops) {
    db.exec("SAVEPOINT replay_op");
    try {
      applyLocalOps(db, [op], 5, { batchId: batchIdOf(rawBatchId) });
    } catch {
      db.exec("ROLLBACK TO replay_op");
    }
    db.exec("RELEASE replay_op");
  }
};

const UIDS = ["u_aaaaa1", "u_aaaaa2", "u_aaaaa3", "u_aaaaa4", "u_aaaaa5",
              "u_aaaaa6", "u_aaaaa7", "x,u_aaaaa2", "u_aaaaa3,y"];
const TITLES = ["A", "B", "C", "D", "E"];

// A comma is outside the BlockUid shape: those uids are forged on purpose.
const mintUid = (raw: string): BlockUid =>
  raw.includes(",") ? malformedUid(raw) : uidOf(raw);

const uidArb = fc.constantFrom(...UIDS).map(mintUid);
const parentArb = fc.oneof(
  fc.constant(null), fc.constantFrom(...UIDS, "u_gone01").map(mintUid));
const textArb = fc.constantFrom("plain", "see [[A]]", "[[D]] and ((u_aaaaa1))",
                                "#B ((u_aaaaa3))", "[[C]]", "[[E]]");
const orderArb = fc.integer({ min: 0, max: 2 }).map(orderIdxOf);
const titleArb = fc.constantFrom(...TITLES);

const shapedOpArb: fc.Arbitrary<BlockOp> = fc.oneof(
  fc.record({ op: fc.constant("create" as const), uid: uidArb, page_title: titleArb,
              parent_uid: parentArb, order_idx: orderArb, text: textArb }),
  fc.record({ op: fc.constant("move" as const), uid: uidArb, parent_uid: parentArb,
              order_idx: orderArb }, { requiredKeys: ["op", "uid", "parent_uid", "order_idx"] }),
  fc.record({ op: fc.constant("move" as const), uid: uidArb, parent_uid: parentArb,
              page_title: titleArb, order_idx: orderArb }),
  fc.record({ op: fc.constant("delete" as const), uid: uidArb }),
  fc.record({ op: fc.constant("update_text" as const), uid: uidArb, text: textArb }),
  fc.record({ op: fc.constant("create_page" as const), page_title: titleArb }),
  fc.record({ op: fc.constant("set_collapsed" as const), uid: uidArb, collapsed: fc.boolean() }),
);

// One op in twenty that has a uid carries a NULL one instead: data no wire op
// can hold, which the replay must survive. The op is copied, not mutated, so
// the value fast-check drew (and may shrink from) stays intact.
const opArb: fc.Arbitrary<BlockOp> = fc.tuple(shapedOpArb, fc.nat({ max: 19 })).map(
  ([op, roll]) => (roll === 0 && "uid" in op ? { ...op, uid: malformedUid(null) } : op));

const baseBlockArb = fc.record({
  uid: fc.constantFrom(...UIDS),
  page: fc.constantFrom(1, 2, 3, 4, 9),
  parent: fc.option(fc.constantFrom(...UIDS, "u_gone01"), { nil: null }),
  order: orderArb,
  ref: fc.option(fc.constantFrom(1, 2, 3, 9), { nil: null }),
  bref: fc.option(fc.constantFrom(...UIDS), { nil: null }),
});

type Scenario = {
  fksOff: boolean; pageD: boolean; dangling: boolean;
  blocks: { uid: string; page: number; parent: string | null; order: number;
            ref: number | null; bref: string | null }[];
  ghost: boolean; prior: BlockOp[]; priorShared: BlockOp[]; ops: BlockOp[];
};

const randomScenarioArb: fc.Arbitrary<Scenario> = fc.record({
  fksOff: fc.boolean(),
  pageD: fc.boolean(),
  dangling: fc.boolean(),
  blocks: fc.array(baseBlockArb, { maxLength: 8 }),
  ghost: fc.boolean(),
  prior: fc.array(opArb, { maxLength: 3 }),
  priorShared: fc.array(opArb, { maxLength: 1 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 4 }),
});

// Random draws almost never make a batch add a violation key, so two
// scenario shapes are drawn on purpose, each prepended to a random scenario.
// The first block of a uid wins in the setup, so a prepended block overrides
// a random one, and the batch's first op is the prepended one.

// The case CHILD exists for: FKs are off, so deleting a block leaves behind a
// child that subtreeUids' path match skips, and the child's own uid is never
// recorded, so only the deleted parent's record shows it. The match skips a
// NULL uid (instr over a NULL is NULL) and a child whose uid sits in the
// parent's path, as "u_aaaaa2" does in the path of "x,u_aaaaa2". A NULL-uid
// child needs a create, in this batch or an earlier one; the comma pair is
// plain baseline rows.
const COMMA_PAIRS = [["x,u_aaaaa2", "u_aaaaa2"], ["u_aaaaa3,y", "u_aaaaa3"]];
const childCaseArb = fc.tuple(randomScenarioArb, fc.boolean(), orderArb, orderArb,
                              fc.constantFrom(...COMMA_PAIRS, null))
  .map(([s, earlier, order, childOrder, pair]): Scenario => {
    const parent = pair?.[0] ?? "u_aaaaa5";
    const create: BlockOp = {
      op: "create", uid: malformedUid(null), page_title: "A",
      parent_uid: mintUid(parent), order_idx: childOrder, text: "plain" };
    const drop: BlockOp = { op: "delete", uid: mintUid(parent) };
    const blocks = [{ uid: parent, page: 1, parent: null, order, ref: null,
                      bref: null }, ...s.blocks];
    if (pair) {
      blocks.unshift({ uid: pair[1], page: 1, parent: parent, order: childOrder,
                       ref: null, bref: null });
      return { ...s, fksOff: true, blocks, ops: [drop, ...s.ops] };
    }
    return {
      ...s,
      fksOff: true,
      blocks,
      prior: earlier ? [create, ...s.prior] : s.prior,
      ops: earlier ? [drop, ...s.ops] : [create, drop, ...s.ops],
    };
  });

// The case PAGE exists for: a dangling block on a page with no row (page 9
// never gets one, page 4 only with pageD), then a create beneath it. The new
// block inherits the missing page and takes a fresh rowid, so its violation
// key is new, and only the recorded page shows it. The page's blocks all
// share one order_idx, so a guard that needs order_idx > 0 misses it.
const pageCaseArb = fc.tuple(randomScenarioArb, fc.boolean(), orderArb)
  .map(([s, nine, order]): Scenario => ({
    ...s,
    dangling: true,
    pageD: nine ? s.pageD : false,
    blocks: [{ uid: "u_aaaaa7", page: nine ? 9 : 4, parent: null, order,
               ref: null, bref: null }, ...s.blocks],
    ops: [{ op: "create", uid: uidOf("u_aaaaa6"), page_title: "A",
            parent_uid: uidOf("u_aaaaa7"), order_idx: order, text: "plain" },
          ...s.ops],
  }));

const scenarioArb = fc.oneof(randomScenarioArb, childCaseArb, pageCaseArb);

let t: TestDb;
// Unchecked rows, as in the production worker: comma uids are data the row
// check refuses, and the property must see what production sees.
beforeAll(async () => { t = await openTestDb({ checkRows: false }); });
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
          if (!targetedFkHit(db, batchIdOf("b1"))) {
            const added = [...after].filter((k) => !before.has(k));
            expect(added).toEqual([]);
          }
        });
      } finally {
        if (s.fksOff) db.exec("PRAGMA foreign_keys=ON");
      }
    // 1000 runs: the two targeted shapes make about half the runs add a
    // violation key, and dropping either clause, or narrowing it, fails by the
    // 53rd run on every seed tried, so the count has a margin of about twenty.
    // The random third of the runs keeps the other states in play.
    }), { numRuns: 1000 });
  // About 0.7 s alone and 1.1 s under coverage; 10 s leaves nine times the
  // slower for a loaded machine without hiding a hang.
  }, 10_000);
});
