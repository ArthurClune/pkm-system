import { describe, expect, test } from "vitest";
import { block, ord, uid } from "../test-helpers";
import type { MoveOp } from "../api/ops";
import { FIRST_ORDER_IDX, orderIdxAfter, orderIdxAfterLast,
         orderIdxPlus } from "./orderIdx";
import { locate } from "./tree";

describe("OrderIdx narrowing", () => {
  test("a MoveOp's order_idx cannot be a dense sibling position", () => {
    const siblings = [block("a", "A"), block("b", "B")];
    const found = locate(siblings, uid("b"))!;
    const op: MoveOp = {
      op: "move", uid: uid("a"), parent_uid: null,
      // @ts-expect-error a dense position is not an OrderIdx
      order_idx: found.index,
    };
    void op;
  });
});

describe("orderIdxAfter", () => {
  test("is one past the given key", () => {
    expect(orderIdxAfter(ord(0))).toBe(1);
    expect(orderIdxAfter(ord(5))).toBe(6);
  });
});

describe("orderIdxAfterLast", () => {
  test("is FIRST_ORDER_IDX when there are no siblings", () => {
    expect(orderIdxAfterLast([])).toBe(FIRST_ORDER_IDX);
  });

  test("is one past the last sibling's key, gaps and all", () => {
    expect(orderIdxAfterLast([
      { order_idx: ord(0) }, { order_idx: ord(5) }, { order_idx: ord(7) },
    ])).toBe(8);
  });
});

describe("orderIdxPlus", () => {
  test("advances a base key by n", () => {
    expect(orderIdxPlus(ord(3), 0)).toBe(3);
    expect(orderIdxPlus(ord(3), 2)).toBe(5);
  });
});
