// pattern: Imperative Shell
// The outliner. Only the focused block is a live textarea (raw markdown);
// everything else renders through the read pipeline. This file owns DOM
// concerns (focus placement, auto-grow, key mapping) and delegates every
// semantic decision to the handlers (useOutline).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { BlockNode } from "../api/payloads";
import { clampCaret, type FocusTarget } from "../outline/edits";
import { BlockEditContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { applyCompletion, detectAutocomplete,
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
import { quoteContent } from "./blockPresentation";
import { effectiveChildView, type EffectiveBlockView } from "./blockView";

export interface OutlineHandlers {
  onFocusBlock(uid: string, cursor: number): void;
  /** Blur reports WHICH block blurred: when a structural op has already
   * moved focus elsewhere, the old textarea's unmount-blur arrives late and
   * must not clear the new focus (the hook checks the uid). */
  onBlurBlock(uid: string): void;
  onDraftChange(uid: string, text: string): void;
  onSplit(uid: string, cursor: number): void;
  onIndent(uid: string): void;
  onOutdent(uid: string): void;
  onMoveUp(uid: string): void;
  onMoveDown(uid: string): void;
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
  onExtendBlockSelection(dir: "up" | "down"): void;
  onClearBlockSelection(): void;
  /** Alt+Arrow while a block selection is active: move every selected block
   * as a group, preserving their relative order (pkm-q89w). */
  onMoveSelectionUp(): void;
  onMoveSelectionDown(): void;
  /** Backspace/Delete while a block selection is active: delete every
   * selected block as a set (pkm-q89w). */
  onDeleteBlockSelection(): void;
  onDragStartBlock(uid: string): void;
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
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      handlers.onExtendBlockSelection(e.key === "ArrowUp" ? "up" : "down");
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void navigator.clipboard?.writeText(selectionText(blocks, selection));
    } else if (e.key === "Escape") {
      e.preventDefault();
      handlers.onClearBlockSelection();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (e.key === "ArrowUp") handlers.onMoveSelectionUp();
      else handlers.onMoveSelectionDown();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handlers.onDeleteBlockSelection();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // a plain arrow collapses the selection back to editing the head block
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
                       fallback={fallback}
                       viewMode="document" number={index + 1}
                       openMenuUid={menu?.uid ?? null}
                       onOpenMenu={(uid, x, y, viewMode, trigger) =>
                         setMenu({ uid, x, y, viewMode, trigger })} />
      ))}
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

function EditableBlock({ node, focus, selected, handlers, readOnly, fallback,
                         viewMode, number, openMenuUid, onOpenMenu }: {
  node: BlockNode; focus: FocusTarget | null;
  selected: ReadonlySet<string>;
  handlers: OutlineHandlers; readOnly: boolean; fallback: boolean;
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
  return (
    <div className="block">
      <div className={"block-row" + (focused ? " focused" : "")
             + (isSelected ? " selected" : "")}
           data-uid={node.uid}>
        <button
          className={"chevron" + (node.collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => handlers.onToggleCollapsed(node.uid, !node.collapsed)}
          disabled={fallback || readOnly || !hasChildren}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className={"bullet" + (viewMode === "numbered" ? " numbered" : "")
              + (hasChildren && node.collapsed ? " closed" : "")}
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
                      readOnly={readOnly} />
        ) : (
          <Tag className={"block-text" + (quoted !== null ? " quote-block" : "")}
               onClick={() => {
                 if (!fallback) handlers.onFocusBlock(node.uid, node.text.length);
               }}>
            <BlockEditContext.Provider
                value={readOnly || fallback
                  ? null : { toggleTodo: () => handlers.onToggleTodo(node.uid) }}>
              <InlineSegments segments={tokenizeBlock(quoted ?? node.text)} />
            </BlockEditContext.Provider>
          </Tag>
        )}
      </div>
      {hasChildren && !node.collapsed && (
        <div className={`block-children ${childrenView}-view`}>
          {node.children.map((c, index) => (
            <EditableBlock key={c.uid} node={c} focus={focus} selected={selected}
                           handlers={handlers} readOnly={readOnly}
                           fallback={fallback}
                           viewMode={childrenView} number={index + 1}
                           openMenuUid={openMenuUid}
                           onOpenMenu={onOpenMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockInput({ node, cursor, handlers, readOnly }: {
  node: BlockNode; cursor: number;
  handlers: OutlineHandlers; readOnly: boolean;
}) {
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
  // The /upload file picker, and the caret offset the trigger was stripped at
  // (where the asset markdown should be spliced once files are chosen).
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAtRef = useRef(0);
  const navigate = useNavigate();
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
  const applyKeyEdit = (r: TextSelection) => {
    dirtyRef.current = true;
    setDraft(r.text);
    setCaret(r.selStart);
    setAcSelected(0);
    setAc(detectAutocomplete(r.text, r.selStart));
    handlers.onDraftChange(node.uid, r.text);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(r.selStart, r.selEnd);
    });
  };

  const pick = (row: AcRow) => {
    if (!ac) return;
    // "/upload": strip the trigger, then open a file picker. onPickUpload
    // splices the uploaded asset's markdown in (via handlers.onFiles) once the
    // user has chosen files.
    if (row.command === "upload") {
      const at = ac.start - 1; // where the "/" was
      setAc(null);
      setAcSelected(0);
      setText(draft.slice(0, at) + draft.slice(caret), at);
      uploadAtRef.current = at;
      fileInputRef.current?.click();
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
    setAc(detectAutocomplete(value, pos));
    handlers.onDraftChange(node.uid, value);
  };

  // The keydown POLICY lives in the functional core (keyboardPolicy.ts); this
  // shell only reads the live DOM/autocomplete state, then executes the
  // returned semantic decision (preventDefault, blur, navigation, edits).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const decision = decideEditorKey({
      key: e.key, code: e.code,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
      shiftKey: e.shiftKey,
      selStart: el.selectionStart, selEnd: el.selectionEnd,
      draft, readOnly, acRowsLength: acRows.length, acSelected,
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
        navigate(pagePath(decision.title));
        return;
      case "start-block-selection":
        e.preventDefault();
        handlers.onStartBlockSelection(node.uid, decision.dir);
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
      case "move-up":
        e.preventDefault();
        handlers.onMoveUp(node.uid);
        return;
      case "move-down":
        e.preventDefault();
        handlers.onMoveDown(node.uid);
        return;
      case "move-subtree-up":
        // preventDefault matters here more than for move-up: Shift-Cmd-Arrow
        // is a macOS text-selection key and must not extend the textarea's
        // native selection.
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
        e.preventDefault();
        // TODO (Task 6): add handler for undo
        return;
      case "redo":
        e.preventDefault();
        // TODO (Task 6): add handler for redo
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

  const onPickUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // let the same file be picked again later
    if (files.length === 0 || readOnly) return;
    handlers.onFiles(node.uid, uploadAtRef.current, files);
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
      <textarea ref={ref} className="block-input" rows={1} value={draft}
                readOnly={readOnly}
                onChange={onChange} onKeyDown={onKeyDown}
                onBlur={() => handlers.onBlurBlock(node.uid)}
                onPaste={onPaste} onDrop={onDrop}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd} />
      {!readOnly && (
        <AutocompletePopup rows={acRows} selected={acSelected} onPick={pick} />
      )}
      {!readOnly && (
        <input ref={fileInputRef} type="file" multiple
               className="upload-input" aria-label="Upload file"
               accept={"image/*,application/pdf,text/plain,text/markdown,"
                 + "text/csv,application/json,.doc,.docx,.xls,.xlsx,.ppt,.pptx"}
               onChange={onPickUpload} />
      )}
    </div>
  );
}
