import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { sha256Hex, type Sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { block } from "../test-helpers";
import { nodeSubtreePairs, stampBaseTextHashes, withoutStamps } from "./baseTextHash";
import { backspaceAtStart } from "./edits";

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
      { op: "update_text", uid: "u1", text: "after",
        base_text_hash: "deadbeef" as Sha256Hex },
    ];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .toMatchObject({ base_text_hash: "deadbeef" });
  });

  test("a block unknown in this tree gets no hash (plain LWW, as the worker does)", () => {
    const ops: BlockOp[] = [{ op: "update_text", uid: "elsewhere", text: "after" }];
    expect(stampBaseTextHashes([block("u1", "before")], "AI", ops)[0])
      .not.toHaveProperty("base_text_hash");
  });

  test("ops that carry no hash pass through untouched and in order", () => {
    const ops: BlockOp[] = [
      { op: "move", uid: "u2", parent_uid: null, order_idx: 0 },
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

describe("stampBaseTextHashes on delete", () => {
  // r -> c1 -> g, and r -> c2.
  const tree = () => [
    block("r", "root", {
      children: [
        block("c1", "child one", { children: [block("g", "grandchild")] }),
        block("c2", "child two", { order_idx: 1 }),
      ],
    }),
  ];

  test("stamps a delete with the hash of its subtree", () => {
    const [stamped] = stampBaseTextHashes(tree(), "AI", [{ op: "delete", uid: "r" }]);
    expect(stamped).toEqual({
      op: "delete", uid: "r",
      base_subtree_hash: subtreeHash([
        ["r", "root"], ["c1", "child one"], ["g", "grandchild"], ["c2", "child two"],
      ]),
    });
  });

  test("leaves a supplied subtree hash alone", () => {
    const ops: BlockOp[] = [
      { op: "delete", uid: "r", base_subtree_hash: "feedface" as Sha256Hex },
    ];
    expect(stampBaseTextHashes(tree(), "AI", ops)[0]).toBe(ops[0]);
  });

  test("leaves a delete of an unknown node unstamped", () => {
    const ops: BlockOp[] = [{ op: "delete", uid: "elsewhere" }];
    expect(stampBaseTextHashes(tree(), "AI", ops)[0])
      .not.toHaveProperty("base_subtree_hash");
  });

  test("a merge batch stamps the delete against the tree its moves left", () => {
    // The real backspace merge: backspaceAtStart only merges a childless
    // block, as [update_text prev, delete B]. The delete must hash B as it
    // stood before the merge, not the merged text on prev.
    const blocks = [
      block("a", "hello"),
      block("b", " world", { order_idx: 1 }),
    ];
    const { ops } = backspaceAtStart(blocks, "AI", "b");
    expect(ops.map((op) => op.op)).toEqual(["update_text", "delete"]);
    const stamped = stampBaseTextHashes(blocks, "AI", ops);
    expect(stamped[1]).toEqual({
      op: "delete", uid: "b",
      base_subtree_hash: subtreeHash([["b", " world"]]),
    });
  });

  test("a delete after in-batch moves hashes only what the moves left", () => {
    // Synthetic ordering check, not an edits.ts gesture: no producer moves a
    // block's children out and then deletes it, but the walk must still hash
    // the tree the earlier ops in the batch left behind.
    const ops: BlockOp[] = [
      { op: "move", uid: "c1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "c2", parent_uid: null, order_idx: 2 },
      { op: "delete", uid: "r" },
    ];
    expect(stampBaseTextHashes(tree(), "AI", ops)[2]).toEqual({
      op: "delete", uid: "r", base_subtree_hash: subtreeHash([["r", "root"]]),
    });
  });

  test("stamps a parent delete after its child's delete in the same batch", () => {
    const stamped = stampBaseTextHashes(tree(), "AI", [
      { op: "delete", uid: "c1" },
      { op: "delete", uid: "r" },
    ]);
    expect(stamped[0]).toMatchObject({
      base_subtree_hash: subtreeHash([["c1", "child one"], ["g", "grandchild"]]),
    });
    expect(stamped[1]).toMatchObject({
      base_subtree_hash: subtreeHash([["r", "root"], ["c2", "child two"]]),
    });
  });

  test("a child update then a parent delete hashes the updated text", () => {
    const stamped = stampBaseTextHashes(tree(), "AI", [
      { op: "update_text", uid: "g", text: "edited" },
      { op: "delete", uid: "r" },
    ]);
    expect(stamped[1]).toMatchObject({
      base_subtree_hash: subtreeHash([
        ["r", "root"], ["c1", "child one"], ["g", "edited"], ["c2", "child two"],
      ]),
    });
  });
});

describe("nodeSubtreePairs", () => {
  test("lists the node and every descendant as (uid, text)", () => {
    const node = block("r", "root", {
      children: [block("c", "kid", { children: [block("g", "")] })],
    });
    expect(nodeSubtreePairs(node)).toEqual([
      ["r", "root"], ["c", "kid"], ["g", ""],
    ]);
  });
});

describe("withoutStamps", () => {
  test("withoutStamps drops both stamps and keeps the op", () => {
    expect(withoutStamps({
      op: "update_text", uid: "a", text: "t",
      base_text_hash: "h" as Sha256Hex, page_title: "P",
    })).toEqual({ op: "update_text", uid: "a", text: "t" });
  });
});
