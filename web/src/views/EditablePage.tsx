// pattern: Imperative Shell
import { useEffect, useRef } from "react";
import type { BlockNode } from "../api/payloads";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day). */
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const outline = useOutline(title, initial);
  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef(outline.blocks);
  blocksRef.current = outline.blocks;
  const { indicator, zoneProps } =
    useDropZone(title, () => blocksRef.current, containerRef);

  useEffect(() => dnd.registerOutline(title, outline.dnd),
            [dnd, title, outline.dnd]);

  const handlers = {
    ...outline.handlers,
    onDragStartBlock: (uid: string) => {
      if (outline.readOnly) return;
      dnd.startDrag({ uid, pageTitle: title });
    },
  };

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
