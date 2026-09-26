// @vitest-environment node
import { expect, test } from "vitest";
import { pendingSetStillCovered } from "./pendingGuard";

const seqs = (entries: Array<[number, number]>): ReadonlyMap<number, number> =>
  new Map(entries);

test("an unchanged pending set is covered", () => {
  expect(pendingSetStillCovered([1, 2], [1, 2], seqs([]), 10)).toBe(true);
  expect(pendingSetStillCovered([], [], seqs([]), 0)).toBe(true);
});

test("a removal whose acked seq the window has reached is covered", () => {
  expect(pendingSetStillCovered([1, 2, 3], [1, 3], seqs([[2, 10]]), 10)).toBe(true);
  expect(pendingSetStillCovered([1, 2], [], seqs([[1, 4], [2, 9]]), 12)).toBe(true);
});

test("a removal acked after the window's latest_seq is not covered", () => {
  expect(pendingSetStillCovered([1, 2], [1], seqs([[2, 11]]), 10)).toBe(false);
});

test("a removal with no recorded acked seq is not covered", () => {
  expect(pendingSetStillCovered([1, 2], [1], seqs([]), 10)).toBe(false);
  // one of two removals known is still not enough
  expect(pendingSetStillCovered([1, 2], [], seqs([[1, 3]]), 10)).toBe(false);
});

test("an added batch is never covered", () => {
  expect(pendingSetStillCovered([1], [1, 2], seqs([]), 10)).toBe(false);
  expect(pendingSetStillCovered([1], [2], seqs([[1, 3]]), 10)).toBe(false);
});

test("a reordered set is never covered", () => {
  expect(pendingSetStillCovered([1, 2], [2, 1], seqs([]), 10)).toBe(false);
});
