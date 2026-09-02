import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, test, vi } from "vitest";
import { block } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import type { OutlineHandlers } from "../outline/handlers";
import { EditableBlockTree } from "./EditableBlockTree";

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onFlushDraft: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveSubtreeUp: vi.fn(), onMoveSubtreeDown: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onSetHeading: vi.fn(),
    onSetViewType: vi.fn(),
    onToggleTodo: vi.fn(), onFiles: vi.fn(), onPasteOutline: vi.fn(),
    onStartBlockSelection: vi.fn(), onSelectBlock: vi.fn(),
    onExtendBlockSelection: vi.fn(),
    onClearBlockSelection: vi.fn(), onDragStartBlock: vi.fn(),
    onIndentSelection: vi.fn(), onOutdentSelection: vi.fn(),
    onMoveSelectionUp: vi.fn(), onMoveSelectionDown: vi.fn(),
    onDeleteBlockSelection: vi.fn(),
    onUndo: vi.fn(), onRedo: vi.fn(),
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
  // jsdom does not apply the stylesheet's `.chevron.hidden { visibility:
  // hidden }`, so the childless "kid" block's chevron is still reachable by
  // role in this test even though the browser would hide it visually.
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

test("fallback renders nested rich text but exposes no editor controls", () => {
  const h = handlers();
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree
        blocks={[block("parent", "Papers", {
          heading: 2,
          children: [block("child", "read [[Paper]]")],
        })]}
        focus={null}
        handlers={h}
        readOnly={false}
        fallback
      />
    </MemoryRouter>,
  );

  expect(screen.getByText("Papers").closest("h2")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "toggle children" })[0])
    .toBeDisabled();
  const bullet = container.querySelector('[data-uid="parent"] .bullet');
  expect(bullet).not.toHaveAttribute("role");
  expect(bullet).not.toHaveAttribute("tabindex");
  fireEvent.click(screen.getByText("Papers"));
  expect(h.onFocusBlock).not.toHaveBeenCalled();
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

test("/upload strips the trigger and hands picked files to onFiles (pkm-coz9)", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/upload" } });
  ta.setSelectionRange(7, 7);
  expect(screen.getByRole("option", { name: "upload file…" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" }); // pick /upload
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", ""); // trigger stripped
  const input = screen.getByLabelText("Upload file") as HTMLInputElement;
  const file = new File(["x"], "pic.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(h.onFiles).toHaveBeenCalledWith("u1", 0, [file]);
});

test("the upload input survives the block blurring while the native picker is "
     + "open, so a late file choice still reaches onFiles (pkm-gbsb)", () => {
  const h = handlers();
  const view = mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/upload" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" }); // pick /upload, opens the native dialog

  // The native dialog taking focus blurs the textarea; in the real app
  // onBlurBlock -> setFocus(null) unmounts BlockInput while the picker is
  // still open. Simulate that focus loss here.
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
  expect(screen.queryByRole("textbox")).toBeNull(); // BlockInput did unmount

  const input = screen.getByLabelText("Upload file") as HTMLInputElement;
  const file = new File(["x"], "pic.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(h.onFiles).toHaveBeenCalledWith("u1", 0, [file]);
});

test("only one upload input exists in the tree regardless of block count", () => {
  mount(handlers(), { uid: "u1", cursor: 0 });
  expect(screen.getAllByLabelText("Upload file")).toHaveLength(1);
});

test("a readOnly tree renders no upload input", () => {
  mount(handlers(), null, true);
  expect(screen.queryByLabelText("Upload file")).toBeNull();
});

function mountSelected(
  h: OutlineHandlers,
  selection: { anchor: string; head: string },
  readOnly = false,
) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly={readOnly} />
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

test("Tab and Shift-Tab indent and outdent an editable selection (pkm-0ovd)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "Tab" })).toBe(false);
  expect(h.onIndentSelection).toHaveBeenCalledTimes(1);
  expect(fireEvent.keyDown(tree, { key: "Tab", shiftKey: true })).toBe(false);
  expect(h.onOutdentSelection).toHaveBeenCalledTimes(1);
});

test("Tab does not mutate a read-only selection (pkm-0ovd)", () => {
  const h = handlers();
  const { container } = mountSelected(
    h, { anchor: "u1", head: "u2" }, true,
  );
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "Tab", shiftKey: true })).toBe(true);
  expect(h.onIndentSelection).not.toHaveBeenCalled();
  expect(h.onOutdentSelection).not.toHaveBeenCalled();
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

test("Ctrl+Cmd+Arrow extends an active selection block-by-block (pkm-am54)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u1" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;
  expect(fireEvent.keyDown(tree, {
    key: "ArrowDown", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onExtendBlockSelection).toHaveBeenCalledWith("down");
  expect(fireEvent.keyDown(tree, {
    key: "ArrowUp", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onExtendBlockSelection).toHaveBeenCalledWith("up");
  expect(h.onMoveSelectionUp).not.toHaveBeenCalled();
  expect(h.onMoveSelectionDown).not.toHaveBeenCalled();
});

test("Shift+Cmd+Arrow moves a selection before plain Shift handling", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, {
    key: "ArrowUp", shiftKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onMoveSelectionUp).toHaveBeenCalledTimes(1);
  expect(fireEvent.keyDown(tree, {
    key: "ArrowDown", shiftKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onMoveSelectionDown).toHaveBeenCalledTimes(1);
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
});

test("selected Option+Arrow remains unhandled", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "ArrowDown", altKey: true })).toBe(true);
  expect(h.onMoveSelectionUp).not.toHaveBeenCalled();
  expect(h.onMoveSelectionDown).not.toHaveBeenCalled();
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
  expect(h.onFocusBlock).not.toHaveBeenCalled();
});

test("read-only Shift+Cmd does not move or extend a selection", () => {
  const h = handlers();
  const { container } = mountSelected(
    h, { anchor: "u1", head: "u2" }, true,
  );
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, {
    key: "ArrowUp", shiftKey: true, metaKey: true,
  })).toBe(true);
  expect(h.onMoveSelectionUp).not.toHaveBeenCalled();
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
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

test("read-only Backspace/Delete cannot destroy a selection (pkm-rckh)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" }, true);
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  // not handled: the event stays uncancelled, exactly like read-only
  // Shift+Cmd+Arrow above
  expect(fireEvent.keyDown(tree, { key: "Backspace" })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "Delete" })).toBe(true);
  expect(h.onDeleteBlockSelection).not.toHaveBeenCalled();
  // creating and copying a selection stay read-only-safe (pkm-am54)
  expect(fireEvent.keyDown(tree, {
    key: "ArrowDown", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onExtendBlockSelection).toHaveBeenCalledWith("down");
});

test("a selection made while editable is safe once sync turns the outline read-only (pkm-rckh)", () => {
  const h = handlers();
  const selection = { anchor: "u1", head: "u2" };
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  const tree = view.container.querySelector(".block-tree") as HTMLDivElement;

  // the socket drops / storage fills: the same live selection is now read-only
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly />
    </MemoryRouter>);
  fireEvent.keyDown(tree, { key: "Backspace" });
  expect(h.onDeleteBlockSelection).not.toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: "Escape" });
  expect(h.onClearBlockSelection).toHaveBeenCalledTimes(1); // still dismissible
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

// pkm-muka: the menu is position:fixed and anchored at viewport coordinates,
// so it must never render inside a container that imposes layout containment
// -- such a container becomes the containing block for fixed descendants and
// displaces the menu by its own offset (styling.md carries the invariant).
test("the block menu renders in a portal at document.body (pkm-muka)", () => {
  const { container } = mount(handlers(), null);
  fireEvent.click(bullet(container, "u1"));
  expect(container.querySelector(".block-menu")).toBeNull();
  expect(screen.getByRole("menu").parentElement).toBe(document.body);
});

// A portal still bubbles its synthetic events through the REACT tree
// (PdfViewer.tsx documents the hazard), so the menu being out of the DOM
// subtree is no reason to stop checking that a pick can't reach a row.
test("a menu item's click does not reach the row's click-to-edit (pkm-muka)", () => {
  const h = handlers();
  const { container } = mount(h, null);
  fireEvent.click(bullet(container, "u1"));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 1" }));
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 1);
  expect(h.onFocusBlock).not.toHaveBeenCalled();
});

// The menu's own keys (roving focus, Tab-to-close) live in a different effect
// from its Escape/click-away dismissal, so they need coverage that would
// notice one of the two going missing.
test("the block menu keeps its roving focus and Tab-closes", () => {
  const { container } = mount(handlers(), null);
  fireEvent.click(bullet(container, "u1"));
  const copy = screen.getByRole("menuitem", { name: "Copy block reference" });
  expect(copy).toHaveFocus();
  // fired on document, where the listener is: firing on a menu item would
  // also run the tree's own Tab handling on the way up
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(screen.getByRole("menuitemradio", { name: "Plain text" })).toHaveFocus();
  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(copy).toHaveFocus();
  fireEvent.keyDown(document, { key: "Tab" });
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

test("a rendered Roam table focuses its macro and reveals raw editable blocks", () => {
  const h = handlers();
  const macro = block("table", "{{[[table]]}}", { collapsed: true, children: [
    block("header", "Model", { children: [block("header-2", "Price")] }),
    block("row", "Claude", { children: [block("row-2", "$5")] }),
  ] });
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("table"));
  expect(h.onFocusBlock).toHaveBeenCalledWith("table", "{{[[table]]}}".length);

  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={{ uid: "table", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(focusedTextarea()).toHaveValue("{{[[table]]}}");
  expect(screen.getByText("Model")).toBeInTheDocument();
  expect(screen.getByText("Claude")).toBeInTheDocument();
  expect(view.container.querySelector('[data-uid="table"] .bullet.closed')).toBeNull();
});

test("a rendered Roam table stays in raw mode when focus moves to a revealed descendant", () => {
  const h = handlers();
  const macro = block("table", "{{[[table]]}}", { collapsed: true, children: [
    block("header", "Model", { children: [block("header-2", "Price")] }),
    block("row", "Claude", { children: [block("row-2", "$5")] }),
  ] });
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("table"));
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={{ uid: "table", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>,
  );
  expect(focusedTextarea()).toHaveValue("{{[[table]]}}");

  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={{ uid: "row-2", cursor: 1 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText("Model")).toBeInTheDocument();
  expect(screen.getByText("Claude")).toBeInTheDocument();
  expect(focusedTextarea()).toHaveValue("$5");
  expect(view.container.querySelector('[data-uid="table"] .chevron'))
    .not.toHaveClass("closed");
  expect(view.container.querySelector('[data-uid="table"] .bullet.closed')).toBeNull();
  expect(document.activeElement).toBe(focusedTextarea());
  expect(focusedTextarea().selectionStart).toBe(1);
});

test("an unfocused valid Roam table with a heading renders inside div.block-text, not a heading tag", () => {
  const h = handlers();
  const macro = block("table", "{{[[table]]}}", {
    heading: 2,
    children: [
      block("header", "Model", { children: [block("header-2", "Price")] }),
      block("row", "Claude", { children: [block("row-2", "$5")] }),
    ],
  });
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  const rendered = screen.getByRole("table");
  const blockText = container.querySelector('[data-uid="table"] .block-text');
  expect(blockText?.tagName).toBe("DIV");
  expect(rendered.closest(".block-text")).toBe(blockText);
  expect(rendered.closest("h1, h2, h3")).toBeNull();
});

// --- block-stamp margin column (bean pkm-4ler) ---

const DAY = 24 * 60 * 60 * 1000;

function mountStamped(blocks: BlockNode[], stamps: boolean) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={handlers()}
                         readOnly={false} stamps={stamps} />
    </MemoryRouter>);
}

test("renders no stamp column unless asked (journal and sidebar mounts)", () => {
  const view = mountStamped([block("s1", "text", { updated_at: Date.now() })],
                            false);
  expect(view.container.querySelector(".block-stamp")).toBeNull();
});

test("renders the stamp cell with the age band of updated_at", () => {
  const now = Date.now();
  const view = mountStamped([
    block("s1", "this week", { updated_at: now - 2 * DAY, order_idx: 0 }),
    block("s2", "this month", { updated_at: now - 20 * DAY, order_idx: 1 }),
    block("s3", "this year", { updated_at: now - 200 * DAY, order_idx: 2 }),
    block("s4", "ancient", { updated_at: now - 900 * DAY, order_idx: 3 }),
  ], true);
  const bandOf = (uid: string) =>
    view.container.querySelector(`[data-uid="${uid}"] .block-stamp`)?.className;

  expect(bandOf("s1")).toContain("block-stamp-week");
  expect(bandOf("s2")).toContain("block-stamp-month");
  expect(bandOf("s3")).toContain("block-stamp-year");
  expect(bandOf("s4")).toContain("block-stamp-older");
});

test("shows created_at when updated_at is missing, with a full hover title", () => {
  const created = new Date(2026, 7, 3, 14, 22).getTime();
  const view = mountStamped(
    [block("s1", "text", { created_at: created, updated_at: null })], true);
  const cell = view.container.querySelector(".block-stamp")!;

  expect(cell).toHaveTextContent("3 Aug 26");
  expect(cell).toHaveAttribute("title", "3 August 2026, 14:22");
});

test("keeps an empty cell when the block has no timestamps at all", () => {
  const view = mountStamped(
    [block("s1", "text", { created_at: null, updated_at: null })], true);
  const cell = view.container.querySelector(".block-stamp")!;

  // Present but blank: omitting it would let this row's text run wider than
  // its neighbours' and break the column.
  expect(cell).not.toBeNull();
  expect(cell.textContent).toBe("");
  expect(cell.className).toBe("block-stamp");
  expect(cell).not.toHaveAttribute("title");
});

test("stamps nested rows too, as the last child of their own row", () => {
  const now = Date.now();
  const view = mountStamped([block("p1", "parent", {
    updated_at: now,
    children: [block("c1", "child", { updated_at: now - 200 * DAY })],
  })], true);
  const childRow = view.container.querySelector('[data-uid="c1"]')!;

  expect(childRow.lastElementChild).toHaveClass("block-stamp");
  expect(childRow.lastElementChild).toHaveClass("block-stamp-year");
});

test("the stamp stays the row's last child while the block is focused", () => {
  const now = Date.now();
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("s1", "text", { updated_at: now })]}
                         focus={{ uid: "s1", cursor: 0 }} handlers={handlers()}
                         readOnly={false} stamps />
    </MemoryRouter>);
  const row = view.container.querySelector('[data-uid="s1"]')!;

  expect(row.querySelector("textarea")).not.toBeNull();
  expect(row.lastElementChild).toHaveClass("block-stamp");
});

// --- reference-count gutter badge (pkm-d31f) ---

test("blocks with incoming refs show a count badge; others none", () => {
  const h = handlers();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} handlers={h}
                         readOnly={false} refCounts={{ [BLOCKS[0].uid]: 3 }} />
    </MemoryRouter>);
  const badge = screen.getByRole("button", { name: "3 references" });
  expect(badge).toHaveClass("block-ref-badge");
  expect(badge).toHaveTextContent("3");
  expect(screen.getAllByRole("button", { name: /references?$/ })).toHaveLength(1);
});

test("badge click does not focus the block", () => {
  const h = handlers();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} handlers={h}
                         readOnly={false} refCounts={{ [BLOCKS[0].uid]: 1 }} />
    </MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "1 reference" }));
  expect(h.onFocusBlock).not.toHaveBeenCalled();
});
