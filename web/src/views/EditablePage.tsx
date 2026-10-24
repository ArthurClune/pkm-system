// pattern: Imperative Shell
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import type { DropTarget } from "../outline/dnd";
import { selectionDragUids } from "../outline/blockSelection";
import { hidingAncestors } from "../outline/tree";
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
export function EditablePage({ title, initial, stamps = false, refCounts, reveal,
                              revealNavigation, onRevealed }: {
  title: CanonicalTitle;
  initial: BlockNode[];
  /** Show the last-changed margin column. Only the main-pane
   * PageView passes this; the journal scroll and sidebar panels omit it. */
  stamps?: boolean;
  /** Incoming ((uid)) reference counts, threaded straight to the
   * tree exactly like `stamps`. */
  refCounts?: Record<string, number>;
  /** A navigation target (a #uid, a sidebar panel's shift-clicked uid):
   * every collapsed ancestor hiding it is expanded, persisted like any
   * toggle, and `onRevealed` fires once the uncovered rows have rendered,
   * so the caller's useScrollFlashTarget can find the row. A new
   * `revealNavigation` (the router's location key) reveals the same uid
   * again after the reader has collapsed it. */
  reveal?: BlockUid | null;
  revealNavigation?: unknown;
  onRevealed?: () => void;
}) {
  const ownerRef = useRef(Symbol(`editor:${title}`));
  // useOutline acquires and claims in one layout effect. That keeps render
  // pure, makes the initial render a safe fallback, and avoids an intermediate
  // committed fallback DOM after the lease is already available.
  const outline = useOutline(title, initial, ownerRef.current);
  const ownsEditor = outline.ownsEditor;
  // Set by the tree when the /link-local-file picker chunk fails to load.
  const [pickerNotice, setPickerNotice] = useState<string | null>(null);

  // Only the editor can emit the expansion. A read-only outline (sync cannot
  // edit), or the fallback mount of a title already open elsewhere in the
  // tab, leaves a hidden target hidden and the caller's scroll a no-op. Each
  // navigation is revealed once: a later change of lease or editability must
  // not re-expand what the reader has collapsed since.
  const canReveal = ownsEditor && !outline.readOnly;
  const revealOutline = outline.reveal;
  const revealedRef = useRef<{ uid: BlockUid; navigation: unknown } | null>(null);
  const awaitingRevealRef = useRef<BlockUid | null>(null);
  useEffect(() => {
    if (!reveal || !canReveal) return;
    const last = revealedRef.current;
    if (last?.uid === reveal && last.navigation === revealNavigation) return;
    revealedRef.current = { uid: reveal, navigation: revealNavigation };
    if (revealOutline(reveal)) awaitingRevealRef.current = reveal;
  }, [reveal, revealNavigation, canReveal, revealOutline]);
  // The expansion lands in a later render than the one that ran it; this
  // effect runs after the commit that put the uncovered rows in the DOM.
  useEffect(() => {
    const uid = awaitingRevealRef.current;
    if (!uid || hidingAncestors(outline.blocks, uid).length > 0) return;
    awaitingRevealRef.current = null;
    onRevealed?.();
  }, [outline.blocks, onRevealed]);

  const dnd = useDnd();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef(outline.blocks);
  blocksRef.current = outline.blocks;
  // Stable identity: a fresh arrow every render would rebuild useDropZone's
  // `process` (dep `getBlocks`) on every render, making that memoization
  // inert even though the ref read below is always current regardless.
  const getBlocks = useCallback(() => blocksRef.current, []);
  const uploadOutlineFiles = outline.onDropFiles;
  const onDropFiles = useCallback((files: File[], target: DropTarget) => {
    void uploadOutlineFiles(files, target);
  }, [uploadOutlineFiles]);
  const { indicator, zoneProps } = useDropZone(
    title, getBlocks, containerRef, onDropFiles);

  useEffect(() => {
    if (!ownsEditor) return undefined;
    const registration = dnd.registerOutline(title, outline.dnd);
    return registration.accepted ? registration.unregister : undefined;
  }, [dnd, title, outline.dnd, ownsEditor]);

  const onDragStartBlock = useCallback((uid: BlockUid) => {
    if (!ownsEditor || outline.readOnly) return;
    // Grabbing a block inside an active multi-block selection drags the
    // whole selection; grabbing any other block drags just it.
    const group = outline.selection
      ? selectionDragUids(blocksRef.current, outline.selection, uid) : null;
    dnd.startDrag(group && group.length > 1
      ? { kind: "blocks", uid, pageTitle: title, uids: group }
      : { kind: "blocks", uid, pageTitle: title });
  }, [ownsEditor, outline.readOnly, outline.selection, dnd, title]);
  // The tree hands this object to every row, so a fresh literal per render
  // would defeat EditableBlock's memo — one Journal day's worth of wasted
  // rows per mounted day, on any re-render.
  const handlers = useMemo(() => ({ ...outline.handlers, onDragStartBlock }),
                           [outline.handlers, onDragStartBlock]);

  return (
    <div ref={containerRef}
         className={ownsEditor ? "outline-drop-zone" : undefined}
         style={ownsEditor ? { position: "relative" } : undefined}
         {...(ownsEditor && !outline.readOnly ? zoneProps : {})}
         onDragEnd={ownsEditor ? () => dnd.endDrag() : undefined}>
      {ownsEditor && outline.uploadError && (
        <p className="error upload-error" role="alert">
          {outline.uploadError}
          <button type="button" className="btn-secondary"
                  onClick={outline.dismissUploadError}>
            Dismiss
          </button>
        </p>
      )}
      {ownsEditor && outline.goodlinksNotice && (
        <p className="editor-notice" role="status">
          {outline.goodlinksNotice}
          <button type="button" className="btn-secondary"
                  onClick={outline.dismissGoodlinksNotice}>
            Dismiss
          </button>
        </p>
      )}
      {ownsEditor && outline.depthNotice && (
        <p className="editor-notice" role="status">
          {outline.depthNotice}
          <button type="button" className="btn-secondary"
                  onClick={outline.dismissDepthNotice}>
            Dismiss
          </button>
        </p>
      )}
      {ownsEditor && pickerNotice && (
        <p className="editor-notice" role="status">
          {pickerNotice}
          <button type="button" className="btn-secondary"
                  onClick={() => setPickerNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
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
                           fallback={!ownsEditor} stamps={stamps}
                           refCounts={refCounts}
                           onPickerNotice={setPickerNotice} />
      )}
      {ownsEditor && indicator && (
        <div className="drop-indicator"
             style={{ top: indicator.top, left: indicator.left }} />
      )}
      {outline.dialog}
    </div>
  );
}
