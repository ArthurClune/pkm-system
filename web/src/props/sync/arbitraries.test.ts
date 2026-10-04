import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BAD_UID, editDrafts, EDIT_TARGETS, opsFor, PAGE_TITLES, resolveOps, showDraft,
         showOp, targetPool, type OpDraft } from "./arbitraries";
import { countDown, FALL_BACK, freshPool, initialModel, londonMs, londonTime,
         midnightCrossing, SPRING_FORWARD, START_MS } from "./model";

const BLOCK_UID = /^[a-zA-Z0-9_-]{6,32}$/;

const draft = (over: Partial<OpDraft>): OpDraft => ({
  kind: "update_text", target: 0, parent: null, page: null, orderIdx: 0, text: "",
  collapsed: false,
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

  it("pool targets exclude the BadBatch uid, and the seed blocks keep their indexes", () => {
    expect(EDIT_TARGETS).not.toContain(BAD_UID);
    expect(EDIT_TARGETS).toEqual(["pt_seed_1", "pt_seed_2", "pt_seed_3", "pt_seed_4",
                                  "pt_seed_5", "pt_sec_1", "pt_sec_2", "pt_sec_3"]);
  });

  it("creates on the drawn title, Proptest when none is drawn", () => {
    const { ops } = resolveOps(
      [draft({ kind: "create", page: 2 }), draft({ kind: "create", page: 5 }),
       draft({ kind: "create" })],
      ["pt_seed_1"], ["pt_A_1", "pt_A_2", "pt_A_3"]);
    expect(ops.map((op) => op.op === "create" && op.page_title))
      .toEqual(["Third", "Second", "Proptest"]);
  });

  it("gives only a top-level move a page_title, and only when one is drawn", () => {
    const { ops } = resolveOps(
      [draft({ kind: "move", page: 1, orderIdx: 4 }),
       draft({ kind: "move", page: null }),
       draft({ kind: "move", parent: 1, page: 3 })],
      ["pt_seed_1", "pt_seed_2"], []);
    expect(ops).toEqual([
      { op: "move", uid: "pt_seed_1", parent_uid: null, order_idx: 4, page_title: "Second" },
      { op: "move", uid: "pt_seed_1", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "pt_seed_1", parent_uid: "pt_seed_2", order_idx: 0 },
    ]);
    expect(ops.map(showOp)).toEqual([
      "move pt_seed_1 under top of Second at 4", "move pt_seed_1 under top at 0",
      "move pt_seed_1 under pt_seed_2 at 0"]);
  });

  it("shows a draft's page by the title it draws", () => {
    expect(showDraft(draft({ kind: "move", target: 2, page: 3 })))
      .toBe("move #2 under top of Fourth at 0");
    expect(showDraft(draft({ kind: "move", target: 2, parent: 1, page: 3 })))
      .toBe("move #2 under #1 at 0");
    expect(showDraft(draft({ kind: "create", text: "x" })))
      .toBe('create under top of Proptest at 0 "x"');
  });

  it("draws every pool title, and no title for some", () => {
    const pages = fc.sample(editDrafts, { numRuns: 300, seed: 5 }).flat().map((d) => d.page);
    expect(new Set(pages)).toEqual(new Set([null, ...PAGE_TITLES.keys()]));
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

  it("counts every countdown down by one and returns those due, with their count", () => {
    const { backAfter, due } = countDown({
      A: { after: 2, left: 2 }, B: { after: 1, left: 1 }, C: null,
    });
    expect(backAfter).toEqual({ A: { after: 2, left: 1 }, B: null, C: null });
    expect(due).toEqual([{ client: "B", after: 1 }]);
    const again = countDown(backAfter);
    expect(again.backAfter).toEqual({ A: null, B: null, C: null });
    expect(again.due).toEqual([{ client: "A", after: 2 }]);
  });

  it("leaves the countdowns it is given alone", () => {
    const before = { A: { after: 3, left: 3 } };
    countDown(before);
    expect(before).toEqual({ A: { after: 3, left: 3 } });
  });

  it("starts every client online with no countdown", () => {
    const m = initialModel(["A", "B"]);
    expect(m.online).toEqual({ A: true, B: true });
    expect(m.backAfter).toEqual({ A: null, B: null });
  });
});
