// pattern: Imperative Shell
import { useEffect, useRef } from "react";
import type { BlockNode } from "../api/payloads";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day).
 *
 * A page can be mounted more than once in the same tab (main pane plus a
 * sidebar panel, or two panels on the same title): each mount would run its
 * own useOutline instance, but the websocket only dedupes a batch as "our
 * own echo" once per tab (see sync/SyncProvider), not per instance — so a
 * second live editor would never learn about edits flushed through the
 * first, and the two would silently diverge. A per-title session shares each
 * flushed tree and grants exactly one editor lease after commit. */
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const ownerRef = useRef(Symbol(`editor:${title}`));
  // useOutline acquires and claims in one layout effect. That keeps render
  // pure, makes the initial render a safe fallback, and avoids an intermediate
  // committed fallback DOM after the lease is already available.
  const outline = useOutline(title, initial, ownerRef.current);
  const ownsEditor = outline.ownsEditor;

  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef(outline.blocks);
  blocksRef.current = outline.blocks;
  const { indicator, zoneProps } =
    useDropZone(title, () => blocksRef.current, containerRef);

  useEffect(() => {
    if (!ownsEditor) return undefined;
    const registration = dnd.registerOutline(title, outline.dnd);
    return registration.accepted ? registration.unregister : undefined;
  }, [dnd, title, outline.dnd, ownsEditor]);

  const handlers = {
    ...outline.handlers,
    onDragStartBlock: (uid: string) => {
      if (!ownsEditor || outline.readOnly) return;
      dnd.startDrag({ uid, pageTitle: title });
    },
  };

  return (
    <div ref={containerRef}
         className={ownsEditor ? "outline-drop-zone" : undefined}
         style={ownsEditor ? { position: "relative" } : undefined}
         {...(ownsEditor && !outline.readOnly ? zoneProps : {})}
         onDragEnd={ownsEditor ? () => dnd.endDrag() : undefined}>
      {outline.blocks.length === 0 && ownsEditor ? (
        <div className="empty-drop-zone">
          <button className="empty-page" disabled={outline.readOnly}
                  onClick={() => outline.createFirstBlock()}>
            Click to start writing…
          </button>
        </div>
      ) : (
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           selection={outline.selection} handlers={handlers}
                           readOnly={outline.readOnly || !ownsEditor}
                           fallback={!ownsEditor} />
      )}
      {ownsEditor && indicator && (
        <div className="drop-indicator"
             style={{ top: indicator.top, left: indicator.left }} />
      )}
      {ownsEditor && composer && (
        <Composer onSend={outline.appendBlock} readOnly={outline.readOnly} />
      )}
    </div>
  );
}
