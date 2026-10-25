import { describe, expect, it } from "vitest";
import type { BlockUid } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { linkNestingDepth } from "./scan";
import {
  LINK_NESTING_NOTICE, MAX_BLOCK_TEXT_CHARS, TEXT_LENGTH_NOTICE,
  findOpTextLimitViolation, textLimitNotice,
} from "./textLimits";

const PAGE = canonicalTitleOf("Limits");
const TOO_LONG = "x".repeat(MAX_BLOCK_TEXT_CHARS + 1);
const TOO_DEEP = "[[a//".repeat(33) + "x" + "]]".repeat(33);

const create = (uid: BlockUid, text: string): BlockOp => ({
  op: "create", uid, page_title: PAGE, parent_uid: null,
  order_idx: orderIdxOf(0), text,
});
const updateText = (uid: BlockUid, text: string): BlockOp => ({
  op: "update_text", uid, text,
});

describe("the notices", () => {
  it("say what the limit is", () => {
    expect(TEXT_LENGTH_NOTICE)
      .toBe("A block can't be longer than 1,000,000 characters.");
    expect(LINK_NESTING_NOTICE)
      .toBe("Links can't nest more than 32 levels deep.");
  });

  it("are chosen by the limit a text is over", () => {
    expect(textLimitNotice({ kind: "length", measured: 2, limit: 1 }))
      .toBe(TEXT_LENGTH_NOTICE);
    expect(textLimitNotice({ kind: "nesting", measured: 33, limit: 32 }))
      .toBe(LINK_NESTING_NOTICE);
  });
});

describe("findOpTextLimitViolation", () => {
  it("is null for no ops", () => {
    expect(findOpTextLimitViolation([])).toBeNull();
  });

  it("is null when every text is within the limits", () => {
    expect(findOpTextLimitViolation([
      create(uidOf("tuid-a1"), "[[x]]"), updateText(uidOf("tuid-a1"), "y".repeat(100)),
    ])).toBeNull();
  });

  it("names the first over-limit create by index and uid", () => {
    expect(findOpTextLimitViolation([
      updateText(uidOf("tuid-ok"), "fine"), create(uidOf("tuid-long"), TOO_LONG),
      create(uidOf("tuid-deep"), TOO_DEEP),
    ])).toEqual({
      opIndex: 1, uid: uidOf("tuid-long"),
      violation: { kind: "length", measured: MAX_BLOCK_TEXT_CHARS + 1,
                   limit: MAX_BLOCK_TEXT_CHARS },
    });
  });

  it("names an over-limit update_text", () => {
    expect(findOpTextLimitViolation([
      create(uidOf("tuid-ok"), "fine"), updateText(uidOf("tuid-deep"), TOO_DEEP),
    ])).toEqual({
      opIndex: 1, uid: uidOf("tuid-deep"),
      violation: { kind: "nesting", measured: 33, limit: 32 },
    });
  });

  it("does not judge moves, deletes or headings", () => {
    expect(findOpTextLimitViolation([
      { op: "move", uid: uidOf("tuid-m1"), parent_uid: null, page_title: PAGE,
        order_idx: orderIdxOf(1) },
      { op: "delete", uid: uidOf("tuid-d1") },
      { op: "set_heading", uid: uidOf("tuid-h1"), heading: 1 },
    ])).toBeNull();
  });
});

describe("linkNestingDepth", () => {
  it("measures a nest far past the limit without recursing", () => {
    const depth = 200_000;
    expect(linkNestingDepth("[[".repeat(depth) + "x" + "]]".repeat(depth)))
      .toBe(depth);
  });
});
