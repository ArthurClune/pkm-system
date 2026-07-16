// pattern: Imperative Shell
// Owns one page's editable outline: block state, focus, the text-op
// debounce, and the wiring between pure edit commands, the op queue, and
// remote websocket batches. All op semantics live in edits.ts / tree.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef,
         useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload, BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { OutlineHandlers } from "../components/EditableBlockTree";
import type { OutlineDndApi } from "../dnd/DndContext";
import { toggleTodo } from "../grammar/todo";
import { encodeTitle } from "../paths";
import { assetMarkdown, uploadAsset } from "../sync/assets";
import { useSync } from "../sync/SyncProvider";
import { newUid } from "../uid";
import { backspaceAtStart, indentBlock, moveBlockDown, moveBlockUp,
         outdentBlock, setCollapsed, setHeading, splitBlock,
         setViewType,
         type EditResult, type FocusTarget } from "./edits";
import { applyOps, findNode, insertSubtree, removeSubtree,
         visibleNeighbor } from "./tree";
import { extendSelection, type BlockSelection } from "./blockSelection";
import { acquireOutlineSession,
         type OutlineSessionHandle } from "./outlineSessions";
import { pendingTextOps, spliceUploadedMarkdown,
         validateOutlineFocus } from "./outlineState";

const TEXT_DEBOUNCE_MS = 500;

export interface Outline {
  blocks: BlockNode[];
  session: OutlineSessionHandle | null;
  ownsEditor: boolean;
  focus: FocusTarget | null;
  selection: BlockSelection | null;
  readOnly: boolean;
  handlers: OutlineHandlers;
  dnd: OutlineDndApi;
  createFirstBlock(): void;
  appendBlock(text: string): void;
}

export function useOutline(
  pageTitle: string,
  initial: BlockNode[],
  editorOwner?: symbol,
): Outline {
  const sync = useSync();
  const [blocks, setBlocks] = useState(initial);
  const [session, setSession] = useState<OutlineSessionHandle | null>(null);
  const [ownsEditor, setOwnsEditor] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  // A live multi-block selection (Shift+Arrow), mutually exclusive with an
  // editing focus: starting one blurs the textarea, focusing a block clears it.
  const [selection, setSelection] = useState<BlockSelection | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const sessionRef = useRef<OutlineSessionHandle | null>(null);
  const bootstrapRef = useRef(initial);
  bootstrapRef.current = initial;
  const pendingRef = useRef<{ uid: string; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const handle = acquireOutlineSession(pageTitle, bootstrapRef.current);
    sessionRef.current = handle;
    const adoptShared = () => {
      const shared = handle.getSnapshot().blocks;
      blocksRef.current = shared;
      setBlocks(shared);
      setFocus((current) => validateOutlineFocus(current, shared));
    };
    const unsubscribe = handle.subscribe(adoptShared);
    const removeLoader = handle.setAuthoritativeLoader(async () => {
      const page = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(pageTitle)}`,
      );
      return page.blocks;
    });
    const lease = editorOwner ? handle.claimEditor(editorOwner) : null;
    const updateLease = () => setOwnsEditor(lease?.granted ?? false);
    const unsubscribeLease = lease?.subscribe(updateLease);
    adoptShared();
    setSession(handle);
    updateLease();
    return () => {
      unsubscribeLease?.();
      lease?.release();
      removeLoader();
      unsubscribe();
      if (sessionRef.current === handle) sessionRef.current = null;
      handle.release();
    };
  }, [pageTitle, editorOwner]);

  const publishBlocks = useCallback((next: BlockNode[]) => {
    blocksRef.current = next;
    setBlocks(next);
    sessionRef.current?.applyOptimistic(next);
  }, []);

  // Parent fetches normally pair their payload with a read token before this
  // prop changes. Direct consumers/tests still enter through the same session
  // transition instead of bypassing causality with a naked setState.
  const receivedInitialRef = useRef(initial);
  useEffect(() => {
    if (receivedInitialRef.current === initial) return;
    receivedInitialRef.current = initial;
    const handle = sessionRef.current;
    if (!handle) return;
    // Token-aware parents publish into the session before passing the exact
    // accepted shared array down. Do not turn that already-reconciled payload
    // into a newer, synthetic read that could hide the original causality.
    if (handle.getSnapshot().blocks === initial) return;
    const token = handle.beginAuthoritativeRead("parent");
    handle.receiveAuthoritative(token, initial);
    pendingRef.current = null;
  }, [initial]);

  const takePendingTextOps = useCallback((): BlockOp[] => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    // no node: a remote batch deleted it — flushing would doom the whole
    // batch. same text: the draft never actually changed anything.
    return pendingTextOps(pending, blocksRef.current);
  }, []);

  /** Flush any pending text op, run the command against the flushed tree,
   * apply + enqueue everything in order, then move focus. */
  const run = useCallback((fn: (b: BlockNode[]) => EditResult) => {
    const textOps = takePendingTextOps();
    const base = textOps.length > 0
      ? applyOps(blocksRef.current, textOps, pageTitle)
      : blocksRef.current;
    const result = fn(base);
    const ops = [...textOps, ...result.ops];
    if (ops.length === 0) return;
    const next = result.ops.length > 0 ? result.blocks : base;
    const write = sync.enqueue(ops, ["page", pageTitle]);
    const handle = sessionRef.current;
    if (handle) handle.applyLocal(write, ops);
    else {
      blocksRef.current = next;
      setBlocks(next);
    }
    if (result.focus) setFocus(result.focus);
  }, [takePendingTextOps, pageTitle, sync, publishBlocks]);

  const flushNow = useCallback(() => {
    run((b) => ({ blocks: b, ops: [], focus: null }));
  }, [run]);

  // A hidden tab can be killed without blur ever firing (the one real
  // data-loss window): flush the draft as soon as the tab hides.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [flushNow]);

  // Unknown target content needs an authoritative tree. The session allocates
  // the read token before the loader dispatches and coalesces same-title reads.
  const refetch = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    void handle.requestAuthoritative(async () => {
      const page = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(pageTitle)}`,
      );
      return page.blocks;
    })
      .catch(() => undefined); // next resync will repair
  }, [pageTitle]);

  // Remote batches: the same applyOps as local edits. Text updates always
  // land on the block tree, even for the focused block — focus does not imply
  // an unflushed local draft. When a real draft exists the focused textarea
  // keeps showing it (BlockInput owns that decision); its next flush then
  // becomes the legitimate last-writer (per-block last-write-wins).
  useEffect(() => sync.subscribe((batch) => {
    const remote = sessionRef.current?.applyRemote(batch);
    if (remote?.needsAuthoritative) {
      // we are the target of a cross-page move: the op carries no block
      // content, so adopt the authoritative tree.
      refetch();
    }
  }), [sync, refetch]);

  const handlers = useMemo<OutlineHandlers>(() => ({
    onFocusBlock: (uid, cursor) => {
      setSelection(null); // focusing a block to edit ends any block selection
      setFocus({ uid, cursor });
    },
    onBlurBlock: (uid) => {
      flushNow();
      // Only clear if this block still owns focus — a structural op may
      // already have moved it (the old textarea's unmount-blur arrives late).
      setFocus((f) => (f?.uid === uid ? null : f));
    },
    onDraftChange: (uid, text) => {
      pendingRef.current = { uid, text };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushNow, TEXT_DEBOUNCE_MS);
    },
    onSplit: (uid, cursor) =>
      run((b) => splitBlock(b, pageTitle, uid, cursor, newUid())),
    onIndent: (uid) => run((b) => indentBlock(b, pageTitle, uid)),
    onOutdent: (uid) => run((b) => outdentBlock(b, pageTitle, uid)),
    onMoveUp: (uid) => run((b) => moveBlockUp(b, pageTitle, uid)),
    onMoveDown: (uid) => run((b) => moveBlockDown(b, pageTitle, uid)),
    onBackspaceAtStart: (uid) => run((b) => backspaceAtStart(b, pageTitle, uid)),
    onArrow: (uid, dir) => {
      const to = visibleNeighbor(blocksRef.current, uid,
        dir === "up" || dir === "left" ? "up" : "down");
      if (!to) return;
      flushNow();
      const node = findNode(blocksRef.current, to);
      setFocus({
        uid: to,
        cursor: dir === "down" || dir === "right" ? 0 : (node?.text.length ?? 0),
      });
    },
    onToggleCollapsed: (uid, collapsed) =>
      run((b) => setCollapsed(b, pageTitle, uid, collapsed)),
    onSetHeading: (uid, heading) =>
      run((b) => setHeading(b, pageTitle, uid, heading)),
    onSetViewType: (uid, viewType) =>
      run((b) => setViewType(b, pageTitle, uid, viewType)),
    onToggleTodo: (uid) => run((b) => {
      const node = findNode(b, uid);
      const flipped = node ? toggleTodo(node.text) : null;
      if (flipped === null) return { blocks: b, ops: [], focus: null };
      const ops: BlockOp[] = [{ op: "update_text", uid, text: flipped }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    }),
    onFiles: (uid, cursor, files) => {
      void (async () => {
        let inserted = "";
        for (const file of files) {
          try {
            inserted += (inserted ? " " : "") + assetMarkdown(await uploadAsset(file));
          } catch {
            // failed upload: leave the text untouched rather than half-splice
          }
        }
        if (inserted === "") return;
        run((b) => {
          const node = findNode(b, uid);
          if (!node) return { blocks: b, ops: [], focus: null };
          // splice at the pre-paste offset, clamped: the user may have kept
          // typing during a slow upload (accepted for v1)
          const spliced = spliceUploadedMarkdown(node.text, cursor, inserted);
          const ops: BlockOp[] = [{ op: "update_text", uid, text: spliced.text }];
          return { blocks: applyOps(b, ops, pageTitle), ops,
                   focus: { uid, cursor: spliced.selStart } };
        });
      })();
    },
    // Multi-block selection (Shift+Arrow). Starting one flushes the current
    // draft and blurs the textarea (focus → null) so the whole run renders
    // read-only while selected.
    onStartBlockSelection: (uid, dir) => {
      flushNow();
      const head = visibleNeighbor(blocksRef.current, uid, dir) ?? uid;
      setFocus(null);
      setSelection({ anchor: uid, head });
    },
    onExtendBlockSelection: (dir) =>
      setSelection((s) => (s ? extendSelection(blocksRef.current, s, dir) : s)),
    onClearBlockSelection: () => setSelection(null),
    // overridden by EditablePage (which knows the drag-source page title);
    // kept here only so this object satisfies OutlineHandlers on its own.
    onDragStartBlock: () => undefined,
  }), [run, flushNow, pageTitle]);

  const dnd = useMemo<OutlineDndApi>(() => ({
    moveTo: (uid, target) => run((b) => {
      const ops: BlockOp[] = [{ op: "move", uid,
        parent_uid: target.parent_uid, order_idx: target.order_idx }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    }),
    removeSubtreeLocal: (uid) => {
      flushNow();
      const { tree, node } = removeSubtree(blocksRef.current, uid);
      if (!node) return null;
      publishBlocks(tree);
      setFocus((f) => (f && findNode(tree, f.uid) ? f : null));
      return node;
    },
    insertSubtreeLocal: (node, target) => {
      publishBlocks(insertSubtree(
        blocksRef.current, node, target.parent_uid, target.order_idx));
    },
  }), [run, flushNow, pageTitle, publishBlocks]);

  const createFirstBlock = useCallback(() => {
    run((b) => {
      if (b.length > 0) return { blocks: b, ops: [], focus: null };
      const uid = newUid();
      const ops: BlockOp[] = [{ op: "create", uid, page_title: pageTitle,
                                parent_uid: null, order_idx: 0, text: "" }];
      return { blocks: applyOps(b, ops, pageTitle), ops,
               focus: { uid, cursor: 0 } };
    });
  }, [run, pageTitle]);

  const appendBlock = useCallback((text: string) => {
    run((b) => {
      const uid = newUid();
      const last = b[b.length - 1];
      const ops: BlockOp[] = [{ op: "create", uid, page_title: pageTitle,
                                parent_uid: null,
                                order_idx: last ? last.order_idx + 1 : 0,
                                text }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    });
  }, [run, pageTitle]);

  return {
    blocks,
    session,
    ownsEditor,
    focus,
    selection,
    // offline editing (pkm-y8p0): the replica persists + renders edits
    readOnly: !sync.canEdit,
    handlers,
    dnd,
    createFirstBlock,
    appendBlock,
  };
}
