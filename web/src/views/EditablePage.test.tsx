import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, test, vi } from "vitest";
import { block, makeSync, reserveOutlineEditor, stubFetch,
         type SyncFake } from "../test-helpers";
import { SyncContext } from "../sync/SyncProvider";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { resetHistory } from "../outline/undoManager";
import { EditablePage } from "./EditablePage";

afterEach(() => {
  vi.useRealTimers();
  resetHistory();
});

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
    [{ op: "update_text", uid: "u1", text: "first edited",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
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
  expect(batch[0]).toEqual({ op: "update_text", uid: "u1", text: "first!",
                            base_text_hash: sha256Hex("first"),
                            page_title: "Page" });
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
  const sync = makeSync("connected", { settled: () => new Promise(() => undefined) });
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

test("stale initial rerender while its scoped write is unsettled keeps optimistic heading", async () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const initial = [block("u1", "first", { order_idx: 0 })];
  let deliver!: () => void;
  const delivered = new Promise<{ status: "delivered" }>((resolve) => {
    deliver = () => resolve({ status: "delivered" });
  });
  const base = makeSync("reconnecting", {
    canEdit: true,
    pending: 0,
  });
  const sync = {
    ...base,
    enqueue: (ops: Parameters<typeof base.enqueue>[0],
              scope?: readonly string[]) => {
      base.sent.push(ops);
      return {
        id: "write-page",
        scope: scope ?? [],
        settled: new Promise<never>(() => undefined),
        delivered,
      };
    },
  };
  const view = (blocks: typeof initial) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={blocks} />
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(view(initial));

  const ta = focusBlock("first");
  fireEvent.keyDown(ta, { key: "1", code: "Digit1", metaKey: true, altKey: true });
  await act(async () => undefined);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.getByText("first").closest("h1")).not.toBeNull();

  // Only this title's ticket blocks adoption; the global pending count is not
  // consulted by outline causality.
  rerender(view([block("u1", "first", { order_idx: 0, heading: null })]));

  expect(screen.getByText("first").closest("h1")).not.toBeNull();
  await act(async () => deliver());
});

test("Cmd-Alt heading shortcuts update focused typography immediately", () => {
  const sync = mount();
  let ta = focusBlock("first");

  for (const level of [1, 2, 3] as const) {
    fireEvent.keyDown(ta, {
      key: String(level), code: `Digit${level}`,
      metaKey: true, altKey: true,
    });
    ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta).toHaveClass(`heading-${level}`);
    expect(ta).toHaveValue("first");
  }

  fireEvent.keyDown(ta, {
    key: "0", code: "Digit0", metaKey: true, altKey: true,
  });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).not.toHaveClass("heading-1", "heading-2", "heading-3");
  expect(ta).toHaveValue("first");
  expect(sync.sent).toEqual([
    [{ op: "set_heading", uid: "u1", heading: 1 }],
    [{ op: "set_heading", uid: "u1", heading: 2 }],
    [{ op: "set_heading", uid: "u1", heading: 3 }],
    [{ op: "set_heading", uid: "u1", heading: null }],
  ]);
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

test.each(["ArrowUp", "ArrowDown"])(
  "Alt+%s does not enqueue a focused block move",
  (key) => {
    const sync = mount(makeSync(), [
      block("u1", "first", { order_idx: 0 }),
      block("u2", "second", { order_idx: 1 }),
      block("u3", "third", { order_idx: 2 }),
    ]);
    const ta = focusBlock("second");

    expect(fireEvent.keyDown(ta, { key, altKey: true })).toBe(true);
    expect(sync.sent).toEqual([]);
  },
);

test("Backspace at the start merges with the previous block", () => {
  const sync = mount();
  const ta = focusBlock("second");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "Backspace" });
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "firstsecond",
      base_text_hash: sha256Hex("first"), page_title: "Page" },
    { op: "delete", uid: "u2",
      base_subtree_hash: subtreeHash([["u2", "second"]]) },
  ]]);
  expect(screen.getByRole("textbox")).toHaveValue("firstsecond");
});

test("boundary arrows use text end vertically and preserve horizontal entry", () => {
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
  expect(ta.selectionStart).toBe(6);

  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowLeft" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("first");
  expect(ta.selectionStart).toBe(5);

  fireEvent.keyDown(ta, { key: "ArrowRight" });
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
    { op: "update_text", uid: "u1", text: "",
      base_text_hash: sha256Hex("first"), page_title: "Page" },
    { op: "set_heading", uid: "u1", heading: 1 },
  ]]);
});

test("clicking a TODO checkbox queues the toggled text op", () => {
  const sync = mount(makeSync(), [block("u1", "{{TODO}} buy milk")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "TODO" }));
  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "{{DONE}} buy milk",
      base_text_hash: sha256Hex("{{TODO}} buy milk"), page_title: "Page" },
  ]]);
});

test("Cmd-Enter shows the cycled TODO marker immediately and survives the next flush", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount(makeSync(), [block("u1", "first", { order_idx: 0 })]);
  const ta = focusBlock("first");

  // A keystroke queues a debounced draft edit that has NOT flushed yet.
  fireEvent.change(ta, { target: { value: "first edited" } });
  expect(sync.sent).toEqual([]);

  // Cmd-Enter fires before the debounce timer does.
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
  expect(screen.getByRole("textbox")).toHaveValue("{{TODO}} first edited");

  // Keep typing on top of the (now-marked) draft, then let the debounce
  // flush: the marker must still be there, not silently reverted.
  fireEvent.change(screen.getByRole("textbox"),
                    { target: { value: "{{TODO}} first edited more" } });
  act(() => { vi.advanceTimersByTime(500); });

  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "{{TODO}} first edited more",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
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

test("a remote update under a debounced draft: the flush carries the draft's base hash", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "typed" } });
  // The tree takes the remote text; the textarea keeps showing the draft.
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("typed");
  act(() => { vi.advanceTimersByTime(500); });
  // The flush hashes the text the draft was typed over ("first"), so the
  // server sees a mismatch and keeps "remote" as a conflict copy.
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("keystrokes after a remote update keep the draft's first base", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "t1" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "t12" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "t12",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("typing back to the base under a remote edit, then typing on, still bases on the shown text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "firstX" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  // Back to the base: the flush has nothing to send, but the textarea is
  // still showing text typed over "first", not the "remote" in the tree.
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([]);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "first!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "first!",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a first keystroke after a remote edit reached the tree but not the textarea bases on the shown text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  // One act: the remote batch is in the tree, the textarea has not yet
  // adopted it, and the keystroke is typed over the "first" still shown.
  act(() => {
    sync.emit({ client_id: "other", ts: 1, ops: [
      { op: "update_text", uid: "u1", text: "remote" },
    ] });
    fireEvent.change(ta, { target: { value: "firstX" } });
  });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "firstX",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("the draft after a flush bases on the flushed text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "one" } });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "one two" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1][0]).toMatchObject({
    op: "update_text", uid: "u1", text: "one two",
    base_text_hash: sha256Hex("one"),
  });
});

test("a keystroke between a flush and the textarea catching up bases on the flushed text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "one" } });
  // One act: the debounce flushes "one", and the next keystroke lands before
  // the textarea has seen its own text reach the tree (it is still dirty).
  act(() => {
    vi.advanceTimersByTime(500);
    fireEvent.change(ta, { target: { value: "one two" } });
  });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1][0]).toMatchObject({
    op: "update_text", uid: "u1", text: "one two",
    base_text_hash: sha256Hex("one"),
  });
});

const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const undoKey = () => fireEvent.keyDown(textbox(), { key: "z", metaKey: true });
const redoKey = () =>
  fireEvent.keyDown(textbox(), { key: "z", metaKey: true, shiftKey: true });

test("Cmd+Z on a dirty draft shows the undone text, and the next draft bases on it", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "first X" } });
  undoKey(); // within the debounce: flushes "first X", then undoes it
  expect(textbox().value).toBe("first");
  fireEvent.change(textbox(), { target: { value: "first!" } });
  act(() => { vi.advanceTimersByTime(500); });
  // The server holds "first" after the undo, so this applies cleanly.
  expect(sync.sent.at(-1)).toEqual([
    { op: "update_text", uid: "u1", text: "first!",
      base_text_hash: sha256Hex("first"), page_title: "Page" },
  ]);
});

test("Cmd+Shift+Z after an undo shows the redone text, and the next draft bases on it", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "first X" } });
  undoKey();
  redoKey();
  expect(textbox().value).toBe("first X");
  fireEvent.change(textbox(), { target: { value: "first X!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent.at(-1)).toEqual([
    { op: "update_text", uid: "u1", text: "first X!",
      base_text_hash: sha256Hex("first X"), page_title: "Page" },
  ]);
});

test("a second Cmd+Z reaches further back, and the next draft bases on its text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "first X" } });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.change(textbox(), { target: { value: "first X!" } });
  undoKey(); // flushes "first X!", then undoes it
  undoKey(); // undoes "first X"
  expect(textbox().value).toBe("first");
  fireEvent.change(textbox(), { target: { value: "first?" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent.at(-1)).toEqual([
    { op: "update_text", uid: "u1", text: "first?",
      base_text_hash: sha256Hex("first"), page_title: "Page" },
  ]);
});

test("Enter after a remote update under a draft stamps the split batch with the base", () => {
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first!" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  const live = screen.getByRole("textbox") as HTMLTextAreaElement;
  live.setSelectionRange(6, 6);
  fireEvent.keyDown(live, { key: "Enter" });
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0][0]).toEqual({
    op: "update_text", uid: "u1", text: "first!",
    base_text_hash: sha256Hex("first"), page_title: "Page",
  });
  expect(sync.sent[0][1]).toMatchObject({ op: "create", page_title: "Page" });
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
      base_text_hash: sha256Hex("first"), page_title: "Page",
    });
  });
});

test("a paste-upload into a dirty draft shows the spliced text, and the next draft bases on it", async () => {
  const url = `/assets/${"cd".repeat(32)}/pic.png`;
  const spliced = `D![pic.png](${url})`;
  stubFetch([["/api/titles", { titles: [] }],
             ["/api/assets", { sha256: "cd".repeat(32), filename: "pic.png",
                               mime: "image/png", size: 3, url }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "D" } });
  ta.setSelectionRange(1, 1);
  fireEvent.paste(ta, { clipboardData: {
    files: [new File(["png"], "pic.png", { type: "image/png" })] } });
  await vi.waitFor(() => { expect(textbox().value).toBe(spliced); });
  fireEvent.change(textbox(), { target: { value: `${spliced}!` } });
  fireEvent.blur(textbox());
  expect(sync.sent.at(-1)).toEqual([
    { op: "update_text", uid: "u1", text: `${spliced}!`,
      base_text_hash: sha256Hex(spliced), page_title: "Page" },
  ]);
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
    [{ op: "update_text", uid: "u1", text: "first draft",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

// Navigating away with Ctrl-O / Ctrl-Shift-O while the
// caret still sits inside a [[ref]] token must not discard the whole block --
// the draft is flush-held and navigate() unmounts the tree without
// React ever delivering a blur, so the held text was simply dropped.
function heldRefDraft(sync: SyncFake) {
  stubFetch([
    ["/api/titles", { titles: [] }],
    ["/api/pages", { id: 9, title: "Fresh Idea", created_at: 0, updated_at: 0 }],
  ]);
  mount(sync);
  const ta = focusBlock("first");
  // "see [[Fresh Idea]]" with the caret before the closers: exactly what
  // bracket auto-pairing leaves behind mid-typing, so the draft is held.
  fireEvent.change(ta, { target: {
    value: "see [[Fresh Idea]]", selectionStart: 16, selectionEnd: 16,
  } });
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toEqual([]); // held: the debounce must not have flushed
  return ta;
}

const HELD_TEXT_OP = { op: "update_text", uid: "u1", text: "see [[Fresh Idea]]",
                       base_text_hash: sha256Hex("first"), page_title: "Page" };

test("Ctrl-O over a held [[ref]] flushes the block text before navigating", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  const ta = heldRefDraft(sync);
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("Ctrl-Shift-O over a held [[ref]] flushes the block text too", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  const ta = heldRefDraft(sync);
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true, shiftKey: true });
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

// The other door onto the same loss. Navigation that never touches
// the textarea -- App's global Ctrl-Shift-D daily-notes chord, browser
// back/forward -- just unmounts the outline. There is no blur to flush the
// held draft and (unlike an ordinary draft) no armed debounce either, so the
// unmount has to commit it. The click below moves no focus in jsdom, which is
// exactly the no-blur condition those navigations create.
function NavAway() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/elsewhere")}>go</button>;
}

test("navigating away with no blur still flushes a held draft", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = makeSync();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SyncContext.Provider value={sync}>
        <Routes>
          <Route path="/" element={<>
            <EditablePage title="Page"
                          initial={[block("u1", "first", { order_idx: 0 })]} />
            <NavAway />
          </>} />
          <Route path="/elsewhere" element={<p>elsewhere</p>} />
        </Routes>
      </SyncContext.Provider>
    </MemoryRouter>);
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: {
    value: "see [[Fresh Idea]]", selectionStart: 16, selectionEnd: 16,
  } });
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toEqual([]); // held: no debounce is armed to save it
  fireEvent.click(screen.getByText("go"));
  expect(screen.getByText("elsewhere")).toBeInTheDocument();
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

const CROSS_PAGE_MOVE = { op: "move", uid: "u1", parent_uid: null,
                         order_idx: 0, page_title: "Elsewhere" } as const;

function hideTab() {
  Object.defineProperty(document, "visibilityState",
                        { value: "hidden", configurable: true });
  fireEvent(document, new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState",
                        { value: "visible", configurable: true });
}

test("a debounced draft whose block a remote batch deleted still flushes", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "kept draft" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  act(() => { vi.advanceTimersByTime(500); });
  // The server lands an edit to a missing block on today's daily note.
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "kept draft",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a debounced draft whose block a remote cross-page move took still flushes", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "moved draft" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [CROSS_PAGE_MOVE] }));
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "moved draft",
      base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a debounced draft on a remotely deleted block flushes when another block's draft starts", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "kept draft" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  // The textarea unmounted with the block, and no blur was delivered.
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.change(focusBlock("second"), { target: { value: "second!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent.flat()).toContainEqual(
    { op: "update_text", uid: "u1", text: "kept draft",
      base_text_hash: sha256Hex("first"), page_title: "Page" });
  expect(sync.sent.flat()).toContainEqual(
    expect.objectContaining({ uid: "u2", text: "second!" }));
});

test("a held draft on a remotely deleted block flushes when another block's draft starts", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  heldRefDraft(sync);
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  fireEvent.change(focusBlock("second"), { target: { value: "second!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("a held draft under a remote update flushes on blur with its base hash", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  const ta = heldRefDraft(sync);
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  fireEvent.blur(ta);
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("a held draft whose block a remote batch deleted flushes on tab hide", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  heldRefDraft(sync);
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  hideTab();
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("a held draft whose block a remote cross-page move took flushes on tab hide", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  heldRefDraft(sync);
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [CROSS_PAGE_MOVE] }));
  hideTab();
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

// A remote batch that reparents the focused block (or an ancestor) within the
// page remounts its textarea with no blur, while its draft is still pending.
// The new textarea resumes that draft, keeps the draft's base (the text first
// typed over, not the remounted tree's text), and puts the caret back where
// the old textarea left it.
const SAME_PAGE_MOVE = { op: "move", uid: "u1", parent_uid: "u2",
                         order_idx: 0, page_title: "Page" } as const;

test("a remote same-page move of the focused block keeps its draft on the remounted textarea", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "typed words" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(ta.isConnected).toBe(false); // the move remounted it
  expect(textbox().value).toBe("typed words");
  expect(document.activeElement).toBe(textbox());
  expect(textbox().selectionStart).toBe("typed words".length);
  fireEvent.change(textbox(), { target: { value: "typed words!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed words!",
       base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a remounted textarea keeps the caret where the user left it in the draft", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: {
    value: "typed words", selectionStart: 5, selectionEnd: 5,
  } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(ta.isConnected).toBe(false);
  expect(textbox().value).toBe("typed words");
  expect(textbox().selectionStart).toBe(5);
  expect(textbox().selectionEnd).toBe(5);
});

test("a caret moved without typing is kept across the remount too", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "typed words" } });
  ta.setSelectionRange(2, 7); // a click or arrow key: no change event
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(ta.isConnected).toBe(false);
  expect(textbox().value).toBe("typed words");
  expect(textbox().selectionStart).toBe(2);
  expect(textbox().selectionEnd).toBe(7);
});

test("a resumed draft goes clean once it flushes, and later remote text is adopted", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "typed" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(textbox().value).toBe("typed");
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed",
       base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
  act(() => sync.emit({ client_id: "other", ts: 2, ops: [
    { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  expect(textbox().value).toBe("remote");
});

test("a remote batch that moves and edits the focused block keeps the draft and its base", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "typed" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    SAME_PAGE_MOVE, { op: "update_text", uid: "u1", text: "remote" },
  ] }));
  expect(textbox().value).toBe("typed");
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed",
       base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a remote move of the focused block's parent keeps the draft on the remounted child", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount(makeSync(), [
    block("u1", "first", { order_idx: 0,
      children: [block("c1", "child", { order_idx: 0 })] }),
    block("u2", "second", { order_idx: 1 }),
  ]);
  const ta = focusBlock("child");
  fireEvent.change(ta, { target: { value: "child typed" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(ta.isConnected).toBe(false);
  expect(textbox().value).toBe("child typed");
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "c1", text: "child typed",
       base_text_hash: sha256Hex("child"), page_title: "Page" }],
  ]);
});

test("a held draft survives a remote same-page move and still flushes on blur", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  heldRefDraft(sync);
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(textbox().value).toBe("see [[Fresh Idea]]");
  expect(textbox().selectionStart).toBe(16); // still mid-ref
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toEqual([]); // still held
  fireEvent.blur(textbox());
  expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("Cmd+Z on a resumed draft shows the undone text", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  fireEvent.change(focusBlock("first"), { target: { value: "typed" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  undoKey();
  expect(textbox().value).toBe("first");
  expect(sync.sent.flat()).toContainEqual({ op: "update_text", uid: "u1",
    text: "typed", base_text_hash: sha256Hex("first"), page_title: "Page" });
});

test("a page already active elsewhere in this tab renders read-only", () => {
  // Simulates a second instance for the same title (e.g. the page is also
  // open in a sidebar panel): the newcomer must not offer an editable
  // textarea, since the atomic outlineSessions editor lease permits only one
  // editor per title in this tab.
  const release = reserveOutlineEditor("Page");
  try {
    mount();
    fireEvent.click(screen.getByText("first"));
    expect(screen.queryByRole("textbox")).toBeNull();
  } finally {
    release();
  }
});

test("two same-title instances mounted in one commit expose exactly one editor", () => {
  const sync = makeSync();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={[block("u1", "first")]} />
        <EditablePage title="Page" initial={[block("u1", "first")]} />
      </SyncContext.Provider>
    </MemoryRouter>);

  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);
  const fallback = [...document.querySelectorAll(".block-tree")]
    .find((tree) => tree.closest(".outline-drop-zone") === null)!;
  expect(fallback.querySelector(".bullet")).not.toHaveAttribute("draggable", "true");
  fireEvent.click(fallback.querySelector(".block-text")!);
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("StrictMode same-title mount cleanup never exposes duplicate editors", () => {
  render(
    <StrictMode>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <SyncContext.Provider value={makeSync()}>
          <EditablePage title="Strict Page" initial={[block("u1", "first")]} />
          <EditablePage title="Strict Page" initial={[block("u1", "first")]} />
        </SyncContext.Provider>
      </MemoryRouter>
    </StrictMode>);

  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);
});

test("same-title fallback observes the owner's flushed optimistic tree", () => {
  vi.useFakeTimers();
  const sync = makeSync();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title="Page" initial={[block("u1", "first")]} />
        <EditablePage title="Page" initial={[block("u1", "first")]} />
      </SyncContext.Provider>
    </MemoryRouter>);

  const ownerText = document.querySelector(".outline-drop-zone .block-text")!;
  fireEvent.click(ownerText);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "shared optimistic text" },
  });
  act(() => { vi.advanceTimersByTime(500); });

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "u1", text: "shared optimistic text",
      base_text_hash: sha256Hex("first"), page_title: "Page" },
  ]]);
  const fallback = [...document.querySelectorAll(".block-tree")]
    .find((tree) => tree.closest(".outline-drop-zone") === null)!;
  expect(fallback).toHaveTextContent("shared optimistic text");
});

test("a remaining same-title fallback atomically takes over after owner unmount", () => {
  const sync = makeSync();
  const view = (includeFirst: boolean) => (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        {includeFirst && (
          <EditablePage key="first" title="Page" initial={[block("u1", "first")]} />
        )}
        <EditablePage key="second" title="Page" initial={[block("u1", "first")]} />
      </SyncContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(view(true));
  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);

  rerender(view(false));

  expect(document.querySelectorAll(".outline-drop-zone")).toHaveLength(1);
  fireEvent.click(screen.getByText("first"));
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});

test("the read-only fallback still reflects genuinely remote batches", () => {
  const release = reserveOutlineEditor("Page");
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
