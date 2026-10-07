// A drag of files in from outside the app, through one outline's drop zone.
// Block drags are covered by useDropZone.test.tsx; the window-level cleanup
// and navigation guard by DndContext.test.tsx.
import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, ord } from "../test-helpers";
import { DndProvider, useDnd } from "./DndContext";
import { useDropZone } from "./useDropZone";

const ROW_H = 20;

function stubRects() {
  const rect = (top: number, bottom: number) => ({
    top, bottom, height: bottom - top, left: 0, right: 400, width: 400,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const uid = (this as HTMLElement).dataset?.uid;
      if (uid === undefined) return rect(0, 3 * ROW_H);
      const top = (Number(uid.slice(1)) - 1) * ROW_H;
      return rect(top, top + ROW_H);
    });
}
beforeEach(stubRects);
afterEach(() => { vi.restoreAllMocks(); });

const png = new File(["x"], "a.png", { type: "image/png" });
const pdf = new File(["x"], "b.pdf", { type: "application/pdf" });
const txt = new File(["x"], "c.txt", { type: "text/plain" });

/** jsdom has no DataTransfer. `items` is what a real browser exposes during
 * dragover; `files` is only filled at drop. */
function filesTransfer(files: File[], { listed = files } = {}) {
  return {
    types: ["Files"],
    items: listed.map((f) => ({ kind: "file", type: f.type })),
    files,
    dropEffect: "", effectAllowed: "",
  };
}

const blocks: BlockNode[] = [
  block("u1", "one", { order_idx: ord(0) }),
  block("u2", "two", { order_idx: ord(1) }),
  block("u3", "three", { order_idx: ord(2) }),
];

let dnd!: ReturnType<typeof useDnd>;
function Capture() { dnd = useDnd(); return null; }

function setup(onDropFiles: ((f: File[], t: unknown) => void) | null = vi.fn()) {
  function Zone() {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const { indicator, zoneProps } = useDropZone(
      "P", () => blocks, containerRef, (onDropFiles ?? undefined) as never);
    return (
      <div ref={containerRef} data-testid="zone" {...zoneProps}>
        {blocks.map((b) => <div key={b.uid} data-uid={b.uid}>{b.text}</div>)}
        <textarea className="block-input" data-testid="ta"
                  onDrop={(e) => { if (e.dataTransfer.files.length) e.preventDefault(); }} />
        {indicator && <div className="drop-indicator"
                           style={{ top: indicator.top, left: indicator.left }} />}
      </div>);
  }
  render(
    <SyncContext.Provider value={makeSync()}>
      <DndProvider><Capture /><Zone /></DndProvider>
    </SyncContext.Provider>);
  const zone = document.querySelector<HTMLElement>('[data-testid="zone"]')!;
  const ta = document.querySelector<HTMLElement>('[data-testid="ta"]')!;
  return { zone, ta, onDropFiles };
}

const indicatorTop = () =>
  document.querySelector<HTMLElement>(".drop-indicator")?.style.top ?? null;

it("a dragover of an image starts a files drag, accepts it as a copy and draws the line", () => {
  const { zone } = setup();
  const transfer = filesTransfer([png]);
  const ev = createEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  fireEvent(zone, ev);
  expect(ev.defaultPrevented).toBe(true);
  expect(transfer.dropEffect).toBe("copy");
  expect(dnd.drag).toEqual({ kind: "files" });
  expect(indicatorTop()).toBe("20px"); // 25 is above u2's midpoint (30)
});

it("dragenter of an uploadable file is accepted too", () => {
  const { zone } = setup();
  const ev = createEvent.dragEnter(zone, { dataTransfer: filesTransfer([pdf]) });
  fireEvent(zone, ev);
  expect(ev.defaultPrevented).toBe(true);
  expect(dnd.drag).toEqual({ kind: "files" });
});

it("a files drag with nothing uploadable draws no line and is not accepted", () => {
  const { zone } = setup();
  const transfer = filesTransfer([txt]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(transfer.dropEffect).not.toBe("copy"); // the window guard refuses it
  expect(dnd.drag).toBeNull();
  expect(indicatorTop()).toBeNull();
});

it("a drag that carries no files (text, a link) is left alone", () => {
  const { zone } = setup();
  const ev = createEvent.dragOver(zone, { clientX: 0, clientY: 25,
    dataTransfer: { types: ["text/plain"], items: [], files: [], dropEffect: "" } });
  fireEvent(zone, ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(dnd.drag).toBeNull();
});

it("a zone given no onDropFiles ignores file drags", () => {
  const { zone } = setup(null);
  const transfer = filesTransfer([png]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(transfer.dropEffect).not.toBe("copy");
  expect(dnd.drag).toBeNull();
});

it("dropping calls onDropFiles with the target the line was drawn at", () => {
  const { zone, onDropFiles } = setup();
  const transfer = filesTransfer([png, pdf]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(onDropFiles).toHaveBeenCalledWith(
    [png, pdf], { parent_uid: null, order_idx: 1, page_title: "P" });
  expect(dnd.drag).toBeNull();
  expect(indicatorTop()).toBeNull();
});

it("a drop passes unsuitable files through for onDropFiles to report", () => {
  const { zone, onDropFiles } = setup();
  const transfer = filesTransfer([png, txt], { listed: [png, txt] });
  fireEvent.dragOver(zone, { clientX: 0, clientY: 5, dataTransfer: transfer });
  fireEvent.drop(zone, { clientX: 0, clientY: 5, dataTransfer: transfer });
  expect(onDropFiles).toHaveBeenCalledWith(
    [png, txt], { parent_uid: null, order_idx: 0, page_title: "P" });
});

it("dragging onto the focused block's textarea clears the line and defers to it", () => {
  const { zone, ta } = setup();
  const transfer = filesTransfer([png]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(indicatorTop()).toBe("20px");
  const ev = createEvent.dragOver(ta, { clientX: 0, clientY: 25, dataTransfer: transfer });
  fireEvent(ta, ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(indicatorTop()).toBeNull();
});

it("a drop on the textarea is the textarea's alone", () => {
  const { zone, ta, onDropFiles } = setup();
  const transfer = filesTransfer([png]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  fireEvent.dragOver(ta, { clientX: 0, clientY: 25, dataTransfer: transfer });
  fireEvent.drop(ta, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(onDropFiles).not.toHaveBeenCalled();
});

it("a drop the textarea already took (defaultPrevented) is not taken again", () => {
  const { zone, onDropFiles } = setup();
  const transfer = filesTransfer([png]);
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: transfer });
  zone.addEventListener("drop", () => undefined);
  // an earlier handler (the textarea's) prevented the event
  const child = zone.querySelector("div[data-uid]")!;
  child.addEventListener("drop", (e) => e.preventDefault());
  fireEvent.drop(child, { clientX: 0, clientY: 25, dataTransfer: transfer });
  expect(onDropFiles).not.toHaveBeenCalled();
});

it("Escape ends a files drag and its line", () => {
  const { zone } = setup();
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: filesTransfer([png]) });
  expect(dnd.drag).not.toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(dnd.drag).toBeNull();
  expect(indicatorTop()).toBeNull();
});

it("the pointer leaving the window ends a files drag", () => {
  const { zone } = setup();
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: filesTransfer([png]) });
  // moving between elements inside the page names the element entered
  fireEvent.dragLeave(zone, { relatedTarget: document.body });
  expect(dnd.drag).not.toBeNull();
  fireEvent.dragLeave(document.documentElement, { relatedTarget: null });
  expect(dnd.drag).toBeNull();
  expect(indicatorTop()).toBeNull();
});

it("a drop anywhere ends a files drag", () => {
  const { zone } = setup();
  fireEvent.dragOver(zone, { clientX: 0, clientY: 25, dataTransfer: filesTransfer([png]) });
  act(() => { fireEvent.drop(document.body, { dataTransfer: filesTransfer([png]) }); });
  expect(dnd.drag).toBeNull();
});
