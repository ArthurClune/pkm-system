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
    onSetViewType: vi.fn(),
    onToggleTodo: vi.fn(), onFiles: vi.fn(),
    onStartBlockSelection: vi.fn(), onExtendBlockSelection: vi.fn(),
    onClearBlockSelection: vi.fn(), onDragStartBlock: vi.fn(),
    onMoveSelectionUp: vi.fn(), onMoveSelectionDown: vi.fn(),
    onDeleteBlockSelection: vi.fn(),
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

test("quoted display hides the prefix while editing exposes the raw source", () => {
  const quoted = [block("q1", "> **hello** [[World]]")];
  const h = handlers();
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={quoted} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  const display = view.container.querySelector('[data-uid="q1"] .quote-block');
  expect(display).not.toBeNull();
  expect(display).toHaveTextContent("hello World");
  expect(display).not.toHaveTextContent("> ");

  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={quoted} focus={{ uid: "q1", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(focusedTextarea()).toHaveValue("> **hello** [[World]]");
});

test("a TODO inside a quote remains interactive", () => {
  const h = handlers();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("q1", "> {{[[TODO]]}} task")]}
                         focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>);
  fireEvent.click(screen.getByRole("checkbox", { name: "TODO" }));
  expect(h.onToggleTodo).toHaveBeenCalledWith("q1");
});

test("removing the quote prefix removes quote presentation", () => {
  const h = handlers();
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("q1", "> hello")]} focus={null}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(view.container.querySelector('[data-uid="q1"] .quote-block')).not.toBeNull();
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("q1", "hello")]} focus={null}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(view.container.querySelector('[data-uid="q1"] .quote-block')).toBeNull();
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

test("Ctrl-Alt-0 through Ctrl-Alt-3 set plain text and heading levels", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  for (const key of ["0", "1", "2", "3"]) {
    fireEvent.keyDown(ta, { key, ctrlKey: true, altKey: true });
  }
  expect(h.onSetHeading).toHaveBeenNthCalledWith(1, "u1", null);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(2, "u1", 1);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(3, "u1", 2);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(4, "u1", 3);
  expect(h.onDraftChange).not.toHaveBeenCalled();
});

test("heading shortcuts do not mutate a read-only outline", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 }, true);
  fireEvent.keyDown(focusedTextarea(), {
    key: "2", ctrlKey: true, altKey: true,
  });
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("heading shortcuts use the physical digit when Alt changes the key glyph", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  fireEvent.keyDown(focusedTextarea(), {
    key: "™", code: "Digit2", ctrlKey: true, altKey: true,
  });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 2);
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

test("Cmd-Enter cycles the block's TODO state, updating the textarea immediately (pkm-wquz)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
  expect(ta).toHaveValue("{{TODO}} hello [[World]]");
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} hello [[World]]");
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("Ctrl-Enter also cycles the block's TODO state (pkm-wquz)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
  expect(ta).toHaveValue("{{TODO}} hello [[World]]");
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} hello [[World]]");
});

test("Cmd-Shift-Enter does not cycle the TODO state (pkm-wquz)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true, shiftKey: true });
  expect(ta).toHaveValue("hello [[World]]");
  expect(h.onDraftChange).not.toHaveBeenCalled();
  expect(h.onSplit).not.toHaveBeenCalled();
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

test("Alt+ArrowUp/Down on a selection moves the whole group, not just one block (pkm-q89w)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(tree, { key: "ArrowUp", altKey: true });
  expect(h.onMoveSelectionUp).toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: "ArrowDown", altKey: true });
  expect(h.onMoveSelectionDown).toHaveBeenCalled();
});

test("Backspace/Delete on a selection deletes the whole group (pkm-q89w)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(tree, { key: "Backspace" });
  expect(h.onDeleteBlockSelection).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(tree, { key: "Delete" });
  expect(h.onDeleteBlockSelection).toHaveBeenCalledTimes(2);
});

// --- bullet context menu: Copy block reference (pkm-y6af) ---

function bullet(container: HTMLElement, uid: string): Element {
  const el = container.querySelector(`[data-uid="${uid}"] .bullet`);
  expect(el).not.toBeNull();
  return el as Element;
}

test("clicking a bullet opens the block menu (pkm-y6af)", () => {
  const { container } = mount(handlers(), null);
  fireEvent.click(bullet(container, "u1"));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Copy block reference" }))
    .toBeInTheDocument();
});

test("right-clicking a bullet opens the block menu (pkm-y6af)", () => {
  const { container } = mount(handlers(), null);
  fireEvent.contextMenu(bullet(container, "u2"));
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("keyboard opens and navigates the block menu, then restores trigger focus", () => {
  const { container } = mount(handlers(), null);
  const trigger = bullet(container, "u1") as HTMLElement;
  trigger.focus();
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "false");

  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const copy = screen.getByRole("menuitem", { name: "Copy block reference" });
  expect(copy).toHaveFocus();
  fireEvent.keyDown(copy, { key: "ArrowDown" });
  expect(screen.getByRole("menuitemradio", { name: "Plain text" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(screen.getByRole("menuitemradio", { name: "View as document" }))
    .toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");

  fireEvent.keyDown(trigger, { key: "ContextMenu" });
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

test("Copy block reference writes ((uid)) and closes the menu (pkm-y6af)", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText }, configurable: true,
  });
  const { container } = mount(handlers(), null);
  fireEvent.click(bullet(container, "u1"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy block reference" }));
  expect(writeText).toHaveBeenCalledWith("((u1))");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Escape and click-away close the block menu (pkm-y6af)", () => {
  const { container } = mount(handlers(), null);
  fireEvent.click(bullet(container, "u1"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(bullet(container, "u2"));
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the block menu also opens in read-only mode (pkm-y6af)", () => {
  // copying a ref is read-only-safe, same as multi-block copy
  const { container } = mount(handlers(), null, true);
  fireEvent.click(bullet(container, "u1"));
  expect(screen.getByRole("menuitem", { name: "Copy block reference" }))
    .toBeInTheDocument();
});

test("block menu marks current heading/view and dispatches both control groups", () => {
  const h = handlers();
  const blocks = [block("u1", "hello", {
    heading: 2, view_type: "numbered",
    children: [block("u2", "child")],
  })];
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);

  fireEvent.click(bullet(view.container, "u1"));
  expect(screen.getByRole("menuitemradio", { name: "Heading 2" }))
    .toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "View as numbered list" }))
    .toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 1" }));
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 1);

  fireEvent.click(bullet(view.container, "u1"));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "View as document" }));
  expect(h.onSetViewType).toHaveBeenCalledWith("u1", "document");
});

test("block menu exposes all heading choices; unset view shows document", () => {
  const h = handlers();
  const blocks = [block("root", "root", { view_type: "numbered", children: [
    block("child", "child", { heading: null, children: [block("leaf", "leaf")] }),
  ] })];
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  fireEvent.click(bullet(view.container, "child"));
  for (const name of ["Plain text", "Heading 1", "Heading 2", "Heading 3"]) {
    expect(screen.getByRole("menuitemradio", { name })).toBeInTheDocument();
  }
  expect(screen.getByRole("menuitemradio", { name: "Plain text" }))
    .toHaveAttribute("aria-checked", "true");
  // The child's own view is unset: it does not inherit the parent's numbered
  // mode, so the menu reflects the document default.
  expect(screen.getByRole("menuitemradio", { name: "View as document" }))
    .toHaveAttribute("aria-checked", "true");
});

test("read-only block menus show but disable mutation controls", () => {
  const h = handlers();
  const view = mount(h, null, true);
  fireEvent.click(bullet(view.container, "u1"));
  expect(screen.getByRole("menuitem", { name: "Copy block reference" }))
    .toBeEnabled();
  for (const name of ["Plain text", "Heading 1", "Heading 2", "Heading 3",
                      "View as numbered list", "View as document"]) {
    expect(screen.getByRole("menuitemradio", { name })).toBeDisabled();
  }
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 3" }));
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("editable rendering numbers direct children only", () => {
  const h = handlers();
  const blocks = [block("root", "root", { view_type: "numbered", children: [
    block("a", "A", { order_idx: 0, children: [block("a1", "A1")] }),
    block("b", "B", { order_idx: 1, view_type: "numbered",
      children: [block("b1", "B1")] }),
  ] })];
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  const marker = (uid: string) =>
    view.container.querySelector(`[data-uid="${uid}"] > .bullet`)?.textContent;
  expect([marker("root"), marker("a"), marker("b"), marker("a1"), marker("b1")])
    .toEqual(["", "1.", "2.", "", "1."]);
});
