import { render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext, type Sync } from "../sync/SyncProvider";
import { block, makeSync } from "../test-helpers";
import { DndProvider, useDnd, type OutlineDndApi } from "./DndContext";

function Harness({ onReady }: { onReady: (dnd: ReturnType<typeof useDnd>) => void }) {
  const dnd = useDnd();
  useEffect(() => onReady(dnd), [dnd, onReady]);
  return null;
}

function setup(over: Record<string, unknown> = {}) {
  const sync = makeSync("connected", over as Partial<Sync>);
  let dnd!: ReturnType<typeof useDnd>;
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider><Harness onReady={(d) => { dnd = d; }} /></DndProvider>
    </SyncContext.Provider>);
  return { sync, dnd: () => dnd };
}

function fakeOutline(over: Partial<OutlineDndApi> = {}): OutlineDndApi {
  return { moveTo: vi.fn(), removeSubtreeLocal: vi.fn(() => null),
           insertSubtreeLocal: vi.fn(), ...over };
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
  expect(sync.tickets[0].scope).toEqual(["page", "P"]);
});

it("cross-page drop does two-outline surgery and one op with page_title", () => {
  const attachOutlineReplay = vi.fn();
  const { sync, dnd } = setup({ attachOutlineReplay });
  const moved: BlockNode = block("u1", "hi", {
    children: [block("child", "child")],
  });
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
  expect(sync.tickets[0].scope).toEqual(["page", "A", "B"]);
  expect(attachOutlineReplay).toHaveBeenCalledWith(
    sync.tickets[0], "B", [{
      type: "insert-subtree", node: moved, parentUid: null, orderIdx: 1,
    }],
  );
});

it("unmounted cross-page target skips insertion but retains subtree replay", () => {
  const attachOutlineReplay = vi.fn();
  const { sync, dnd } = setup({ attachOutlineReplay });
  const moved: BlockNode = block("u1", "hi", {
    children: [block("child", "child")],
  });
  const src = fakeOutline({ removeSubtreeLocal: vi.fn(() => moved) });
  const unmountedDst = fakeOutline();
  dnd().registerOutline("A", src);
  const targetRegistration = dnd().registerOutline("B", unmountedDst);
  if (targetRegistration.accepted) targetRegistration.unregister();
  // target page "B" has no registered outline: nothing to insert into.
  dnd().drop({ uid: "u1", pageTitle: "A" },
             { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(src.removeSubtreeLocal).toHaveBeenCalledWith("u1");
  expect(unmountedDst.insertSubtreeLocal).not.toHaveBeenCalled();
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1,
      page_title: "B" }]]);
  expect(attachOutlineReplay).toHaveBeenCalledWith(
    sync.tickets[0], "B", [{
      type: "insert-subtree", node: moved, parentUid: null, orderIdx: 1,
    }],
  );
});

it("cross-page drop without a source node fabricates no target replay", () => {
  const attachOutlineReplay = vi.fn();
  const { sync, dnd } = setup({ attachOutlineReplay });
  const dst = fakeOutline();
  dnd().registerOutline("B", dst);

  dnd().drop({ uid: "missing", pageTitle: "A" },
             { parent_uid: null, order_idx: 0, page_title: "B" });

  expect(dst.insertSubtreeLocal).not.toHaveBeenCalled();
  expect(attachOutlineReplay).not.toHaveBeenCalled();
  expect(sync.sent).toEqual([[
    { op: "move", uid: "missing", parent_uid: null, order_idx: 0,
      page_title: "B" },
  ]]);
});

it("unregister stops delivery", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  const registration = dnd().registerOutline("P", api);
  expect(registration.accepted).toBe(true);
  if (registration.accepted) registration.unregister();
  dnd().drop({ uid: "u1", pageTitle: "P" },
             { parent_uid: null, order_idx: 0, page_title: "P" });
  expect(api.moveTo).not.toHaveBeenCalled();
  expect(sync.sent.length).toBe(1); // fell back to direct enqueue
});

it.each(["first", "duplicate"] as const)(
  "rejects a duplicate title and cleanup of the %s registration is token-safe",
  (released) => {
    const { sync, dnd } = setup();
    const first = fakeOutline();
    const duplicate = fakeOutline();
    const firstRegistration = dnd().registerOutline("P", first);
    const duplicateRegistration = dnd().registerOutline("P", duplicate);

    expect(firstRegistration.accepted).toBe(true);
    expect(duplicateRegistration).toEqual({
      accepted: false,
      reason: "duplicate-title",
    });
    if (released === "first" && firstRegistration.accepted) {
      firstRegistration.unregister();
    }

    dnd().drop({ uid: "u1", pageTitle: "P" },
      { parent_uid: null, order_idx: 0, page_title: "P" });
    if (released === "first") {
      expect(first.moveTo).not.toHaveBeenCalled();
      expect(sync.sent).toHaveLength(1);
    } else {
      expect(first.moveTo).toHaveBeenCalledTimes(1);
      expect(sync.sent).toEqual([]);
    }
    expect(duplicate.moveTo).not.toHaveBeenCalled();
  },
);
