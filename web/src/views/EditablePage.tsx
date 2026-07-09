// pattern: Imperative Shell
import { useEffect, useRef } from "react";
import type { BlockNode } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { isOutlineActive, registerOutline } from "../outline/activeOutlines";
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
    return registerOutline(title);
  }, [title, activeElsewhere]);

  const outline = useOutline(title, initial);

  if (activeElsewhere) {
    return <BlockTree blocks={outline.blocks} />;
  }

  return (
    <>
      {outline.blocks.length === 0 ? (
        <button className="empty-page" disabled={outline.readOnly}
                onClick={() => outline.createFirstBlock()}>
          Click to start writing…
        </button>
      ) : (
        <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                           handlers={outline.handlers}
                           readOnly={outline.readOnly} />
      )}
      {composer && (
        <Composer onSend={outline.appendBlock} readOnly={outline.readOnly} />
      )}
    </>
  );
}
