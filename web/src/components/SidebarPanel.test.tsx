import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DndProvider, useDnd } from "../dnd/DndContext";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, pagePayload, stubFetch } from "../test-helpers";
import { SidebarPanel } from "./SidebarPanel";

afterEach(() => vi.unstubAllGlobals());

// jsdom has no DataTransfer: minimal stub (mirrors EditableBlockTree.dnd.test.tsx)
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

function renderPanel(title: string) {
  const sync = makeSync();
  let dnd!: ReturnType<typeof useDnd>;
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <Harness onReady={(d) => { dnd = d; }} />
        <MemoryRouter><SidebarPanel title={title} onClose={() => undefined} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  return { sync, dnd: () => dnd };
}

it("fetches its page and renders title plus block tree, no backlinks", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("uid_s1", "a paper block")], {
    backlinks: { groups: [{ page_id: 1, page_title: "Machine Learning", items: [
      { uid: "uid_b3", text: "should not render", breadcrumbs: [] }] }],
      total_pages: 1, offset: 0, limit: 20 },
  })]]);
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={() => undefined} /></MemoryRouter>);
  expect(await screen.findByText("a paper block")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.queryByText("should not render")).toBeNull();
});

it("close button fires onClose", async () => {
  stubFetch([["/api/page/Paper", pagePayload("Paper", [])]]);
  const onClose = vi.fn();
  render(<MemoryRouter><SidebarPanel title="Paper" onClose={onClose} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "close panel" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("panel bullets are draggable and start a drag for the panel's page", async () => {
  stubFetch([["/api/page/Some%20Page", pagePayload("Some Page",
    [block("s1", "side one")])]]);
  const { dnd } = renderPanel("Some Page");
  await screen.findByText("side one");
  const bullet = document.querySelector(".sidebar-panel .bullet");
  expect(bullet).toHaveAttribute("draggable", "true");

  fireEvent.dragStart(bullet!, { dataTransfer: dt() });
  expect(dnd().drag).toEqual({ uid: "s1", pageTitle: "Some Page" });
});

it("dragging is disabled while disconnected (writes paused invariant)", async () => {
  const sync = makeSync("reconnecting");
  stubFetch([["/api/page/Paper", pagePayload("Paper", [block("s1", "side one")])]]);
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter><SidebarPanel title="Paper" onClose={() => undefined} /></MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  await screen.findByText("side one");
  const bullet = document.querySelector(".sidebar-panel .bullet");
  expect(bullet).toHaveAttribute("draggable", "false");
});

it("panel refetches after a drop that touches its page", async () => {
  const fetchMock = stubFetch([["/api/page/Some%20Page",
    pagePayload("Some Page", [block("s1", "side one")])]]);
  const { dnd } = renderPanel("Some Page");
  await screen.findByText("side one");
  const before = fetchMock.mock.calls.length;
  dnd().drop({ uid: "zz", pageTitle: "Elsewhere" },
             { parent_uid: null, order_idx: 0, page_title: "Some Page" });
  await Promise.resolve(); await Promise.resolve();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
});
