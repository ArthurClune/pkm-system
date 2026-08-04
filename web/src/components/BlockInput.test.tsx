import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { describe, expect, test, vi } from "vitest";
import { SidebarContext } from "../contexts";
import { titleForDate } from "../replica/daily";
import { block, stubFetch } from "../test-helpers";
import type { OutlineHandlers } from "../outline/handlers";
import { BlockInput } from "./BlockInput";

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

const NODE = block("u1", "hello [[World]]", { order_idx: 0 });

function inputElement(
  h: OutlineHandlers,
  node = NODE,
  cursor = 0,
  readOnly = false,
) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <BlockInput
        node={node}
        cursor={cursor}
        handlers={h}
        readOnly={readOnly}
        onRequestUpload={vi.fn()}
      />
    </MemoryRouter>
  );
}

function mount(
  h: OutlineHandlers,
  cursor = 0,
  readOnly = false,
  node = NODE,
) {
  return render(inputElement(h, node, cursor, readOnly));
}

function focusedTextarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

test("the focused block is a textarea with the raw markdown", () => {
  mount(handlers(), 5);
  const ta = focusedTextarea();
  expect(ta.value).toBe("hello [[World]]");
  expect(document.activeElement).toBe(ta);
  expect(ta.selectionStart).toBe(5);
});

test.each([
  [1, "heading-1"],
  [2, "heading-2"],
  [3, "heading-3"],
] as const)("a focused heading %i retains the %s typography class",
            (heading, className) => {
  const h = handlers();
  mount(h, 0, false, block("heading", "Heading", { heading }));

  expect(focusedTextarea()).toHaveClass("block-input", className);
});

test("a focused plain-text block keeps block-input and omits heading classes", () => {
  const h = handlers();
  mount(h, 0, false, block("plain", "Heading", { heading: null }));

  const ta = focusedTextarea();
  expect(ta).toHaveClass("block-input");
  expect(ta).not.toHaveClass("heading-1");
  expect(ta).not.toHaveClass("heading-2");
  expect(ta).not.toHaveClass("heading-3");
});

test("typing reports the draft", () => {
  const h = handlers();
  mount(h, 0);
  fireEvent.change(focusedTextarea(), { target: { value: "hi" } });
  expect(h.onDraftChange).toHaveBeenCalledWith("u1", "hi");
});

test("keyboard map dispatches to the right handlers", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).toHaveBeenCalledWith("u1", 3);
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(h.onIndent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
  expect(h.onOutdent).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true, metaKey: true });
  expect(h.onMoveSubtreeUp).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true, metaKey: true });
  expect(h.onMoveSubtreeDown).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowUp" }); // single-line: crosses up
  expect(h.onArrow).toHaveBeenCalledWith("u1", "up");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "Backspace" });
  expect(h.onBackspaceAtStart).toHaveBeenCalledWith("u1");
  fireEvent.keyDown(ta, { key: "ArrowLeft" });
  expect(h.onArrow).toHaveBeenCalledWith("u1", "left");
});

test("Option+Arrow stays with browser text handling", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();

  expect(fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(ta, { key: "ArrowDown", altKey: true })).toBe(true);
  expect(h.onMoveSubtreeUp).not.toHaveBeenCalled();
  expect(h.onMoveSubtreeDown).not.toHaveBeenCalled();
  expect(h.onArrow).not.toHaveBeenCalled();
});

test("Cmd-Alt-0 through Cmd-Alt-3 set plain text and heading levels", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  for (const key of ["0", "1", "2", "3"]) {
    fireEvent.keyDown(ta, { key, metaKey: true, altKey: true });
  }
  expect(h.onSetHeading).toHaveBeenNthCalledWith(1, "u1", null);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(2, "u1", 1);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(3, "u1", 2);
  expect(h.onSetHeading).toHaveBeenNthCalledWith(4, "u1", 3);
  expect(h.onDraftChange).not.toHaveBeenCalled();
});

test("the old Ctrl-Alt heading chord no longer fires (pkm-bt9h)", () => {
  const h = handlers();
  mount(h, 0);
  fireEvent.keyDown(focusedTextarea(), {
    key: "2", ctrlKey: true, altKey: true,
  });
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("heading shortcuts do not mutate a read-only outline", () => {
  const h = handlers();
  mount(h, 0, true);
  fireEvent.keyDown(focusedTextarea(), {
    key: "2", metaKey: true, altKey: true,
  });
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("heading shortcuts use the physical digit when Alt changes the key glyph", () => {
  const h = handlers();
  mount(h, 0);
  fireEvent.keyDown(focusedTextarea(), {
    key: "™", code: "Digit2", metaKey: true, altKey: true,
  });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 2);
});

test("Shift-Enter does not split (literal newline)", () => {
  const h = handlers();
  mount(h, 0);
  fireEvent.keyDown(focusedTextarea(), { key: "Enter", shiftKey: true });
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("arrows stay inside a multi-line draft until the edge line", () => {
  const h = handlers();
  mount(h, 0);
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
  mount(h, 0, true);
  const ta = focusedTextarea();
  expect(ta).toHaveAttribute("readonly");
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(ta); // mount effect focused it
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(document.activeElement).not.toBe(ta);
});

test("typing / opens the command menu; Enter wraps the block in a code fence", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  expect(screen.getByRole("option", { name: "python code block" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter was consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```python\n\n```");
  expect(screen.queryByRole("listbox")).toBeNull(); // popup closed
});

test("/t filters to text+todo; ArrowDown+Enter picks /todo", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/t" } });
  ta.setSelectionRange(2, 2);
  expect(screen.getByRole("option", { name: "text" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "to-do" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // "text" -> "to-do"
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} ");
});

test("Option/Alt+Arrow stays unhandled while autocomplete is open", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();

  fireEvent.change(ta, { target: { value: "/t" } });
  ta.setSelectionRange(2, 2);
  expect(screen.getByRole("option", { name: "text" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "to-do" })).toBeInTheDocument();
  expect(fireEvent.keyDown(ta, { key: "ArrowDown", altKey: true })).toBe(true);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```\n\n```");

  fireEvent.change(ta, { target: { value: "/t" } });
  ta.setSelectionRange(2, 2);
  fireEvent.keyDown(ta, { key: "ArrowDown" });
  expect(fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true })).toBe(true);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} ");

  expect(h.onArrow).not.toHaveBeenCalled();
  expect(h.onMoveSubtreeUp).not.toHaveBeenCalled();
  expect(h.onMoveSubtreeDown).not.toHaveBeenCalled();
  expect(h.onStartBlockSelection).not.toHaveBeenCalled();
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("typing /tab offers Table; Enter inserts {{table}}", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/tab" } });
  ta.setSelectionRange(4, 4);
  expect(screen.getByRole("option", { name: "table" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{table}}")
});

test("clicking a slash-menu row picks it (mouseDown, not click)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  fireEvent.mouseDown(screen.getByRole("option", { name: "python code block" }));
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```python\n\n```");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Tab accepts the highlighted slash-menu row, same as Enter (pkm-x3so: this " +
     "already worked at HEAD — kept as a regression test)", () => {
  const h = handlers();
  mount(h, 0);
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
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/text" } });
  ta.setSelectionRange(5, 5);
  expect(screen.getByRole("option", { name: "text" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "```\n\n```");
});

test("a non-matching slash query shows no rows and Enter falls through to split", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/zzz" } });
  ta.setSelectionRange(4, 4);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).toHaveBeenCalledWith("u1", 4);
});

describe("a caret moved without an input event (pkm-noow)", () => {
  // A click or a selection-only key moves selectionStart with no input
  // event, so the context captured by the last onChange can describe a token
  // the caret has left. jsdom does not move the caret for a native key, so
  // these tests move the selection the way the browser does: before the next
  // event is dispatched.
  test("Enter splits at the live caret instead of applying the slash command", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "hello /py" } });
    ta.setSelectionRange(9, 9);
    expect(screen.getByRole("option", { name: "python code block" }))
      .toBeInTheDocument();

    ta.setSelectionRange(2, 2); // clicked back into "hello"
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(h.onSplit).toHaveBeenCalledWith("u1", 2);
    expect(h.onDraftChange)
      .not.toHaveBeenCalledWith("u1", expect.stringContaining("```"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("Tab indents instead of completing a stale [[ reference", () => {
    stubFetch([["/api/titles", { titles: [] }]]);
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, {
      target: { value: "see [[Al", selectionStart: 8, selectionEnd: 8 },
    });
    expect(screen.getByRole("option", { name: /New page: Al/ }))
      .toBeInTheDocument();

    ta.setSelectionRange(3, 3);
    fireEvent.keyDown(ta, { key: "Tab" });

    expect(h.onIndent).toHaveBeenCalledWith("u1");
    expect(ta).toHaveValue("see [[Al");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("clicking away from the token closes the popup", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "hello /py" } });
    ta.setSelectionRange(9, 9);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    ta.setSelectionRange(2, 2); // the browser moves the caret, then clicks
    fireEvent.click(ta);

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("clicking a row of a stale popup applies nothing", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "hello /py" } });
    ta.setSelectionRange(9, 9);
    const row = screen.getByRole("option", { name: "python code block" });

    ta.setSelectionRange(2, 2);
    fireEvent.mouseDown(row);

    expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "hello /py");
    expect(ta).toHaveValue("hello /py");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

test("typing /h1 shows the heading rows; Enter strips the trigger and dispatches onSetHeading", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "hello [[World]] /h1" } });
  ta.setSelectionRange(19, 19);
  expect(screen.getByRole("option", { name: "heading 1" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "hello [[World]] ");
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", 1);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("/h1 on a block that is already h1 toggles back to plain text", () => {
  const h = handlers();
  mount(h, 0, false, block("u1", "hello [[World]]", { order_idx: 0, heading: 1 }));
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "hello [[World]] /h1" } });
  ta.setSelectionRange(19, 19);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", null);
});

test("/normal always clears the heading, even from plain text", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/normal" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).toHaveBeenCalledWith("u1", null);
});

test("non-heading commands never call onSetHeading", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "/py" } });
  ta.setSelectionRange(3, 3);
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSetHeading).not.toHaveBeenCalled();
});

test("a remote update arriving mid-composition is deferred until composition ends", () => {
  const h = handlers();
  const view = mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.compositionStart(ta);
  const updated = block("u1", "hola [[World]]", { order_idx: 0 });
  view.rerender(inputElement(h, updated, 0));
  expect(ta.value).toBe("hello [[World]]"); // untouched while composing
  fireEvent.compositionEnd(ta);
  expect(ta.value).toBe("hola [[World]]"); // adopted once composition ends
});

test("adopting a remote update preserves the caret in a focused, clean textarea", () => {
  const h = handlers();
  const view = mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(5, 5); // caret right after "hello"
  const updated = block("u1", "hello there [[World]]", { order_idx: 0 });
  view.rerender(inputElement(h, updated, 0));
  expect(ta.value).toBe("hello there [[World]]");
  expect(ta.selectionStart).toBe(5);
  expect(ta.selectionEnd).toBe(5);
});

test("adopting a remote update clamps the caret to the new (shorter) length", () => {
  const h = handlers();
  const view = mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(15, 15);
  const updated = block("u1", "hi", { order_idx: 0 });
  view.rerender(inputElement(h, updated, 0));
  expect(ta.value).toBe("hi");
  expect(ta.selectionStart).toBe(2);
});

function mountWithPageRoute(h: OutlineHandlers, cursor: number) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <BlockInput
        node={NODE}
        cursor={cursor}
        handlers={h}
        readOnly={false}
        onRequestUpload={vi.fn()}
      />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>);
}

test("Ctrl-O inside a [[page reference]] navigates to that page (pkm-ul9u)", async () => {
  stubFetch([["/api/pages", { id: 1, title: "World", created_at: 0, updated_at: 0 }]]);
  const h = handlers();
  mountWithPageRoute(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(9, 9); // caret inside "[[World]]" (block text: "hello [[World]]")
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  await waitFor(() => expect(screen.getByText("page view here")).toBeInTheDocument());
});

test("Ctrl-O outside a ref does not navigate or preventDefault (pkm-ul9u)", () => {
  const h = handlers();
  mountWithPageRoute(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(2, 2); // caret inside "hello", not a ref
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  expect(screen.queryByText("page view here")).toBeNull();
  expect(screen.getByText("home")).toBeInTheDocument();
});

// pkm-a1e4: a freshly-typed [[ref]] whose caret never left the brackets has
// no server-side row yet (the create-on-flush path is held mid-token,
// pkm-xlah) -- Ctrl-O used to navigate straight to a page that 404s. It must
// create the page first.
test("Ctrl-O creates the target page before navigating if it doesn't exist yet (pkm-a1e4)", async () => {
  const fetchMock = stubFetch([
    ["/api/pages", { id: 9, title: "World", created_at: 0, updated_at: 0 }],
  ]);
  const h = handlers();
  mountWithPageRoute(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(9, 9);
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pages",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ title: "World" }),
    })));
  await waitFor(() => expect(screen.getByText("page view here")).toBeInTheDocument());
});

// pkm-hhbc (data loss): the draft that names the ref is flush-held while the
// caret is inside the token, and navigating unmounts this tree without a blur.
// The flush must therefore be asked for HERE, and before POST /api/pages, so
// the ref row is created by the normal ops path rather than racing it.
test("navigate-ref flushes the held draft before creating the page (pkm-hhbc)", async () => {
  const fetchMock = stubFetch([
    ["/api/pages", { id: 9, title: "World", created_at: 0, updated_at: 0 }],
  ]);
  const h = handlers();
  mountWithPageRoute(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(9, 9);
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true });
  expect(h.onFlushDraft).toHaveBeenCalled();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pages",
    expect.objectContaining({ method: "POST" })));
  const pagesCall = fetchMock.mock.calls
    .findIndex(([url]) => String(url).startsWith("/api/pages"));
  expect(vi.mocked(h.onFlushDraft).mock.invocationCallOrder[0])
    .toBeLessThan(fetchMock.mock.invocationCallOrder[pagesCall]);
});

test("Ctrl-Shift-O opens the reference in the sidebar instead of navigating (pkm-a1e4)", async () => {
  stubFetch([["/api/pages", { id: 9, title: "World", created_at: 0, updated_at: 0 }]]);
  const openInSidebar = vi.fn();
  const h = handlers();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <BlockInput
          node={NODE}
          cursor={0}
          handlers={h}
          readOnly={false}
          onRequestUpload={vi.fn()}
        />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>);
  const ta = focusedTextarea();
  ta.setSelectionRange(9, 9);
  fireEvent.keyDown(ta, { key: "o", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(openInSidebar).toHaveBeenCalledWith("World"));
  // the main pane must not have navigated
  expect(screen.getByText("home")).toBeInTheDocument();
});

test("Cmd-K wraps the selection as a markdown link (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5); // select "hello" in "hello [[World]]"
  fireEvent.keyDown(ta, { key: "k", metaKey: true });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[hello]() [[World]]");
});

test("Cmd-K with no selection inserts an empty []() (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "k", metaKey: true });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[]()hello [[World]]");
});

test("Ctrl-K is left alone (mac kill-line, not link) (pkm-jbjk)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5);
  fireEvent.keyDown(ta, { key: "k", ctrlKey: true });
  expect(h.onDraftChange).not.toHaveBeenCalled();
});

test("Cmd-Enter cycles the block's TODO state, updating the textarea immediately (pkm-wquz)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
  expect(ta).toHaveValue("{{TODO}} hello [[World]]");
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} hello [[World]]");
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("Ctrl-Enter also cycles the block's TODO state (pkm-wquz)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });
  expect(ta).toHaveValue("{{TODO}} hello [[World]]");
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "{{TODO}} hello [[World]]");
});

test("Cmd-Shift-Enter does not cycle the TODO state (pkm-wquz)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.keyDown(ta, { key: "Enter", metaKey: true, shiftKey: true });
  expect(ta).toHaveValue("hello [[World]]");
  expect(h.onDraftChange).not.toHaveBeenCalled();
  expect(h.onSplit).not.toHaveBeenCalled();
});

test("typing [ auto-closes the bracket (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "[" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[]hello [[World]]");
});

test("typing ( around a selection wraps it (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 5); // "hello"
  fireEvent.keyDown(ta, { key: "(" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "(hello) [[World]]");
});

test("typing [ twice opens the [[ page-link autocomplete (pkm-3sxw)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  // Start from an empty block so the [[ is unambiguous.
  fireEvent.change(ta, { target: { value: "" } });
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "[" }); // -> "[]" caret 1
  // The real browser leaves the caret between the pair; jsdom won't run the
  // rAF that places it, so set it explicitly before the second keystroke.
  ta.setSelectionRange(1, 1);
  fireEvent.keyDown(ta, { key: "[" }); // -> "[[]]" caret 2, ref popup opens
  // caret inside the open ref: the draft is flush-held (pkm-xlah)
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[[]]", true);
});

test("typing with the caret inside an open [[ ref holds the draft flush "
     + "(pkm-xlah)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  // auto-pair state: "[[How LLM]]" with the caret before the closer
  fireEvent.change(ta, {
    target: { value: "[[How LLM]]", selectionStart: 9, selectionEnd: 9 },
  });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[[How LLM]]", true);
});

test("a #tag token holds the draft flush until the token ends (pkm-xlah)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, {
    target: { value: "#How", selectionStart: 4, selectionEnd: 4 },
  });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "#How", true);
  fireEvent.change(ta, {
    target: { value: "#How ", selectionStart: 5, selectionEnd: 5 },
  });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "#How ");
});

test("Shift+ArrowDown at a block edge starts a block selection (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowDown", shiftKey: true });
  expect(h.onStartBlockSelection).toHaveBeenCalledWith("u1", "down");
});

test("Shift+ArrowUp at a block edge starts a block selection upward (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  expect(h.onStartBlockSelection).toHaveBeenCalledWith("u1", "up");
});

test("Shift+Arrow inside a multi-line block extends text, not blocks (pkm-9b8n)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(8, 8); // on line2, not the top edge
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  expect(h.onStartBlockSelection).not.toHaveBeenCalled();
});

test("Shift+ArrowUp with text selected starts a block selection, not a focus move (pkm-jgtn)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(2, 7);
  fireEvent.keyDown(ta, { key: "ArrowUp", shiftKey: true });
  expect(h.onStartBlockSelection).toHaveBeenCalledWith("u1", "up");
  expect(h.onArrow).not.toHaveBeenCalled();
});

test("Shift+Cmd+ArrowLeft selects line-wise: to the line start, then a line per press (pkm-jgtn)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(8, 8); // mid "line2"
  expect(fireEvent.keyDown(ta, {
    key: "ArrowLeft", shiftKey: true, metaKey: true,
  })).toBe(false); // preventDefault: we own the selection, not the browser
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([6, 8]);
  fireEvent.keyDown(ta, { key: "ArrowLeft", shiftKey: true, metaKey: true });
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 8]);
  // at the block start: nothing left to add
  fireEvent.keyDown(ta, { key: "ArrowLeft", shiftKey: true, metaKey: true });
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 8]);
});

test("Shift+Cmd+ArrowRight selects line-wise downward (pkm-jgtn)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  fireEvent.change(ta, { target: { value: "line1\nline2" } });
  ta.setSelectionRange(2, 2); // mid "line1"
  expect(fireEvent.keyDown(ta, {
    key: "ArrowRight", shiftKey: true, metaKey: true,
  })).toBe(false);
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 5]);
  fireEvent.keyDown(ta, { key: "ArrowRight", shiftKey: true, metaKey: true });
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 11]);
});

test("Ctrl+Cmd+ArrowLeft selects to the block start and stays there (pkm-am54)", () => {
  const h = handlers();
  mount(h, 5);
  const ta = focusedTextarea();
  ta.setSelectionRange(5, 5);
  expect(fireEvent.keyDown(ta, {
    key: "ArrowLeft", ctrlKey: true, metaKey: true,
  })).toBe(false); // preventDefault: we own the selection, not the browser
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 5]);
  // pressing again changes nothing — already selected to the start
  fireEvent.keyDown(ta, { key: "ArrowLeft", ctrlKey: true, metaKey: true });
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 5]);
});

test("Ctrl+Cmd+ArrowRight selects to the block end (pkm-am54)", () => {
  const h = handlers();
  mount(h, 6);
  const ta = focusedTextarea();
  ta.setSelectionRange(6, 6);
  expect(fireEvent.keyDown(ta, {
    key: "ArrowRight", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect([ta.selectionStart, ta.selectionEnd])
    .toEqual([6, "hello [[World]]".length]);
});

test("Ctrl+Cmd+ArrowUp/Down selects the whole block instead of moving focus (pkm-am54)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(0, 0);
  expect(fireEvent.keyDown(ta, {
    key: "ArrowUp", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onSelectBlock).toHaveBeenCalledWith("u1");
  expect(fireEvent.keyDown(ta, {
    key: "ArrowDown", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onSelectBlock).toHaveBeenCalledTimes(2);
  expect(h.onArrow).not.toHaveBeenCalled();
  expect(h.onStartBlockSelection).not.toHaveBeenCalled();
});

// pkm-fwa2: plain paste is ALWAYS native; only the Shift-Cmd-V chord (armed
// by its keydown, consumed by the paste event that follows) splits the
// clipboard into an outline.
const pressPasteChord = (ta: HTMLTextAreaElement, mods: object = {}) =>
  fireEvent.keyDown(ta, { key: "v", metaKey: true, shiftKey: true, ...mods });

test("multi-line paste WITHOUT the chord keeps the native textarea behaviour", () => {
  const h = handlers();
  mount(h, 0);
  const prevented = !fireEvent.paste(focusedTextarea(), {
    clipboardData: { files: [], getData: () => "a\n\tb" },
  });
  expect(prevented).toBe(false);
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("Shift-Cmd-V arms the split: the next paste dispatches onPasteOutline "
     + "with the caret range", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  ta.setSelectionRange(2, 5);
  pressPasteChord(ta);
  const prevented = !fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\n\tb" },
  });
  expect(prevented).toBe(true); // preventDefault: we own the paste
  expect(h.onPasteOutline).toHaveBeenCalledWith("u1", 2, 5, "a\n\tb");
});

test("Ctrl-Shift-V (non-Mac) arms the split too", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  pressPasteChord(ta, { metaKey: false, ctrlKey: true });
  fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(h.onPasteOutline).toHaveBeenCalled();
});

test("the arm is consumed by one paste: a second paste is native again", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  pressPasteChord(ta);
  fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(h.onPasteOutline).toHaveBeenCalledTimes(1);
  const prevented = !fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(prevented).toBe(false);
  expect(h.onPasteOutline).toHaveBeenCalledTimes(1);
});

test("any other keydown clears a stale arm (chord pressed, no paste came)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  pressPasteChord(ta);
  fireEvent.keyDown(ta, { key: "v", metaKey: true }); // plain Cmd-V keydown
  const prevented = !fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(prevented).toBe(false);
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("an armed single-line paste stays native (no structure to split; a "
     + "tree-direct update of the focused block would fight the draft)", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  pressPasteChord(ta);
  const prevented = !fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "hello\n" },
  });
  expect(prevented).toBe(false);
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("file paste still routes to onFiles, never onPasteOutline, even armed", () => {
  const h = handlers();
  mount(h, 0);
  const ta = focusedTextarea();
  pressPasteChord(ta);
  const file = new File(["x"], "x.png", { type: "image/png" });
  fireEvent.paste(ta, {
    clipboardData: { files: [file], getData: () => "a\nb" },
  });
  expect(h.onFiles).toHaveBeenCalled();
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("read-only outlines do not intercept text pastes", () => {
  const h = handlers();
  mount(h, 0, true);
  const ta = focusedTextarea();
  pressPasteChord(ta);
  fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

describe("/date picker (pkm-rw6w)", () => {
  test("picking /date strips the trigger and opens the picker", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    expect(screen.getByRole("option", { name: "link to a date…" })).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "");
    expect(screen.getByRole("dialog", { name: "pick a date" })).toBeInTheDocument();
  });

  test("clicking a day inserts that date's daily-note link and closes the picker", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.mouseDown(screen.getByRole("button", { name: "15" }));
    const now = new Date();
    const expected =
      `[[${titleForDate(new Date(now.getFullYear(), now.getMonth(), 15))}]]`;
    expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", expected);
    expect(screen.queryByRole("dialog", { name: "pick a date" })).toBeNull();
  });

  test("Escape closes the picker without inserting", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: "Enter" });
    const callsAfterOpen = vi.mocked(h.onDraftChange).mock.calls.length;
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "pick a date" })).toBeNull();
    expect(vi.mocked(h.onDraftChange).mock.calls.length).toBe(callsAfterOpen);
  });

  test("typing while the picker is open closes it", () => {
    const h = handlers();
    mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "pick a date" })).toBeInTheDocument();
    fireEvent.change(ta, { target: { value: "x" } });
    expect(screen.queryByRole("dialog", { name: "pick a date" })).toBeNull();
  });

  test("a remote update adopted while the picker is open closes it (pkm-0xla)", () => {
    const h = handlers();
    const view = mount(h, 0);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "pick a date" })).toBeInTheDocument();
    // The stripped draft ("") lands on the tree — dirty clears — then a
    // remote edit to the same block arrives and is adopted.
    const flushed = block("u1", "", { order_idx: 0 });
    view.rerender(inputElement(h, flushed, 0));
    const remote = block("u1", "remote text", { order_idx: 0 });
    view.rerender(inputElement(h, remote, 0));
    expect(ta.value).toBe("remote text");
    expect(screen.queryByRole("dialog", { name: "pick a date" })).toBeNull();
  });

  test("readOnly tree never renders a picker", () => {
    const h = handlers();
    mount(h, 0, true);
    const ta = focusedTextarea();
    fireEvent.change(ta, { target: { value: "/date" } });
    ta.setSelectionRange(5, 5);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "pick a date" })).toBeNull();
  });
});
