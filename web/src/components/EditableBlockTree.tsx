// pattern: Imperative Shell
// The outliner: the read-side rendering of the block tree, the bullet menu,
// the tree-owned upload input, and the keyboard of a multi-block selection
// (which has no focused textarea to own it). The focused block's live
// textarea is BlockInput.tsx. Every semantic decision is delegated — key
// meanings to outline/keyboardPolicy.ts, mutations to the OutlineHandlers
// port (implemented by useOutline).
import { useEffect, useRef, useState } from "react";
import type { BlockNode } from "../api/payloads";
import type { FocusTarget } from "../outline/edits";
import type { OutlineHandlers } from "../outline/handlers";
import { BlockEditContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { selectedUids, selectionText,
         type BlockSelection } from "../outline/blockSelection";
import { findNode } from "../outline/tree";
import { BlockInput } from "./BlockInput";
import { BlockMenu } from "./BlockMenu";
import { InlineSegments } from "./InlineSegments";
import { RoamTable } from "./roamTable";
import { quoteContent } from "./blockPresentation";
import { effectiveChildView, type EffectiveBlockView } from "./blockView";
import { roamTableRows } from "./roamTableRows";

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
      // Selection CREATION and copying are deliberately read-only-safe
      // (pkm-am54); destroying one is a mutation, so it is gated like the
      // Tab and Shift+Cmd+Arrow branches above. A selection made while
      // editable outlives the switch to read-only (pkm-rckh).
      if (!readOnly) {
        e.preventDefault();
        handlers.onDeleteBlockSelection();
      }
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
