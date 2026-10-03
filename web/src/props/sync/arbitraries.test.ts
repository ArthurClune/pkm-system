import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BAD_UID, editDrafts, EDIT_TARGETS, opsFor, resolveOps, targetPool,
         type OpDraft } from "./arbitraries";
import { FALL_BACK, freshPool, initialModel, londonMs, londonTime,
         midnightCrossing, SPRING_FORWARD, START_MS } from "./model";

const BLOCK_UID = /^[a-zA-Z0-9_-]{6,32}$/;

const draft = (over: Partial<OpDraft>): OpDraft => ({
  kind: "update_text", target: 0, parent: null, orderIdx: 0, text: "", collapsed: false,
  ...over,
});

describe("resolveOps", () => {
  it("takes the client's fresh uids in order, and creates under top or the pool", () => {
    const { ops, used } = resolveOps(
      [draft({ kind: "create", parent: 1, orderIdx: 5, text: "x" }),
       draft({ kind: "create" })],
      ["pt_seed_1", "pt_seed_2"], ["pt_A_1", "pt_A_2"]);
    expect(used).toEqual(["pt_A_1", "pt_A_2"]);
    expect(ops).toEqual([
      { op: "create", uid: "pt_A_1", page_title: "Proptest", parent_uid: "pt_seed_2",
        order_idx: 5, text: "x" },
      { op: "create", uid: "pt_A_2", page_title: "Proptest", parent_uid: null,
        order_idx: 0, text: "" },
    ]);
  });

  it("lets a later op in the batch target a uid created earlier in it", () => {
    const { ops } = resolveOps(
      [draft({ kind: "create" }), draft({ kind: "delete", target: 1 })],
      ["pt_seed_1"], ["pt_A_1"]);
    expect(ops[1]).toEqual({ op: "delete", uid: "pt_A_1" });
  });

  it("turns a create with no fresh uid left into an update_text", () => {
    const { ops, used } = resolveOps([draft({ kind: "create", text: "t" })],
                                     ["pt_seed_3"], []);
    expect(used).toEqual([]);
    expect(ops).toEqual([{ op: "update_text", uid: "pt_seed_3", text: "t" }]);
  });

  it("never names the BadBatch uid, never creates a uid twice, leaves hashes unset", () => {
    fc.assert(fc.property(
      fc.array(editDrafts, { maxLength: 12 }), fc.constantFrom("A", "B", "C"),
      (edits, client) => {
        const model = initialModel(["A", "B", "C"]);
        const created = new Set<string>();
        for (const drafts of edits) {
          const { ops, used } = resolveOps(drafts, targetPool(model),
                                           model.freshUids[client]);
          for (const op of ops) {
            const named = [("uid" in op ? op.uid : ""),
                           ("parent_uid" in op ? op.parent_uid ?? "" : "")];
            expect(named).not.toContain(BAD_UID);
            expect(op).not.toHaveProperty("base_text_hash");
            expect(op).not.toHaveProperty("base_subtree_hash");
            if (op.op === "create") {
              expect(created.has(op.uid)).toBe(false);
              expect(op.uid.startsWith(`pt_${client}_`)).toBe(true);
              created.add(op.uid);
            }
          }
          model.freshUids[client] = model.freshUids[client].slice(used.length);
          model.createdUids.push(...used);
        }
      }));
  });

  it("opsFor draws 1-4 ops", () => {
    const model = initialModel(["A", "B"]);
    for (const ops of fc.sample(opsFor(model, "A"), 50)) {
      expect(ops.length).toBeGreaterThanOrEqual(1);
      expect(ops.length).toBeLessThanOrEqual(4);
    }
  });

  it("pool targets exclude the BadBatch uid", () => {
    expect(EDIT_TARGETS).not.toContain(BAD_UID);
    expect(EDIT_TARGETS).toHaveLength(5);
  });
});

describe("model", () => {
  it("fresh uids are valid block uids, eight per client", () => {
    const pool = freshPool("C");
    expect(pool).toHaveLength(8);
    for (const uid of pool) expect(uid).toMatch(BLOCK_UID);
  });

  it("START_MS is 2026-03-01 12:00 in London", () => {
    expect(START_MS).toBe(Date.UTC(2026, 2, 1, 12, 0, 0));
  });

  it("londonMs honours BST", () => {
    expect(londonMs(2026, 3, 29, 23, 59, 55)).toBe(Date.UTC(2026, 2, 29, 22, 59, 55));
    expect(londonMs(2026, 10, 25, 23, 59, 55)).toBe(Date.UTC(2026, 9, 25, 23, 59, 55));
    expect(londonTime(Date.UTC(2026, 5, 1, 23, 30))).toMatchObject({ m: 6, d: 2, hh: 0 });
  });

  it("crosses midnight on the model's date", () => {
    const c = midnightCrossing(START_MS, "model");
    expect(c).toEqual({ date: "2026-03-01", before: Date.UTC(2026, 2, 1, 23, 59, 55),
                        after: Date.UTC(2026, 2, 2, 0, 0, 5), fellBack: false });
    // The next crossing starts from the day after.
    expect(midnightCrossing(c.after, "model").date).toBe("2026-03-02");
  });

  it("crosses midnight on a changeover date ahead of the clock", () => {
    expect(midnightCrossing(START_MS, SPRING_FORWARD))
      .toMatchObject({ date: "2026-03-29", fellBack: false });
    expect(midnightCrossing(START_MS, FALL_BACK))
      .toMatchObject({ date: "2026-10-25", fellBack: false });
  });

  it("falls back to the model's date when the changeover is behind the clock", () => {
    const late = midnightCrossing(START_MS, FALL_BACK).after;
    const c = midnightCrossing(late, SPRING_FORWARD);
    expect(c).toMatchObject({ date: "2026-10-26", fellBack: true });
    expect(c.before).toBeGreaterThan(late);
  });
});
