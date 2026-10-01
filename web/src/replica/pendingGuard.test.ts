// @vitest-environment node
import { expect, test } from "vitest";
import type { SyncSeq } from "../api/brands";
import type { PendingRowId } from "./client";
import { pendingSetStillCovered } from "./pendingGuard";

const rid = (n: number): PendingRowId => n as PendingRowId;

const seqs = (entries: Array<[number, number]>): ReadonlyMap<PendingRowId, SyncSeq> =>
  new Map(entries.map(([id, seq]) => [rid(id), seq as SyncSeq]));

// Plain-number call sites, same shape as pendingSetStillCovered: ids and the
// window's latest_seq take a brand on the production path, but every test
// here picks arbitrary small numbers, so this wrapper mints the brands once
// rather than at every call.
const covered = (
  expected: number[], current: number[],
  acked: ReadonlyMap<PendingRowId, SyncSeq>, latestSeq: number,
): boolean =>
  pendingSetStillCovered(
    expected.map(rid), current.map(rid), acked, latestSeq as SyncSeq);

test("an unchanged pending set is covered", () => {
  expect(covered([1, 2], [1, 2], seqs([]), 10)).toBe(true);
  expect(covered([], [], seqs([]), 0)).toBe(true);
});

test("a removal whose acked seq the window has reached is covered", () => {
  expect(covered([1, 2, 3], [1, 3], seqs([[2, 10]]), 10)).toBe(true);
  expect(covered([1, 2], [], seqs([[1, 4], [2, 9]]), 12)).toBe(true);
});

test("a removal acked after the window's latest_seq is not covered", () => {
  expect(covered([1, 2], [1], seqs([[2, 11]]), 10)).toBe(false);
});

test("a removal with no recorded acked seq is not covered", () => {
  expect(covered([1, 2], [1], seqs([]), 10)).toBe(false);
  // one of two removals known is still not enough
  expect(covered([1, 2], [], seqs([[1, 3]]), 10)).toBe(false);
});

test("an added batch is never covered", () => {
  expect(covered([1], [1, 2], seqs([]), 10)).toBe(false);
  expect(covered([1], [2], seqs([[1, 3]]), 10)).toBe(false);
});

test("a reordered set is never covered", () => {
  expect(covered([1, 2], [2, 1], seqs([]), 10)).toBe(false);
});

// `pendingSetStillCovered`'s id/seq pair looks interchangeable as bare
// numbers -- this is the swap the brands exist to block at compile time.
test("the id/seq brands reject a swapped call (compile-time only)", () => {
  const id = rid(1);
  const seq = 7 as SyncSeq;
  // @ts-expect-error a PendingRowId array is not a SyncSeq array
  pendingSetStillCovered([seq], [], new Map(), seq);
  // @ts-expect-error latestSeq takes a SyncSeq, not a PendingRowId
  pendingSetStillCovered([], [], new Map(), id);
  // @ts-expect-error the acked map is keyed by PendingRowId, valued by
  // SyncSeq -- swapping them must not typecheck even though both are numbers
  pendingSetStillCovered([], [], new Map([[seq, id]]), seq);
  expect(true).toBe(true); // the assertions above are compile-time only
});
