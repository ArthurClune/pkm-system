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
