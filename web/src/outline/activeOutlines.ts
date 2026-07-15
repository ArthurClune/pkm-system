// pattern: Imperative Shell
// Backward-compatible imperative reservation facade used by tests and legacy
// callers that model an editor mounted elsewhere. EditablePage now claims the
// same atomic session lease directly from a layout effect.
import {
  acquireOutlineSession,
  isOutlineEditorActive,
} from "./outlineSessions";

export function isOutlineActive(title: string): boolean {
  return isOutlineEditorActive(title);
}

/** Reserve the editor lease without supplying a block snapshot. */
export function registerOutline(title: string): () => void {
  const handle = acquireOutlineSession(title, null);
  handle.claimEditor(Symbol(`legacy:${title}`));
  return handle.release;
}
