// pattern: Imperative Shell
// DOM measurement for one outline's drop zone: pixel positions in, pure
// dnd.ts semantics out. One indicator per outline.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop, INDENT_PX,
         type DragSource, type DropRow } from "../outline/dnd";
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

export function useDropZone(pageTitle: string,
                            getBlocks: () => BlockNode[],
                            containerRef: React.RefObject<HTMLElement | null>) {
  const dnd = useDnd();
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // candidate survives between dragover and drop
  const candidateRef = useRef<{ boundary: number; depth: number } | null>(null);
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

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dnd.drag || !containerRef.current) return;
    // preventDefault is the "this zone accepts the drag" signal, and HTML5
    // DnD only honours it synchronously: deferring it to the coalesced frame
    // would leave the drop refused on every event the frame hadn't caught up
    // with. It is unconditional because allowedDepths never comes back empty
    // (outline/dnd.test.ts pins that), so there is no reachable pointer
    // position this zone would decline.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    pointerRef.current = { x: e.clientX, y: e.clientY };
    if (performance.now() - processedAtRef.current >= THROTTLE_MS) {
      cancelFrame();
      process();
    } else if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        process();
      });
    }
  }, [dnd.drag, containerRef, process]);

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

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    cancelFrame();
    // Deliberately the last *processed* candidate rather than this event's
    // coordinates: the user aims with the indicator, so the drop has to land
    // where the line is, even when the line is a frame behind the pointer.
    const cand = candidateRef.current;
    candidateRef.current = null;
    pointerRef.current = null;
    setIndicator(null);
    if (!dnd.drag || !cand) return;
    const target = resolveDrop(getBlocks(), pageTitle, dnd.drag,
                               cand.boundary, cand.depth);
    if (target) dnd.drop(dnd.drag, target);
    else dnd.endDrag();
  }, [dnd, getBlocks, pageTitle]);

  const dragging = dnd.drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    // A fresh drag measures fresh rows, and processes its first dragover on
    // the spot rather than inheriting the last drag's throttle window.
    cacheRef.current = null;
    processedAtRef.current = 0;
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

  return { indicator, zoneProps: { onDragOver, onDragLeave, onDrop } };
}
