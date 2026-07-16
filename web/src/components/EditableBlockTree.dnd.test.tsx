import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { DndProvider } from "../dnd/DndContext";
import { registerOutline as registerActiveOutline } from "../outline/activeOutlines";
import { EditablePage } from "../views/EditablePage";
import { block, makeSync } from "../test-helpers";

// jsdom has no DataTransfer: minimal stub
function dt() {
  const data: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "", dropEffect: "",
  };
}

function renderPage(blocks = [
  block("u1", "one", { order_idx: 0 }),
  block("u2", "two", { order_idx: 1 }),
]) {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}><EditablePage title="P" initial={blocks} /></MemoryRouter>
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
    { op: "move", uid: "u2", parent_uid: null, order_idx: 0 }]]);
  // optimistic: u2 now renders first
  const texts = [...document.querySelectorAll(".block-text")].map((n) => n.textContent);
  expect(texts).toEqual(["two", "one"]);
});

it("dragging a block inside a multi-block selection moves the whole selection (pkm-q89w)", () => {
  const sync = renderPage([
    block("u1", "one", { order_idx: 0 }),
    block("u2", "two", { order_idx: 1 }),
    block("u3", "three", { order_idx: 2 }),
  ]);
  // select u2 + u3 through the real editor wiring (Shift+ArrowDown at edge)
  fireEvent.click(screen.getByText("two"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(2);

  // drag u2's bullet to the top boundary: the whole [u2, u3] run moves
  const transfer = dt();
  fireEvent.dragStart(document.querySelector('[data-uid="u2"] .bullet')!,
                      { dataTransfer: transfer });
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "u2", parent_uid: null, order_idx: 0 },
    { op: "move", uid: "u3", parent_uid: null, order_idx: 1 },
  ]]);
  const texts = [...document.querySelectorAll(".block-text")].map((n) => n.textContent);
  expect(texts).toEqual(["two", "three", "one"]);
});

it("dragging a block outside the selection moves only that block (pkm-q89w)", () => {
  const sync = renderPage([
    block("u1", "one", { order_idx: 0 }),
    block("u2", "two", { order_idx: 1 }),
    block("u3", "three", { order_idx: 2 }),
  ]);
  // select u1 + u2, then drag the unselected u3
  fireEvent.click(screen.getByText("one"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(2);

  const transfer = dt();
  fireEvent.dragStart(document.querySelector('[data-uid="u3"] .bullet')!,
                      { dataTransfer: transfer });
  const zone = document.querySelector(".block-tree")!;
  fireEvent.dragOver(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: -1, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "u3", parent_uid: null, order_idx: 0 },
  ]]);
});

it("an empty page accepts a top-level drop from another page", () => {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title="Src" initial={[block("s1", "from src")]} />
          <EditablePage title="Empty" initial={[]} />
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
    { op: "move", uid: "s1", parent_uid: null, order_idx: 0,
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

it("a fallback panel (title already active elsewhere) is excluded from DnD both ways", () => {
  // Claim "P" as the live instance elsewhere in the tab, so the P mount below
  // renders as the read-only fallback.
  const release = registerActiveOutline("P");
  try {
    const sync = makeSync();
    render(
      <SyncContext.Provider value={sync}>
        <DndProvider>
          <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
            <EditablePage title="Src" initial={[block("s1", "from src")]} />
            <EditablePage title="P" initial={[block("u1", "fallback block")]} />
          </MemoryRouter>
        </DndProvider>
      </SyncContext.Provider>);

    // Drag OUT is impossible: the fallback's bullet is not draggable.
    const fallbackBullet = document.querySelector('[data-uid="u1"] .bullet')!;
    expect(fallbackBullet).not.toHaveAttribute("draggable", "true");

    // Drag IN is impossible: the fallback contributes no drop zone — the only
    // .outline-drop-zone in the document is the live "Src" page.
    expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);

    // And a real drop attempt over the fallback tree is inert: dragging a
    // "Src" block over the fallback's block-tree enqueues nothing, because the
    // fallback has no drop handlers.
    const srcBullet = document.querySelector('[data-uid="s1"] .bullet')!;
    const transfer = dt();
    fireEvent.dragStart(srcBullet, { dataTransfer: transfer });
    const fallbackTree = document.querySelector('[data-uid="u1"]')!.closest(".block-tree")!;
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
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}><EditablePage title="P" initial={[block("u1", "x")]} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  expect(document.querySelector(".bullet")).toHaveAttribute("draggable", "false");
});

it("hands DnD registration to the remaining same-title view", () => {
  const sync = makeSync();
  const blocks = [
    block("u1", "one", { order_idx: 0 }),
    block("u2", "two", { order_idx: 1 }),
  ];
  const view = (includeFirst: boolean) => (
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          {includeFirst && (
            <EditablePage key="first" title="P" initial={blocks} />
          )}
          <EditablePage key="second" title="P" initial={blocks} />
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
    { op: "move", uid: "u2", parent_uid: null, order_idx: 0 },
  ]]);
});
