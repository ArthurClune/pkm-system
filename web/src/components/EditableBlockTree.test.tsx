import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";
import { block } from "../test-helpers";
import type { OutlineHandlers } from "./EditableBlockTree";
import { EditableBlockTree } from "./EditableBlockTree";

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveUp: vi.fn(), onMoveDown: vi.fn(), onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onToggleTodo: vi.fn(),
    onFiles: vi.fn(),
  };
}

const BLOCKS = [
  block("u1", "hello [[World]]", { order_idx: 0 }),
  block("u2", "{{[[TODO]]}} task", { order_idx: 1 }),
];

function mount(h: OutlineHandlers, focus: { uid: string; cursor: number } | null,
               readOnly = false) {
  return render(
    <MemoryRouter>
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
    <MemoryRouter>
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
    <MemoryRouter>
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
    <MemoryRouter>
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

test("collapsed children are hidden", () => {
  const h = handlers();
  const t = [block("p", "parent", {
    order_idx: 0, collapsed: true,
    children: [block("k", "hidden kid", { order_idx: 0 })],
  })];
  render(
    <MemoryRouter>
      <EditableBlockTree blocks={t} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>);
  expect(screen.queryByText("hidden kid")).toBeNull();
});
