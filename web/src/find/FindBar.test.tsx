import { act, cleanup, fireEvent, render, screen, waitFor }
  from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { FakeMediaQueryList } from "../test-helpers";
import { useModal } from "../useModal";
import { FindBar } from "./FindBar";

function standalone(on: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((q: string) =>
    new FakeMediaQueryList(on && q === "(display-mode: standalone)")));
}

class FakeHighlight {
  priority = 0;
  ranges: Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
  add(range: Range) { this.ranges.push(range); return this; }
}

let highlights: Map<string, FakeHighlight>;
// jsdom has no layout: a match's viewport top is looked up by the text of
// the node it starts in (0 when unlisted), and scrolls are recorded.
let tops: Map<string, number>;
let scrolls: number[];
const realRangeRect = Range.prototype.getBoundingClientRect;
const realScrollBy = Element.prototype.scrollBy;

beforeEach(() => {
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", FakeHighlight);
  tops = new Map();
  scrolls = [];
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const top = tops.get(this.startContainer.textContent ?? "") ?? 0;
    return { top, bottom: top + 16, left: 0, right: 40 } as DOMRect;
  };
  Element.prototype.scrollBy = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") scrolls.push(options.top ?? 0);
  } as Element["scrollBy"];
  standalone(true);
});

afterEach(() => {
  // Unmount while the CSS stub is still installed: unmounting deletes the
  // highlights.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Range.prototype.getBoundingClientRect = realRangeRect;
  Element.prototype.scrollBy = realScrollBy;
  window.getSelection()?.removeAllRanges();
});

function Modal({ onClose = () => {} }: { onClose?: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  useModal({ surfaceRef, initialFocusRef, onClose });
  return (
    <div ref={surfaceRef}>
      <button type="button" ref={initialFocusRef}>in modal</button>
    </div>
  );
}

function Page() {
  return (
    <>
      <button type="button">elsewhere</button>
      <main className="main-pane">
        <div className="block-row" data-uid="uid-b1">
          <div className="block-text">apple pie</div>
        </div>
        <div className="block-row" data-uid="uid-b2">
          <div className="block-text">apple tart</div>
        </div>
        <div className="block-row" data-uid="uid-b3">
          <div className="block-text">pear</div>
        </div>
      </main>
      <FindBar />
    </>
  );
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body,
    { key, metaKey: true, ...init });

const input = () => screen.getByRole("textbox", { name: "Find on page" });
const count = () => screen.getByRole("search").querySelector("[aria-live]")!;

function search(query: string) {
  press("f");
  fireEvent.change(input(), { target: { value: query } });
}

describe("FindBar", () => {
  it("does nothing outside the installed app", () => {
    standalone(false);
    render(<Page />);
    expect(press("f")).toBe(true);
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("Cmd-F opens the bar with the input focused", () => {
    render(<Page />);
    expect(press("f")).toBe(false);
    expect(input()).toHaveFocus();
  });

  it("Cmd-F while open re-focuses and re-selects the query", () => {
    render(<Page />);
    search("apple");
    screen.getByRole("button", { name: "elsewhere" }).focus();
    press("f");
    expect(input()).toHaveFocus();
    const box = input() as HTMLInputElement;
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 5]);
  });

  it("prefills from the page selection", () => {
    render(<Page />);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("pear"));
    window.getSelection()!.addRange(range);
    press("f");
    expect(input()).toHaveValue("pear");
    expect(count()).toHaveTextContent("1 of 1");
  });

  it("prefills from a focused textarea's selection", () => {
    render(<Page />);
    const area = document.createElement("textarea");
    area.value = "pear tree";
    document.body.append(area);
    area.focus();
    area.setSelectionRange(0, 4);
    press("f");
    expect(input()).toHaveValue("pear");
    area.remove();
  });

  it("keeps the previous query when the selection spans lines", () => {
    render(<Page />);
    search("apple");
    fireEvent.keyDown(input(), { key: "Escape" });
    const area = document.createElement("textarea");
    area.value = "pear\ntree";
    document.body.append(area);
    area.focus();
    area.select();
    press("f");
    expect(input()).toHaveValue("apple");
    area.remove();
  });

  it("counts and steps with Enter and Shift-Enter, wrapping", () => {
    render(<Page />);
    search("apple");
    expect(count()).toHaveTextContent("1 of 2");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toHaveTextContent("2 of 2");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toHaveTextContent("1 of 2");
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(count()).toHaveTextContent("2 of 2");
  });

  it("steps with the Previous and Next buttons", () => {
    render(<Page />);
    search("apple");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(count()).toHaveTextContent("2 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(count()).toHaveTextContent("1 of 2");
  });

  it("Cmd-G and Shift-Cmd-G step when focus is outside the bar", () => {
    render(<Page />);
    search("apple");
    screen.getByRole("button", { name: "elsewhere" }).focus();
    expect(press("g")).toBe(false);
    expect(count()).toHaveTextContent("2 of 2");
    press("g", { shiftKey: true });
    expect(count()).toHaveTextContent("1 of 2");
  });

  it("Cmd-G and Shift-Cmd-G reopen a closed bar on the last query", () => {
    render(<Page />);
    search("apple");
    fireEvent.keyDown(input(), { key: "Escape" });
    press("g", { shiftKey: true });
    expect(input()).toHaveValue("apple");
    expect(count()).toHaveTextContent("2 of 2");
    fireEvent.keyDown(input(), { key: "Escape" });
    press("g");
    expect(count()).toHaveTextContent("1 of 2");
  });

  it("scrolls a stepped-to match below the view into it", () => {
    tops.set("apple tart", 2000);
    render(<Page />);
    search("apple");
    expect(scrolls).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(scrolls).toEqual([2000 + 16 - window.innerHeight + 16]);
  });

  it("does not scroll to a match already in view", () => {
    render(<Page />);
    search("apple");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toHaveTextContent("2 of 2");
    expect(scrolls).toEqual([]);
  });

  it("starts a new query at the first match in view", () => {
    tops.set("apple pie", -500);
    render(<Page />);
    search("apple");
    expect(count()).toHaveTextContent("2 of 2");
  });

  it("starts at the first match when every match is above the view", () => {
    tops.set("apple pie", -500);
    tops.set("apple tart", -400);
    render(<Page />);
    search("apple");
    expect(count()).toHaveTextContent("1 of 2");
  });

  it("shows No matches", () => {
    render(<Page />);
    search("zzz");
    expect(count()).toHaveTextContent("No matches");
  });

  it("recounts when the searched DOM changes", async () => {
    render(<Page />);
    search("apple");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(count()).toHaveTextContent("2 of 2");
    act(() => document.querySelector('[data-uid="uid-b2"]')!.remove());
    await waitFor(() => expect(count()).toHaveTextContent("1 of 1"));
  });

  it("recounts when a searched region appears while open", async () => {
    render(<Page />);
    search("apple");
    expect(count()).toHaveTextContent("1 of 2");
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    sidebar.innerHTML = '<div class="block-row" data-uid="uid-s1">'
      + '<div class="block-text">apple sauce</div></div>';
    try {
      act(() => document.body.append(sidebar));
      await waitFor(() => expect(count()).toHaveTextContent("1 of 3"));
    } finally {
      sidebar.remove();
    }
  });

  it("the bar's own updates and unsearched regions schedule no recount",
    async () => {
      render(<Page />);
      const raf = vi.spyOn(window, "requestAnimationFrame");
      search("apple");
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(count()).toHaveTextContent("2 of 2");
      act(() => {
        screen.getByRole("button", { name: "elsewhere" }).textContent = "x";
      });
      await act(() => Promise.resolve());
      expect(raf).not.toHaveBeenCalled();
    });

  it("Escape closes and restores focus to the previous element", () => {
    render(<Page />);
    const before = screen.getByRole("button", { name: "elsewhere" });
    before.focus();
    press("f");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(before).toHaveFocus();
  });

  it("the Close button closes like Escape", () => {
    render(<Page />);
    const before = screen.getByRole("button", { name: "elsewhere" });
    before.focus();
    press("f");
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(screen.queryByRole("search")).toBeNull();
    expect(before).toHaveFocus();
  });

  it("Escape re-enters a block whose textarea went away", () => {
    render(<Page />);
    const row = document.querySelector('[data-uid="uid-b1"]')!;
    const text = row.querySelector(".block-text")!;
    const click = vi.fn();
    text.addEventListener("click", click);
    const area = document.createElement("textarea");
    area.className = "block-input";
    row.append(area);
    area.focus();
    press("f");
    act(() => area.remove());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("Escape returns to the block focused while the bar was open", () => {
    render(<Page />);
    const textOf = (row: string) =>
      document.querySelector(`[data-uid="${row}"] > .block-text`)!;
    const clicks = { b1: vi.fn(), b2: vi.fn() };
    textOf("uid-b1").addEventListener("click", clicks.b1);
    textOf("uid-b2").addEventListener("click", clicks.b2);
    search("apple");
    const area = document.createElement("textarea");
    area.className = "block-input";
    document.querySelector('[data-uid="uid-b2"]')!.append(area);
    area.focus();
    press("f");
    expect(input()).toHaveValue("apple");
    act(() => area.remove());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(clicks.b2).toHaveBeenCalledTimes(1);
    expect(clicks.b1).not.toHaveBeenCalled();
  });

  it("Escape and Enter work after a bar button took focus", () => {
    render(<Page />);
    search("apple");
    const next = screen.getByRole("button", { name: "Next match" });
    expect(fireEvent.mouseDown(next)).toBe(false);
    next.focus();
    fireEvent.keyDown(next, { key: "Enter" });
    expect(count()).toHaveTextContent("1 of 2");
    fireEvent.keyDown(next, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("Escape closes the bar while focus is on the page", () => {
    render(<Page />);
    search("apple");
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("search")).toBeInTheDocument();
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(highlights.has("pkm-find")).toBe(false);
    expect(elsewhere).toHaveFocus();
  });

  it("Escape in a block being edited closes the bar, not the edit", () => {
    render(<Page />);
    search("apple");
    const area = document.createElement("textarea");
    area.className = "block-input";
    document.querySelector('[data-uid="uid-b2"]')!.append(area);
    area.focus();
    const blockKey = vi.fn();
    area.addEventListener("keydown", blockKey);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(blockKey).not.toHaveBeenCalled();
    expect(area).toHaveFocus();
  });

  it("leaves Enter and Escape to an input method mid-composition", () => {
    render(<Page />);
    search("apple");
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(count()).toHaveTextContent("1 of 2");
    fireEvent.keyDown(input(), { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("search")).toBeInTheDocument();
  });

  it("Escape in the bar does not reach document listeners", () => {
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    try {
      render(<Page />);
      press("f");
      seen.mockClear();
      fireEvent.keyDown(input(), { key: "Escape" });
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", seen);
    }
  });

  it("paints highlights", () => {
    render(<Page />);
    search("apple");
    expect(highlights.get("pkm-find")?.ranges).toHaveLength(2);
    expect(highlights.get("pkm-find-current")?.ranges).toHaveLength(1);
    expect(highlights.get("pkm-find")?.priority).toBe(0);
    expect(highlights.get("pkm-find-current")?.priority).toBe(1);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(highlights.has("pkm-find")).toBe(false);
    expect(highlights.has("pkm-find-current")).toBe(false);
  });

  it("clears highlights on unmount", () => {
    const { unmount } = render(<Page />);
    search("apple");
    unmount();
    expect(highlights.size).toBe(0);
  });

  it("ignores the chords while a modal is open", () => {
    render(<><Page /><Modal /></>);
    expect(press("f")).toBe(true);
    expect(press("g")).toBe(true);
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("leaves an open bar alone while a modal is up", () => {
    const { rerender } = render(<Page />);
    search("apple");
    const onClose = vi.fn();
    rerender(<><Page /><Modal onClose={onClose} /></>);
    expect(press("g")).toBe(true);
    expect(count()).toHaveTextContent("1 of 2");
    press("Escape", { metaKey: false });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("search")).toBeInTheDocument();
  });

  it("paints any number of matches without spreading them", () => {
    // JavaScriptCore throws a RangeError past about 64k spread arguments.
    class StrictHighlight extends FakeHighlight {
      constructor(...ranges: Range[]) {
        if (ranges.length > 0) throw new RangeError("too many arguments");
        super();
      }
    }
    vi.stubGlobal("Highlight", StrictHighlight);
    render(<Page />);
    search("p");
    expect(highlights.get("pkm-find")?.ranges).toHaveLength(6);
    expect(highlights.get("pkm-find-current")?.ranges).toHaveLength(1);
  });
});
