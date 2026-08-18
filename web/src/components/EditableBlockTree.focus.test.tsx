import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import type { OutlineHandlers } from "../outline/handlers";
import * as tree from "../outline/tree";
import { EditableBlockTree } from "./EditableBlockTree";

// The real module with one export watched: this file asserts HOW OFTEN the
// tree walks itself, so the walk has to be countable (pkm-nvxh).
vi.mock("../outline/tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../outline/tree")>();
  return { ...actual, ancestorChain: vi.fn(actual.ancestorChain) };
});

/** Every handler a no-op: nothing here fires one, and listing the whole port
 * would say nothing about what these tests check. */
const handlers = () =>
  new Proxy({}, { get: () => vi.fn() }) as unknown as OutlineHandlers;

/** A spine of nested blocks, "b0" outermost down to "b{depth-1}". */
function spine(depth: number): BlockNode[] {
  let node = block(`b${depth - 1}`, `text ${depth - 1}`);
  for (let i = depth - 2; i >= 0; i--) {
    node = block(`b${i}`, `text ${i}`, { children: [node] });
  }
  return [node];
}

function table(uid: string): BlockNode {
  return block(uid, "{{[[table]]}}", { children: [
    block(`${uid}-row`, "Claude", { children: [block(`${uid}-cell`, "$5")] }),
  ] });
}

function mount(blocks: BlockNode[], focus: { uid: string; cursor: number } | null) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={focus} handlers={handlers()}
                         readOnly={false} />
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.mocked(tree.ancestorChain).mockClear(); });

test("walks for the focused block's ancestors once per render, not once per row",
     () => {
  mount(spine(12), { uid: "b11", cursor: 0 });

  // Twelve rendered rows, one walk: the per-row "is the focus inside me?"
  // test is a lookup in the chain the root computed. A walk per row is the
  // regression this guards (it ran on every keystroke's re-render).
  expect(document.querySelectorAll(".block-row")).toHaveLength(12);
  expect(vi.mocked(tree.ancestorChain)).toHaveBeenCalledTimes(1);
});

test("does not walk at all when no block is focused", () => {
  mount(spine(4), null);

  expect(vi.mocked(tree.ancestorChain)).not.toHaveBeenCalled();
});

test("focus inside one table subtree leaves a sibling table rendered", () => {
  mount([table("t1"), table("t2")], { uid: "t1-cell", cursor: 0 });

  // t1 is in raw editable rows; t2 is untouched by t1's focus.
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getByRole("textbox")).toHaveValue("$5");
});
