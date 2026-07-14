import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, test, vi } from "vitest";
import { block, makeSync, stubFetch } from "../test-helpers";
import { registerOutline } from "../outline/activeOutlines";
import { SyncContext } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

afterEach(() => vi.useRealTimers());

function mount(sync = makeSync(), initial = [
  block("u1", "first", { order_idx: 0 }),
  block("u2", "second", { order_idx: 1 }),
]) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
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

test("stale initial rerender during a pending split keeps the optimistic new block focused", () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const initial = [
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
  ];
  const sync = makeSync("connected", { idle: () => new Promise(() => undefined) });
  const view = (
    blocks: typeof initial,
  ) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={blocks} />
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(view(initial));

  const ta = focusBlock("first");
  ta.setSelectionRange(5, 5);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(screen.getByRole("textbox")).toHaveValue("");

  // A startup/reconnect refetch can return the old page payload while the
  // local create is still queued. That stale `initial` must not replace the
  // optimistic split and send the caret back to the previous line.
  rerender(view([
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
  ]));

  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(document.querySelectorAll(".block-row")).toHaveLength(3);
});

test("stale initial rerender while the sync queue still has pending ops keeps optimistic heading", async () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const initial = [block("u1", "first", { order_idx: 0 })];
  const sync = makeSync("reconnecting", {
    canEdit: true,
    pending: 1,
    idle: () => Promise.resolve(),
  });
  const view = (blocks: typeof initial) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={blocks} />
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(view(initial));

  const ta = focusBlock("first");
  fireEvent.keyDown(ta, { key: "1", code: "Digit1", ctrlKey: true, altKey: true });
  await act(async () => undefined);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.getByText("first").closest("h1")).not.toBeNull();

  // Offline/replica idle means "persisted locally", not "server has accepted
  // it". While Sync.pending is non-zero, a same-page refetch may still be
  // server-stale and must not revert the optimistic heading.
  rerender(view([block("u1", "first", { order_idx: 0, heading: null })]));

  expect(screen.getByText("first").closest("h1")).not.toBeNull();
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

test("Shift+Tab outdents a child through the real editor wiring", () => {
  const child = block("c1", "child", { order_idx: 0 });
  const sync = mount(makeSync(), [
    block("u1", "parent", { order_idx: 0, children: [child] }),
    block("u2", "after", { order_idx: 1 }),
  ]);
  const ta = focusBlock("child");
  fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
  expect(sync.sent).toEqual([
    [{ op: "move", uid: "c1", parent_uid: null, order_idx: 1 }],
  ]);
});

test.each([
  ["ArrowUp", { op: "move", uid: "u2", parent_uid: null, order_idx: 0 }],
  ["ArrowDown", { op: "move", uid: "u2", parent_uid: null, order_idx: 3 }],
])("Alt+%s moves the focused block in that direction", (key, expected) => {
  const sync = mount(makeSync(), [
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
    block("u3", "third", { order_idx: 2 }),
  ]);
  const ta = focusBlock("second");
  fireEvent.keyDown(ta, { key, altKey: true });
  expect(sync.sent).toEqual([[expected]]);
});

test("Backspace at the start merges with the previous block", () => {
  const sync = mount();
  const ta = focusBlock("second");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "Backspace" });
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "firstsecond" },
    { op: "delete", uid: "u2" },
  ]]);
  expect(screen.getByRole("textbox")).toHaveValue("firstsecond");
});

test("boundary arrows move editor focus to the visible neighbour", () => {
  mount();
  let ta = focusBlock("second");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowUp" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("first");
  expect(ta.selectionStart).toBe(5);
  fireEvent.keyDown(ta, { key: "ArrowDown" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("second");
  expect(ta.selectionStart).toBe(0);
});

test("chevron click queues the collapse op through useOutline", () => {
  const sync = mount(makeSync(), [
    block("u1", "parent", {
      order_idx: 0,
      children: [block("c1", "child", { order_idx: 0 })],
    }),
  ]);
  const chevron = document.querySelector(
    '.block-row[data-uid="u1"] .chevron') as HTMLButtonElement;
  fireEvent.click(chevron);
  expect(sync.sent).toEqual([[
    { op: "set_collapsed", uid: "u1", collapsed: true },
  ]]);
});

test("heading command selection queues text and heading ops", () => {
  stubFetch([]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, {
    target: { value: "/h1", selectionStart: 3, selectionEnd: 3 },
  });
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "" },
    { op: "set_heading", uid: "u1", heading: 1 },
  ]]);
});

test("clicking a TODO checkbox queues the toggled text op", () => {
  const sync = mount(makeSync(), [block("u1", "{{TODO}} buy milk")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "TODO" }));
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "{{DONE}} buy milk" },
  ]]);
});

test("Shift+Arrow starts and extends a block selection; Escape clears it", () => {
  mount(makeSync(), [
    block("u1", "first", { order_idx: 0 }),
    block("u2", "second", { order_idx: 1 }),
    block("u3", "third", { order_idx: 2 }),
  ]);
  const ta = focusBlock("second");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  const tree = document.querySelector(".block-tree") as HTMLElement;
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(2);
  fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(1);
  fireEvent.keyDown(tree, { key: "Escape" });
  expect(document.querySelectorAll(".block-row.selected")).toHaveLength(0);
});

test("remote batches patch the tree; own-echo filtering is the provider's job", () => {
  const sync = mount();
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "create", uid: "r1", page_title: "Page", parent_uid: null,
      order_idx: 2, text: "from the iPad" },
  ] }));
  expect(screen.getByText("from the iPad")).toBeInTheDocument();
});

test("remote update_text for a focused block with no draft is adopted", () => {
  const sync = mount();
  focusBlock("first");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote first" },
    { op: "update_text", uid: "u2", text: "second remote" },
  ] }));
  // No local draft exists, so the focused textarea must adopt the remote text
  // rather than keep the stale value.
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value)
    .toBe("remote first");
  expect(screen.getByText("second remote")).toBeInTheDocument();
});

test("focused block with a pending draft keeps the draft; it wins on flush", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "typed" } });
  // Remote update arrives while a real local draft is unflushed: the block
  // tree adopts it, but the textarea keeps showing the local draft (LWW).
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("typed");
  // The draft flush is the next legitimate last-writer.
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed" }],
  ]);
});

test("focus then blur without editing after a remote update stays consistent", () => {
  const sync = mount();
  const ta = focusBlock("first");
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  fireEvent.blur(ta);
  // Blurring without typing must not enqueue a stale-value op, and the block
  // must display the remote text: client and server agree.
  expect(sync.sent).toEqual([]);
  expect(screen.getByText("remote")).toBeInTheDocument();
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

test("pasting an image uploads it and splices markdown at the cursor", async () => {
  const url = `/assets/${"cd".repeat(32)}/pic.png`;
  stubFetch([["/api/assets", { sha256: "cd".repeat(32), filename: "pic.png",
                               mime: "image/png", size: 3, url }]]);
  const sync = mount();
  const ta = focusBlock("first");
  ta.setSelectionRange(5, 5);
  fireEvent.paste(ta, {
    clipboardData: {
      files: [new File(["png"], "pic.png", { type: "image/png" })],
    },
  });
  await vi.waitFor(() => {
    expect(sync.sent.flat()).toContainEqual({
      op: "update_text", uid: "u1", text: `first![pic.png](${url})`,
    });
  });
});

test("hiding the tab flushes the pending draft immediately", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first draft" } });
  expect(sync.sent).toEqual([]);
  Object.defineProperty(document, "visibilityState",
                        { value: "hidden", configurable: true });
  fireEvent(document, new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState",
                        { value: "visible", configurable: true });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "first draft" }],
  ]);
});

test("draft for a remotely-deleted block is dropped, not flushed", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "doomed draft" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([]);
});

test("a page already active elsewhere in this tab renders read-only", () => {
  // Simulates a second instance for the same title (e.g. the page is also
  // open in a sidebar panel): the newcomer must not offer an editable
  // textarea, since two live editors of one page in this tab can't see
  // each other's edits (see outline/activeOutlines.ts).
  const release = registerOutline("Page");
  try {
    mount();
    fireEvent.click(screen.getByText("first"));
    expect(screen.queryByRole("textbox")).toBeNull();
  } finally {
    release();
  }
});

test("two same-title instances mounted in one commit both claim editing (documents the sequential-mount assumption)", () => {
  // isOutlineActive is read during render but registration happens in an
  // effect, so two instances mounted in a SINGLE commit both see the title as
  // inactive and both render editable. Production never does this (panels
  // mount after an async fetch, so mounts are sequential and the second sees
  // the first's registration) — this locks the current behavior for the edge
  // case documented in EditablePage. See outline/activeOutlines.ts.
  const sync = makeSync();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={[block("u1", "first")]} />
        <EditablePage title="Page" initial={[block("u2", "second")]} />
      </SyncContext.Provider>
    </MemoryRouter>);
  // Both are editable: each renders its own drop zone (the read-only fallback
  // renders a bare block tree with no .outline-drop-zone).
  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(2);
});

test("the read-only fallback still reflects genuinely remote batches", () => {
  const release = registerOutline("Page");
  try {
    const sync = mount();
    act(() => sync.emit({ client_id: "other", ts: 1, ops: [
      { op: "create", uid: "r1", page_title: "Page", parent_uid: null,
        order_idx: 2, text: "from elsewhere" },
    ] }));
    expect(screen.getByText("from elsewhere")).toBeInTheDocument();
  } finally {
    release();
  }
});

test("once the first instance unmounts, a freshly mounted one becomes editable again", () => {
  const sync = makeSync();
  const first = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={[block("u1", "first", { order_idx: 0 })]} />
      </SyncContext.Provider>
    </MemoryRouter>);
  first.unmount();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={[block("u1", "first", { order_idx: 0 })]} />
      </SyncContext.Provider>
    </MemoryRouter>);
  fireEvent.click(screen.getByText("first"));
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});
