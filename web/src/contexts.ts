// pattern: Functional Core
import { createContext } from "react";
import type { BlockRefText } from "./api/payloads";

export interface SidebarApi {
  openInSidebar: (title: string) => void;
}

export const SidebarContext = createContext<SidebarApi>({
  openInSidebar: () => undefined,
});

/** uid -> resolved text of ((uid)) block refs, from the page payload. */
export const BlockRefContext = createContext<Record<string, BlockRefText>>({});

/** Present only inside the editable outline: lets deep segment renders
 * (TODO checkboxes) reach the block's edit handlers. */
export interface BlockEditApi {
  toggleTodo: () => void;
}

export const BlockEditContext = createContext<BlockEditApi | null>(null);
