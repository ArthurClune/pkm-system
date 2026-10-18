import { describe, expect, test } from "vitest";
import { parseChanges, parseEcho, parseOpsAck, parseSnapshot, readBatchHead } from "./wire";

const rawBlock = {
  uid: "pt_seed_1", page_id: 1, parent_uid: null, order_idx: 0, text: "one",
  heading: null, view_type: null, collapsed: 0, created_at: 1, updated_at: 2,
  refs: [{ target_page_id: 2, kind: "link" }],
};

const rawSnapshot = {
  generation: "g", plain_space_title_canonicalization: true, seq: 7,
  pages: [{ id: 1, title: "Proptest", created_at: 1, updated_at: 1 }],
  blocks: [rawBlock],
  sidebar: [{ id: 3, title: "Proptest", order_idx: 1 }],
};

describe("parseSnapshot", () => {
  test("reads a snapshot as the route answers it", () => {
    expect(parseSnapshot(rawSnapshot)).toEqual(rawSnapshot);
  });

  test("keeps applied_batches only when the answer has them", () => {
    const applied = [{ batch_id: "b-1", seq: null, skipped: [] }];
    expect(parseSnapshot({ ...rawSnapshot, applied_batches: applied }).applied_batches)
      .toEqual(applied);
    expect("applied_batches" in parseSnapshot(rawSnapshot)).toBe(false);
  });

  test("names the field that is not a uid", () => {
    const bad = { ...rawSnapshot, blocks: [{ ...rawBlock, uid: "x" }] };
    expect(() => parseSnapshot(bad)).toThrow(/"x" is not a valid BlockUid/);
  });

  test("names a field of the wrong kind by its path", () => {
    const bad = { ...rawSnapshot, blocks: [{ ...rawBlock, collapsed: "no" }] };
    expect(() => parseSnapshot(bad)).toThrow(/snapshot\.blocks\[0\]\.collapsed is not an integer/);
  });

  test("refuses a heading outside the levels", () => {
    const bad = { ...rawSnapshot, blocks: [{ ...rawBlock, heading: 4 }] };
    expect(() => parseSnapshot(bad)).toThrow(/heading is not one of 1\|2\|3/);
  });
});

describe("parseChanges", () => {
  const raw = {
    reset: false, generation: "g", plain_space_title_canonicalization: false,
    next_since: 8, latest_seq: 9, pages: [], blocks: [rawBlock], sidebar: [],
    tombstones: [{ kind: "block", entity_id: "pt_seed_2" }],
  };

  test("reads a changes window", () => {
    expect(parseChanges(raw)).toEqual(raw);
  });

  test("refuses a tombstone of an unknown kind", () => {
    expect(() => parseChanges({ ...raw, tombstones: [{ kind: "row", entity_id: "x" }] }))
      .toThrow(/kind is not one of block\|page\|sidebar/);
  });
});

describe("parseOpsAck", () => {
  test("reads an ack with and without a seq or skipped ops", () => {
    expect(parseOpsAck({ ok: true, ts: 1.5, applied: 2 })).toEqual({ ok: true, ts: 1.5, applied: 2 });
    const skipped = [{ index: 0, op: "delete", uid: "pt_seed_1", reason: "block_not_found",
                       note_page: null }];
    expect(parseOpsAck({ ok: true, ts: 1, applied: 0, seq: 4, skipped }))
      .toEqual({ ok: true, ts: 1, applied: 0, seq: 4, skipped });
    expect(parseOpsAck({ ok: true, ts: 1, applied: 0, seq: null }).seq).toBeNull();
  });

  test("refuses a skipped op with an unknown reason", () => {
    const skipped = [{ index: 0, op: "delete", uid: "pt_seed_1", reason: "because",
                       note_page: null }];
    expect(() => parseOpsAck({ ok: true, ts: 1, applied: 0, skipped })).toThrow(/reason/);
  });
});

describe("readBatchHead", () => {
  test("reads the batch id and the op count of an ops body", () => {
    expect(readBatchHead(JSON.stringify({ batch_id: "b-9", client_id: "c", ops: [{}, {}] })))
      .toEqual({ batchId: "b-9", opCount: 2 });
  });

  test("refuses a body without a batch id", () => {
    expect(() => readBatchHead(JSON.stringify({ ops: [] }))).toThrow(/batch_id is not a string/);
  });
});

describe("parseEcho", () => {
  test("is null when no frame was recorded, else the ops it carried", () => {
    expect(parseEcho({ ops: null })).toBeNull();
    const ops = [{ op: "delete", uid: "pt_seed_1" }];
    expect(parseEcho({ ops })).toEqual(ops);
  });
});
