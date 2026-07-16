// pattern: Imperative Shell
// App-wide drag state + drop dispatch. HTML5 dataTransfer is unreadable
// during dragover, so the active drag lives here. Outlines register their
// optimistic APIs by page title; a drop is dispatched to the registered
// source/target outlines and enqueued as a move op.
import { createContext, useContext, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { DragSource, DropTarget } from "../outline/dnd";
import { useSync } from "../sync/SyncProvider";

export interface OutlineDndApi {
  moveTo(uid: string, target: DropTarget): void;
  removeSubtreeLocal(uid: string): BlockNode | null;
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
  drop(drag: DragSource, target: DropTarget): void;
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
  const sync = useSync();
  const [drag, setDrag] = useState<DragSource | null>(null);
  const outlinesRef = useRef(new Map<
    string,
    { token: symbol; api: OutlineDndApi }
  >());

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
      if (target.page_title === d.pageTitle) {
        if (src) {
          src.moveTo(d.uid, target);
        } else {
          const ops: BlockOp[] = [{ op: "move", uid: d.uid,
            parent_uid: target.parent_uid, order_idx: target.order_idx }];
          sync.enqueue(ops, ["page", d.pageTitle]);
        }
      } else {
        const node = src?.removeSubtreeLocal(d.uid) ?? null;
        const dst = outlinesRef.current.get(target.page_title)?.api;
        if (dst && node) dst.insertSubtreeLocal(node, target);
        const ops: BlockOp[] = [{ op: "move", uid: d.uid,
          parent_uid: target.parent_uid, order_idx: target.order_idx,
          page_title: target.page_title }];
        const ticket = sync.enqueue(
          ops, ["page", d.pageTitle, target.page_title],
        );
        if (node) {
          sync.attachOutlineReplay(ticket, target.page_title, [{
            type: "insert-subtree", node,
            parentUid: target.parent_uid, orderIdx: target.order_idx,
          }]);
        }
      }
      setDrag(null);
    },
  }), [drag, sync]);

  return <DndContext.Provider value={api}>{children}</DndContext.Provider>;
}
