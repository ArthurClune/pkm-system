// The editor's command port: everything the outline UI can ask the engine to
// do. It lives HERE, in outline/, because the engine owns the contract —
// useOutline implements it and the components (EditableBlockTree, BlockInput)
// consume it, so the dependency points UI -> engine. It used to be declared in
// EditableBlockTree.tsx, which forced the engine to import a type from a
// component.
//
// Deliberately a plain callback interface rather than a discriminated command
// union + dispatcher: every member is already a distinct, named,
// individually-typed operation, and the union would add a second name and a
// switch for each one without removing a single case.
export interface OutlineHandlers {
  onFocusBlock(uid: string, cursor: number): void;
  /** Blur reports WHICH block blurred: when a structural op has already
   * moved focus elsewhere, the old textarea's unmount-blur arrives late and
   * must not clear the new focus (the hook checks the uid). */
  onBlurBlock(uid: string): void;
  /** The first edit of a clean draft is about to be reported: `shown` is the
   * text the textarea showed, which the user is typing over. It becomes the
   * new draft's base, so its flush hashes what the user saw rather than a
   * remote text the tree took before the textarea could show it. */
  onDraftStart(uid: string, shown: string): void;
  /** holdFlush: the caret sits mid [[ref / #tag token, so the
   * debounced autosave must wait — flushing now would create a page from the
   * half-typed title. Blur/structural commits flush held drafts regardless. */
  onDraftChange(uid: string, text: string, holdFlush?: boolean): void;
  /** The unflushed draft for `uid`, or null when none is pending. A textarea
   * mounting for that block resumes it: a remote batch that reparents the
   * block (or an ancestor) remounts the textarea with no blur, so the draft
   * is still pending and the tree does not hold its text. */
  pendingDraft(uid: string): ResumedDraft | null;
  /** The focused textarea for `uid` is unmounting with this selection. It is
   * kept while that block's draft is pending, so a textarea remounted over
   * the draft puts the caret back where the user left it. */
  onInputUnmount(uid: string, selStart: number, selEnd: number): void;
  /** Commit the pending draft NOW, without touching focus. The
   * tree calls this before it navigates away under its own steam: unmounting
   * delivers no blur, so a flush-held draft would otherwise be dropped. */
  onFlushDraft(): void;
  onSplit(uid: string, cursor: number): void;
  onIndent(uid: string): void;
  onOutdent(uid: string): void;
  /** Shift+Cmd+Arrow: move the block's whole subtree, preserving depth,
   * possibly crossing a parent boundary. */
  onMoveSubtreeUp(uid: string): void;
  onMoveSubtreeDown(uid: string): void;
  onBackspaceAtStart(uid: string): void;
  onArrow(uid: string, dir: "up" | "down" | "left" | "right"): void;
  onToggleCollapsed(uid: string, collapsed: boolean): void;
  onSetHeading(uid: string, heading: number | null): void;
  onSetViewType(uid: string, viewType: "numbered" | "document"): void;
  onToggleTodo(uid: string): void;
  /** Resolves once the uploads have finished: true when their markdown was
   * spliced into the block, false when nothing was (every upload failed, or
   * the block is gone). */
  onFiles(uid: string, cursor: number, files: File[]): Promise<boolean>;
  /** /goodlinks (see outline/goodlinks.ts): resolve the nearest URL against
   * GoodLinks and splice the `Local copy::` attribute at `cursor` in `uid`.
   * The block has already been blurred by the pick, like /upload. */
  onGoodlinks(uid: string, cursor: number): void;
  /** Shift-Cmd-V outline paste: parse the clipboard's
   * indentation into real blocks anchored at the caret. Plain Cmd-V and
   * single-line clipboards stay native. */
  onPasteOutline(uid: string, selStart: number, selEnd: number,
                 text: string): void;
  /** Begin a multi-block selection from `uid` towards `dir` (Shift+Arrow at a
   * block edge); the current block is included. */
  onStartBlockSelection(uid: string, dir: "up" | "down"): void;
  /** Ctrl+Cmd+Arrow Up/Down: select exactly `uid` as a one-block
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
   * selected block as a set. */
  onDeleteBlockSelection(): void;
  /** Optional: useOutline has no access to the page title or the drag/drop
   * API a real implementation needs, so it leaves this unset. EditablePage
   * is the one host that owns those and supplies the real handler by
   * spreading useOutline's handlers and adding this key — optionality means
   * that spread no longer needs a satisfy-the-interface stub to override. */
  onDragStartBlock?(uid: string): void;
  /** App-level undo/redo: global history, not per-outline. */
  onUndo(): void;
  onRedo(): void;
}

/** A pending draft a mounting textarea takes over. `selection` is where the
 * textarea that last showed the draft left its selection, or null when none
 * was recorded (the caret then goes to the end of the text). */
export interface ResumedDraft {
  text: string;
  selection: { start: number; end: number } | null;
}
