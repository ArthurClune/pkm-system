import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, test, vi } from "vitest";
import { block, stubFetch } from "../test-helpers";
import type { OutlineHandlers } from "./EditableBlockTree";
import { EditableBlockTree } from "./EditableBlockTree";

// state updates land during timer advances: keep React quiet with act()
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function handlers(): OutlineHandlers {
  return {
    onFocusBlock: vi.fn(), onBlurBlock: vi.fn(), onDraftChange: vi.fn(),
    onSplit: vi.fn(), onIndent: vi.fn(), onOutdent: vi.fn(),
    onMoveSubtreeUp: vi.fn(), onMoveSubtreeDown: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onArrow: vi.fn(), onToggleCollapsed: vi.fn(), onSetHeading: vi.fn(),
    onSetViewType: vi.fn(),
    onToggleTodo: vi.fn(), onFiles: vi.fn(),
    onStartBlockSelection: vi.fn(), onSelectBlock: vi.fn(),
    onExtendBlockSelection: vi.fn(),
    onClearBlockSelection: vi.fn(), onDragStartBlock: vi.fn(),
    onIndentSelection: vi.fn(), onOutdentSelection: vi.fn(),
    onMoveSelectionUp: vi.fn(), onMoveSelectionDown: vi.fn(),
    onDeleteBlockSelection: vi.fn(),
    onUndo: vi.fn(), onRedo: vi.fn(),
  };
}

function mount(h: OutlineHandlers) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("u1", "", { order_idx: 0 })]}
                         focus={{ uid: "u1", cursor: 0 }} handlers={h}
                         readOnly={false} />
    </MemoryRouter>);
}

function type(value: string) {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value } });
  ta.setSelectionRange(value.length, value.length);
  return ta;
}

test("typing [[ shows title options; Enter picks and closes the brackets", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: ["Machine Learning", "Magic"] }]]);
  const h = handlers();
  mount(h);
  const ta = type("see [[Ma");
  await tick(200); // debounce + fetch
  expect(screen.getByRole("option", { name: "Machine Learning" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "ArrowDown" }); // select "Magic"
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onSplit).not.toHaveBeenCalled(); // Enter was consumed by the popup
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "see [[Magic]]");
  expect(screen.queryByRole("listbox")).toBeNull(); // popup closed
  vi.useRealTimers();
});

test("a query with no exact match offers a New page row", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const h = handlers();
  mount(h);
  const ta = type("[[Fresh Idea");
  await tick(200);
  expect(screen.getByRole("option", { name: /New page: Fresh Idea/ })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(h.onDraftChange).toHaveBeenLastCalledWith("u1", "[[Fresh Idea]]");
  vi.useRealTimers();
});

test("Escape closes the popup without blurring", async () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: ["Tasks"] }]]);
  const h = handlers();
  mount(h);
  const ta = type("#Ta");
  await tick(200);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(h.onBlurBlock).not.toHaveBeenCalled();
  vi.useRealTimers();
});
