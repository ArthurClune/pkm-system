// pattern: Imperative Shell
// App-wide drag state + drop dispatch. HTML5 dataTransfer is unreadable
// during dragover, so the active drag lives here. Outlines register their
// optimistic APIs by page title; read-only sidebar panels register a
// refetch instead and are refreshed once the op queue drains.
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
  /** Authoritative idle-gated refetch. Used as the cross-page-drop fallback
   * when the source outline isn't registered (e.g. dragged from a panel of
   * an unopened page): no subtree ever arrives locally to insert, so the
   * target outline must pull the server's tree instead. */
  refetch(): void;
}

export interface Dnd {
  drag: DragSource | null;
  startDrag(d: DragSource): void;
  endDrag(): void;
  registerOutline(pageTitle: string, api: OutlineDndApi): () => void;
  registerPanel(pageTitle: string, refetch: () => void): () => void;
  drop(drag: DragSource, target: DropTarget): void;
}

export const DndContext = createContext<Dnd>({
  drag: null,
  startDrag: () => undefined,
  endDrag: () => undefined,
  registerOutline: () => () => undefined,
  registerPanel: () => () => undefined,
  drop: () => undefined,
});

export function useDnd(): Dnd {
  return useContext(DndContext);
}

export function DndProvider({ children }: { children: ReactNode }) {
  const sync = useSync();
  const [drag, setDrag] = useState<DragSource | null>(null);
  const outlinesRef = useRef(new Map<string, OutlineDndApi>());
  const panelsRef = useRef(new Map<string, Set<() => void>>());

  const api = useMemo<Dnd>(() => ({
    drag,
    startDrag: (d) => setDrag(d),
    endDrag: () => setDrag(null),
    registerOutline: (title, outlineApi) => {
      outlinesRef.current.set(title, outlineApi);
      return () => {
        if (outlinesRef.current.get(title) === outlineApi) {
          outlinesRef.current.delete(title);
        }
      };
    },
    registerPanel: (title, refetch) => {
      const set = panelsRef.current.get(title) ?? new Set();
      set.add(refetch);
      panelsRef.current.set(title, set);
      return () => { set.delete(refetch); };
    },
    drop: (d, target) => {
      const src = outlinesRef.current.get(d.pageTitle);
      if (target.page_title === d.pageTitle) {
        if (src) {
          src.moveTo(d.uid, target);
        } else {
          const ops: BlockOp[] = [{ op: "move", uid: d.uid,
            parent_uid: target.parent_uid, order_idx: target.order_idx }];
          sync.enqueue(ops);
        }
      } else {
        const node = src?.removeSubtreeLocal(d.uid) ?? null;
        const dst = outlinesRef.current.get(target.page_title);
        if (dst) {
          if (node) dst.insertSubtreeLocal(node, target);
          else dst.refetch();
        }
        const ops: BlockOp[] = [{ op: "move", uid: d.uid,
          parent_uid: target.parent_uid, order_idx: target.order_idx,
          page_title: target.page_title }];
        sync.enqueue(ops);
      }
      void sync.idle().then(() => {
        for (const title of [d.pageTitle, target.page_title]) {
          panelsRef.current.get(title)?.forEach((fn) => fn());
        }
      });
      setDrag(null);
    },
  }), [drag, sync]);

  return <DndContext.Provider value={api}>{children}</DndContext.Provider>;
}
