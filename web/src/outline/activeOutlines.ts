// pattern: Imperative Shell
// Tracks, per browser tab, which page titles currently have a live editable
// outline mounted. Needed because two useOutline instances of the SAME page
// in one tab can't reconcile: the websocket dedupes each batch by client_id
// once per tab (see sync/SyncProvider's "our own echo" check), not per
// outline instance, so a second live editor would never learn about edits
// made through the first and the two would silently diverge. Consulted by
// EditablePage, which lets the first mounted instance for a title edit and
// falls back later ones to read-only.
const counts = new Map<string, number>();

export function isOutlineActive(title: string): boolean {
  return (counts.get(title) ?? 0) > 0;
}

/** Claims a title as active; call the returned function on unmount. Refcounted
 * so a title only goes inactive once every claimant has released it. */
export function registerOutline(title: string): () => void {
  counts.set(title, (counts.get(title) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(title) ?? 1) - 1;
    if (next <= 0) counts.delete(title);
    else counts.set(title, next);
  };
}
