// pattern: Imperative Shell
// DOM measurement for one outline's drop zone: pixel positions in, pure
// dnd.ts semantics out. One indicator per outline.
import { useCallback, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop,
         INDENT_PX, type DropRow } from "../outline/dnd";
import { useDnd } from "./DndContext";

export interface Indicator { top: number; left: number }

/** Boundary index for clientY among the container's rendered rows (rows =
 * dropRows order; element lookup by data-uid). Above a row's midpoint =
 * the boundary before it; below every midpoint = rows.length. */
function boundaryAt(container: HTMLElement, rows: DropRow[],
                    clientY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const el = container.querySelector<HTMLElement>(
      `[data-uid="${CSS.escape(rows[i].uid)}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return rows.length;
}

/** y-position (relative to container) for the indicator at a boundary. */
function indicatorTop(container: HTMLElement, rows: DropRow[],
                      boundary: number): number {
  const cr = container.getBoundingClientRect();
  const rowEl = (i: number) => container.querySelector<HTMLElement>(
    `[data-uid="${CSS.escape(rows[i].uid)}"]`);
  if (rows.length === 0) return 0;
  if (boundary < rows.length) {
    const el = rowEl(boundary);
    return el ? el.getBoundingClientRect().top - cr.top : 0;
  }
  const el = rowEl(rows.length - 1);
  return el ? el.getBoundingClientRect().bottom - cr.top : 0;
}

export function useDropZone(pageTitle: string,
                            getBlocks: () => BlockNode[],
                            containerRef: React.RefObject<HTMLElement | null>) {
  const dnd = useDnd();
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // candidate survives between dragover and drop
  const candidateRef = useRef<{ boundary: number; depth: number } | null>(null);

  const onDragOver = useCallback((e: React.DragEvent) => {
    const container = containerRef.current;
    if (!dnd.drag || !container) return;
    const blocks = getBlocks();
    const rows = dropRows(blocks, dnd.drag, pageTitle);
    const boundary = boundaryAt(container, rows, e.clientY);
    const allowed = allowedDepths(rows, boundary);
    if (allowed.length === 0) return;
    e.preventDefault(); // this zone accepts the drag
    e.dataTransfer.dropEffect = "move";
    const offsetX = e.clientX - container.getBoundingClientRect().left;
    const depth = depthFromX(allowed, offsetX);
    candidateRef.current = { boundary, depth };
    setIndicator({ top: indicatorTop(container, rows, boundary),
                   left: depth * INDENT_PX });
  }, [dnd.drag, getBlocks, pageTitle, containerRef]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    candidateRef.current = null;
    setIndicator(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const cand = candidateRef.current;
    candidateRef.current = null;
    setIndicator(null);
    if (!dnd.drag || !cand) return;
    const target = resolveDrop(getBlocks(), pageTitle, dnd.drag,
                               cand.boundary, cand.depth);
    if (target) dnd.drop(dnd.drag, target);
    else dnd.endDrag();
  }, [dnd, getBlocks, pageTitle]);

  return { indicator, zoneProps: { onDragOver, onDragLeave, onDrop } };
}
