// The editor's command port: everything the outline UI can ask the engine to
// do. It lives HERE, in outline/, because the engine owns the contract —
// useOutline implements it and the components (EditableBlockTree, BlockInput)
// consume it, so the dependency points UI -> engine. It used to be declared in
// EditableBlockTree.tsx, which forced the engine to import a type from a
// component (pkm-64bq).
//
// Deliberately a plain callback interface rather than a discriminated command
// union + dispatcher: every member is already a distinct, named,
// individually-typed operation, and the union would add a second name and a
// switch for each one without removing a single case (pkm-64bq).
export interface OutlineHandlers {
  onFocusBlock(uid: string, cursor: number): void;
  /** Blur reports WHICH block blurred: when a structural op has already
   * moved focus elsewhere, the old textarea's unmount-blur arrives late and
   * must not clear the new focus (the hook checks the uid). */
  onBlurBlock(uid: string): void;
  /** holdFlush (pkm-xlah): the caret sits mid [[ref / #tag token, so the
   * debounced autosave must wait — flushing now would create a page from the
   * half-typed title. Blur/structural commits flush held drafts regardless. */
  onDraftChange(uid: string, text: string, holdFlush?: boolean): void;
  /** Commit the pending draft NOW, without touching focus (pkm-hhbc). The
   * tree calls this before it navigates away under its own steam: unmounting
   * delivers no blur, so a flush-held draft would otherwise be dropped. */
  onFlushDraft(): void;
  onSplit(uid: string, cursor: number): void;
  onIndent(uid: string): void;
  onOutdent(uid: string): void;
  /** Shift+Cmd+Arrow: move the block's whole subtree, preserving depth,
   * possibly crossing a parent boundary (pkm-hx2w). */
  onMoveSubtreeUp(uid: string): void;
  onMoveSubtreeDown(uid: string): void;
  onBackspaceAtStart(uid: string): void;
  onArrow(uid: string, dir: "up" | "down" | "left" | "right"): void;
  onToggleCollapsed(uid: string, collapsed: boolean): void;
  onSetHeading(uid: string, heading: number | null): void;
  onSetViewType(uid: string, viewType: "numbered" | "document"): void;
  onToggleTodo(uid: string): void;
  onFiles(uid: string, cursor: number, files: File[]): void;
  /** Shift-Cmd-V outline paste (pkm-tu3a/pkm-fwa2): parse the clipboard's
   * indentation into real blocks anchored at the caret. Plain Cmd-V and
   * single-line clipboards stay native. */
  onPasteOutline(uid: string, selStart: number, selEnd: number,
                 text: string): void;
  /** Begin a multi-block selection from `uid` towards `dir` (Shift+Arrow at a
   * block edge); the current block is included. */
  onStartBlockSelection(uid: string, dir: "up" | "down"): void;
  /** Ctrl+Cmd+Arrow Up/Down (pkm-am54): select exactly `uid` as a one-block
   * selection; further presses extend it via onExtendBlockSelection. */
  onSelectBlock(uid: string): void;
  onExtendBlockSelection(dir: "up" | "down"): void;
  onClearBlockSelection(): void;
  /** Tab/Shift-Tab while a block selection is active: atomically change every
   * selected root's depth by one while preserving the selected structure. */
  onIndentSelection(): void;
  onOutdentSelection(): void;
  /** Shift+Cmd+Arrow while a block selection is active: atomically move every
   * selected root one depth-preserving position. */
  onMoveSelectionUp(): void;
  onMoveSelectionDown(): void;
  /** Backspace/Delete while a block selection is active: delete every
   * selected block as a set (pkm-q89w). */
  onDeleteBlockSelection(): void;
  onDragStartBlock(uid: string): void;
  /** App-level undo/redo (pkm-7q14): global history, not per-outline. */
  onUndo(): void;
  onRedo(): void;
}
