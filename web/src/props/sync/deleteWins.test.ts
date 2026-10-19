import { describe, expect, test } from "vitest";
import type { BatchId } from "../../api/brands";
import { BEYOND_ANY_SEQ, deleteWins, type DeleteWinsRun, replaySeenSeq, staleNamers,
         withSeenSeq } from "./deleteWins";
import type { DeleteRecord, RenameRecord } from "./serverControl";
import { batchIdOf, canonicalTitleOf, pageIdOf, seqOf, uidOf } from "../../test-helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("replaySeenSeq", () => {
  // Faulted deletes at seqs 20 and 30; the replay made them at 18 and 27.
  const faulted = [20, 30];
  const replayed = [18, 27];

  test("before every delete maps to 0", () => {
    expect(replaySeenSeq(19, faulted, replayed, 40)).toBe(0);
  });

  test("maps to the replay's seq of the last delete it had passed", () => {
    expect(replaySeenSeq(20, faulted, replayed, 40)).toBe(18);
    expect(replaySeenSeq(29, faulted, replayed, 40)).toBe(18);
    expect(replaySeenSeq(30, faulted, replayed, 40)).toBe(27);
    expect(replaySeenSeq(40, faulted, replayed, 40)).toBe(27);
  });

  test("no deletes maps everything in the journal to 0", () => {
    expect(replaySeenSeq(12, [], [], 40)).toBe(0);
  });

  test("beyond the faulted journal maps beyond the replay's", () => {
    expect(replaySeenSeq(41, faulted, replayed, 40)).toBe(BEYOND_ANY_SEQ);
  });

  test("null when the replay has not made a delete the batch had passed", () => {
    expect(replaySeenSeq(30, faulted, [18], 40)).toBeNull();
  });
});

describe("withSeenSeq", () => {
  test("a body without seen_seq is returned as it is", () => {
    const body = '{"client_id":"c","batch_id":"b","ops":[]}';
    expect(withSeenSeq(body, () => 99)).toBe(body);
  });

  test("rewrites seen_seq and keeps the rest", () => {
    const out = withSeenSeq('{"client_id":"c","batch_id":"b","ops":[],"seen_seq":20}',
                            (seen) => seen - 2);
    expect(JSON.parse(out ?? "")).toEqual(
      { client_id: "c", batch_id: "b", ops: [], seen_seq: 18 });
  });

  test("null when the mapping has none", () => {
    expect(withSeenSeq('{"ops":[],"seen_seq":20}', () => null)).toBeNull();
  });
});

const id = (s: string): BatchId => batchIdOf(s);

const body = (ops: unknown[], seen?: number): string =>
  JSON.stringify({ client_id: "c", batch_id: "x", ops,
                   ...(seen === undefined ? {} : { seen_seq: seen }) });

const createOn = (title: string, text = "plain"): unknown =>
  ({ op: "create", uid: "pt_A_1", page_title: title, parent_uid: null, order_idx: 0, text });

const del = (over: Partial<DeleteRecord> = {}): DeleteRecord => ({
  title: "Second", seq: seqOf(20), after_batch_id: id("b1"), at: 1000, ord: 1,
  uids: [uidOf("pt_sec_1")], ...over,
});

const rename = (over: Partial<RenameRecord> = {}): RenameRecord => ({
  old_title: canonicalTitleOf("Third"), new_title: canonicalTitleOf("Second"),
  after_batch_id: id("b2"), at: 1000, ord: 2,
  ...over,
});

type Pages = [number, string][];
const snap = (pages: Pages, blocks: [string, number][] = []): DeleteWinsRun["snapshot"] => ({
  pages: pages.map(([pid, title]) => ({ id: pageIdOf(pid), title })),
  blocks: blocks.map(([tag, pid]) => ({ uid: uidOf(tag), page_id: pageIdOf(pid) })),
});

/** b1 lands, Second is deleted after it at seq 20, then b2 (whose body is
 * given) lands; Second exists at quiescence unless `pages` says otherwise. */
const run = (b2: string, over: Partial<DeleteWinsRun> = {}): DeleteWinsRun => ({
  applied: [{ batch_id: id("b1"), applied_at: 1000 }, { batch_id: id("b2"), applied_at: 1000 }],
  committed: new Map([[id("b1"), body([])], [id("b2"), b2]]),
  renames: [],
  deletes: [del()],
  snapshot: snap([[1, "Proptest"], [2, "Second"]]),
  ...over,
});

describe("deleteWins", () => {
  test("holds when the deleted page stays gone", () => {
    expect(deleteWins(run(body([createOn("Second")], 10),
                          { snapshot: snap([[1, "Proptest"]]) }))).toEqual([]);
  });

  test("a block the deleted page held, alive anywhere, is a finding", () => {
    const findings = deleteWins(run(body([]), {
      snapshot: snap([[1, "Proptest"]], [["pt_sec_1", 1]]) }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/pt_sec_1 .*Second.*Proptest/);
  });

  test("a stale top-level create re-creating the page is a finding", () => {
    const findings = deleteWins(run(body([createOn("Second")], 10)));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/Second .*exists.*b2/s);
  });

  test("a stale link re-creating the page is a finding", () => {
    const ops = [{ op: "update_text", uid: "pt_seed_1", text: "left [[Second]]" },
                 { op: "create", uid: "pt_A_2", page_title: "Proptest", parent_uid: null,
                   order_idx: 5, text: "right [[Second]]" }];
    expect(deleteWins(run(body(ops, 19)))).toHaveLength(1);
  });

  test("a stale tag re-creating the page is a finding", () => {
    const ops = [{ op: "update_text", uid: "pt_seed_1", text: "#Second" }];
    expect(deleteWins(run(body(ops, 19)))).toHaveLength(1);
  });

  test("a stale leading attribute re-creating the page is a finding", () => {
    const ops = [{ op: "update_text", uid: "pt_seed_1", text: "Second:: note" }];
    expect(deleteWins(run(body(ops, 19)))).toHaveLength(1);
    expect(staleNamers(run(body(ops, 19)))).toEqual([id("b2")]);
  });

  test("a fenced attribute names nothing", () => {
    const ops = [{ op: "update_text", uid: "pt_seed_1", text: "`Second`:: note" }];
    expect(staleNamers(run(body(ops, 19)))).toEqual([]);
  });

  test("a leading attribute from a fresh batch justifies the page", () => {
    const ops = [{ op: "update_text", uid: "pt_seed_1", text: "Second:: note" }];
    expect(deleteWins(run(body(ops, 20)))).toEqual([]);
  });

  test("nothing naming the page after the delete is a finding", () => {
    expect(deleteWins(run(body([])))).toHaveLength(1);
  });

  test("a batch before the delete does not justify the page", () => {
    const r = run(body([]), {
      committed: new Map([[id("b1"), body([createOn("Second")])], [id("b2"), body([])]]) });
    expect(deleteWins(r)).toHaveLength(1);
  });

  test("a batch that had seen the delete may re-create the page", () => {
    expect(deleteWins(run(body([createOn("Second")], 20)))).toEqual([]);
    expect(deleteWins(run(body([{ op: "update_text", uid: "pt_seed_1",
                                  text: "[[Second]]" }], 25)))).toEqual([]);
  });

  test("a batch without seen_seq may re-create the page", () => {
    expect(deleteWins(run(body([createOn("Second")])))).toEqual([]);
  });

  test("a top-level move naming the page from a fresh batch justifies it", () => {
    const move = { op: "move", uid: "pt_seed_1", parent_uid: null, order_idx: 0,
                   page_title: "Second" };
    expect(deleteWins(run(body([move], 20)))).toEqual([]);
  });

  test("a later rename onto the title justifies it", () => {
    expect(deleteWins(run(body([]), { renames: [rename()] }))).toEqual([]);
  });

  test("a rename onto the title before the delete does not", () => {
    expect(deleteWins(run(body([]), { renames: [rename({ ord: 0, after_batch_id: null })] })))
      .toHaveLength(1);
  });

  test("only the title's last delete counts", () => {
    // Deleted after b1, re-created by b2 (fresh), deleted again after b2:
    // b2 no longer justifies a page that exists at quiescence.
    const r = run(body([createOn("Second")], 20), {
      deletes: [del(), del({ seq: seqOf(30), after_batch_id: id("b2"), ord: 2, uids: [] })] });
    expect(deleteWins(r)).toHaveLength(1);
  });

  test("a stale batch may re-create the page once a later delete may have pruned its row", () => {
    const r = run(body([createOn("Second")], 10), {
      deletes: [del(), del({ title: "Third", seq: seqOf(22), after_batch_id: id("b1"), ord: 2,
                             at: 1000 + 31 * DAY, uids: [] })] });
    expect(deleteWins(r)).toEqual([]);
  });

  test("a batch clock past the retention window prunes nothing, so the delete is still checked", () => {
    const r = run(body([createOn("Second")], 10), {
      applied: [{ batch_id: id("b1"), applied_at: 1000 },
                { batch_id: id("b2"), applied_at: 1000 + 31 * DAY }] });
    expect(deleteWins(r)).toHaveLength(1);
  });

  test("a rename clock past the retention window prunes nothing either", () => {
    const r = run(body([createOn("Second")], 10), {
      renames: [rename({ old_title: canonicalTitleOf("Fourth"),
                         new_title: canonicalTitleOf("Fifth"), at: 1000 + 31 * DAY,
                         after_batch_id: id("b1") })] });
    expect(deleteWins(r)).toHaveLength(1);
  });

  test("reports every violation", () => {
    const r = run(body([createOn("Second"), createOn("Third")], 10), {
      deletes: [del(), del({ title: "Third", seq: seqOf(22), ord: 2, uids: [uidOf("pt_A_9")] })],
      snapshot: snap([[1, "Proptest"], [2, "Second"], [3, "Third"]], [["pt_A_9", 3]]),
    });
    expect(deleteWins(r)).toHaveLength(3);
  });
});

describe("staleNamers", () => {
  test("the batches after a delete that name its title while stale for it", () => {
    expect(staleNamers(run(body([createOn("Second")], 10)))).toEqual([id("b2")]);
    expect(staleNamers(run(body([createOn("Second")], 20)))).toEqual([]);
    expect(staleNamers(run(body([createOn("Third")], 10)))).toEqual([]);
    expect(staleNamers(run(body([createOn("Second")])))).toEqual([]);
  });
});
