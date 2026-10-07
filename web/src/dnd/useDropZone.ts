// pattern: Imperative Shell
// DOM measurement for one outline's drop zone: pixel positions in, pure
// dnd.ts semantics out. One indicator per outline.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop, INDENT_PX,
         type DragSource, type DropPosition, type DropRow,
         type DropTarget } from "../outline/dnd";
import { uploadableDrag } from "../outline/fileDrop";
import { boundaryFromRects, cacheIsUsable, cachedRectFor,
         indicatorTopFromRects, type RectCache,
         type RowRect } from "./dropGeometry";
import { useDnd } from "./DndContext";

export interface Indicator { top: number; left: number }

/** Leading edge of the dragover throttle. A dragover arriving this long
 * after the last processed one is measured on the spot; anything sooner
 * waits for the frame already scheduled.
 *
 * rAF alone would be tidier, but a native drag loop is not guaranteed to run
 * animation frames on every platform, and an indicator that never appears is
 * far worse than one that lags. This keeps the floor at ~20 Hz with no frames
 * at all, while a browser that does run them gets exactly one recompute per
 * frame — the leading edge only ever fires for the first dragover of a
 * drag. */
const THROTTLE_MS = 50;

/** The drag's `dataTransfer` says it carries files. */
const carriesFiles = (e: React.DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Over the focused block's own textarea, which takes a file drop itself
 * (splicing at the caret). */
const overBlockTextarea = (e: React.DragEvent) =>
  e.target instanceof Element && e.target.closest("textarea.block-input") !== null;

/** `onDropFiles` makes this zone a target for files dragged in from outside
 * the app: it uploads them into this page at the drop target. Without it the
 * zone only takes block drags. */
export function useDropZone(pageTitle: string,
                            getBlocks: () => BlockNode[],
                            containerRef: React.RefObject<HTMLElement | null>,
                            onDropFiles?: (files: File[], target: DropTarget) => void) {
  const dnd = useDnd();
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // candidate survives between dragover and drop
  const candidateRef = useRef<DropPosition | null>(null);
  // one drag's row rectangles, filled in as the walk asks for them
  const cacheRef = useRef<RectCache | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const processedAtRef = useRef(0);

  const cancelFrame = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };

  /** The cache for this drag, created empty if there isn't a usable one. */
  const cacheFor = (container: HTMLElement, drag: DragSource,
                    rows: DropRow[]): RectCache => {
    const cached = cacheRef.current;
    if (cached && cacheIsUsable(cached, drag, rows)) return cached;
    // one container read per (re)build, for both the indicator's origin and
    // the offsetX the depth comes from
    const box = container.getBoundingClientRect();
    const fresh: RectCache = { drag, rowCount: rows.length,
                               containerTop: box.top, containerLeft: box.left,
                               rects: [], uids: [] };
    cacheRef.current = fresh;
    return fresh;
  };

  /** Measure and remember row `i`'s extent — the getBoundingClientRect that
   * used to run per row per dragover, and now runs at most once per row per
   * drag, or again if that index came to mean a different row. */
  const measure = (container: HTMLElement, cache: RectCache, rows: DropRow[]) =>
    (i: number): RowRect | null => {
      const uid = rows[i].uid;
      const known = cachedRectFor(cache, i, uid);
      if (known !== undefined) return known;
      const el = container.querySelector<HTMLElement>(
        `[data-uid="${CSS.escape(uid)}"]`);
      const box = el ? el.getBoundingClientRect() : null;
      const rect = box ? { top: box.top, bottom: box.bottom } : null;
      cache.rects[i] = rect;
      cache.uids[i] = uid;
      return rect;
    };

  /** Resolve the last pointer sample to a candidate and an indicator. Both
   * come out of the same sample, which is what lets a drop use the candidate
   * the visible line was drawn from (see onDrop). */
  const process = useCallback(() => {
    const container = containerRef.current;
    const at = pointerRef.current;
    if (!dnd.drag || !container || !at) return;
    processedAtRef.current = performance.now();
    const rows = dropRows(getBlocks(), dnd.drag, pageTitle);
    const cache = cacheFor(container, dnd.drag, rows);
    const rectAt = measure(container, cache, rows);
    const boundary = boundaryFromRects(rows, rectAt, at.y);
    const depth = depthFromX(allowedDepths(rows, boundary),
                             at.x - cache.containerLeft);
    candidateRef.current = { boundary, depth };
    const top = indicatorTopFromRects(rows, rectAt, cache.containerTop, boundary);
    const left = depth * INDENT_PX;
    // A throttled process() commits every ~50ms of pointer movement inside
    // the same gap, but the position often hasn't moved: reuse the previous
    // object so React can bail out instead of re-rendering every row for no
    // visible change.
    setIndicator((prev) =>
      prev && prev.top === top && prev.left === left ? prev : { top, left });
  }, [dnd.drag, getBlocks, pageTitle, containerRef]);

  /** Accept (or decline) a drag of files from outside the app, starting the
   * files drag on first sight. Returns true when the zone is taking this
   * event as part of a files drag. The accept (preventDefault, dropEffect) is
   * synchronous like every dragover's. */
  const acceptFiles = (e: React.DragEvent): boolean => {
    if (!onDropFiles || !containerRef.current || !carriesFiles(e)) return false;
    if (dnd.drag !== null && dnd.drag.kind !== "files") return false;
    if (overBlockTextarea(e)) {
      // the textarea's own drop handler owns this one: no line, no accept
      cancelFrame();
      candidateRef.current = null;
      setIndicator(null);
      return false;
    }
    if (dnd.drag === null &&
        !uploadableDrag(Array.from(e.dataTransfer.items ?? []))) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (dnd.drag === null) dnd.startDrag({ kind: "files" });
    return true;
  };

  const onDragEnter = (e: React.DragEvent) => { acceptFiles(e); };

  const onDragOver = (e: React.DragEvent) => {
    if (dnd.drag?.kind === "blocks") {
      if (!containerRef.current) return;
      // preventDefault is the "this zone accepts the drag" signal, and HTML5
      // DnD only honours it synchronously: deferring it to the coalesced frame
      // would leave the drop refused on every event the frame hadn't caught up
      // with. It is unconditional because allowedDepths never comes back empty
      // (outline/dnd.test.ts pins that), so there is no reachable pointer
      // position this zone would decline.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    } else if (!acceptFiles(e)) {
      return;
    }
    pointerRef.current = { x: e.clientX, y: e.clientY };
    // A files drag is still starting when dnd.drag is null: the effect on
    // `dragging` draws its first line.
    if (!dnd.drag) return;
    if (performance.now() - processedAtRef.current >= THROTTLE_MS) {
      cancelFrame();
      process();
    } else if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        process();
      });
    }
  };

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    cancelFrame();
    // The pointer can be anywhere by the time it comes back, including past a
    // scroll this zone never saw, so re-enter measures again.
    cacheRef.current = null;
    pointerRef.current = null;
    candidateRef.current = null;
    setIndicator(null);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    const drag = dnd.drag;
    if (drag?.kind === "files") {
      // the textarea splices a dropped file at its caret, and says so by
      // preventing the event
      if (e.defaultPrevented || overBlockTextarea(e)) return;
      e.preventDefault();
      cancelFrame();
      const files = Array.from(e.dataTransfer.files);
      let cand = candidateRef.current;
      if (!cand) {
        // no dragover was processed yet: measure the drop's own position
        pointerRef.current = { x: e.clientX, y: e.clientY };
        process();
        cand = candidateRef.current;
      }
      candidateRef.current = null;
      pointerRef.current = null;
      setIndicator(null);
      dnd.endDrag();
      const target = cand
        ? resolveDrop(getBlocks(), pageTitle, drag, cand) : null;
      if (target && files.length > 0) onDropFiles?.(files, target);
      return;
    }
    e.preventDefault();
    cancelFrame();
    // Deliberately the last *processed* candidate rather than this event's
    // coordinates: the user aims with the indicator, so the drop has to land
    // where the line is, even when the line is a frame behind the pointer.
    const cand = candidateRef.current;
    candidateRef.current = null;
    pointerRef.current = null;
    setIndicator(null);
    if (!drag || !cand) return;
    const target = resolveDrop(getBlocks(), pageTitle, drag, cand);
    if (target) dnd.drop(drag, target);
    else dnd.endDrag();
  };

  const dragging = dnd.drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    // A fresh drag measures fresh rows, and processes its first dragover on
    // the spot rather than inheriting the last drag's throttle window.
    cacheRef.current = null;
    processedAtRef.current = 0;
    // A files drag starts on a dragover that could not measure (there was no
    // drag yet), so it draws its first line from that pointer sample.
    if (pointerRef.current) process();
    // A scroll really does move rows out from under the cached tops, and
    // cannot be shifted for: clientY is viewport-relative. Capture, because
    // a scroll inside a pane does not bubble to window.
    const invalidate = () => { cacheRef.current = null; };
    window.addEventListener("scroll", invalidate, { capture: true, passive: true });
    window.addEventListener("resize", invalidate, { passive: true });
    return () => {
      window.removeEventListener("scroll", invalidate, { capture: true });
      window.removeEventListener("resize", invalidate);
      // Whatever frame is still queued closes over the drag that has just
      // ended, so it would move the indicator after the fact.
      cancelFrame();
      cacheRef.current = null;
    };
  }, [dragging]);

  // A files drag has no dragend to clear this zone's line, so the end of the
  // drag (drop elsewhere, Escape, leaving the window) does it.
  const filesDragging = dnd.drag?.kind === "files";
  useEffect(() => {
    if (!filesDragging) return undefined;
    return () => {
      pointerRef.current = null;
      candidateRef.current = null;
      setIndicator(null);
    };
  }, [filesDragging]);

  return { indicator, zoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
