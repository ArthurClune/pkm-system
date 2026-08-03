// pattern: Imperative Shell
// React context objects: createContext() is a runtime React call (the
// context identity itself is instantiated at module load), and every
// context here exists purely to carry mutable app state/callbacks across
// the tree -- there's no pure decision to extract.
import { createContext } from "react";
import type { BlockRefText } from "./api/payloads";

export interface SidebarApi {
  /** uid, when given, is the block to scroll to and flash once the panel's
   * page has rendered (pkm-gdi5) -- scoped to that panel's own container,
   * never a document-wide lookup (the same page may be open in the main
   * window at the same time). */
  openInSidebar: (title: string, uid?: string) => void;
}

export const SidebarContext = createContext<SidebarApi>({
  openInSidebar: () => undefined,
});

/** uid -> resolved text of ((uid)) block refs, from the page payload. */
export const BlockRefContext = createContext<Record<string, BlockRefText>>({});

/** Ask the enclosing BlockRefProvider to fetch a uid missing from the map
 * (a ref pasted after the payload loaded). No-op default keeps plain
 * BlockRefContext render sites (and their tests) working unchanged. */
export const BlockRefRequestContext =
  createContext<(uid: string) => void>(() => undefined);

/** Present only inside the editable outline: lets deep segment renders
 * (TODO checkboxes) reach the block's edit handlers. */
export interface BlockEditApi {
  toggleTodo: () => void;
}

export const BlockEditContext = createContext<BlockEditApi | null>(null);

/** Whether main-pane pages render the block-stamp margin column (pkm-4ler),
 * plus the toggle TopBar's page menu drives. One provider in App.tsx so the
 * menu's checkmark and PageView's column always agree. */
export interface BlockStampsApi {
  stamps: boolean;
  toggle: () => void;
}

export const BlockStampsContext = createContext<BlockStampsApi>({
  stamps: false,
  toggle: () => undefined,
});
