// Files dragged onto a whole editable page: wiring from the drop zone through
// useOutline's upload to the new blocks. Geometry and window behaviour are
// covered in dnd/useDropZone.files.test.tsx.
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DndProvider } from "../dnd/DndContext";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync, ord, title } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import { EditablePage } from "./EditablePage";

const INFO = { sha256: "ab".repeat(32), filename: "cat.png", mime: "image/png",
               size: 1, url: `/assets/${"ab".repeat(32)}/cat.png` };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderPage(initial: BlockNode[]) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(INFO)));
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title={title("P")} initial={initial} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  return sync;
}

const transfer = () => {
  const file = new File(["x"], "cat.png", { type: "image/png" });
  return { types: ["Files"], items: [{ kind: "file", type: "image/png" }],
           files: [file], dropEffect: "" };
};

it("dropping an image on an empty page creates its block at the root", async () => {
  const sync = renderPage([]);
  const zone = document.querySelector(".outline-drop-zone")!;
  const t = transfer();
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: t });
  expect(document.querySelector(".drop-indicator")).not.toBeNull();
  await act(async () => {
    fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: t });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(document.querySelector(".drop-indicator")).toBeNull();
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0]).toMatchObject([
    { op: "create", parent_uid: null, order_idx: 0, text: `![cat.png](${INFO.url})` }]);
});

it("dropping an image on a populated page uploads it as a new block", async () => {
  const sync = renderPage([block("u1", "one", { order_idx: ord(0) })]);
  const zone = document.querySelector(".outline-drop-zone")!;
  const t = transfer();
  fireEvent.dragOver(zone, { clientX: 0, clientY: 0, dataTransfer: t });
  await act(async () => {
    fireEvent.drop(zone, { clientX: 0, clientY: 0, dataTransfer: t });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(sync.sent[0]).toMatchObject([{ op: "create", order_idx: 0 }]);
});
