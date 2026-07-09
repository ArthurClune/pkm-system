// pattern: Imperative Shell
// Owns one page's editable outline: block state, focus, the text-op
// debounce, and the wiring between pure edit commands, the op queue, and
// remote websocket batches. All op semantics live in edits.ts / tree.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { OutlineHandlers } from "../components/EditableBlockTree";
import { toggleTodo } from "../grammar/todo";
import { useSync } from "../sync/SyncProvider";
import { newUid } from "../uid";
import { backspaceAtStart, indentBlock, moveBlockDown, moveBlockUp,
         outdentBlock, setCollapsed, splitBlock,
         type EditResult, type FocusTarget } from "./edits";
import { applyOps, findNode, visibleNeighbor } from "./tree";

const TEXT_DEBOUNCE_MS = 500;

export interface Outline {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  readOnly: boolean;
  handlers: OutlineHandlers;
  createFirstBlock(): void;
  appendBlock(text: string): void;
}

export function useOutline(pageTitle: string, initial: BlockNode[]): Outline {
  const sync = useSync();
  const [blocks, setBlocks] = useState(initial);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pendingRef = useRef<{ uid: string; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new `initial` identity is authoritative state (refetch / navigation):
  // adopt it and drop any pending draft op.
  useEffect(() => {
    setBlocks(initial);
    blocksRef.current = initial;
    pendingRef.current = null;
  }, [initial]);

  const takePendingTextOps = useCallback((): BlockOp[] => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return [];
    pendingRef.current = null;
    if (findNode(blocksRef.current, pending.uid)?.text === pending.text) {
      return []; // draft never actually changed the text
    }
    return [{ op: "update_text", uid: pending.uid, text: pending.text }];
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
    blocksRef.current = next;
    setBlocks(next);
    sync.enqueue(ops);
    if (result.focus) setFocus(result.focus);
  }, [takePendingTextOps, pageTitle, sync]);

  const flushNow = useCallback(() => {
    run((b) => ({ blocks: b, ops: [], focus: null }));
  }, [run]);

  // Remote batches: the same applyOps as local edits. Text updates for the
  // block being typed in are skipped — the local draft wins on its next
  // flush (per-block last-write-wins).
  useEffect(() => sync.subscribe((batch) => {
    const ops = batch.ops.filter((op) =>
      !(op.op === "update_text" && op.uid === focusRef.current?.uid));
    blocksRef.current = applyOps(blocksRef.current, ops, pageTitle);
    setBlocks(blocksRef.current);
  }), [sync, pageTitle]);

  const handlers = useMemo<OutlineHandlers>(() => ({
    onFocusBlock: (uid, cursor) => setFocus({ uid, cursor }),
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
    onToggleTodo: (uid) => run((b) => {
      const node = findNode(b, uid);
      const flipped = node ? toggleTodo(node.text) : null;
      if (flipped === null) return { blocks: b, ops: [], focus: null };
      const ops: BlockOp[] = [{ op: "update_text", uid, text: flipped }];
      return { blocks: applyOps(b, ops, pageTitle), ops, focus: null };
    }),
    onFiles: () => undefined, // wired in T11 (paste/drop upload)
  }), [run, flushNow, pageTitle]);

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
    focus,
    readOnly: sync.status !== "connected",
    handlers,
    createFirstBlock,
    appendBlock,
  };
}
