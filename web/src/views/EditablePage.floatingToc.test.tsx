// The main page's {{toc}} floats beside the outline when App says there is
// room; the row then shows a marker, so the list is on screen exactly once.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { BlockNode } from "../api/payloads";
import { TocFloatRoomContext } from "../contexts";
import { resetDroppedDrafts } from "../outline/droppedDrafts";
import { resetHistory } from "../outline/undoManager";
import { SyncContext } from "../sync/SyncProvider";
import {
  block, canonicalTitleOf, makeSync, orderIdxOf, stubFetch, uidOf,
} from "../test-helpers";
import { EditablePage } from "./EditablePage";

beforeEach(() => {
  resetDroppedDrafts();
  stubFetch([["/api/titles", { titles: [] }]]);
});
afterEach(resetHistory);

const PAGE = [
  block("tuid-h", "Intro", { heading: 1, order_idx: orderIdxOf(0) }),
  block("tuid-t", "{{toc}}", { order_idx: orderIdxOf(1) }),
  block("tuid-h2", "Body", { heading: 2, order_idx: orderIdxOf(2) }),
];

const sync = makeSync();

function view(room: boolean, initial: BlockNode[] = PAGE, floatToc = true) {
  return (
    <MemoryRouter>
      <SyncContext.Provider value={sync}>
        <TocFloatRoomContext.Provider value={room}>
          <EditablePage title={canonicalTitleOf("Page")} initial={initial}
                        floatToc={floatToc} />
        </TocFloatRoomContext.Provider>
      </SyncContext.Provider>
    </MemoryRouter>);
}

const aside = (c: HTMLElement) => c.querySelector("aside.toc-float");
const row = (c: HTMLElement, rawUid: string) =>
  c.querySelector(`[data-uid="${uidOf(rawUid)}"]`)!;
const linkTexts = (el: Element | null) =>
  Array.from(el?.querySelectorAll("a.toc-link") ?? []).map((a) => a.textContent);
const listsOnScreen = (c: HTMLElement) => c.querySelectorAll("nav.toc").length;

test("with room, the list floats and the row shows a marker", () => {
  const { container } = render(view(true));
  expect(linkTexts(aside(container))).toEqual(["Intro", "Body"]);
  expect(row(container, "tuid-t").querySelector(".toc-marker")).not.toBeNull();
  expect(linkTexts(row(container, "tuid-t"))).toEqual([]);
  expect(listsOnScreen(container)).toBe(1);
});

test("without room, the row keeps its card and nothing floats", () => {
  const { container } = render(view(false));
  expect(aside(container)).toBeNull();
  expect(container.querySelector(".outline-with-toc")).toBeNull();
  expect(linkTexts(row(container, "tuid-t"))).toEqual(["Intro", "Body"]);
});

test("a host that does not opt in never floats", () => {
  const { container } = render(view(true, PAGE, false));
  expect(aside(container)).toBeNull();
  expect(linkTexts(row(container, "tuid-t"))).toEqual(["Intro", "Body"]);
});

test("losing and regaining room swaps the list in one render", () => {
  const { container, rerender } = render(view(true));
  for (const room of [false, true, false]) {
    rerender(view(room));
    expect(listsOnScreen(container)).toBe(1);
    expect(aside(container) !== null).toBe(room);
  }
});

test("editing the toc block keeps the floating list", () => {
  const { container } = render(view(true));
  fireEvent.click(row(container, "tuid-t").querySelector(".toc-marker")!);
  expect(screen.getByRole("textbox")).toHaveProperty("value", "{{toc}}");
  expect(linkTexts(aside(container))).toEqual(["Intro", "Body"]);
});

test("editing the macro away removes the column", () => {
  const { container } = render(view(true));
  fireEvent.click(row(container, "tuid-t").querySelector(".toc-marker")!);
  const ta = screen.getByRole("textbox");
  fireEvent.change(ta, { target: { value: "notes" } });
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(aside(container)).toBeNull();
  expect(container.querySelector(".outline-with-toc")).toBeNull();
});

test("a second toc block keeps its card while the first floats", () => {
  const { container } = render(view(true, [
    ...PAGE, block("tuid-t2", "{{toc}}", { order_idx: orderIdxOf(3) })]));
  expect(row(container, "tuid-t").querySelector(".toc-marker")).not.toBeNull();
  expect(linkTexts(row(container, "tuid-t2"))).toEqual(["Intro", "Body"]);
  expect(linkTexts(aside(container))).toEqual(["Intro", "Body"]);
});

test("a heading edit shows in the floating list", () => {
  const { container } = render(view(true));
  fireEvent.click(screen.getByText("Intro", { selector: "h1 *, h1" }));
  const ta = screen.getByRole("textbox");
  fireEvent.change(ta, { target: { value: "Introduction" } });
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(linkTexts(aside(container))).toEqual(["Introduction", "Body"]);
});
