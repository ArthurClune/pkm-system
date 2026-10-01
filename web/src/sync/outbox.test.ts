import { describe, expect, it } from "vitest";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import {
  append,
  clearMarks,
  createOutbox,
  forget,
  headPrecedes,
  laneHead,
  markFollows,
  settleHead,
  type OutboxState,
} from "./outbox";

const op = (uid: string): BlockOp =>
  ({ op: "update_text", uid, text: uid }) as unknown as BlockOp;

// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => s as BatchId;

const withEntries = (...batchIds: string[]): OutboxState =>
  batchIds.map(bid).reduce((s, id) => append(s, id, [op(id)]), createOutbox());

describe("append", () => {
  it("assigns seq 0, 1, 2 in append order and advances the counter", () => {
    const s = withEntries("a", "b", "c");
    expect(s.entries.map((e) => [e.batchId, e.laneSeq])).toEqual([
      ["a", 0], ["b", 1], ["c", 2],
    ]);
    expect(s.appended).toBe(3);
    expect(laneHead(s)?.batchId).toBe("a");
  });

  it("keeps counting after the lane empties, so a seq is never reused", () => {
    let s = withEntries("a");
    s = settleHead(s, bid("a"));
    s = append(s, bid("b"), [op("b")]);
    expect(s.entries[0]?.laneSeq).toBe(1);
    expect(s.appended).toBe(2);
  });
});

describe("markFollows", () => {
  it("records nothing while the lane is empty", () => {
    const s = markFollows(createOutbox(), bid("durable"));
    expect(s.follows.has(bid("durable"))).toBe(false);
  });

  it("records the append boundary when the lane holds entries", () => {
    const s = markFollows(withEntries("a", "b"), bid("durable"));
    expect(s.follows.get(bid("durable"))).toBe(2);
  });
});

describe("headPrecedes", () => {
  it("is true for any head when the durable queue is empty", () => {
    expect(headPrecedes(withEntries("a"), null)).toBe(true);
  });

  it("is false on an empty lane", () => {
    expect(headPrecedes(createOutbox(), null)).toBe(false);
    expect(headPrecedes(createOutbox(), bid("durable"))).toBe(false);
  });

  it("is false for a durable batch that was never marked", () => {
    expect(headPrecedes(withEntries("a", "b"), bid("unmarked"))).toBe(false);
  });

  it("holds a marked batch behind every entry appended before it", () => {
    let s = markFollows(withEntries("a", "b"), bid("durable"));
    s = append(s, bid("c"), [op("c")]);
    expect(headPrecedes(s, bid("durable"))).toBe(true);
    s = settleHead(s, bid("a"));
    expect(headPrecedes(s, bid("durable"))).toBe(true);
    s = settleHead(s, bid("b"));
    // "c" was appended after the durable batch persisted, so it waits.
    expect(laneHead(s)?.batchId).toBe("c");
    expect(headPrecedes(s, bid("durable"))).toBe(false);
  });
});

describe("settleHead", () => {
  it("shifts once when the same head is settled twice", () => {
    let s = withEntries("a", "b");
    s = settleHead(s, bid("a"));
    const again = settleHead(s, bid("a"));
    expect(again.entries.map((e) => e.batchId)).toEqual(["b"]);
    expect(again.entries).toEqual(s.entries);
  });

  it("leaves the lane alone for a batch id that is not the head", () => {
    const s = withEntries("a", "b");
    expect(settleHead(s, bid("b")).entries.map((e) => e.batchId)).toEqual(["a", "b"]);
  });

  it("clears every mark once the lane empties", () => {
    let s = markFollows(withEntries("a"), bid("durable"));
    s = settleHead(s, bid("a"));
    expect(s.entries).toEqual([]);
    expect(s.follows.size).toBe(0);
  });

  it("keeps marks while entries remain", () => {
    let s = markFollows(withEntries("a", "b"), bid("durable"));
    s = settleHead(s, bid("a"));
    expect(s.follows.get(bid("durable"))).toBe(2);
  });
});

describe("forget and clearMarks", () => {
  it("forget removes only that batch's mark", () => {
    let s = markFollows(withEntries("a"), bid("d1"));
    s = markFollows(s, bid("d2"));
    s = forget(s, bid("d1"));
    expect([...s.follows.keys()]).toEqual(["d2"]);
    expect(s.entries.map((e) => e.batchId)).toEqual(["a"]);
  });

  it("clearMarks removes every mark and keeps the entries", () => {
    let s = markFollows(withEntries("a", "b"), bid("d1"));
    s = markFollows(s, bid("d2"));
    s = clearMarks(s);
    expect(s.follows.size).toBe(0);
    expect(s.entries.map((e) => e.batchId)).toEqual(["a", "b"]);
    expect(s.appended).toBe(2);
  });
});

describe("purity", () => {
  it("no transition mutates its input", () => {
    const s = markFollows(withEntries("a", "b"), bid("durable"));
    const entries = structuredClone(s.entries);
    const follows = new Map(s.follows);
    const appended = s.appended;
    append(s, bid("c"), [op("c")]);
    markFollows(s, bid("other"));
    settleHead(s, bid("a"));
    forget(s, bid("durable"));
    clearMarks(s);
    headPrecedes(s, bid("durable"));
    expect(s.entries).toEqual(entries);
    expect(new Map(s.follows)).toEqual(follows);
    expect(s.appended).toBe(appended);
  });

  it("settling the last entry does not clear the input's marks", () => {
    const s = markFollows(withEntries("a"), bid("durable"));
    settleHead(s, bid("a"));
    expect(s.follows.get(bid("durable"))).toBe(1);
    expect(s.entries).toHaveLength(1);
  });
});
