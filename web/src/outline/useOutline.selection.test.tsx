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
