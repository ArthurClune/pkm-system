// pattern: Imperative Shell
import { useEffect, useRef } from "react";
import type { BlockNode } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import {
  isOutlineActive,
  registerOutline as registerActiveOutline,
} from "../outline/activeOutlines";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day).
 *
 * A page can be mounted more than once in the same tab (main pane plus a
 * sidebar panel, or two panels on the same title): each mount would run its
 * own useOutline instance, but the websocket only dedupes a batch as "our
 * own echo" once per tab (see sync/SyncProvider), not per instance — so a
 * second live editor would never learn about edits flushed through the
 * first, and the two would silently diverge. The first instance to mount
 * for a title keeps editing; later ones render read-only (still live for
 * batches from genuinely other clients, via outline.blocks). */
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const activeElsewhereRef = useRef<boolean | null>(null);
  if (activeElsewhereRef.current === null) {
    activeElsewhereRef.current = isOutlineActive(title);
  }
  const activeElsewhere = activeElsewhereRef.current;

  useEffect(() => {
    if (activeElsewhere) return undefined;
    return registerActiveOutline(title);
  }, [title, activeElsewhere]);

  const outline = useOutline(title, initial);
  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef(outline.blocks);
  blocksRef.current = outline.blocks;
  const { indicator, zoneProps } =
    useDropZone(title, () => blocksRef.current, containerRef);

  // The DnD outline registry is last-wins per title: a read-only fallback
  // instance must never register, or it would shadow the live instance's
  // entry and route drops at its stale copy.
  useEffect(() => {
    if (activeElsewhere) return undefined;
    return dnd.registerOutline(title, outline.dnd);
  }, [dnd, title, outline.dnd, activeElsewhere]);

  const handlers = {
    ...outline.handlers,
    onDragStartBlock: (uid: string) => {
      if (outline.readOnly) return;
      dnd.startDrag({ uid, pageTitle: title });
    },
  };

  if (activeElsewhere) {
    // Read-only fallback: no drop zone, no draggable bullets. Dragging
    // into/out of a fallback instance is deliberately unsupported for now
    // (pkm-auvy tracks revisiting this).
    return <BlockTree blocks={outline.blocks} />;
  }

  return (
    <div ref={containerRef} className="outline-drop-zone"
         style={{ position: "relative" }}
         {...(outline.readOnly ? {} : zoneProps)}
         onDragEnd={() => dnd.endDrag()}>
      {outline.blocks.length === 0 ? (
        <div className="empty-drop-zone">
          <button className="empty-page" disabled={outline.readOnly}
                  onClick={() => outline.createFirstBlock()}>
            Click to start writing…
          </button>
        </div>
      ) : (
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           handlers={handlers}
                           readOnly={outline.readOnly} />
      )}
      {indicator && (
        <div className="drop-indicator"
             style={{ top: indicator.top, left: indicator.left }} />
      )}
      {composer && (
        <Composer onSend={outline.appendBlock} readOnly={outline.readOnly} />
      )}
    </div>
  );
}
