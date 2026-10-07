// pattern: Imperative Shell
// App-wide drag state + drop dispatch. HTML5 dataTransfer is unreadable
// during dragover, so the active drag lives here. Outlines register their
// optimistic APIs by page title; a drop is dispatched to the registered
// source/target outlines and enqueued as a move op.
import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockUid } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { dragUids, type BlockDragSource, type DragSource,
         type DropTarget } from "../outline/dnd";
import { groupMoveOps } from "../outline/edits";
import { orderIdxPlus } from "../outline/orderIdx";
import { useSyncActions } from "../sync/SyncProvider";

export interface OutlineDndApi {
  /** Move a group of blocks (a multi-block selection's roots, document
   * order; a plain drag passes one uid) to the target as a contiguous run. */
  moveTo(uids: BlockUid[], target: DropTarget): void;
  removeSubtreeLocal(uid: BlockUid): BlockNode | null;
  insertSubtreeLocal(node: BlockNode, target: DropTarget): void;
}

export type DndRegistration =
  | { accepted: true; unregister(): void }
  | { accepted: false; reason: "duplicate-title" };

export interface Dnd {
  drag: DragSource | null;
  startDrag(d: DragSource): void;
  endDrag(): void;
  registerOutline(pageTitle: string, api: OutlineDndApi): DndRegistration;
  /** Dispatch a block drag's drop. A files drag never comes through here:
   * its zone uploads straight into its own page. */
  drop(drag: BlockDragSource, target: DropTarget): void;
}

export const DndContext = createContext<Dnd>({
  drag: null,
  startDrag: () => undefined,
  endDrag: () => undefined,
  registerOutline: () => ({ accepted: true, unregister: () => undefined }),
  drop: () => undefined,
});

export function useDnd(): Dnd {
  return useContext(DndContext);
}

export function DndProvider({ children }: { children: ReactNode }) {
  // Writes only: this value is a dependency of every outline's drop handling,
  // so it must not churn with the delivery counters.
  const sync = useSyncActions();
  const [drag, setDrag] = useState<DragSource | null>(null);
  const outlinesRef = useRef(new Map<
    string,
    { token: symbol; api: OutlineDndApi }
  >());

  // Files dragged in from outside the app never fire dragend on anything of
  // ours, so a files drag is ended by what can be seen of it: the drop (the
  // zone has used it by the time this bubbles to window), the pointer leaving
  // the window, or Escape.
  const filesDrag = drag?.kind === "files";
  useEffect(() => {
    if (!filesDrag) return undefined;
    const end = () => setDrag(null);
    const onLeave = (e: DragEvent) => { if (e.relatedTarget === null) end(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
    window.addEventListener("drop", end);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("drop", end);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("keydown", onKey);
    };
  }, [filesDrag]);

  // A file dropped where nothing takes it makes the browser navigate to the
  // file, abandoning the page. Zones and the block textarea run first (React
  // listens below window), so only a drag nobody accepted reaches this: it is
  // refused (cursor shows not-allowed) and its drop is swallowed. A text field
  // is left alone on dragover, since it is a drop target in its own right.
  useEffect(() => {
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e) || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest("textarea, input")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const onDrop = (e: DragEvent) => { if (carriesFiles(e)) e.preventDefault(); };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const api = useMemo<Dnd>(() => ({
    drag,
    startDrag: (d) => setDrag(d),
    endDrag: () => setDrag(null),
    registerOutline: (title, outlineApi) => {
      if (outlinesRef.current.has(title)) {
        return { accepted: false, reason: "duplicate-title" };
      }
      const token = Symbol(title);
      outlinesRef.current.set(title, { token, api: outlineApi });
      let registered = true;
      return {
        accepted: true,
        unregister: () => {
          if (!registered) return;
          registered = false;
          if (outlinesRef.current.get(title)?.token === token) {
            outlinesRef.current.delete(title);
          }
        },
      };
    },
    drop: (d, target) => {
      const src = outlinesRef.current.get(d.pageTitle)?.api;
      const uids = dragUids(d); // one uid, or a whole selection
      if (target.page_title === d.pageTitle) {
        if (src) {
          src.moveTo(uids, target);
        } else {
          sync.enqueue(
            groupMoveOps(uids, target.parent_uid, target.order_idx),
            ["page", d.pageTitle]);
        }
      } else {
        const dst = outlinesRef.current.get(target.page_title)?.api;
        // Per-uid surgery + ops at consecutive slots: block k inserts before
        // whatever now sits at order_idx + k, keeping the run's order.
        const moves = uids.map((uid, k) => ({
          uid,
          node: src?.removeSubtreeLocal(uid) ?? null,
          orderIdx: orderIdxPlus(target.order_idx, k),
        }));
        for (const m of moves) {
          if (dst && m.node) {
            dst.insertSubtreeLocal(m.node, { ...target, order_idx: m.orderIdx });
          }
        }
        const ops: BlockOp[] = moves.map((m) => ({ op: "move", uid: m.uid,
          parent_uid: target.parent_uid, order_idx: m.orderIdx,
          page_title: target.page_title }));
        const ticket = sync.enqueue(
          ops, ["page", d.pageTitle, target.page_title],
        );
        const replays = moves
          .filter((m) => m.node !== null)
          .map((m) => ({ type: "insert-subtree" as const, node: m.node!,
                         parentUid: target.parent_uid, orderIdx: m.orderIdx }));
        if (replays.length > 0) {
          sync.attachOutlineReplay(ticket, target.page_title, replays);
        }
      }
      setDrag(null);
    },
  }), [drag, sync]);

  return <DndContext.Provider value={api}>{children}</DndContext.Provider>;
}
