import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { block, makeSync, stubFetch } from "../test-helpers";
import { SyncContext } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

afterEach(() => vi.useRealTimers());

function mount(sync = makeSync(), initial = [
  block("u1", "first", { order_idx: 0 }),
  block("u2", "second", { order_idx: 1 }),
]) {
  render(
    <MemoryRouter>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={initial} />
      </SyncContext.Provider>
    </MemoryRouter>);
  return sync;
}

function focusBlock(text: string): HTMLTextAreaElement {
  fireEvent.click(screen.getByText(text));
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

test("typing flushes one update_text op after the debounce", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first edited" } });
  expect(sync.sent).toEqual([]);
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "first edited" }],
  ]);
});

test("Enter splits: pending text flushes first, create follows, focus moves", () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first!" } });
  ta.setSelectionRange(6, 6);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(sync.sent).toHaveLength(1);
  const batch = sync.sent[0];
  expect(batch[0]).toEqual({ op: "update_text", uid: "u1", text: "first!" });
  expect(batch[1]).toMatchObject({ op: "create", page_title: "Page",
                                   parent_uid: null, order_idx: 1, text: "" });
  // the new block's textarea is now the focused one (empty draft)
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

test("Tab indents the second block under the first", () => {
  stubFetch([]);
  const sync = mount();
  const ta = focusBlock("second");
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(sync.sent).toEqual([
    [{ op: "move", uid: "u2", parent_uid: "u1", order_idx: 0 }],
  ]);
});

test("remote batches patch the tree; own-echo filtering is the provider's job", () => {
  const sync = mount();
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "create", uid: "r1", page_title: "Page", parent_uid: null,
      order_idx: 2, text: "from the iPad" },
  ] }));
  expect(screen.getByText("from the iPad")).toBeInTheDocument();
});

test("remote update_text for the focused block is skipped (draft wins)", () => {
  const sync = mount();
  focusBlock("first");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "clobbered" },
    { op: "update_text", uid: "u2", text: "second remote" },
  ] }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first");
  expect(screen.getByText("second remote")).toBeInTheDocument();
});

test("empty page shows the start-writing affordance which creates block zero", () => {
  const sync = mount(makeSync(), []);
  fireEvent.click(screen.getByRole("button", { name: /start writing/i }));
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0][0]).toMatchObject({ op: "create", page_title: "Page",
                                          parent_uid: null, order_idx: 0, text: "" });
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});

test("editing is read-only while the socket is not connected", () => {
  mount(makeSync("connecting"));
  const ta = focusBlock("first");
  expect(ta).toHaveAttribute("readonly");
});
