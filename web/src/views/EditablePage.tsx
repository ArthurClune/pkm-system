// pattern: Imperative Shell
import type { BlockNode } from "../api/payloads";
import { Composer } from "../components/Composer";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day). */
export function EditablePage({ title, initial, composer = false }: {
  title: string;
  initial: BlockNode[];
  composer?: boolean;
}) {
  const outline = useOutline(title, initial);
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
