import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, test, vi } from "vitest";
import { registerOutline } from "../outline/activeOutlines";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, pagePayload, stubFetch } from "../test-helpers";
import { EditableSidebarPanel } from "./EditableSidebarPanel";

afterEach(() => vi.useRealTimers());

function mount(sync = makeSync(), title = "Paper",
               blocks = [block("uid_s1", "a paper block", { order_idx: 0 })]) {
  stubFetch([["/api/page/Paper", pagePayload(title, blocks)]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditableSidebarPanel title={title} />
      </SyncContext.Provider>
    </MemoryRouter>);
  return sync;
}

test("fetches its page and renders it as an editable outline", async () => {
  mount();
  expect(await screen.findByText("a paper block")).toBeInTheDocument();
});

test("editing a block in the panel sends the op after the debounce", async () => {
  vi.useFakeTimers();
  const sync = mount();
  await vi.waitFor(() => screen.getByText("a paper block"));
  fireEvent.click(screen.getByText("a paper block"));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "edited in panel" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "uid_s1", text: "edited in panel" }],
  ]);
});

test("a remote websocket batch updates the panel", async () => {
  const sync = mount();
  await screen.findByText("a paper block");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "create", uid: "r1", page_title: "Paper", parent_uid: null,
      order_idx: 1, text: "from the iPad" },
  ] }));
  expect(screen.getByText("from the iPad")).toBeInTheDocument();
});

test("a page already open elsewhere in this tab falls back to read-only", async () => {
  const release = registerOutline("Paper");
  try {
    mount();
    fireEvent.click(await screen.findByText("a paper block"));
    expect(screen.queryByRole("textbox")).toBeNull();
  } finally {
    release();
  }
});

test("shows the fetch error", async () => {
  stubFetch([]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={makeSync()}>
        <EditableSidebarPanel title="Missing" />
      </SyncContext.Provider>
    </MemoryRouter>);
  expect(await screen.findByText(/request failed: 404/i)).toBeInTheDocument();
});
