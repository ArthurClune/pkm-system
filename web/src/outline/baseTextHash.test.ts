import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { sha256Hex, type Sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { block, orderIdxOf, canonicalTitleOf, uidOf } from "../test-helpers";
import { nodeSubtreePairs, stampBaseTextHashes, withoutStamps } from "./baseTextHash";
import { backspaceAtStart } from "./edits";

describe("stampBaseTextHashes", () => {
  test("stamps the hash of the text the op replaces", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-u1"), text: "after" }];
    const [stamped] = stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops);
    expect(stamped).toMatchObject({
      op: "update_text", uid: "tuid-u1", text: "after",
      base_text_hash: sha256Hex("before"),
    });
  });

  test("does not mutate the input ops", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-u1"), text: "after" }];
    stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops);
    expect(ops[0]).not.toHaveProperty("base_text_hash");
  });

  test("an edit chain hashes each op against the previous op's result", () => {
    // The property that makes a user's own chain flush cleanly instead of
    // conflicting with itself.
    const ops: BlockOp[] = [
      { op: "update_text", uid: uidOf("tuid-u1"), text: "one" },
      { op: "update_text", uid: uidOf("tuid-u1"), text: "two" },
    ];
    const stamped = stampBaseTextHashes([block("tuid-u1", "zero")], "AI", ops);
    expect(stamped[0]).toMatchObject({ base_text_hash: sha256Hex("zero") });
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("one") });
  });

  test("an explicitly supplied hash is preserved", () => {
    const ops: BlockOp[] = [
      { op: "update_text", uid: uidOf("tuid-u1"), text: "after",
        base_text_hash: "deadbeef" as Sha256Hex },
    ];
    expect(stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops)[0])
      .toMatchObject({ base_text_hash: "deadbeef" });
  });

  test("a block unknown in this tree gets no hash (plain LWW, as the worker does)", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-elsewhere"), text: "after" }];
    expect(stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("base_text_hash");
  });

  test("ops that carry no hash pass through untouched and in order", () => {
    const ops: BlockOp[] = [
      { op: "move", uid: uidOf("tuid-u2"), parent_uid: null, order_idx: orderIdxOf(0) },
      { op: "update_text", uid: uidOf("tuid-u1"), text: "after" },
      { op: "set_collapsed", uid: uidOf("tuid-u1"), collapsed: true },
    ];
    const stamped = stampBaseTextHashes(
      [block("tuid-u1", "before"), block("tuid-u2", "x", { order_idx: orderIdxOf(1) })], "AI", ops);
    expect(stamped[0]).toBe(ops[0]);
    expect(stamped[2]).toBe(ops[2]);
    expect(stamped[1]).toMatchObject({ base_text_hash: sha256Hex("before") });
  });

  test("an empty batch is returned as an empty batch", () => {
    expect(stampBaseTextHashes([block("tuid-u1", "a")], "AI", [])).toEqual([]);
  });

  test("stamps the planning page's title on update_text ops it finds", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-u1"), text: "after" }];
    const [stamped] = stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops);
    expect(stamped).toEqual({
      op: "update_text", uid: "tuid-u1", text: "after",
      base_text_hash: sha256Hex("before"),
      page_title: "AI",
    });
  });

  test("leaves page_title off ops for blocks the tree does not know", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-elsewhere"), text: "after" }];
    expect(stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("page_title");
  });

  test("keeps a caller-supplied page_title", () => {
    const ops: BlockOp[] = [
      { op: "update_text", uid: uidOf("tuid-u1"), text: "after", page_title: "Other Page" },
    ];
    expect(stampBaseTextHashes([block("tuid-u1", "before")], "AI", ops)[0])
      .toMatchObject({ page_title: "Other Page" });
  });
});

describe("stampBaseTextHashes on delete", () => {
  // r -> c1 -> g, and r -> c2.
  const tree = () => [
    block("tuid-r", "root", {
      children: [
        block("tuid-c1", "child one", { children: [block("tuid-g", "grandchild")] }),
        block("tuid-c2", "child two", { order_idx: orderIdxOf(1) }),
      ],
    }),
  ];

  test("stamps a delete with the hash of its subtree", () => {
    const [stamped] = stampBaseTextHashes(tree(), "AI", [{ op: "delete", uid: uidOf("tuid-r") }]);
    expect(stamped).toEqual({
      op: "delete", uid: "tuid-r",
      base_subtree_hash: subtreeHash([
        ["tuid-r", "root"], ["tuid-c1", "child one"], ["tuid-g", "grandchild"], ["tuid-c2", "child two"],
      ]),
    });
  });

  test("leaves a supplied subtree hash alone", () => {
    const ops: BlockOp[] = [
      { op: "delete", uid: uidOf("tuid-r"), base_subtree_hash: "feedface" as Sha256Hex },
    ];
    expect(stampBaseTextHashes(tree(), "AI", ops)[0]).toBe(ops[0]);
  });

  test("leaves a delete of an unknown node unstamped", () => {
    const ops: BlockOp[] = [{ op: "delete", uid: uidOf("tuid-elsewhere") }];
    expect(stampBaseTextHashes(tree(), "AI", ops)[0])
      .not.toHaveProperty("base_subtree_hash");
  });

  test("a backspace merge hashes the deleted block as it stood before the merge", () => {
    // The real backspace merge: backspaceAtStart only merges a childless
    // block, as [update_text prev, delete B]. The delete must hash B as it
    // stood before the merge, not the merged text on prev.
    const blocks = [
      block("tuid-a", "hello"),
      block("tuid-b", " world", { order_idx: orderIdxOf(1) }),
    ];
    const { ops } = backspaceAtStart(blocks, canonicalTitleOf("AI"), uidOf("tuid-b"));
    expect(ops.map((op) => op.op)).toEqual(["update_text", "delete"]);
    const stamped = stampBaseTextHashes(blocks, "AI", ops);
    expect(stamped[1]).toEqual({
      op: "delete", uid: "tuid-b",
      base_subtree_hash: subtreeHash([["tuid-b", " world"]]),
    });
  });

  test("a delete after in-batch moves hashes only what the moves left", () => {
    // Synthetic ordering check, not an edits.ts gesture: no producer moves a
    // block's children out and then deletes it, but the walk must still hash
    // the tree the earlier ops in the batch left behind.
    const ops: BlockOp[] = [
      { op: "move", uid: uidOf("tuid-c1"), parent_uid: null, order_idx: orderIdxOf(1) },
      { op: "move", uid: uidOf("tuid-c2"), parent_uid: null, order_idx: orderIdxOf(2) },
      { op: "delete", uid: uidOf("tuid-r") },
    ];
    expect(stampBaseTextHashes(tree(), "AI", ops)[2]).toEqual({
      op: "delete", uid: "tuid-r", base_subtree_hash: subtreeHash([["tuid-r", "root"]]),
    });
  });

  test("stamps a parent delete after its child's delete in the same batch", () => {
    const stamped = stampBaseTextHashes(tree(), "AI", [
      { op: "delete", uid: uidOf("tuid-c1") },
      { op: "delete", uid: uidOf("tuid-r") },
    ]);
    expect(stamped[0]).toMatchObject({
      base_subtree_hash: subtreeHash([["tuid-c1", "child one"], ["tuid-g", "grandchild"]]),
    });
    expect(stamped[1]).toMatchObject({
      base_subtree_hash: subtreeHash([["tuid-r", "root"], ["tuid-c2", "child two"]]),
    });
  });

  test("a child update then a parent delete hashes the updated text", () => {
    const stamped = stampBaseTextHashes(tree(), "AI", [
      { op: "update_text", uid: uidOf("tuid-g"), text: "edited" },
      { op: "delete", uid: uidOf("tuid-r") },
    ]);
    expect(stamped[1]).toMatchObject({
      base_subtree_hash: subtreeHash([
        ["tuid-r", "root"], ["tuid-c1", "child one"], ["tuid-g", "edited"], ["tuid-c2", "child two"],
      ]),
    });
  });
});

describe("nodeSubtreePairs", () => {
  test("lists the node and every descendant as (uid, text)", () => {
    const node = block("tuid-r", "root", {
      children: [block("c", "kid", { children: [block("tuid-g", "")] })],
    });
    expect(nodeSubtreePairs(node)).toEqual([
      ["tuid-r", "root"], ["c", "kid"], ["tuid-g", ""],
    ]);
  });
});

describe("withoutStamps", () => {
  test("withoutStamps drops both stamps and keeps the op", () => {
    expect(withoutStamps({
      op: "update_text", uid: uidOf("tuid-a"), text: "t",
      base_text_hash: "h" as Sha256Hex, page_title: "P",
    })).toEqual({ op: "update_text", uid: "tuid-a", text: "t" });
  });
});
