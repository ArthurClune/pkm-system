// pattern: Imperative Shell
// The outliner. Only the focused block is a live textarea (raw markdown);
// everything else renders through the read pipeline. This file owns DOM
// concerns (focus placement, auto-grow, key mapping) and delegates every
// semantic decision to the handlers (useOutline).
import { useEffect, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import type { FocusTarget } from "../outline/edits";
import { BlockEditContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
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
  onToggleTodo(uid: string): void;
  onFiles(uid: string, cursor: number, files: File[]): void;
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
      <div className={"block-row" + (focused ? " focused" : "")}>
        <button
          className={"chevron" + (node.collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => handlers.onToggleCollapsed(node.uid, !node.collapsed)}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className="bullet">•</span>
        {focused ? (
          <BlockInput node={node} cursor={focus.cursor} handlers={handlers}
                      readOnly={readOnly} />
        ) : (
          <Tag className="block-text"
               onClick={() => handlers.onFocusBlock(node.uid, node.text.length)}>
            <BlockEditContext.Provider
                value={{ toggleTodo: () => handlers.onToggleTodo(node.uid) }}>
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
  const ref = useRef<HTMLTextAreaElement | null>(null);

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

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    handlers.onDraftChange(node.uid, e.target.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pos = el.selectionStart;
    const caretOnly = el.selectionStart === el.selectionEnd;
    if (e.key === "Escape") {
      el.blur();
      return;
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

  return (
    <textarea ref={ref} className="block-input" rows={1} value={draft}
              readOnly={readOnly}
              onChange={onChange} onKeyDown={onKeyDown}
              onBlur={() => handlers.onBlurBlock(node.uid)}
              onPaste={onPaste} onDrop={onDrop} />
  );
}
