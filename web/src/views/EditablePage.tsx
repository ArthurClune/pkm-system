// pattern: Imperative Shell
import type { BlockNode } from "../api/payloads";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useOutline } from "../outline/useOutline";

/** One editable outline (a page body or a journal day). */
export function EditablePage({ title, initial }: {
  title: string;
  initial: BlockNode[];
}) {
  const outline = useOutline(title, initial);
  if (outline.blocks.length === 0) {
    return (
      <button className="empty-page" disabled={outline.readOnly}
              onClick={() => outline.createFirstBlock()}>
        Click to start writing…
      </button>
    );
  }
  return (
    <EditableBlockTree blocks={outline.blocks} focus={outline.focus}
                       handlers={outline.handlers}
                       readOnly={outline.readOnly} />
  );
}
