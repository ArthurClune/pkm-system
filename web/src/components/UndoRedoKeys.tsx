// pattern: Imperative Shell
// Window-level Cmd-Z / Shift-Cmd-Z (pkm-7q14), for when no block textarea
// owns the keystroke (block selection active, or nothing focused). Editable
// targets are left alone: block textareas run the chord through
// keyboardPolicy themselves (and preventDefault, so defaultPrevented guards
// the double-dispatch), while search/title inputs keep native input undo.
// Also registers router navigation so undoing an edit on an unmounted page
// can bring the user to it.
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { performRedo, performUndo,
         setHistoryNavigator } from "../outline/undoManager";
import { useSync } from "../sync/SyncProvider";

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function UndoRedoKeys() {
  const sync = useSync();
  const navigate = useNavigate();

  useEffect(() => setHistoryNavigator(navigate), [navigate]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((!e.metaKey && !e.ctrlKey) || e.altKey
          || e.key.toLowerCase() !== "z") return;
      if (isEditableTarget(e.target)) return;
      if (!sync.canEdit) return;
      e.preventDefault();
      if (e.shiftKey) performRedo(sync);
      else performUndo(sync);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sync]);

  return null;
}
