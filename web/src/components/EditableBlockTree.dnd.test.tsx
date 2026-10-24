import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { DndProvider, useDnd } from "../dnd/DndContext";
import { EditablePage } from "../views/EditablePage";
import { block, makeSync, orderIdxOf, reserveOutlineEditor, canonicalTitleOf } from "../test-helpers";

// jsdom has no DataTransfer: minimal stub
function dt() {
  const data: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "", dropEffect: "",
  };
}

function Harness({ onReady }: { onReady: (dnd: ReturnType<typeof useDnd>) => void }) {
  const dnd = useDnd();
  useEffect(() => onReady(dnd), [dnd, onReady]);
  return null;
}

function renderPage(blocks = [
  block("tuid-u1", "one", { order_idx: orderIdxOf(0) }),
  block("tuid-u2", "two", { order_idx: orderIdxOf(1) }),
], onDnd: (dnd: ReturnType<typeof useDnd>) => void = () => undefined) {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <Harness onReady={onDnd} />
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title={canonicalTitleOf("P")} initial={blocks} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  return sync;
}

it("bullets are draggable and a drop reorders via one move op", () => {
  const sync = renderPage();
  const bullets = document.querySelectorAll(".bullet");
  expect(bullets[0]).toHaveAttribute("draggable", "true");

  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer });
  // drop at the very top boundary (above row u1): rects are all 0 in
  // jsdom, so clientY 0 maps to boundary 0 and clientX 0 to depth 0
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-u2", parent_uid: null, order_idx: 0 }]]);
  // optimistic: u2 now renders first
  const texts = [...document.querySelectorAll(".block-text")].map((n) => n.textContent);
  expect(texts).toEqual(["two", "one"]);
});

it("dragging a block inside a multi-block selection moves the whole selection", () => {
  const sync = renderPage([
    block("tuid-u1", "one", { order_idx: orderIdxOf(0) }),
    block("tuid-u2", "two", { order_idx: orderIdxOf(1) }),
    block("tuid-u3", "three", { order_idx: orderIdxOf(2) }),
  ]);
  // select u2 + u3 through the real editor wiring (Shift+ArrowDown at edge)
  fireEvent.click(screen.getByText("two"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(2);

  // drag u2's bullet to the top boundary: the whole [u2, u3] run moves
  const transfer = dt();
  fireEvent.dragStart(document.querySelector('[data-uid="tuid-u2"] .bullet')!,
                      { dataTransfer: transfer });
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-u2", parent_uid: null, order_idx: 0 },
    { op: "move", uid: "tuid-u3", parent_uid: null, order_idx: 1 },
  ]]);
  const texts = [...document.querySelectorAll(".block-text")].map((n) => n.textContent);
  expect(texts).toEqual(["two", "three", "one"]);
});

// A cross-page drop moves the block with sync.enqueue, past run()'s depth
// check, so the height measured here is the web's only bound on that path.
it("a drag carries the grabbed block's subtree height", () => {
  let dnd!: ReturnType<typeof useDnd>;
  renderPage([
    block("tuid-u1", "one", { order_idx: orderIdxOf(0), children: [
      block("tuid-u1a", "one a", { children: [block("tuid-u1b", "one b")] }),
    ] }),
    block("tuid-u2", "two", { order_idx: orderIdxOf(1) }),
  ], (d) => { dnd = d; });

  fireEvent.dragStart(document.querySelector('[data-uid="tuid-u1"] .bullet')!,
                      { dataTransfer: dt() });
  expect(dnd.drag).toEqual({ kind: "blocks", uid: "tuid-u1", pageTitle: "P",
                             height: 2 });
});

it("a selection drag carries the tallest root's height, not the grabbed one's", () => {
  let dnd!: ReturnType<typeof useDnd>;
  renderPage([
    block("tuid-u1", "one", { order_idx: orderIdxOf(0) }),
    block("tuid-u2", "two", { order_idx: orderIdxOf(1), children: [
      block("tuid-u2a", "two a", { children: [
        block("tuid-u2b", "two b", { children: [block("tuid-u2c", "two c")] }),
      ] }),
    ] }),
  ], (d) => { dnd = d; });
  fireEvent.click(screen.getByText("one"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });

  // grab the leaf root: the selection's other root is three levels tall
  fireEvent.dragStart(document.querySelector('[data-uid="tuid-u1"] .bullet')!,
                      { dataTransfer: dt() });
  expect(dnd.drag).toEqual({ kind: "blocks", uid: "tuid-u1", pageTitle: "P",
                             uids: ["tuid-u1", "tuid-u2"], height: 3 });
});

it("dragging a block outside the selection moves only that block", () => {
  const sync = renderPage([
    block("tuid-u1", "one", { order_idx: orderIdxOf(0) }),
    block("tuid-u2", "two", { order_idx: orderIdxOf(1) }),
    block("tuid-u3", "three", { order_idx: orderIdxOf(2) }),
  ]);
  // select u1 + u2, then drag the unselected u3
  fireEvent.click(screen.getByText("one"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(2);

  const transfer = dt();
  fireEvent.dragStart(document.querySelector('[data-uid="tuid-u3"] .bullet')!,
                      { dataTransfer: transfer });
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-u3", parent_uid: null, order_idx: 0 },
  ]]);
});

it("an empty page accepts a top-level drop from another page", () => {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title={canonicalTitleOf("Src")} initial={[block("tuid-s1", "from src")]} />
          <EditablePage title={canonicalTitleOf("Empty")} initial={[]} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);

  // drag starts on the source page's bullet (only page with any blocks)
  const srcBullet = document.querySelector(".bullet")!;
  const transfer = dt();
  fireEvent.dragStart(srcBullet, { dataTransfer: transfer });

  const zone = screen.getByText(/start writing/i).closest(".empty-drop-zone")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-s1", parent_uid: null, order_idx: 0,
      page_title: "Empty" }]]);
});

it("dragleave clears the drop indicator", () => {
  renderPage();
  const bullets = document.querySelectorAll(".bullet");
  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer });

  const zone = document.querySelector(".outline-drop-zone")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  expect(document.querySelector(".drop-indicator")).not.toBeNull();

  // pointer left the zone (relatedTarget outside): the indicator clears
  fireEvent.dragLeave(zone, { dataTransfer: transfer });
  expect(document.querySelector(".drop-indicator")).toBeNull();
});

it("dragend without a drop clears the active drag so a later drop is inert", () => {
  const sync = renderPage();
  const bullets = document.querySelectorAll(".bullet");
  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer });

  const zone = document.querySelector(".outline-drop-zone")!;
  // arm a drop candidate, then abandon the drag (dropped outside any zone)
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  expect(document.querySelector(".drop-indicator")).not.toBeNull(); // drag armed
  fireEvent.dragEnd(bullets[1], { dataTransfer: transfer });

  // the context drag is gone: even with a live candidate, drop resolves
  // nothing and enqueues no op.
  fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  expect(sync.sent).toEqual([]);
  expect(document.querySelector(".drop-indicator")).toBeNull();
});

it("a drop that changes nothing enqueues nothing and still ends the drag", () => {
  const sync = renderPage();
  const bullets = document.querySelectorAll(".bullet");
  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer }); // u2, already last

  const zone = document.querySelector(".outline-drop-zone")!;
  // rects are all zero in jsdom, so clientY 0 is below every midpoint: this
  // is the boundary after the last row, which is where u2 already sits.
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  expect(sync.sent).toEqual([]);
  expect(document.querySelector(".drop-indicator")).toBeNull();

  // and the drag really is over, rather than left armed for a later drop
  fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: transfer });
  expect(sync.sent).toEqual([]);
});

it("a fallback panel (title already active elsewhere) is excluded from DnD both ways", () => {
  // Claim "P" as the live instance elsewhere in the tab, so the P mount below
  // renders as the read-only fallback.
  const release = reserveOutlineEditor(canonicalTitleOf("P"));
  try {
    const sync = makeSync();
    render(
      <SyncContext.Provider value={sync}>
        <DndProvider>
          <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
            <EditablePage title={canonicalTitleOf("Src")} initial={[block("tuid-s1", "from src")]} />
            <EditablePage title={canonicalTitleOf("P")} initial={[block("tuid-u1", "fallback block")]} />
          </MemoryRouter>
        </DndProvider>
      </SyncContext.Provider>);

    // Drag OUT is impossible: the fallback's bullet is not draggable.
    const fallbackBullet = document.querySelector('[data-uid="tuid-u1"] .bullet')!;
    expect(fallbackBullet).not.toHaveAttribute("draggable", "true");

    // Drag IN is impossible: the fallback contributes no drop zone — the only
    // .outline-drop-zone in the document is the live "Src" page.
    expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);

    // And a real drop attempt over the fallback tree is inert: dragging a
    // "Src" block over the fallback's block-tree enqueues nothing, because the
    // fallback has no drop handlers.
    const srcBullet = document.querySelector('[data-uid="tuid-s1"] .bullet')!;
    const transfer = dt();
    fireEvent.dragStart(srcBullet, { dataTransfer: transfer });
    const fallbackTree = document.querySelector('[data-uid="tuid-u1"]')!.closest(".block-tree")!;
    fireEvent.dragOver(fallbackTree, { clientX: 0, clientY: 0, dataTransfer: transfer });
    fireEvent.drop(fallbackTree, { clientX: 0, clientY: 0, dataTransfer: transfer });
    expect(sync.sent).toEqual([]);
    expect(document.querySelector(".drop-indicator")).toBeNull();
  } finally {
    release();
  }
});

it("dragging is disabled when read-only", () => {
  const sync = makeSync("reconnecting");
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title={canonicalTitleOf("P")} initial={[block("tuid-u1", "x")]} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  expect(document.querySelector(".bullet")).toHaveAttribute("draggable", "false");
});

it("hands DnD registration to the remaining same-title view", () => {
  const sync = makeSync();
  const blocks = [
    block("tuid-u1", "one", { order_idx: orderIdxOf(0) }),
    block("tuid-u2", "two", { order_idx: orderIdxOf(1) }),
  ];
  const view = (includeFirst: boolean) => (
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          {includeFirst && (
            <EditablePage key="first" title={canonicalTitleOf("P")} initial={blocks} />
          )}
          <EditablePage key="second" title={canonicalTitleOf("P")} initial={blocks} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>
  );
  const { rerender } = render(view(true));
  rerender(view(false));

  const bullets = document.querySelectorAll(".bullet");
  expect(bullets).toHaveLength(2);
  expect(bullets[1]).toHaveAttribute("draggable", "true");
  const transfer = dt();
  fireEvent.dragStart(bullets[1], { dataTransfer: transfer });
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-u2", parent_uid: null, order_idx: 0 },
  ]]);
});
