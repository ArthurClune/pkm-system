// pattern: Imperative Shell
// The outliner. Only the focused block is a live textarea (raw markdown);
// everything else renders through the read pipeline. This file owns DOM
// concerns (focus placement, auto-grow, key mapping) and delegates every
// semantic decision to the handlers (useOutline).
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { BlockNode } from "../api/payloads";
import { measureCaretDisplayLine } from "../outline/caretDisplayLine";
import { clampCaret, type FocusTarget } from "../outline/edits";
import { BlockEditContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { applyCompletion, detectAutocomplete, holdsDraftFlush,
         type AcContext } from "../outline/autocomplete";
import { type TextSelection } from "../outline/keyEdits";
import { decideEditorKey } from "../outline/keyboardPolicy";
import { selectedUids, selectionText,
         type BlockSelection } from "../outline/blockSelection";
import { findNode } from "../outline/tree";
import { applySlashCommand, matchSlashCommands,
         resolveHeading } from "../outline/slashCommands";
import { pagePath } from "../paths";
import { AutocompletePopup, buildRows, useTitleOptions,
         type AcRow } from "./AutocompletePopup";
import { BlockMenu } from "./BlockMenu";
import { InlineSegments } from "./InlineSegments";
import { RoamTable } from "./roamTable";
import { quoteContent } from "./blockPresentation";
import { effectiveChildView, type EffectiveBlockView } from "./blockView";
import { roamTableRows } from "./roamTableRows";

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

interface TreeProps {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  // The live multi-block selection, if any. Optional so simple render sites
  // (and tests) that don't exercise selection can omit it.
  selection?: BlockSelection | null;
  handlers: OutlineHandlers;
  readOnly: boolean;
  fallback?: boolean;
}

export function EditableBlockTree({ blocks, focus, selection = null, handlers,
                                    readOnly, fallback = false }: TreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  // The /upload file picker (pkm-gbsb): owned by the tree root, not the
  // focus-scoped BlockInput. The native dialog taking focus blurs the
  // textarea, which unmounts BlockInput while the dialog is still open; a
  // picker-owned input would be detached from the DOM by the time the user
  // picks a file, so its change event would never dispatch. This one input
  // is shared across every block, with the pending target recorded here.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<{ uid: string; at: number } | null>(null);
  const requestUpload = (uid: string, at: number) => {
    uploadTargetRef.current = { uid, at };
    fileInputRef.current?.click();
  };
  const onPickUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be picked again later
    const target = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (files.length === 0 || !target) return;
    handlers.onFiles(target.uid, target.at, files);
  };
  // Bullet context menu (pkm-y6af); one per tree, anchored at the pointer.
  const [menu, setMenu] = useState<{
    uid: string;
    x: number;
    y: number;
    viewMode: EffectiveBlockView;
    trigger: HTMLElement;
  } | null>(null);
  const selected = !fallback && selection
    ? new Set(selectedUids(blocks, selection)) : EMPTY_SET;
  const closeMenu = () => {
    menu?.trigger.focus();
    setMenu(null);
  };

  // When a block selection is active there is no focused textarea, so the tree
  // container itself takes focus and owns the keyboard (extend / copy / clear).
  useEffect(() => {
    if (selection) treeRef.current?.focus();
  }, [selection]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (fallback || !selection) return;
    const verticalArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
    if (!readOnly && e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) handlers.onOutdentSelection();
      else handlers.onIndentSelection();
    } else if (e.shiftKey && e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      if (!readOnly) {
        e.preventDefault();
        if (e.key === "ArrowUp") handlers.onMoveSelectionUp();
        else handlers.onMoveSelectionDown();
      }
    } else if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      e.preventDefault();
      handlers.onExtendBlockSelection(e.key === "ArrowUp" ? "up" : "down");
    } else if (e.ctrlKey && e.metaKey && !e.shiftKey && !e.altKey
               && verticalArrow) {
      // Ctrl+Cmd+Up/Down keeps extending the selection it started (pkm-am54).
      e.preventDefault();
      handlers.onExtendBlockSelection(e.key === "ArrowUp" ? "up" : "down");
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void navigator.clipboard?.writeText(selectionText(blocks, selection));
    } else if (e.key === "Escape") {
      e.preventDefault();
      handlers.onClearBlockSelection();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handlers.onDeleteBlockSelection();
    } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      e.preventDefault();
      handlers.onFocusBlock(selection.head, 0);
    }
  };

  return (
    <div className="block-tree" ref={treeRef}
         tabIndex={selection ? -1 : undefined} onKeyDown={onKeyDown}>
      {blocks.map((b, index) => (
        <EditableBlock key={b.uid} node={b} focus={focus} selected={selected}
                       handlers={handlers} readOnly={readOnly}
                       fallback={fallback} onRequestUpload={requestUpload}
                       viewMode="document" number={index + 1}
                       openMenuUid={menu?.uid ?? null}
                       onOpenMenu={(uid, x, y, viewMode, trigger) =>
                         setMenu({ uid, x, y, viewMode, trigger })} />
      ))}
      {!fallback && !readOnly && (
        <input ref={fileInputRef} type="file" multiple
               className="upload-input" aria-label="Upload file"
               accept={"image/*,application/pdf,text/plain,text/markdown,"
                 + "text/csv,application/json,.doc,.docx,.xls,.xlsx,.ppt,.pptx"}
               onChange={onPickUpload} />
      )}
      {!fallback && menu && (
        <BlockMenu x={menu.x} y={menu.y} onClose={closeMenu}
          items={blockMenuItems(
            menu.uid,
            findNode(blocks, menu.uid)?.heading ?? null,
            menu.viewMode,
            handlers,
            readOnly,
          )} />
      )}
    </div>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function blockMenuItems(
  uid: string,
  heading: number | null,
  viewMode: EffectiveBlockView,
  handlers: OutlineHandlers,
  readOnly: boolean,
) {
  const headingItem = (label: string, value: number | null) => ({
    label,
    group: "Text style",
    checked: heading === value,
    disabled: readOnly,
    action: () => handlers.onSetHeading(uid, value),
  });
  const viewItem = (label: string, value: EffectiveBlockView) => ({
    label,
    group: "Children view",
    checked: viewMode === value,
    disabled: readOnly,
    action: () => handlers.onSetViewType(uid, value),
  });
  return [
    {
      label: "Copy block reference",
      // Copying is read-only-safe (same rationale as multi-block copy).
      action: () => void navigator.clipboard?.writeText(`((${uid}))`),
    },
    headingItem("Plain text", null),
    headingItem("Heading 1", 1),
    headingItem("Heading 2", 2),
    headingItem("Heading 3", 3),
    viewItem("View as numbered list", "numbered"),
    viewItem("View as document", "document"),
  ];
}

function focusInSubtree(node: BlockNode, focusUid: string | null): boolean {
  if (focusUid === null) return false;
  if (node.uid === focusUid) return true;
  return node.children.some((child) => focusInSubtree(child, focusUid));
}

function EditableBlock({ node, focus, selected, handlers, readOnly, fallback,
                         onRequestUpload, viewMode, number, openMenuUid,
                         onOpenMenu }: {
  node: BlockNode; focus: FocusTarget | null;
  selected: ReadonlySet<string>;
  handlers: OutlineHandlers; readOnly: boolean; fallback: boolean;
  /** Click the tree-owned upload input for `uid`, splicing at offset `at`
   * once files are chosen (pkm-gbsb) — see EditableBlockTree for why the
   * input can't live in BlockInput itself. */
  onRequestUpload: (uid: string, at: number) => void;
  viewMode: EffectiveBlockView;
  number: number;
  openMenuUid: string | null;
  onOpenMenu: (uid: string, x: number, y: number,
               viewMode: EffectiveBlockView, trigger: HTMLElement) => void;
}) {
  const focused = !fallback && focus?.uid === node.uid;
  const isSelected = selected.has(node.uid);
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  const quoted = quoteContent(node.text);
  const childrenView = effectiveChildView(node.view_type);
  const tableRows = roamTableRows(node);
  const editingTableSubtree = !fallback && focusInSubtree(node, focus?.uid ?? null);
  const showTable = !editingTableSubtree && tableRows !== null;
  const WrapperTag: "h1" | "h2" | "h3" | "div" = showTable ? "div" : Tag;
  const hidesChildren = hasChildren && node.collapsed && tableRows === null;
  const chevronHasChildren = showTable ? false : hasChildren;
  const chevronClosed = hidesChildren;
  const bulletClosed = hidesChildren;
  return (
    <div className="block">
      <div className={"block-row" + (focused ? " focused" : "")
             + (isSelected ? " selected" : "")}
           data-uid={node.uid}>
        <button
          className={"chevron" + (chevronClosed ? " closed" : "") + (chevronHasChildren ? "" : " hidden")}
          onClick={() => handlers.onToggleCollapsed(node.uid, !node.collapsed)}
          disabled={fallback || readOnly || !chevronHasChildren}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className={"bullet" + (viewMode === "numbered" ? " numbered" : "")
              + (bulletClosed ? " closed" : "")}
              draggable={!fallback && !readOnly}
              onDragStart={(e) => {
                if (fallback) return;
                e.dataTransfer.setData("text/plain", node.uid);
                e.dataTransfer.effectAllowed = "move";
                handlers.onDragStartBlock(node.uid);
              }}
              // Click or right-click opens the block menu (pkm-y6af); plain
              // click included because iPad Safari doesn't fire contextmenu
              // from touch. Drag suppresses click, so DnD is unaffected.
              onClick={(e) => {
                if (!fallback) onOpenMenu(
                  node.uid, e.clientX, e.clientY, childrenView, e.currentTarget,
                );
              }}
              onContextMenu={(e) => {
                if (fallback) return;
                e.preventDefault();
                onOpenMenu(
                  node.uid, e.clientX, e.clientY, childrenView, e.currentTarget,
                );
              }}
              onKeyDown={(e) => {
                if (fallback) return;
                const opens = e.key === "Enter" || e.key === " "
                  || e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
                if (!opens) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                onOpenMenu(
                  node.uid, rect.left, rect.bottom, childrenView, e.currentTarget,
                );
              }}
              role={fallback ? undefined : "button"}
              tabIndex={fallback ? undefined : 0}
              aria-label={fallback ? undefined : "Open block menu"}
              aria-haspopup={fallback ? undefined : "menu"}
              aria-expanded={fallback ? undefined : openMenuUid === node.uid}>
          {viewMode === "numbered" ? `${number}.` : ""}
        </span>
        {focused ? (
          <BlockInput node={node} cursor={focus.cursor} handlers={handlers}
                      readOnly={readOnly} onRequestUpload={onRequestUpload} />
        ) : (
          <WrapperTag className={"block-text" + (quoted !== null ? " quote-block" : "")}
                      onClick={() => {
                        if (!fallback) handlers.onFocusBlock(node.uid, node.text.length);
                      }}>
            {showTable
              ? <RoamTable rows={tableRows!} />
              : <BlockEditContext.Provider
                  value={readOnly || fallback
                    ? null : { toggleTodo: () => handlers.onToggleTodo(node.uid) }}>
                  <InlineSegments segments={tokenizeBlock(quoted ?? node.text)} />
                </BlockEditContext.Provider>}
          </WrapperTag>
        )}
      </div>
      {hasChildren && !showTable && (tableRows !== null || !node.collapsed) && (
        <div className={`block-children ${childrenView}-view`}>
          {node.children.map((c, index) => (
            <EditableBlock key={c.uid} node={c} focus={focus} selected={selected}
                           handlers={handlers} readOnly={readOnly}
                           fallback={fallback} onRequestUpload={onRequestUpload}
                           viewMode={childrenView} number={index + 1}
                           openMenuUid={openMenuUid}
                           onOpenMenu={onOpenMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockInput({ node, cursor, handlers, readOnly, onRequestUpload }: {
  node: BlockNode; cursor: number;
  handlers: OutlineHandlers; readOnly: boolean;
  onRequestUpload: (uid: string, at: number) => void;
}) {
  const headingClass =
    node.heading === 1 ? " heading-1" :
    node.heading === 2 ? " heading-2" :
    node.heading === 3 ? " heading-3" : "";
  const [draft, setDraft] = useState(node.text);
  const [ac, setAc] = useState<AcContext | null>(null);
  const [acSelected, setAcSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // The caret offset to place on mount, captured once: this component is
  // remounted each time focus moves to a new block, so the mount-time
  // `cursor` is the intended initial caret and later prop changes (which
  // don't happen for the focused block) must not re-run the focus effect.
  const initialCursorRef = useRef(cursor);
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  // Whether the user has typed edits not yet committed to the block tree.
  // Focus alone is not a draft: while dirty, remote text still lands on the
  // tree but the textarea keeps the local draft (last-write-wins); with no
  // dirty draft the textarea adopts tree changes. draftRef mirrors `draft`
  // so the adoption effect can read it without re-subscribing on every keystroke.
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Set between compositionstart/end: an IME composition in progress. Remote
  // adoption must not call setDraft mid-composition (it would disturb the
  // native composition UI), so it's deferred and retried on compositionend.
  const composingRef = useRef(false);
  // Caret offset to restore once an adoption's setDraft has committed (see
  // the layout effect below); null when no restore is pending.
  const pendingCaretRef = useRef<number | null>(null);
  // The "/" trigger is served from the static command list, not the titles
  // API, so only fetch titles for ref/tag contexts.
  const options = useTitleOptions(ac && ac.kind !== "command" ? ac.query : null);
  const acRows: AcRow[] = !ac ? [] : ac.kind === "command"
    ? matchSlashCommands(ac.query).map((c) => ({ title: c.label, isNew: false, command: c.name }))
    : buildRows(options, ac.query);

  // Take focus + place the cursor once on mount (this component exists only
  // while its block is the focused one).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const at = Math.min(initialCursorRef.current, el.value.length);
    el.setSelectionRange(at, at);
  }, []);

  // Auto-grow to fit content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Adopt block-tree text changes — a remote update, or our own draft landing
  // after a flush — unless an unflushed local draft should win. node.text
  // matching the draft means our edit committed (or we're already in sync), so
  // the draft is no longer dirty. Deferred while composing (see composingRef);
  // retried from onCompositionEnd below so a remote update that arrived
  // mid-composition still lands once the IME is done.
  const tryAdopt = () => {
    if (node.text === draftRef.current) {
      dirtyRef.current = false;
      return;
    }
    if (dirtyRef.current || composingRef.current) return;
    const el = ref.current;
    if (el && document.activeElement === el) {
      pendingCaretRef.current =
        clampCaret(el.selectionStart ?? 0, node.text.length);
    }
    setDraft(node.text);
  };
  useEffect(tryAdopt, [node.text]);

  // Restore the caret after an adoption's setDraft has committed to the DOM
  // (a plain value swap would otherwise leave the browser's default of
  // moving the caret to the end of the new text).
  useLayoutEffect(() => {
    const at = pendingCaretRef.current;
    if (at === null) return;
    pendingCaretRef.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [draft]);

  const setText = (text: string, cursorPos: number) => {
    dirtyRef.current = true;
    setDraft(text);
    handlers.onDraftChange(node.uid, text);
    // place the cursor after React commits the new value
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(cursorPos, cursorPos);
    });
  };

  // Apply a bracket/link key edit. Unlike a normal keystroke this bypasses
  // onChange (we preventDefault), so we re-derive the autocomplete context here
  // — that's what lets typing "[" twice open the [[ page-link popup.
  // A draft typed with the caret inside an open [[ ref / #tag token is
  // flush-held (pkm-xlah): the debounced autosave would turn the half-typed
  // title into a page. The plain two-arg form is kept when not held.
  const notifyDraft = (text: string, ctx: AcContext | null) => {
    if (holdsDraftFlush(ctx)) handlers.onDraftChange(node.uid, text, true);
    else handlers.onDraftChange(node.uid, text);
  };

  const applyKeyEdit = (r: TextSelection) => {
    dirtyRef.current = true;
    setDraft(r.text);
    setCaret(r.selStart);
    setAcSelected(0);
    const ctx = detectAutocomplete(r.text, r.selStart);
    setAc(ctx);
    notifyDraft(r.text, ctx);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(r.selStart, r.selEnd);
    });
  };

  // Ctrl-O / Ctrl-Shift-O over a [[page reference]] (pkm-a1e4): the target
  // page may not exist server-side yet. A ref only gets-or-created when its
  // block text actually flushes (ops_apply.py, mirroring every ref in the
  // committed text) -- while the caret still sits inside the [[...]] token
  // the draft flush is held (pkm-xlah), so a brand-new reference typed this
  // session has no row at all. POST /api/pages is idempotent (creating an
  // existing page just returns it, routes_pages.create_page) so it's safe
  // to call unconditionally before navigating/opening, the same
  // create-then-go sequence SearchBar's "Create page" row uses. Best-effort:
  // if creation fails (e.g. offline), still navigate/open as before -- the
  // destination view surfaces its own error if the page truly isn't there.
  const ensureRefPageThenOpen = async (title: string, sidebar: boolean) => {
    try {
      await apiFetch("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      // fall through regardless
    }
    if (sidebar) openInSidebar(title);
    else navigate(pagePath(title));
  };

  const pick = (row: AcRow) => {
    if (!ac) return;
    // "/upload": strip the trigger, then open the tree-owned file picker.
    // handlers.onFiles splices the uploaded asset's markdown in once the user
    // has chosen files; the input outlives this component (pkm-gbsb) because
    // choosing a file blurs (and so unmounts) BlockInput.
    if (row.command === "upload") {
      const at = ac.start - 1; // where the "/" was
      setAc(null);
      setAcSelected(0);
      setText(draft.slice(0, at) + draft.slice(caret), at);
      onRequestUpload(node.uid, at);
      return;
    }
    const applied = row.command
      ? applySlashCommand(draft, caret, ac, row.command)
      : applyCompletion(draft, caret, ac, row.title);
    setAc(null);
    setAcSelected(0);
    setText(applied.text, applied.cursor);
    // Heading commands (/h1 /h2 /h3 /normal) aren't text transforms: the
    // trigger is stripped above like any other command, but the heading
    // field itself is set via a dedicated op, dispatched here against the
    // block's current heading so picking the active one toggles it off.
    if (row.command) {
      const heading = resolveHeading(row.command, node.heading);
      if (heading !== undefined) handlers.onSetHeading(node.uid, heading);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const pos = e.target.selectionStart ?? value.length;
    dirtyRef.current = true;
    setDraft(value);
    setCaret(pos);
    setAcSelected(0);
    const ctx = detectAutocomplete(value, pos);
    setAc(ctx);
    notifyDraft(value, ctx);
  };

  // The keydown POLICY lives in the functional core (keyboardPolicy.ts); this
  // shell only reads the live DOM/autocomplete state, then executes the
  // returned semantic decision (preventDefault, blur, navigation, edits).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // Display-line measurement is real layout work, so it's only done for
    // the plain (unmodified) arrow that would actually consult it (pkm-2867)
    // — never for the Shift/Meta/Ctrl chords, which have their own logic,
    // and never for any other key. ArrowUp only needs "first" (measured at
    // selStart, matching the core's own up-check); ArrowDown only needs
    // "last" (at selEnd) — never both, so only one mirror is ever built.
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const caretOnFirstDisplayLine = plain && e.key === "ArrowUp"
      ? measureCaretDisplayLine(el, el.selectionStart)?.first : undefined;
    const caretOnLastDisplayLine = plain && e.key === "ArrowDown"
      ? measureCaretDisplayLine(el, el.selectionEnd)?.last : undefined;
    const decision = decideEditorKey({
      key: e.key, code: e.code,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
      shiftKey: e.shiftKey,
      selStart: el.selectionStart, selEnd: el.selectionEnd,
      draft, readOnly, acRowsLength: acRows.length, acSelected,
      caretOnFirstDisplayLine, caretOnLastDisplayLine,
    });
    switch (decision.type) {
      case "none":
        return;
      case "blur":
        el.blur();
        return;
      case "ac-move":
        e.preventDefault();
        setAcSelected(decision.selected);
        return;
      case "ac-pick":
        e.preventDefault();
        pick(acRows[acSelected]);
        return;
      case "ac-close":
        e.preventDefault();
        setAc(null);
        return;
      case "navigate-ref":
        e.preventDefault();
        void ensureRefPageThenOpen(decision.title, decision.sidebar);
        return;
      case "start-block-selection":
        e.preventDefault();
        handlers.onStartBlockSelection(node.uid, decision.dir);
        return;
      case "select-to-block-edge":
        // Ctrl+Cmd+Left/Right (pkm-am54): the native binding stops at the
        // display line of a wrapped block; we select to the block boundary.
        e.preventDefault();
        if (decision.edge === "start") {
          el.setSelectionRange(0, el.selectionEnd, "backward");
        } else {
          el.setSelectionRange(el.selectionStart, el.value.length, "forward");
        }
        return;
      case "select-whole-block":
        e.preventDefault();
        handlers.onSelectBlock(node.uid);
        return;
      case "set-heading":
        e.preventDefault();
        handlers.onSetHeading(node.uid, decision.heading);
        return;
      case "key-edit":
        e.preventDefault();
        applyKeyEdit(decision.edit);
        return;
      case "split":
        e.preventDefault();
        handlers.onSplit(node.uid, decision.cursor);
        return;
      case "indent":
        e.preventDefault();
        handlers.onIndent(node.uid);
        return;
      case "outdent":
        e.preventDefault();
        handlers.onOutdent(node.uid);
        return;
      case "move-subtree-up":
        // Shift-Cmd-Arrow is a macOS text-selection key and must not extend
        // the textarea's native selection.
        e.preventDefault();
        handlers.onMoveSubtreeUp(node.uid);
        return;
      case "move-subtree-down":
        e.preventDefault();
        handlers.onMoveSubtreeDown(node.uid);
        return;
      case "backspace-at-start":
        e.preventDefault();
        handlers.onBackspaceAtStart(node.uid);
        return;
      case "arrow":
        e.preventDefault();
        handlers.onArrow(node.uid, decision.dir);
        return;
      case "undo":
        e.preventDefault(); // kill native textarea undo
        handlers.onUndo();
        return;
      case "redo":
        e.preventDefault();
        handlers.onRedo();
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
  };

  const onCompositionStart = () => {
    composingRef.current = true;
  };

  const onCompositionEnd = () => {
    composingRef.current = false;
    tryAdopt();
  };

  return (
    <div className="block-input-wrap">
      <textarea ref={ref} className={`block-input${headingClass}`} rows={1}
                value={draft} readOnly={readOnly}
                onChange={onChange} onKeyDown={onKeyDown}
                onBlur={() => handlers.onBlurBlock(node.uid)}
                onPaste={onPaste} onDrop={onDrop}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd} />
      {!readOnly && (
        <AutocompletePopup rows={acRows} selected={acSelected} onPick={pick} />
      )}
    </div>
  );
}
