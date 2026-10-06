// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { BlockUid, CanonicalTitle, OrderIdx, PageId, SyncSeq } from "../../src/api/brands";
import type { BlockOp } from "../../src/api/ops";
import type { Snapshot, SyncBlock } from "../../src/replica/apply";
import { pendingBatches, pickTargets, windowBatches, type Targets } from "./rebaseTargets";

const PAGE = "Perf Big Page";

/** [uid, parent uid] rows on one page, ordered among siblings as given. */
function snapshotOf(pages: Record<string, [string, string | null][]>): Snapshot {
  const blocks: SyncBlock[] = [];
  const titles = Object.keys(pages);
  titles.forEach((title, p) => {
    const seen = new Map<string | null, number>();
    for (const [uid, parent] of pages[title] ?? []) {
      const idx = seen.get(parent) ?? 0;
      seen.set(parent, idx + 1);
      blocks.push({
        uid: uid as BlockUid, page_id: (p + 1) as PageId,
        parent_uid: parent as BlockUid | null, order_idx: idx as OrderIdx,
        text: `text of ${uid}`, heading: null, view_type: null, collapsed: 0,
        created_at: 0, updated_at: 0, refs: [],
      });
    }
  });
  return {
    generation: "g", plain_space_title_canonicalization: true, seq: 7 as SyncSeq,
    pages: titles.map((title, p) => ({
      id: (p + 1) as PageId, title: title as CanonicalTitle, created_at: 0, updated_at: 0,
    })),
    blocks, sidebar: [], applied_batches: [],
  };
}

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, "0")}`);

/** 40 blocks: a 21-block subtree under a00 (a01 holds 16 of them), a
 * 6-block subtree under m00, and 13 top-level singletons. */
function bigPage(): [string, string | null][] {
  return [
    ["a00", null],
    ...range("a", 1, 4).map((u): [string, string] => [u, "a00"]),
    ...range("a", 5, 20).map((u): [string, string] => [u, "a01"]),
    ["m00", null],
    ...range("m", 1, 5).map((u): [string, string] => [u, "m00"]),
    ...range("b", 1, 13).map((u): [string, null] => [u, null]),
  ];
}

const allTargets = (t: Targets): string[] => [
  t.deleteRoot, ...t.editUids, ...t.moveUids, t.moveParent, t.createParent,
  t.windowEditUid, t.pasteParent, t.overlapMoveUid,
];

const ofKind = <K extends BlockOp["op"]>(ops: BlockOp[], kind: K) =>
  ops.filter((o): o is Extract<BlockOp, { op: K }> => o.op === kind);

describe("pickTargets", () => {
  const snap = snapshotOf({ [PAGE]: bigPage(), Other: [["z00", null], ["z01", "z00"]] });
  const t = pickTargets(snap, PAGE);
  const subtree = new Set(["a00", ...range("a", 1, 20)]);

  test("deleteRoot is the root of the subtree closest to 21", () => {
    expect(t.deleteRoot).toBe("a00");
  });

  test("targets are distinct, on the page and outside deleteRoot's subtree", () => {
    const rest = allTargets(t).slice(1);
    expect(t.editUids).toHaveLength(8);
    expect(t.moveUids).toHaveLength(3);
    expect(new Set(allTargets(t)).size).toBe(allTargets(t).length);
    for (const uid of rest) {
      expect(subtree.has(uid)).toBe(false);
      expect(uid.startsWith("z")).toBe(false);
    }
  });

  test("takes candidates in uid order", () => {
    expect(t.editUids).toEqual(range("b", 1, 8));
    expect(t.moveUids).toEqual(range("b", 9, 11));
    expect([t.moveParent, t.createParent, t.windowEditUid, t.pasteParent, t.overlapMoveUid])
      .toEqual(["b12", "b13", "m00", "m01", "m02"]);
  });

  const withoutBM = (): [string, string | null][] =>
    bigPage().filter(([u]) => !u.startsWith("b") && !u.startsWith("m"));

  test("skips parents under a moved block", () => {
    // c09 is the first move; its children c115/c116 sort right after the
    // last move, ahead of c12, so they are the first candidates for both
    // parents, and stay available for the later roles.
    const rows: [string, string | null][] = [
      ...withoutBM(),
      ...range("c", 1, 14).map((u): [string, null] => [u, null]),
      ["c115", "c09"], ["c116", "c09"],
    ];
    const s = pickTargets(snapshotOf({ [PAGE]: rows }), PAGE);
    expect(s.moveUids).toEqual(["c09", "c10", "c11"]);
    expect([s.moveParent, s.createParent]).toEqual(["c12", "c13"]);
    expect([s.windowEditUid, s.pasteParent, s.overlapMoveUid]).toEqual(["c115", "c116", "c14"]);
  });

  test("an overlap move never lands under itself", () => {
    // d00 becomes createParent; d03, next for overlapMoveUid, holds it.
    const rows: [string, string | null][] = [
      ...withoutBM(),
      ...range("c", 1, 12).map((u): [string, null] => [u, null]),
      ["d00", "d03"], ["d01", null], ["d02", null], ["d03", null], ["e00", null],
    ];
    const s = pickTargets(snapshotOf({ [PAGE]: rows }), PAGE);
    expect(s.createParent).toBe("d00");
    expect(s.overlapMoveUid).toBe("e00");
  });

  test("throws when no subtree reaches 5 blocks", () => {
    const flat = range("b", 1, 30).map((u): [string, null] => [u, null]);
    expect(() => pickTargets(snapshotOf({ [PAGE]: flat }), PAGE)).toThrow(/subtree/);
  });

  test("throws when the page runs out of candidates", () => {
    const small: [string, string | null][] = [
      ["a00", null], ...range("a", 1, 5).map((u): [string, string] => [u, "a00"]),
      ...range("b", 1, 10).map((u): [string, null] => [u, null]),
    ];
    expect(() => pickTargets(snapshotOf({ [PAGE]: small }), PAGE)).toThrow(/runs out/);
  });

  test("throws when the page is missing", () => {
    expect(() => pickTargets(snapshotOf({ Other: bigPage() }), PAGE)).toThrow(/no page/);
  });
});

describe("pendingBatches", () => {
  const snap = snapshotOf({ [PAGE]: bigPage() });
  const t = pickTargets(snap, PAGE);
  const batches = pendingBatches(t, snap);

  test("six batches, p5 a single delete of deleteRoot", () => {
    expect(batches.map((b) => b.batchId)).toEqual(
      ["p1", "p2", "p3", "p4", "p5", "p6"].map((p) => `perf-rebase-${p}`));
    expect(batches[4]?.ops).toEqual([{ op: "delete", uid: t.deleteRoot }]);
  });

  test("p1 creates ten blocks after createParent's children", () => {
    const creates = ofKind(batches[0]?.ops ?? [], "create");
    expect(creates).toHaveLength(10);
    expect(creates[0]).toEqual({
      op: "create", uid: "perfrebc01", page_title: PAGE, parent_uid: t.createParent,
      order_idx: 1, text: "perf rebase create 1",
    });
    expect(creates[9]?.uid).toBe("perfrebc10");
    expect(creates[9]?.order_idx).toBe(10);
  });

  test("p2 and p4 edit the edit uids; p3 appends the moves; p6 edits a created block", () => {
    expect(ofKind(batches[1]?.ops ?? [], "update_text")).toEqual(t.editUids.slice(0, 4).map(
      (uid) => ({ op: "update_text", uid, text: `text of ${uid} (pending edit)` })));
    expect(ofKind(batches[3]?.ops ?? [], "update_text").map((o) => o.uid))
      .toEqual(t.editUids.slice(4, 8));
    expect(batches[2]?.ops).toEqual(t.moveUids.map(
      (uid, k) => ({ op: "move", uid, parent_uid: t.moveParent, order_idx: k })));
    expect(batches[5]?.ops).toEqual(
      [{ op: "update_text", uid: "perfrebc01", text: "perf rebase create 1, edited" }]);
  });
});

describe("windowBatches", () => {
  const snap = snapshotOf({ [PAGE]: bigPage() });
  const t = pickTargets(snap, PAGE);
  const windows = windowBatches(t, snap);

  test("edit, paste and overlap windows", () => {
    expect(windows.map((w) => w.batchId)).toEqual(
      ["w1", "w2", "w3"].map((w) => `perf-rebase-${w}`));
    expect(windows[0]?.ops).toEqual(
      [{ op: "update_text", uid: t.windowEditUid, text: `text of ${t.windowEditUid} (peer edit)` }]);
    const paste = ofKind(windows[1]?.ops ?? [], "create");
    expect(paste).toHaveLength(50);
    expect(paste.every((o) => o.parent_uid === t.pasteParent && o.page_title === PAGE)).toBe(true);
    expect(paste[0]?.uid).toBe("perfrebp01");
    expect(paste[49]?.uid).toBe("perfrebp50");
    // m01 has no children
    expect(paste.map((o) => o.order_idx)).toEqual(Array.from({ length: 50 }, (_, k) => k));
  });

  test("overlap edits editUids[0] and moves overlapMoveUid under createParent", () => {
    expect(windows[2]?.ops).toEqual([
      { op: "update_text", uid: t.editUids[0], text: `text of ${t.editUids[0]} (peer overlap)` },
      { op: "move", uid: t.overlapMoveUid, parent_uid: t.createParent, order_idx: 0 },
    ]);
  });
});
