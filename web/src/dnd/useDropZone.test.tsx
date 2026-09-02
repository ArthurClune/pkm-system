// How often the drop zone measures and commits during a drag (pkm-ikk0).
// The drop *semantics* are covered by outline/dnd.test.ts (pure) and
// components/EditableBlockTree.dnd.test.tsx (whole-page wiring); this file is
// only about the throttle, the rect cache, and the two invariants they must
// not break: every dragover is preventDefault()ed synchronously, and the drop
// lands where the indicator is drawn.
import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { DndProvider } from "./DndContext";
import { EditablePage } from "../views/EditablePage";
import { block, makeSync } from "../test-helpers";

const ROW_H = 20;
const ROWS = 6; // u1..u6; u6 is the one dragged, leaving five candidate rows

// jsdom gives every element a zero rect, so lay the rows out by hand: 20px
// tall from clientY 0, keyed on data-uid, with the container at the origin.
// `reads.rows` is the measurement these tests are about — the O(rows) walk
// the pre-fix handler repeated on every single dragover.
function stubRects() {
  const reads = { rows: 0 };
  const rect = (top: number, bottom: number) => ({
    top, bottom, height: bottom - top, left: 0, right: 400, width: 400,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const uid = (this as HTMLElement).dataset?.uid;
      if (uid === undefined) return rect(0, ROWS * ROW_H); // container etc.
      reads.rows++;
      const top = (Number(uid.slice(1)) - 1) * ROW_H;
      return rect(top, top + ROW_H);
    });
  return reads;
}
afterEach(() => { vi.restoreAllMocks(); });

// jsdom has no DataTransfer: minimal stub (as in the dnd wiring tests)
function dt() {
  const data: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    effectAllowed: "", dropEffect: "",
  };
}

/** Render u1..u6 and grab u6's handle, so the candidate rows are u1..u5 with
 * midpoints at clientY 10, 30, 50, 70, 90. */
function startDrag() {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title="P" initial={
            Array.from({ length: ROWS }, (_, i) =>
              block(`u${i + 1}`, `row ${i + 1}`, { order_idx: i }))} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  const reads = stubRects();
  const transfer = dt();
  const handle = document.querySelector('[data-uid="u6"] .bullet')!;
  fireEvent.dragStart(handle, { dataTransfer: transfer });
  reads.rows = 0; // the drag is armed; count only what dragover measures
  const zone = document.querySelector(".outline-drop-zone")!;
  const over = (clientY: number) =>
    fireEvent.dragOver(zone, { clientX: 0, clientY, dataTransfer: transfer });
  return { sync, transfer, handle, zone, reads, over };
}

const indicatorTop = () => {
  const el = document.querySelector<HTMLElement>(".drop-indicator");
  return el ? el.style.top : null;
};
/** Let the coalesced frame run. */
const nextFrame = () => act(async () => {
  await new Promise<void>((r) => { requestAnimationFrame(() => r()); });
});

it("preventDefaults every dragover synchronously, including coalesced ones", () => {
  const { zone, transfer, reads } = startDrag();
  const events = [];
  for (let i = 0; i < 6; i++) {
    const ev = createEvent.dragOver(zone, { clientX: 0, clientY: 5 + i * 15,
                                            dataTransfer: transfer });
    fireEvent(zone, ev);
    events.push(ev);
  }
  // Only the first was measured — the other five coalesced into one pending
  // frame that has not run.
  expect(reads.rows).toBe(1);
  // But the browser refuses the drop unless EVERY dragover was prevented, so
  // preventDefault can never be the part that waits for the frame.
  expect(events.map((e) => e.defaultPrevented))
    .toEqual([true, true, true, true, true, true]);
  expect(transfer.dropEffect).toBe("move");
});

it("measures each row at most once per drag, however many dragovers arrive",
   async () => {
  const { reads, over } = startDrag();
  over(5); // leading edge: measured now, so the indicator appears at once
  expect(indicatorTop()).toBe("0px"); // above u1
  expect(reads.rows).toBe(1);         // the walk stopped at u1

  over(95); // past every midpoint: after the last row
  await nextFrame();
  expect(indicatorTop()).toBe("100px"); // u5's bottom
  expect(reads.rows).toBe(5);           // u2..u5 measured, u1 reused

  over(5); // back to the top: every row it needs is already measured
  await nextFrame();
  expect(indicatorTop()).toBe("0px");
  expect(reads.rows).toBe(5);
});

it("re-measures a row whose uid changed under it, count unchanged", async () => {
  const { sync, reads, over } = startDrag();
  over(95); // measures u1..u5 at tops 0, 20, 40, 60, 80
  expect(indicatorTop()).toBe("100px"); // below u5
  expect(reads.rows).toBe(5);

  // One remote create and one remote delete, landing mid-drag. The row count
  // is unchanged, so nothing about the cache as a whole looks stale -- but
  // every uid has slid up one index, and index 4 is now a row 60px further
  // down the page than the one measured there.
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
    { op: "create", uid: "u9", page_title: "P", parent_uid: null,
      order_idx: 6, text: "row 9" },
  ] }));
  over(95);
  await nextFrame();
  // u9's top, not u5's bottom: clientY 95 is above u9's midpoint (170), so the
  // line belongs above it. Reading the cache by index alone would answer
  // "100px" here and drop the block a row short of where the pointer is.
  expect(indicatorTop()).toBe("160px");
  expect(reads.rows).toBe(10);
});

it("re-measures after a scroll, which moves rows under a viewport-relative pointer",
   async () => {
  const { reads, over } = startDrag();
  over(5);
  expect(reads.rows).toBe(1);

  act(() => { window.dispatchEvent(new Event("scroll")); });
  over(5);
  await nextFrame();
  expect(reads.rows).toBe(2);
});

it("re-measures after leaving and re-entering the zone", async () => {
  const { zone, transfer, reads, over } = startDrag();
  over(5);
  expect(reads.rows).toBe(1);

  fireEvent.dragLeave(zone, { dataTransfer: transfer });
  expect(indicatorTop()).toBeNull();
  over(5);
  await nextFrame();
  expect(indicatorTop()).toBe("0px");
  expect(reads.rows).toBe(2);
});

it("drops where the indicator is drawn, not where an unprocessed pointer got to",
   () => {
  const { sync, zone, transfer, over } = startDrag();
  over(5); // processed: the line is above u1
  expect(indicatorTop()).toBe("0px");
  // The pointer swept to the bottom of the outline, but that sample is still
  // waiting for its frame. The user is aiming with the line, so the drop must
  // resolve to the boundary the line is at (0), not the one the pointer
  // reached (5) -- the indicator and the candidate come from one sample.
  over(95);
  fireEvent.drop(zone, { clientX: 0, clientY: 95, dataTransfer: transfer });

  expect(sync.sent).toEqual([[
    { op: "move", uid: "u6", parent_uid: null, order_idx: 0 }]]);
  expect(indicatorTop()).toBeNull();
});

it("cancels the pending frame when the drag ends, so nothing lands late",
   async () => {
  const { handle, transfer, over } = startDrag();
  over(5);
  over(95); // queued
  fireEvent.dragEnd(handle, { dataTransfer: transfer });
  await nextFrame();
  // The queued callback still closes over the drag it was created under, so
  // without the cancel it would happily move the line after the drag was
  // over.
  expect(indicatorTop()).toBe("0px");
});
