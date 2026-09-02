import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import type { OutlineHandlers } from "../outline/handlers";
import * as tokenize from "../grammar/tokenize";
import { EditableBlockTree } from "./EditableBlockTree";

// The real module with one export watched. Every rendered row tokenizes its
// own text, so the call count is a direct count of rows that re-rendered —
// and a wasted re-render is invisible in the DOM, since React reconciles an
// unchanged render to nothing (pkm-qfee).
vi.mock("../grammar/tokenize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grammar/tokenize")>();
  return { ...actual, tokenizeBlock: vi.fn(actual.tokenizeBlock) };
});

const handlers = () =>
  new Proxy({}, { get: () => vi.fn() }) as unknown as OutlineHandlers;

const rows = (n: number): BlockNode[] =>
  Array.from({ length: n }, (_, i) =>
    block(`u${i}`, `row ${i}`, { order_idx: i }));

/** A parent that re-renders the tree on demand with byte-identical props. */
function Harness({ blocks }: { blocks: BlockNode[] }) {
  const [bumps, setBumps] = useState(0);
  const [shown, setShown] = useState(blocks);
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <button onClick={() => setBumps((n) => n + 1)}>bump {bumps}</button>
      <button onClick={() => setShown(rows(blocks.length))}>replace</button>
      <EditableBlockTree blocks={shown} focus={null} handlers={HANDLERS}
                         readOnly={false} />
    </MemoryRouter>
  );
}

const HANDLERS = handlers();

const tokenizeCalls = () => vi.mocked(tokenize.tokenizeBlock).mock.calls.length;

beforeEach(() => { vi.mocked(tokenize.tokenizeBlock).mockClear(); });

test("a parent re-render with unchanged props re-renders no block row", () => {
  render(<Harness blocks={rows(20)} />);
  const afterMount = tokenizeCalls();
  expect(afterMount).toBeGreaterThanOrEqual(20);

  fireEvent.click(screen.getByText(/^bump/));

  // React.memo plus per-tree-stable props: nothing about these rows changed,
  // so none of them runs again. Journal mounts one of these trees per loaded
  // day, which is what makes a stray re-render expensive.
  expect(tokenizeCalls()).toBe(afterMount);
});

test("a new block tree still re-renders the rows", () => {
  render(<Harness blocks={rows(20)} />);
  vi.mocked(tokenize.tokenizeBlock).mockClear();

  fireEvent.click(screen.getByText("replace"));

  // The control for the test above: applyOps rebuilds every node object, so a
  // real edit must not be memoised away.
  expect(tokenizeCalls()).toBeGreaterThanOrEqual(20);
});
