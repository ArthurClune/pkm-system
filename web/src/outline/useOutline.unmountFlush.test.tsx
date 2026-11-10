// The unmount flush applies the last draft to the shared outline session
// before this outline lets go of it, so another surface of the same page (a
// sidebar panel) shows the edit at once rather than after the write settles.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, makeSync, orderIdxOf, uidOf,
         type SyncFake, typeInto } from "../test-helpers";
import { findNode } from "./tree";
import { useOutline, type Outline } from "./useOutline";

const PAGE = "Two Surfaces";
const UID = uidOf("tuid-a");

function Surface({ owner, onReady }: {
  owner: symbol; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(PAGE),
    [block(UID, "before", { order_idx: orderIdxOf(0) })], owner);
  useEffect(() => onReady(outline));
  return null;
}

function mount(sync: SyncFake, owner: symbol) {
  let outline!: Outline;
  const view = render(
    <SyncContext.Provider value={sync}>
      <Surface owner={owner} onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return { outline: () => outline, unmount: view.unmount };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([
  ["an ordinary draft", false],
  ["a held draft", true],
])("unmounting with %s shows it on the other surface at once",
   (_, held) => {
  const sync = makeSync();
  const main = mount(sync, Symbol("main"));
  const sidebar = mount(sync, Symbol("sidebar"));
  expect(main.outline().ownsEditor).toBe(true);
  act(() => main.outline().handlers.onFocusBlock(UID, 0));
  act(() => typeInto(main.outline(), UID, "before!", held));
  act(() => main.unmount());
  expect(sync.sent.flat()).toEqual([expect.objectContaining(
    { op: "update_text", uid: UID, text: "before!" })]);
  expect(sidebar.outline().ownsEditor).toBe(true);
  expect(findNode(sidebar.outline().blocks, UID)?.text).toBe("before!");
});
