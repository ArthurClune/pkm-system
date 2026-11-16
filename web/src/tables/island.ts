// pattern: Imperative Shell
// A table renders inside an outline block, whose click opens the block's own
// editor and whose tree reads keys for block selection. Spread `island` on a
// table surface's root so neither sees what happens inside it. Cmd and Ctrl
// chords go on: the app's shortcuts (Cmd-U search, Cmd-J assistant) listen
// on window, and stopping a React event stops the native one too, so a
// tree shortcut that acts on the block selection checks isInTableIsland.
// Keys from a portal (the column menu) go on as well: React bubbles them
// through here, but the menu reads them on document. The click stop stays,
// so a click in the menu does not open the host block.
import type { KeyboardEvent, MouseEvent } from "react";
import { TABLE_ISLAND_ATTR } from "../editableTarget";

export const island = {
  [TABLE_ISLAND_ATTR]: "",
  onClick: (e: MouseEvent) => { e.stopPropagation(); },
  onKeyDown: (e: KeyboardEvent) => {
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  },
};
