// pattern: Imperative Shell
// A table renders inside an outline block, whose click opens the block's own
// editor and whose tree reads keys for block selection. Spread `island` on a
// table surface's root so neither sees what happens inside it. Cmd and Ctrl
// chords go on: the app's shortcuts (Cmd-U search, Cmd-J assistant) listen
// on window, and stopping a React event stops the native one too.
import type { KeyboardEvent, MouseEvent } from "react";

export const island = {
  onClick: (e: MouseEvent) => { e.stopPropagation(); },
  onKeyDown: (e: KeyboardEvent) => {
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  },
};
