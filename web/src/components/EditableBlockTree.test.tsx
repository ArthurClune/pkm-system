import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, test, vi } from "vitest";
import { block } from "../test-helpers";
import type { OutlineHandlers } from "./EditableBlockTree";
import { EditableBlockTree } from "./EditableBlockTree";

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveUp: vi.fn(), onMoveDown: vi.fn(), onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onSetHeading: vi.fn(),
    onToggleTodo: vi.fn(), onFiles: vi.fn(),
    onStartBlockSelection: vi.fn(), onExtendBlockSelection: vi.fn(),
    onClearBlockSelection: vi.fn(), onDragStartBlock: vi.fn(),
  };
}

const BLOCKS = [
  block("u1", "hello [[World]]", { order_idx: 0 }),
  block("u2", "{{[[TODO]]}} task", { order_idx: 1 }),
];

function mount(h: OutlineHandlers, focus: { uid: string; cursor: number } | null,
               readOnly = false) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={focus} handlers={h}
                         readOnly={readOnly} />
    </MemoryRouter>);
}

function focusedTextarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

test("unfocused blocks render segments; clicking one focuses it at text end", () => {
  const h = handlers();
  mount(h, null);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("link", { name: "World" })).toBeInTheDocument();
  fireEvent.click(screen.getByText(/hello/));
  expect(h.onFocusBlock).toHaveBeenCalledWith("u1", "hello [[World]]".length);
});

test("the focused block is a textarea with the raw markdown", () => {
  mount(handlers(), { uid: "u1", cursor: 5 });
  const ta = focusedTextarea();
  expect(ta.value).toBe("hello [[World]]");
  expect(document.activeElement).toBe(ta);
  expect(ta.selectionStart).toBe(5);
});

test("typing reports the draft", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  fireEvent.change(focusedTextarea(), { target: { value: "hi" } });
  expect(h.onDraftChange).toHaveBeenCalledWith("u1", "hi");
});

test("bullet shows the closed ring only when collapsed with children", () => {
  const blocks = [
    block("p1", "parent", { collapsed: true, order_idx: 0,
                            children: [block("c1", "child")] }),
    block("p2", "collapsed leaf", { collapsed: true, order_idx: 1 }),
  ];
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={handlers()}
                         readOnly={false} />
    </MemoryRouter>);
  expect(container.querySelector('[data-uid="p1"] .bullet.closed')).not.toBeNull();
  expect(container.querySelector('[data-uid="p2"] .bullet.closed')).toBeNull();
});

test("keyboard map dispatches to the right handlers", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).toHaveBeenCalledWith("u1", 3);
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(h.onIndent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
  expect(h.onOutdent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true });
  expect(h.onMoveUp).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowDown", altKey: true });
  expect(h.onMoveDown).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp" }); // single-line: crosses up
  expect(h.onArrow).toHaveBeenCalledWith("u1", "up");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "Backspace" });
  expect(h.onBackspaceAtStart).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowLeft" });
  expect(h.onArrow).toHaveBeenCalledWith("u1", "left");
});

test("Shift-Enter does not split (literal newline)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  fireEvent.keyDown(focusedTextarea(), { key: "Enter", shiftKey: true });
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("arrows stay inside a multi-line draft until the edge line", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(8, 8); // in line2: ArrowUp must NOT cross
  fireEvent.keyDown(ta, { key: "ArrowUp" });
  expect(h.onArrow).not.toHaveBeenCalled();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // last line: crosses
  expect(h.onArrow).toHaveBeenCalledWith("u1", "down");
});

test("readOnly blocks structural keys but Escape still blurs", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 }, true);
  const ta = focusedTextarea();
  expect(ta).toHaveAttribute("readonly");
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(ta); // mount effect focused it
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(document.activeElement).not.toBe(ta);
});

test("chevron toggles collapse via handler; todo checkbox toggles via handler", () => {
  const h = handlers();
  const withKids = [block("p", "parent", {
    order_idx: 0, children: [block("k", "kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={withKids} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  // jsdom doesn't apply the stylesheet's `.chevron.hidden { visibility:
  // hidden }`, so the childless "kid" block's chevron is still reachable by
  // role here (same workaround as BlockTree.test.tsx uses for this scenario).
  fireEvent.click(screen.getAllByRole("button", { name: "toggle children" })[0]);
  expect(h.onToggleCollapsed).toHaveBeenCalledWith("p", true);
});

test("todo checkbox is enabled in the editable tree and reports its uid", () => {
  const h = handlers();
  mount(h, null);
  const box = screen.getByRole("checkbox");
  expect(box).toBeEnabled();
  fireEvent.click(box);
  expect(h.onToggleTodo).toHaveBeenCalledWith("u2");
});

test("chevron is disabled on a childless block; enabled on a block with children", () => {
  const h = handlers();
  const t = [block("p", "parent", {
    order_idx: 0, children: [block("k", "kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={t} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>);
  const [parentChevron, kidChevron] =
    screen.getAllByRole("button", { name: "toggle children" });
  expect(parentChevron).toBeEnabled();
  expect(kidChevron).toBeDisabled();
  fireEvent.click(kidChevron);
  expect(h.onToggleCollapsed).not.toHaveBeenCalled();
});

test("readOnly disables the chevron (even with children) and the todo checkbox", () => {
  const h = handlers();
  const t = [
    block("p", "parent", {
      order_idx: 0, children: [block("k", "kid", { order_idx: 0 })],
    }),
    block("u2", "{{[[TODO]]}} task", { order_idx: 1 }),
  ];
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={t} focus={null} handlers={h} readOnly={true} />
    </MemoryRouter>);
  const parentChevron =
    screen.getAllByRole("button", { name: "toggle children" })[0];
  expect(parentChevron).toBeDisabled();
  fireEvent.click(parentChevron);
  expect(h.onToggleCollapsed).not.toHaveBeenCalled();

  const box = screen.getByRole("checkbox");
  expect(box).toBeDisabled();
  fireEvent.click(box);
  expect(h.onToggleTodo).not.toHaveBeenCalled();
});

test("typing / opens the command menu; Enter wraps the block in a code fence", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  expect(screen.getByRole("option", { name: "Python code block" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter was consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```python\n\n```");
  expect(screen.queryByRole("listbox")).toBeNull(); // popup closed
});

test("/t filters to text+todo; ArrowDown+Enter picks /todo", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/t" } });
  ta.setSelectionRange(2, 2);
  expect(screen.getByRole("option", { name: "Text" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "To-do" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // "Text" -> "To-do"
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} ");
});

test("clicking a slash-menu row picks it (mouseDown, not click)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  fireEvent.mouseDown(screen.getByRole("option", { name: "Python code block" }));
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```python\n\n```");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Tab accepts the highlighted slash-menu row, same as Enter (pkm-x3so: this " +
     "already worked at HEAD — kept as a regression test)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(h.onIndent).not.toHaveBeenCalled(); // Tab was consumed by the popup, not the indent binding
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```python\n\n```");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("/text on an empty block inserts a lang-less (plain text) fence", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/text" } });
  ta.setSelectionRange(5, 5);
  expect(screen.getByRole("option", { name: "Text" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```\n\n```");
});

test("a non-matching slash query shows no rows and Enter falls through to split", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/zzz" } });
  ta.setSelectionRange(4, 4);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).toHaveBeenCalledWith("u1", 4);
});

test("typing /h1 shows the heading rows; Enter strips the trigger and dispatches onSetHeading", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "hello [[World]] /h1" } });
  ta.setSelectionRange(19, 19);
  expect(screen.getByRole("option", { name: "Heading 1" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "hello [[World]] ");
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 1);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("/h1 on a block that is already h1 toggles back to plain text", () => {
  const h = handlers();
  const heading1 = [block("u1", "hello [[World]]", { order_idx: 0, heading: 1 })];
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={heading1} focus={{ uid: "u1", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "hello [[World]] /h1" } });
  ta.setSelectionRange(19, 19);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", null);
});

test("/normal always clears the heading, even from plain text", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/normal" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", null);
});

test("non-heading commands never call onSetHeading", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("a remote update arriving mid-composition is deferred until composition ends", () => {
  const h = handlers();
  const view = mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.compositionStart(ta);
  const updated = [
    block("u1", "hola [[World]]", { order_idx: 0 }),
    BLOCKS[1],
  ];
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={updated} focus={{ uid: "u1", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(ta.value).toBe("hello [[World]]"); // untouched while composing
  fireEvent.compositionEnd(ta);
  expect(ta.value).toBe("hola [[World]]"); // adopted once composition ends
});

test("adopting a remote update preserves the caret in a focused, clean textarea", () => {
  const h = handlers();
  const view = mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(5, 5); // caret right after "hello"
  const updated = [
    block("u1", "hello there [[World]]", { order_idx: 0 }),
    BLOCKS[1],
  ];
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={updated} focus={{ uid: "u1", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(ta.value).toBe("hello there [[World]]");
  expect(ta.selectionStart).toBe(5);
  expect(ta.selectionEnd).toBe(5);
});

test("adopting a remote update clamps the caret to the new (shorter) length", () => {
  const h = handlers();
  const view = mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(15, 15);
  const updated = [
    block("u1", "hi", { order_idx: 0 }),
    BLOCKS[1],
  ];
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={updated} focus={{ uid: "u1", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(ta.value).toBe("hi");
  expect(ta.selectionStart).toBe(2);
});

test("an emptied (previously-written) block still renders a clickable, focusable block-text (pkm-mc07)", () => {
  const h = handlers();
  const emptied = [block("u1", "", { order_idx: 0 })];
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={emptied} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  const row = container.querySelector('.block-row[data-uid="u1"]');
  expect(row).not.toBeNull();
  const blockText = row!.querySelector(".block-text");
  expect(blockText).not.toBeNull();
  fireEvent.click(blockText!);
  expect(h.onFocusBlock).toHaveBeenCalledWith("u1", 0);
});

test("collapsed children are hidden", () => {
  const h = handlers();
  const t = [block("p", "parent", {
    order_idx: 0, collapsed: true,
    children: [block("k", "hidden kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={t} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(screen.queryByText("hidden kid")).toBeNull();
});

function mountWithPageRoute(h: OutlineHandlers,
                            focus: { uid: string; cursor: number } | null) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <EditableBlockTree blocks={BLOCKS} focus={focus} handlers={h} readOnly={false} />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>);
}

test("Ctrl-O inside a [[page reference]] navigates to that page (pkm-ul9u)", () => {
  const h = handlers();
  mountWithPageRoute(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(9, 9); // caret inside "[[World]]" (block text: "hello [[World]]")
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

test("Ctrl-O outside a ref does not navigate or preventDefault (pkm-ul9u)", () => {
  const h = handlers();
  mountWithPageRoute(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(2, 2); // caret inside "hello", not a ref
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  expect(screen.queryByText("page view here")).toBeNull();
  expect(screen.getByText("home")).toBeInTheDocument();
});

test("Cmd-K wraps the selection as a markdown link (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5); // select "hello" in "hello [[World]]"
  fireEvent.keyDown(ta, { key: "k", metaKey: true });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[hello]() [[World]]");
});

test("Cmd-K with no selection inserts an empty []() (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "k", metaKey: true });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[]()hello [[World]]");
});

test("Ctrl-K is left alone (mac kill-line, not link) (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5);
  fireEvent.keyDown(ta, { key: "k", ctrlKey: true });
  expect(h.onDraftChange).not.toHaveBeenCalled();
});

test("typing [ auto-closes the bracket (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "[" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[]hello [[World]]");
});

test("typing ( around a selection wraps it (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5); // "hello"
  fireEvent.keyDown(ta, { key: "(" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "(hello) [[World]]");
});

test("typing [ twice opens the [[ page-link autocomplete (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  // Start from an empty block so the [[ is unambiguous.
  fireEvent.change(ta, { target: { value: "" } });
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "[" }); // -> "[]" caret 1
  // The real browser leaves the caret between the pair; jsdom won't run the
  // rAF that places it, so set it explicitly before the second keystroke.
  ta.setSelectionRange(1, 1);
  fireEvent.keyDown(ta, { key: "[" }); // -> "[[]]" caret 2, ref popup opens
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[[]]");
});

test("/upload strips the trigger and hands picked files to onFiles (pkm-coz9)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/upload" } });
  ta.setSelectionRange(7, 7);
  expect(screen.getByRole("option", { name: "Upload file…" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" }); // pick /upload
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", ""); // trigger stripped
  const input = screen.getByLabelText("Upload file") as HTMLInputElement;
  const file = new File(["x"], "pic.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(h.onFiles).toHaveBeenCalledWith("u1", 0, [file]);
});

test("Shift+ArrowDown at a block edge starts a block selection (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(h.onStartBlockSelection).toHaveBeenCalledWith("u1", "down");
});

test("Shift+ArrowUp at a block edge starts a block selection upward (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  expect(h.onStartBlockSelection).toHaveBeenCalledWith("u1", "up");
});

test("Shift+Arrow inside a multi-line block extends text, not blocks (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(8, 8); // on line2, not the top edge
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  expect(h.onStartBlockSelection).not.toHaveBeenCalled();
});

function mountSelected(h: OutlineHandlers, selection: { anchor: string; head: string }) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
}

test("selected block rows get the selected class (pkm-9b8n)", () => {
  const { container } = mountSelected(handlers(), { anchor: "u1", head: "u2" });
  expect(container.querySelector('.block-row.selected[data-uid="u1"]')).not.toBeNull();
  expect(container.querySelector('.block-row.selected[data-uid="u2"]')).not.toBeNull();
});

test("Shift+Arrow on the selection extends it; Escape clears it (pkm-9b8n)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u1" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
  expect(h.onExtendBlockSelection).toHaveBeenCalledWith("down");
  fireEvent.keyDown(tree, { key: "Escape" });
  expect(h.onClearBlockSelection).toHaveBeenCalled();
});

test("a plain arrow collapses the selection back to editing the head (pkm-9b8n)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  expect(h.onFocusBlock).toHaveBeenCalledWith("u2", 0);
});

test("Cmd-C copies the selected blocks' text in document order (pkm-9b8n)", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText }, configurable: true,
  });
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(tree, { key: "c", metaKey: true });
  expect(writeText).toHaveBeenCalledWith("hello [[World]]\n{{[[TODO]]}} task");
});
