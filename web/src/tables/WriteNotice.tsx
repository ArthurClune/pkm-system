// pattern: Imperative Shell
// The line under a table's toolbar that names a cell write, with its Undo.
import type { ReactNode } from "react";
import { DismissibleNotice } from "../components/DismissibleNotice";
import { island } from "./island";

export function WriteNotice({ message, onUndo, onDismiss }: {
  message: ReactNode;
  onUndo?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="table-notice" {...island}>
      <DismissibleNotice tone="status" onDismiss={onDismiss}>
        {message}
        {onUndo && (
          <button type="button" className="btn-secondary btn-compact"
                  onClick={onUndo}>Undo</button>
        )}
      </DismissibleNotice>
    </div>
  );
}
