// @vitest-environment node
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import type { BlockUid } from "../../api/brands";
import { MAX_OUTLINE_DEPTH } from "../../outline/depthCap";
import { orderIdxOf, uidOf } from "../../test-helpers";
import type { ReplicaDb } from "../db";
import { openTestDb, type TestDb } from "../testDb";
import { pagePayload } from "./pages";
import {
  ancestorTexts, blockRefCounts, buildTree, fetchAncestors, resolveRefUids,
  type BlockRow,
} from "./tree";

function blockRow(over: Partial<BlockRow> = {}): BlockRow {
  return {
    uid: uidOf("tuid-u1"), parent_uid: null, order_idx: orderIdxOf(0), text: "hi",
    heading: null, view_type: null, collapsed: 0, created_at: null,
    updated_at: null, ...over,
  };
}

describe("buildTree", () => {
  // A replica synced before the server started reading a stored 0 as no
  // heading may still hold a 0 locally (the server only coerces it on
  // response, never rewrites the stored row). buildTree must read it the
  // same way, or the heading UI (which compares against 1/2/3 and null)
  // disagrees with what the server now reports for the same block.
  test("a legacy stored heading of 0 reads as no heading, same as null", () => {
    const [node] = buildTree([blockRow({ heading: 0 })]);
    expect(node.heading).toBeNull();
  });
});

let t: TestDb;

afterEach(() => {
  t?.close();
});

function insertPage(rawPageId: number, titleText: string) {
  t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [rawPageId, titleText]);
}

function seedLinearChain(prefix: string, ancestors: number): BlockUid {
  insertPage(1, `${prefix} page`);
  let parentUid: string | null = null;
  for (let i = 0; i <= ancestors; i += 1) {
    const uid = `${prefix}-${i}`;
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [uid, 1, parentUid, i, `${prefix} text ${i}`, null, 0, 0, 0],
    );
    parentUid = uid;
  }
  return uidOf(`${prefix}-${ancestors}`);
}

function seedFiveNodeCycle(prefix: string): BlockUid {
  insertPage(1, `${prefix} page`);
  const uids = Array.from({ length: 5 }, (_, i) => `${prefix}-${i}`);
  for (let i = 0; i < uids.length; i += 1) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [uids[i], 1, null, i, `${prefix} text ${i}`, null, 0, 0, 0],
    );
  }
  for (let i = 0; i < uids.length; i += 1) {
    t.db.exec(
      "UPDATE blocks SET parent_uid = ? WHERE uid = ?",
      [uids[(i + 1) % uids.length], uids[i]],
    );
  }
  return uidOf(uids[0]);
}

describe("fetchAncestors", () => {
  test.each([100, 101, 102, 150])(
    "returns %i ancestors root-first without truncation",
    async (ancestors) => {
      t = await openTestDb();
      const startUid = seedLinearChain(`chain-${ancestors}`, ancestors);
      expect(fetchAncestors(t.db, [startUid])).toEqual(new Map([
        [startUid, Array.from({ length: ancestors }, (_, i) =>
          `chain-${ancestors} text ${i}`)],
      ]));
    },
  );

  test("returns a five-node cycle as four unique ancestors, excluding the start uid", async () => {
    t = await openTestDb();
    const startUid = seedFiveNodeCycle("cycle");
    const result = fetchAncestors(t.db, [startUid]);
    expect(result.size).toBe(1);
    expect(result.get(startUid)).toEqual([
      "cycle text 4",
      "cycle text 3",
      "cycle text 2",
      "cycle text 1",
    ]);
  });
});

/** `fetchAncestors` as it was with the per-row path string: the oracle
 * the rewrite must match, cycles and dangling parents included. */
function referenceFetchAncestors(db: ReplicaDb,
                                 uids: BlockUid[]): Map<BlockUid, string[]> {
  const out = new Map<BlockUid, string[]>();
  if (uids.length === 0) return out;
  const marks = uids.map(() => "?").join(",");
  const rows = db.select(
    `WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth, path) AS (
       SELECT uid, uid, parent_uid, text, 0, ',' || uid || ',' FROM blocks
        WHERE uid IN (${marks})
       UNION ALL
       SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1,
              a.path || b.uid || ','
         FROM anc a JOIN blocks b ON b.uid = a.parent_uid
        WHERE instr(a.path, ',' || b.uid || ',') = 0
     )
     SELECT start_uid, text, depth FROM anc WHERE depth > 0
      ORDER BY start_uid, depth DESC`, ["text", "start_uid", "depth"], uids);
  for (const r of rows) {
    const list = out.get(r.start_uid);
    if (list) list.push(r.text);
    else out.set(r.start_uid, [r.text]);
  }
  return out;
}

/** Map contents in key order: callers read a trail by key, so the order
 * the entries were inserted in is not part of the contract. */
const sorted = (m: Map<BlockUid, string[]>) =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Replace every block with `parents` (uid -> parent uid or null). Foreign
 * keys are off: a dangling parent and a cycle are corrupt data no write
 * path makes, but the read must cope with them. */
function storeBlocks(parents: ReadonlyMap<string, string | null>) {
  t.db.exec("DELETE FROM blocks");
  let i = 0;
  for (const [uid, parent] of parents) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [uid, 1, parent, i, `text of ${uid}`, null, 0, 0, 0],
    );
    i += 1;
  }
}

async function openGraphDb() {
  t = await openTestDb();
  t.db.exec("PRAGMA foreign_keys=OFF");
  insertPage(1, "Graph page");
}

const chainOf = (n: number) => new Map(Array.from({ length: n }, (_, i) =>
  [`chain-${i}`, i ? `chain-${i - 1}` : null] as const));

describe("ancestorTexts", () => {
  const u = (name: string) => uidOf(`tuid-${name}`);
  const rows = (parents: Record<string, string | null>) =>
    new Map(Object.entries(parents).map(([k, p]) =>
      [u(k), [p === null ? null : u(p), k.toUpperCase()] as const]));

  test("runs root first and skips a start with no ancestors", () => {
    expect(ancestorTexts([u("c"), u("a")], rows({ a: null, b: "a", c: "b" })))
      .toEqual(new Map([[u("c"), ["A", "B"]]]));
  });

  test("stops at the first uid already on the trail", () => {
    const graph = rows({ a: "c", b: "a", c: "b", x: "a" });
    expect(ancestorTexts([u("a"), u("x")], graph)).toEqual(new Map([
      [u("a"), ["B", "C"]], [u("x"), ["B", "C", "A"]]]));
  });

  test("gives a self-parent no trail", () => {
    expect(ancestorTexts([u("a")], rows({ a: "a" }))).toEqual(new Map());
  });

  test("ends at a missing parent and leaves out an unknown start", () => {
    expect(ancestorTexts([u("c"), u("nope")], rows({ b: "gone", c: "b" })))
      .toEqual(new Map([[u("c"), ["B"]]]));
  });
});

describe("fetchAncestors against the path-string walk", () => {
  const NAMES = Array.from({ length: 12 }, (_, i) => `block-${i}`);
  const MISSING = "block-missing";
  const graphs = fc.integer({ min: 1, max: NAMES.length }).chain((n) => {
    const names = NAMES.slice(0, n);
    return fc.record({
      parents: fc.array(fc.oneof(fc.constant(null), fc.constantFrom(...names),
                                 fc.constant(MISSING)),
                        { minLength: n, maxLength: n }),
      starts: fc.array(fc.constantFrom(...names, "block-unknown"),
                       { minLength: 1, maxLength: 2 * n }),
    }).map(({ parents, starts }) => ({
      parents: new Map(names.map((name, i) => [name, parents[i]] as const)),
      starts: starts.map(uidOf),
    }));
  });

  test("matches over random graphs with cycles and dangling parents", async () => {
    await openGraphDb();
    const seen = { cycle: 0, missing: 0 };
    fc.assert(fc.property(graphs, ({ parents, starts }) => {
      storeBlocks(parents);
      for (const start of starts) {
        const trail = new Set<string>([start]);
        let cur = parents.get(start) ?? null;
        while (cur !== null && parents.has(cur) && !trail.has(cur)) {
          trail.add(cur);
          cur = parents.get(cur) ?? null;
        }
        if (cur !== null && trail.has(cur)) seen.cycle += 1;
        if (cur === MISSING) seen.missing += 1;
      }
      expect(sorted(fetchAncestors(t.db, starts)))
        .toEqual(sorted(referenceFetchAncestors(t.db, starts)));
    }), { numRuns: 300 });
    // Both corrupt shapes must actually be drawn.
    expect(seen.cycle).toBeGreaterThan(25);
    expect(seen.missing).toBeGreaterThan(25);
  });

  test("matches on a chain and on a cycle as long as the outline cap", async () => {
    await openGraphDb();
    const chain = chainOf(MAX_OUTLINE_DEPTH + 1);
    const starts = [...chain.keys()].map(uidOf);
    storeBlocks(chain);
    const got = fetchAncestors(t.db, starts);
    expect(sorted(got)).toEqual(sorted(referenceFetchAncestors(t.db, starts)));
    expect(got.get(starts[MAX_OUTLINE_DEPTH])).toHaveLength(MAX_OUTLINE_DEPTH);

    chain.set("chain-0", `chain-${MAX_OUTLINE_DEPTH}`);
    storeBlocks(chain);
    const looped = fetchAncestors(t.db, starts);
    expect(sorted(looped))
      .toEqual(sorted(referenceFetchAncestors(t.db, starts)));
    expect([...looped.values()].every((trail) =>
      trail.length === MAX_OUTLINE_DEPTH)).toBe(true);
  });

  // Every block of the chain is a start, as when each links the page whose
  // backlinks are read. Reading each ancestor once doubles the SQL work when
  // the depth doubles; one row per (start, ancestor), as the path-string
  // walk made, quadruples it.
  test("does SQL work linear in the depth", async () => {
    await openGraphDb();
    const steps = (depth: number) => {
      const chain = chainOf(depth);
      storeBlocks(chain);
      const starts = [...chain.keys()].map(uidOf);
      return t.vmSteps(() => { fetchAncestors(t.db, starts); });
    };
    const shallow = steps(200);
    const deep = steps(400);
    expect(deep).toBeLessThan(3 * shallow);
  });
});

describe("id sets past SQLite's variable limit", () => {
  // The wasm build refuses a statement binding more than 32,766 variables.
  const absent = (n: number) =>
    Array.from({ length: n }, (_, i) => uidOf(`tuid-none${i}`));

  function insertBlock(rawUid: string, rawPageId: number, text: string) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [rawUid, rawPageId, null, 0, text, null, 0, 0, 0],
    );
  }

  test("blockRefCounts counts a target among 40,000 uids", async () => {
    t = await openTestDb();
    insertPage(1, "P");
    insertBlock("tuid-src", 1, "src");
    insertBlock("tuid-tgt", 1, "tgt");
    t.db.exec(
      "INSERT INTO block_refs(src_block_uid, target_block_uid) VALUES (?, ?)",
      ["tuid-src", "tuid-tgt"]);
    const uids = [...absent(40_000), uidOf("tuid-tgt"), uidOf("tuid-tgt")];
    expect(blockRefCounts(t.db, uids)).toEqual({ "tuid-tgt": 1 });
  });

  test("fetchAncestors trails a start among 40,000 uids", async () => {
    t = await openTestDb();
    const deep = seedLinearChain("chain-big", 3);
    const trails = fetchAncestors(t.db, [...absent(40_000), deep]);
    expect(trails.get(deep)).toEqual(
      ["chain-big text 0", "chain-big text 1", "chain-big text 2"]);
    expect(trails.size).toBe(1);
  });

  test("resolveRefUids resolves a uid among 40,000", async () => {
    t = await openTestDb();
    insertPage(1, "P");
    insertBlock("tuid-r", 1, "r");
    expect(resolveRefUids(t.db, [...absent(40_000), uidOf("tuid-r")]))
      .toEqual({ "tuid-r": { text: "r", page_title: "P" } });
  });

  test("pagePayload serves a page of 33,000 blocks", async () => {
    t = await openTestDb();
    insertPage(1, "Big");
    t.db.exec(
      `INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,
                          heading, collapsed, created_at, updated_at)
       WITH RECURSIVE n(i) AS (
         SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 32999)
       SELECT printf('tuid-b%05d', i), 1, NULL, i, 'b' || i,
              NULL, 0, 0, 0 FROM n`);
    const payload = pagePayload(t.db, "Big", 0, 10, Date.now())!;
    expect(payload.blocks).toHaveLength(33_000);
    expect(payload.block_ref_counts).toEqual({});
  });
});
