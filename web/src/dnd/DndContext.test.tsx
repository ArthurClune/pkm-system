import { render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync } from "../test-helpers";
import { DndProvider, useDnd, type OutlineDndApi } from "./DndContext";

function Harness({ onReady }: { onReady: (dnd: ReturnType<typeof useDnd>) => void }) {
  const dnd = useDnd();
  useEffect(() => onReady(dnd), [dnd, onReady]);
  return null;
}

function setup() {
  const sync = makeSync();
  let dnd!: ReturnType<typeof useDnd>;
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider><Harness onReady={(d) => { dnd = d; }} /></DndProvider>
    </SyncContext.Provider>);
  return { sync, dnd: () => dnd };
}

function fakeOutline(over: Partial<OutlineDndApi> = {}): OutlineDndApi {
  return { moveTo: vi.fn(), removeSubtreeLocal: vi.fn(() => null),
           insertSubtreeLocal: vi.fn(), refetch: vi.fn(), ...over };
}

it("same-page drop delegates to the registered outline's moveTo", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  dnd().registerOutline("P", api);
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: null, order_idx: 2, page_title: "P" });
  expect(api.moveTo).toHaveBeenCalledWith("u1",
    { parent_uid: null, order_idx: 2, page_title: "P" });
  expect(sync.sent).toEqual([]); // moveTo enqueues internally, fake doesn't
});

it("same-page drop with no registered outline enqueues the op directly", () => {
  const { sync, dnd } = setup();
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: "x", order_idx: 0, page_title: "P" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: "x", order_idx: 0 }]]);
});

it("cross-page drop does two-outline surgery and one op with page_title", () => {
  const { sync, dnd } = setup();
  const moved: BlockNode = block("u1", "hi");
  const src = fakeOutline({ removeSubtreeLocal: vi.fn(() => moved) });
  const dst = fakeOutline();
  dnd().registerOutline("A", src);
  dnd().registerOutline("B", dst);
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(src.removeSubtreeLocal).toHaveBeenCalledWith("u1");
  expect(dst.insertSubtreeLocal).toHaveBeenCalledWith(moved,
    { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1,
      page_title: "B" }]]);
});

it("cross-page drop with unregistered source refetches the registered target", async () => {
  const { sync, dnd } = setup();
  const enqueueSpy = vi.spyOn(sync, "enqueue");
  const dst = fakeOutline();
  dnd().registerOutline("B", dst);
  // source page "A" has no registered outline (e.g. a panel of an unopened
  // page): removeSubtreeLocal never runs, so there's no subtree to insert —
  // the target must pull authoritative state instead.
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 1, page_title: "B" });
  await Promise.resolve(); await Promise.resolve(); // idle() microtasks
  expect(dst.refetch).toHaveBeenCalled();
  expect(dst.insertSubtreeLocal).not.toHaveBeenCalled();
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1,
      page_title: "B" }]]);
  // ordering is load-bearing: refetch's internal idle() gate only awaits
  // the move POST if the op is already queued when refetch runs. Refetching
  // first would let the authoritative GET race ahead of the move and adopt
  // a pre-move tree — the dropped block would vanish until reload.
  expect(enqueueSpy.mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(dst.refetch).mock.invocationCallOrder[0]);
});

it("cross-page drop with unregistered target only removes from the source", () => {
  const { sync, dnd } = setup();
  const moved: BlockNode = block("u1", "hi");
  const src = fakeOutline({ removeSubtreeLocal: vi.fn(() => moved) });
  dnd().registerOutline("A", src);
  // target page "B" has no registered outline: nothing to insert into and
  // nothing to refetch.
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(src.removeSubtreeLocal).toHaveBeenCalledWith("u1");
  expect(src.insertSubtreeLocal).not.toHaveBeenCalled();
  expect(src.refetch).not.toHaveBeenCalled();
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1,
      page_title: "B" }]]);
});

it("panels for both pages refetch after the queue drains", async () => {
  const { dnd } = setup();
  const srcRefetch = vi.fn();
  const dstRefetch = vi.fn();
  dnd().registerPanel("A", srcRefetch);
  dnd().registerPanel("B", dstRefetch);
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 0, page_title: "B" });
  await Promise.resolve(); await Promise.resolve(); // idle() microtasks
  expect(srcRefetch).toHaveBeenCalled();
  expect(dstRefetch).toHaveBeenCalled();
});

it("unregister stops delivery", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  const off = dnd().registerOutline("P", api);
  off();
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: null, order_idx: 0, page_title: "P" });
  expect(api.moveTo).not.toHaveBeenCalled();
  expect(sync.sent.length).toBe(1); // fell back to direct enqueue
});
