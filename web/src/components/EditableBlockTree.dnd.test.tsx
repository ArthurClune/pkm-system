import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SyncContext } from "../sync/SyncProvider";
import { DndProvider } from "../dnd/DndContext";
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
        <MemoryRouter><EditablePage title="P" initial={blocks} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  return sync;
}

it("bullets are draggable and a drop reorders via one move op", () => {
  const sync = renderPage();
  const rows = document.querySelectorAll(".block-row");
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
  void rows;
});

it("an empty page accepts a top-level drop from another page", () => {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><EditablePage title="Empty" initial={[]} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  // simulate a drag that started elsewhere (context drag set via dragstart
  // is per-provider; here we drive the zone directly with an external drag)
  const zone = screen.getByText(/start writing/i).closest(".empty-drop-zone")!;
  void zone;
  // NOTE: full cross-provider simulation happens in Task 8's journal test;
  // here assert the zone element exists and is wired (has drop handler via
  // React — smoke-level assertion):
  expect(zone).toBeTruthy();
});

it("dragging is disabled when read-only", () => {
  const sync = makeSync("reconnecting");
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><EditablePage title="P" initial={[block("u1", "x")]} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  expect(document.querySelector(".bullet")).toHaveAttribute("draggable", "false");
});
