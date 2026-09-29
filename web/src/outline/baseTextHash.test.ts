import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { block } from "../test-helpers";
import { stampBaseTextHashes, withoutStamps } from "./baseTextHash";

describe("stampBaseTextHashes", () => {
  test("stamps the hash of the text the op replaces", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "u1", text: "after" }];
    const [stamped] = stampBaseTextHashes([block("u1", "before")], "AI", ops);
    expect(stamped).toMatchObject({
      op: "update_text", uid: "u1", text: "after",
      base_text_hash: sha256Hex("before"),
    });
  });

  test("does not mutate the input ops", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "u1", text: "after" }];
    stampBaseTextHashes([block("u1", "before")], "AI", ops);
    expect(ops[0]).not.toHaveProperty("base_text_hash");
  });

  test("an edit chain hashes each op against the previous op's result", () => {
    // The property that makes a user's own chain flush cleanly instead of
    // conflicting with itself.
    const ops: BlockOp[] = [
      { op: "update_text", uid: "u1", text: "one" },
      { op: "update_text", uid: "u1", text: "two" },
    ];
    const stamped = stampBaseTextHashes([block("u1", "zero")], "AI", ops);
    expect(stamped[0]).toMatchObject({ base_text_hash: sha256Hex("zero") });
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("one") });
  });

  test("an explicitly supplied hash is preserved", () => {
    const ops: BlockOp[] = [
      { op: "update_text", uid: "u1", text: "after", base_text_hash: "deadbeef" },
    ];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .toMatchObject({ base_text_hash: "deadbeef" });
  });

  test("a block unknown in this tree gets no hash (plain LWW, as the worker does)", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "elsewhere", text: "after" }];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("base_text_hash");
  });

  test("non-update_text ops pass through untouched and in order", () => {
    const ops: BlockOp[] = [
      { op: "delete", uid: "u2" },
      { op: "update_text", uid: "u1", text: "after" },
      { op: "set_collapsed", uid: "u1", collapsed: true },
    ];
    const stamped = stampBaseTextHashes(
      [block("u1", "before"), block("u2", "x", { order_idx: 1 })], "AI", ops);
    expect(stamped[0]).toBe(ops[0]);
    expect(stamped[2]).toBe(ops[2]);
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("before") });
  });

  test("an empty batch is returned as an empty batch", () => {
    expect(stampBaseTextHashes([block("u1", "a")], "AI", [])).toEqual([]);
  });

  test("stamps the planning page's title on update_text ops it finds", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "u1", text: "after" }];
    const [stamped] = stampBaseTextHashes([block("u1", "before")], "AI", ops);
    expect(stamped).toEqual({
      op: "update_text", uid: "u1", text: "after",
      base_text_hash: sha256Hex("before"),
      page_title: "AI",
    });
  });

  test("leaves page_title off ops for blocks the tree does not know", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "elsewhere", text: "after" }];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("page_title");
  });

  test("keeps a caller-supplied page_title", () => {
    const ops: BlockOp[] = [
      { op: "update_text", uid: "u1", text: "after", page_title: "Other Page" },
    ];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .toMatchObject({ page_title: "Other Page" });
  });
});

describe("withoutStamps", () => {
  test("withoutStamps drops both stamps and keeps the op", () => {
    expect(withoutStamps({
      op: "update_text", uid: "a", text: "t", base_text_hash: "h", page_title: "P",
    })).toEqual({ op: "update_text", uid: "a", text: "t" });
  });
});
