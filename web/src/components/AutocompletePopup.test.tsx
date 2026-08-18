import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, test, vi } from "vitest";
import { block, jsonResponse, stubFetch } from "../test-helpers";
import type { OutlineHandlers } from "../outline/handlers";
import { useTitleOptions } from "./AutocompletePopup";
import { EditableBlockTree } from "./EditableBlockTree";

// state updates land during timer advances: keep React quiet with act()
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

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

// useTitleOptions rides the shared stale-response guard (pkm-kk0t). Both
// halves of that contract matter here: a superseded query must not win, and
// a query the user has emptied must not be repopulated by its own answer.

/** Fetch stub whose responses are resolved by the test, keyed by URL. */
function deferredFetch() {
  const resolvers = new Map<string, (r: Response) => void>();
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    new Promise<Response>((resolve) => resolvers.set(String(input), resolve)));
  vi.stubGlobal("fetch", fetchMock);
  return { resolvers, fetchMock };
}

test("drops a title response superseded by a newer query", async () => {
  const { resolvers, fetchMock } = deferredFetch();
  const { result, rerender } = renderHook(
    ({ q }: { q: string | null }) => useTitleOptions(q),
    { initialProps: { q: "ma" as string | null } });

  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  rerender({ q: "mag" });
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

  await act(async () => {
    resolvers.get("/api/titles?q=mag")!(jsonResponse({ titles: ["Magic"] }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(result.current).toEqual(["Magic"]);

  await act(async () => {
    resolvers.get("/api/titles?q=ma")!(jsonResponse({ titles: ["Stale"] }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(result.current).toEqual(["Magic"]);
  vi.unstubAllGlobals();
});

test("a cleared query is not repopulated by its own in-flight response", async () => {
  const { resolvers } = deferredFetch();
  const { result, rerender } = renderHook(
    ({ q }: { q: string | null }) => useTitleOptions(q),
    { initialProps: { q: "ma" as string | null } });

  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  rerender({ q: null }); // popup dismissed while the fetch is still out

  await act(async () => {
    resolvers.get("/api/titles?q=ma")!(jsonResponse({ titles: ["Magic"] }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(result.current).toEqual([]);
  vi.unstubAllGlobals();
});
