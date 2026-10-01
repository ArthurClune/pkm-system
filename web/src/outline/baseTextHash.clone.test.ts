import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { block, ord, uid } from "../test-helpers";
import { stampBaseTextHashes } from "./baseTextHash";
import * as treeModule from "./tree";

// stampBaseTextHashes is the thing under test; this file only exists apart
// from baseTextHash.test.ts because the partial mock of ./tree below would
// otherwise apply to every test in that file.
vi.mock("./tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tree")>();
  return { ...actual, cloneTree: vi.fn(actual.cloneTree) };
});

const cloneTreeMock = treeModule.cloneTree as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cloneTreeMock.mockClear();
});

function flatTree(count: number): BlockNode[] {
  return Array.from(
    { length: count },
    (_, i) => block(`n${i}`, `text${i}`, { order_idx: ord(i) }),
  );
}

describe("stampBaseTextHashes clones the tree at most once per batch", () => {
  test("a 100-delete batch clones exactly once, not once per delete", () => {
    const tree = flatTree(101);
    const ops: BlockOp[] = tree.slice(0, 100).map((n) => ({ op: "delete", uid: n.uid }));

    stampBaseTextHashes(tree, "AI", ops);

    expect(cloneTreeMock).toHaveBeenCalledTimes(1);
  });

  test("a batch with a single op needing a stamp clones zero times", () => {
    const tree = flatTree(2);
    const ops: BlockOp[] = [{ op: "delete", uid: uid("n0") }];

    stampBaseTextHashes(tree, "AI", ops);

    expect(cloneTreeMock).not.toHaveBeenCalled();
  });

  test("a batch needing no stamps clones zero times", () => {
    const tree = flatTree(2);
    const ops: BlockOp[] = [
      { op: "move", uid: uid("n0"), parent_uid: null, order_idx: ord(1) },
      { op: "set_collapsed", uid: uid("n1"), collapsed: true },
    ];

    stampBaseTextHashes(tree, "AI", ops);

    expect(cloneTreeMock).not.toHaveBeenCalled();
  });
});

describe("stampBaseTextHashes leaves the caller's tree untouched", () => {
  test("a multi-delete batch does not mutate the input blocks", () => {
    const tree = flatTree(5);
    const before = structuredClone(tree);
    const ops: BlockOp[] = [
      { op: "delete", uid: uid("n0") },
      { op: "delete", uid: uid("n1") },
      { op: "delete", uid: uid("n2") },
    ];

    stampBaseTextHashes(tree, "AI", ops);

    expect(tree).toEqual(before);
  });
});
