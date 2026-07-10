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
import { refTitleAtCaret } from "../outline/refAtCaret";
import { applySlashCommand, matchSlashCommands,
         resolveHeading } from "../outline/slashCommands";
import { pagePath } from "../paths";
import { AutocompletePopup, buildRows, useTitleOptions,
         type AcRow } from "./AutocompletePopup";
import { InlineSegments } from "./InlineSegments";

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
  onBackspaceAtStart(uid: string): void;
  onArrow(uid: string, dir: "up" | "down" | "left" | "right"): void;
  onToggleCollapsed(uid: string, collapsed: boolean): void;
  onSetHeading(uid: string, heading: number | null): void;
  onToggleTodo(uid: string): void;
  onFiles(uid: string, cursor: number, files: File[]): void;
  onDragStartBlock(uid: string): void;
}

interface TreeProps {
  blocks: BlockNode[];
  focus: FocusTarget | null;
  handlers: OutlineHandlers;
  readOnly: boolean;
}

export function EditableBlockTree({ blocks, focus, handlers, readOnly }: TreeProps) {
  return (
    <div className="block-tree">
      {blocks.map((b) => (
        <EditableBlock key={b.uid} node={b} focus={focus} handlers={handlers}
                       readOnly={readOnly} />
      ))}
    </div>
  );
}

function EditableBlock({ node, focus, handlers, readOnly }: {
  node: BlockNode; focus: FocusTarget | null;
  handlers: OutlineHandlers; readOnly: boolean;
}) {
  const focused = focus?.uid === node.uid;
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  return (
    <div className="block">
      <div className={"block-row" + (focused ? " focused" : "")}
           data-uid={node.uid}>
        <button
          className={"chevron" + (node.collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => handlers.onToggleCollapsed(node.uid, !node.collapsed)}
          disabled={readOnly || !hasChildren}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className="bullet" draggable={!readOnly}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", node.uid);
                e.dataTransfer.effectAllowed = "move";
                handlers.onDragStartBlock(node.uid);
              }}>
          •
        </span>
        {focused ? (
          <BlockInput node={node} cursor={focus.cursor} handlers={handlers}
                      readOnly={readOnly} />
        ) : (
          <Tag className="block-text"
               onClick={() => handlers.onFocusBlock(node.uid, node.text.length)}>
            <BlockEditContext.Provider
                value={readOnly ? null : { toggleTodo: () => handlers.onToggleTodo(node.uid) }}>
              <InlineSegments segments={tokenizeBlock(node.text)} />
            </BlockEditContext.Provider>
          </Tag>
        )}
      </div>
      {hasChildren && !node.collapsed && (
        <div className="block-children">
          {node.children.map((c) => (
            <EditableBlock key={c.uid} node={c} focus={focus} handlers={handlers}
                           readOnly={readOnly} />
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
    const at = Math.min(cursor, el.value.length);
    el.setSelectionRange(at, at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const pick = (row: AcRow) => {
    if (!ac) return;
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pos = el.selectionStart;
    const caretOnly = el.selectionStart === el.selectionEnd;
    if (acRows.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcSelected((s) => Math.min(s + 1, acRows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(acRows[acSelected]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        return;
      }
    }
    if (e.key === "Escape") {
      el.blur();
      return;
    }
    // Roam/Logseq: Ctrl-O with the caret inside a [[page reference]] opens
    // that page. macOS browsers use Cmd-O for file-open (no clash); on
    // Windows/Linux Ctrl-O is browser open-file, but we only steal it when
    // the caret is actually inside a ref, so the key is left alone otherwise.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "o") {
      const title = refTitleAtCaret(draft, pos);
      if (title) {
        e.preventDefault();
        navigate(pagePath(title));
        return;
      }
    }
    if (readOnly) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlers.onSplit(node.uid, pos);
    } else if (e.key === "Tab") {
      e.preventDefault();
      (e.shiftKey ? handlers.onOutdent : handlers.onIndent)(node.uid);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      (e.key === "ArrowUp" ? handlers.onMoveUp : handlers.onMoveDown)(node.uid);
    } else if (e.key === "Backspace" && pos === 0 && caretOnly) {
      e.preventDefault();
      handlers.onBackspaceAtStart(node.uid);
    } else if (e.key === "ArrowUp" && !draft.slice(0, pos).includes("\n")) {
      e.preventDefault();
      handlers.onArrow(node.uid, "up");
    } else if (e.key === "ArrowDown" && !draft.slice(el.selectionEnd).includes("\n")) {
      e.preventDefault();
      handlers.onArrow(node.uid, "down");
    } else if (e.key === "ArrowLeft" && pos === 0 && caretOnly) {
      e.preventDefault();
      handlers.onArrow(node.uid, "left");
    } else if (e.key === "ArrowRight" && pos === draft.length && caretOnly) {
      e.preventDefault();
      handlers.onArrow(node.uid, "right");
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
    </div>
  );
}
