import fc from "fast-check";
import { expect, test } from "vitest";
import { canonicalTitleOf, orderIdxOf, rawTitleOf, uidOf } from "../test-helpers";
import type { BlockOp } from "../api/ops";
import { wellFormed, wellFormedOp, wellFormedOps } from "./wellFormed";

const HIGH = "\uD800";
const LOW = "\uDC00";

test("lone surrogates become U+FFFD; pairs and other text are untouched", () => {
  expect(wellFormed("plain")).toBe("plain");
  expect(wellFormed(`a${HIGH}b`)).toBe("a\uFFFDb");
  expect(wellFormed(`${LOW}${HIGH}`)).toBe("\uFFFD\uFFFD");
  expect(wellFormed(`${HIGH}${HIGH}${LOW}`)).toBe("\uFFFD\uD800\uDC00");
  expect(wellFormed("\uD83D\uDE00 e\u0301 \u0000\r\n")).toBe("\uD83D\uDE00 e\u0301 \u0000\r\n");
});

// Any sequence of UTF-16 code units, surrogates drawn often.
const unitsArb = fc
  .array(fc.oneof(
    fc.integer({ min: 0xd800, max: 0xdfff }),
    fc.integer({ min: 0, max: 0xffff }),
  ), { maxLength: 12 })
  .map((units) => String.fromCharCode(...units));

test("matches String.prototype.toWellFormed on any code-unit string", () => {
  const native = Reflect.get(String.prototype, "toWellFormed") as
    ((this: string) => string) | undefined;
  expect(native).toBeTypeOf("function");
  fc.assert(fc.property(unitsArb, (text) => {
    expect(wellFormed(text)).toBe(native!.call(text));
  }), { numRuns: 500 });
});

test("an op keeps its identity when nothing needed fixing", () => {
  const op: BlockOp = { op: "update_text", uid: uidOf("abcdef"), text: "ok" };
  expect(wellFormedOp(op)).toBe(op);
});

test("every string field of an op is normalised, not just its text", () => {
  const op: BlockOp = {
    op: "create", uid: uidOf("abcdef"), page_title: rawTitleOf(`P${LOW}`),
    parent_uid: null, order_idx: orderIdxOf(0), text: `t${HIGH}`,
  };
  const [fixed] = wellFormedOps([op]);
  expect(fixed).toStrictEqual({ ...op, page_title: "P\uFFFD", text: "t\uFFFD" });
  expect(op.text).toBe(`t${HIGH}`);
  const page: BlockOp = { op: "create_page", page_title: canonicalTitleOf(`Q${HIGH}`) };
  expect(wellFormedOp(page)).toStrictEqual({ op: "create_page", page_title: "Q\uFFFD" });
});
