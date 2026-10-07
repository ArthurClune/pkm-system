import { createEvent, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext, type Sync } from "../sync/SyncProvider";
import { block, makeSync, ord, uid } from "../test-helpers";
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
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "P" },
             { parent_uid: null, order_idx: ord(2), page_title: "P" });
  expect(api.moveTo).toHaveBeenCalledWith(["u1"],
    { parent_uid: null, order_idx: 2, page_title: "P" });
  expect(sync.sent).toEqual([]); // moveTo enqueues internally, fake doesn't
});

it("a same-page group drop passes the whole selection to moveTo", () => {
  const { sync, dnd } = setup();
  const api = fakeOutline();
  dnd().registerOutline("P", api);
  dnd().drop({ kind: "blocks", uid: uid("u2"), pageTitle: "P", uids: [uid("u1"), uid("u2"), uid("u3")] },
             { parent_uid: null, order_idx: ord(5), page_title: "P" });
  expect(api.moveTo).toHaveBeenCalledWith(["u1", "u2", "u3"],
    { parent_uid: null, order_idx: 5, page_title: "P" });
  expect(sync.sent).toEqual([]);
});

it("same-page drop with no registered outline enqueues the op directly", () => {
  const { sync, dnd } = setup();
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "P" },
             { parent_uid: uid("x"), order_idx: ord(0), page_title: "P" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: "x", order_idx: 0 }]]);
  expect(sync.tickets[0].scope).toEqual(["page", "P"]);
});

it("group drop with no registered outline enqueues sequential move ops", () => {
  const { sync, dnd } = setup();
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "P", uids: [uid("u1"), uid("u2")] },
             { parent_uid: uid("x"), order_idx: ord(3), page_title: "P" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: "x", order_idx: 3 },
    { op: "move", uid: "u2", parent_uid: "x", order_idx: 4 }]]);
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
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "A" },
             { parent_uid: null, order_idx: ord(1), page_title: "B" });
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
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "A" },
             { parent_uid: null, order_idx: ord(1), page_title: "B" });
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

it("a cross-page group drop moves every block: surgery, ops, and replays", () => {
  const attachOutlineReplay = vi.fn();
  const { sync, dnd } = setup({ attachOutlineReplay });
  const one: BlockNode = block("u1", "one");
  const two: BlockNode = block("u2", "two");
  const removeSubtreeLocal = vi.fn((uid: string) =>
    uid === "u1" ? one : uid === "u2" ? two : null);
  const src = fakeOutline({ removeSubtreeLocal });
  const dst = fakeOutline();
  dnd().registerOutline("A", src);
  dnd().registerOutline("B", dst);
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "A", uids: [uid("u1"), uid("u2")] },
             { parent_uid: null, order_idx: ord(1), page_title: "B" });
  expect(removeSubtreeLocal.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
  expect(dst.insertSubtreeLocal).toHaveBeenNthCalledWith(1, one,
    { parent_uid: null, order_idx: 1, page_title: "B" });
  expect(dst.insertSubtreeLocal).toHaveBeenNthCalledWith(2, two,
    { parent_uid: null, order_idx: 2, page_title: "B" });
  expect(sync.sent).toEqual([[
    { op: "move", uid: "u1", parent_uid: null, order_idx: 1, page_title: "B" },
    { op: "move", uid: "u2", parent_uid: null, order_idx: 2, page_title: "B" },
  ]]);
  expect(attachOutlineReplay).toHaveBeenCalledWith(
    sync.tickets[0], "B", [
      { type: "insert-subtree", node: one, parentUid: null, orderIdx: 1 },
      { type: "insert-subtree", node: two, parentUid: null, orderIdx: 2 },
    ],
  );
});

it("cross-page drop without a source node fabricates no target replay", () => {
  const attachOutlineReplay = vi.fn();
  const { sync, dnd } = setup({ attachOutlineReplay });
  const dst = fakeOutline();
  dnd().registerOutline("B", dst);

  dnd().drop({ kind: "blocks", uid: uid("missing"), pageTitle: "A" },
             { parent_uid: null, order_idx: ord(0), page_title: "B" });

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
  dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "P" },
             { parent_uid: null, order_idx: ord(0), page_title: "P" });
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

    dnd().drop({ kind: "blocks", uid: uid("u1"), pageTitle: "P" },
      { parent_uid: null, order_idx: ord(0), page_title: "P" });
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

// --- the window guard: a file nobody takes must not navigate the browser ---

const fileTransfer = () => ({ types: ["Files"], items: [], files: [], dropEffect: "" });

it("refuses a files dragover nothing handled, so the drop cannot navigate", () => {
  setup();
  const transfer = fileTransfer();
  const ev = createEvent.dragOver(document.body, { dataTransfer: transfer });
  fireEvent(document.body, ev);
  expect(ev.defaultPrevented).toBe(true);
  expect(transfer.dropEffect).toBe("none");
});

it("swallows a files drop nothing handled", () => {
  setup();
  const ev = createEvent.drop(document.body, { dataTransfer: fileTransfer() });
  fireEvent(document.body, ev);
  expect(ev.defaultPrevented).toBe(true);
});

it("leaves a files dragover over a text field to the field", () => {
  setup();
  const ta = document.body.appendChild(document.createElement("textarea"));
  const ev = createEvent.dragOver(ta, { dataTransfer: fileTransfer() });
  fireEvent(ta, ev);
  expect(ev.defaultPrevented).toBe(false);
  ta.remove();
});

it("does not touch a dragover a zone already accepted", () => {
  setup();
  const transfer = fileTransfer();
  const zone = document.body.appendChild(document.createElement("div"));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); transfer.dropEffect = "copy"; });
  fireEvent.dragOver(zone, { dataTransfer: transfer });
  expect(transfer.dropEffect).toBe("copy");
  zone.remove();
});

it("ignores drags that carry no files (text, links, blocks)", () => {
  setup();
  const ev = createEvent.dragOver(document.body, {
    dataTransfer: { types: ["text/plain"], items: [], files: [], dropEffect: "" } });
  fireEvent(document.body, ev);
  expect(ev.defaultPrevented).toBe(false);
  const dropEv = createEvent.drop(document.body, {
    dataTransfer: { types: ["text/plain"], items: [], files: [], dropEffect: "" } });
  fireEvent(document.body, dropEv);
  expect(dropEv.defaultPrevented).toBe(false);
});
