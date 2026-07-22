// pkm-q89w: multi-block selection move + delete, wired through useOutline's
// handlers (the imperative half — confirm() gating and op dispatch — of the
// pure moveSelectionUp/moveSelectionDown/deleteSelection in edits.ts).
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

const abc = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", { order_idx: 1 }),
  block("c", "gamma", { order_idx: 2 }),
];

const crossParentTree = () => [
  block("a", "A", {
    order_idx: 0,
    children: [block("a0", "A child", { order_idx: 0 })],
  }),
  block("b", "B", {
    order_idx: 1,
    children: [
      block("b0", "B first", {
        order_idx: 0,
        children: [block("b0x", "B grandchild", { order_idx: 0 })],
      }),
      block("b1", "B second", { order_idx: 1 }),
    ],
  }),
  block("c", "C", { order_idx: 2 }),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

it("onMoveSelectionUp moves every selected block as a group, not just one", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("b", "down")); // anchor b, head c
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([
    [{ op: "move", uid: "a", parent_uid: null, order_idx: 3 }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["b", "c", "a"]);
  // the selection is unaffected — b and c never moved themselves
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });
});

it("onMoveSelectionDown moves every selected block as a group", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down")); // anchor a, head b

  act(() => getOutline().handlers.onMoveSelectionDown());

  expect(sync.sent).toEqual([
    [{ op: "move", uid: "c", parent_uid: null, order_idx: 0 }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["c", "a", "b"]);
});

it("queues and applies one cross-parent selection move batch", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection("b0", "down"));
  act(() => getOutline().handlers.onExtendBlockSelection("down"));
  expect(getOutline().selection).toEqual({ anchor: "b0", head: "b1" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "b0", parent_uid: "a", order_idx: 1 },
    { op: "move", uid: "b1", parent_uid: "a", order_idx: 2 },
  ]]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().blocks[0].children.map((n) => n.uid))
    .toEqual(["a0", "b0", "b1"]);
  expect(getOutline().blocks[0].children[1].children.map((n) => n.uid))
    .toEqual(["b0x"]);
  expect(getOutline().selection).toEqual({ anchor: "b0", head: "b1" });
});

it("does not enqueue when one selected movement run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection("a0", "down"));
  expect(getOutline().selection).toEqual({ anchor: "a0", head: "b" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "a0", head: "b" });
});

it("indents and outdents the selected run as one batch without clearing it", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("b", "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "b", parent_uid: "a", order_idx: 0 },
    { op: "move", uid: "c", parent_uid: "a", order_idx: 1 },
  ]]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a"]);
  expect(getOutline().blocks[0].children.map((b) => b.uid))
    .toEqual(["b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });

  act(() => getOutline().handlers.onOutdentSelection());

  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "b", parent_uid: null, order_idx: 1 },
    { op: "move", uid: "c", parent_uid: null, order_idx: 2 },
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });
});

it("keeps the whole selection unchanged when one indent run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "a", head: "b" });
});

it("onSelectBlock selects exactly that block and ends editing (pkm-am54)", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onFocusBlock("b", 2));

  act(() => getOutline().handlers.onSelectBlock("b"));

  expect(getOutline().selection).toEqual({ anchor: "b", head: "b" });
  expect(getOutline().focus).toBeNull();

  // further Ctrl+Cmd presses extend one block at a time from that anchor
  act(() => getOutline().handlers.onExtendBlockSelection("down"));
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });
});

it("deleting 5 or fewer selected blocks proceeds without confirmation", () => {
  const confirmSpy = vi.fn(() => false); // if this got called, the test should fail below
  vi.stubGlobal("confirm", confirmSpy);
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down")); // a, b selected

  act(() => getOutline().handlers.onDeleteBlockSelection());

  expect(confirmSpy).not.toHaveBeenCalled();
  expect(sync.sent).toEqual([
    [{ op: "delete", uid: "a" }, { op: "delete", uid: "b" }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["c"]);
  expect(getOutline().selection).toBeNull();
});

function sixBlocks() {
  return "abcdef".split("").map((uid, i) =>
    block(uid, uid, { order_idx: i }));
}

it("deleting more than 5 selected blocks requires confirmation, and honours cancel", () => {
  const confirmSpy = vi.fn((_message?: string) => false);
  vi.stubGlobal("confirm", confirmSpy);
  const sync = makeSync();
  const getOutline = setup(sync, "Page", sixBlocks());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down"));
  for (let i = 0; i < 4; i++) {
    act(() => getOutline().handlers.onExtendBlockSelection("down"));
  }
  expect(getOutline().selection).toEqual({ anchor: "a", head: "f" });

  act(() => getOutline().handlers.onDeleteBlockSelection());

  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(confirmSpy.mock.calls[0][0]).toMatch(/6 blocks/);
  // cancelled: nothing sent, nothing deleted, selection untouched
  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(sixBlocks().map((b) => b.uid));
  expect(getOutline().selection).toEqual({ anchor: "a", head: "f" });
});

it("deleting more than 5 selected blocks proceeds once confirmed", () => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  const sync = makeSync();
  const getOutline = setup(sync, "Page", sixBlocks());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down"));
  for (let i = 0; i < 4; i++) {
    act(() => getOutline().handlers.onExtendBlockSelection("down"));
  }

  act(() => getOutline().handlers.onDeleteBlockSelection());

  expect(sync.sent).toEqual([
    "abcdef".split("").map((uid) => ({ op: "delete", uid })),
  ]);
  expect(getOutline().blocks).toEqual([]);
  expect(getOutline().selection).toBeNull();
});
