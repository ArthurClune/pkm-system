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
import { decideSelectionKey } from "../outline/keyboardPolicy";
import { selectedUids, selectionText,
         type BlockSelection } from "../outline/blockSelection";
import { findNode } from "../outline/tree";
import { formatStamp, formatStampTitle, stampBand,
         stampTs } from "../outline/blockStamps";
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
  /** Render the last-changed margin column (bean pkm-4ler). A PROP, never a
   * context read: only PageView passes it, which is exactly what keeps the
   * journal scroll and sidebar panels bare. */
  stamps?: boolean;
}

export function EditableBlockTree({ blocks, focus, selection = null, handlers,
                                    readOnly, fallback = false,
                                    stamps = false }: TreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  // One instant for the whole tree, so two rows a millisecond either side of
  // a band edge can't be tinted inconsistently within a single paint.
  const nowMs = Date.now();
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

  // Like BlockInput's, this keydown only executes: what the key MEANS while a
  // selection is active — including which branches are read-only-gated — is
  // decideSelectionKey's, in the policy core. Anything it doesn't claim is
  // left uncancelled for the platform.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (fallback || !selection) return;
    const decision = decideSelectionKey({
      key: e.key,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
      shiftKey: e.shiftKey,
      readOnly,
    });
    if (decision.type === "none") return;
    e.preventDefault();
    switch (decision.type) {
      case "indent-selection":
        handlers.onIndentSelection();
        return;
      case "outdent-selection":
        handlers.onOutdentSelection();
        return;
      case "move-selection":
        if (decision.dir === "up") handlers.onMoveSelectionUp();
        else handlers.onMoveSelectionDown();
        return;
      case "extend-selection":
        handlers.onExtendBlockSelection(decision.dir);
        return;
      case "copy-selection":
        void navigator.clipboard?.writeText(selectionText(blocks, selection));
        return;
      case "clear-selection":
        handlers.onClearBlockSelection();
        return;
      case "delete-selection":
        handlers.onDeleteBlockSelection();
        return;
      case "focus-selection-head":
        handlers.onFocusBlock(selection.head, 0);
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
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
                       stamps={stamps} nowMs={nowMs}
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

/** The margin cell: always rendered when the column is on, even with no
 * timestamp to show. A missing span would let that row's text claim the
 * gutter and break the column's alignment. */
function BlockStamp({ node, nowMs }: { node: BlockNode; nowMs: number }) {
  const ts = stampTs(node);
  if (ts === null) return <span className="block-stamp" />;
  return (
    <span className={`block-stamp block-stamp-${stampBand(nowMs, ts)}`}
          title={formatStampTitle(ts)}>
      {formatStamp(ts)}
    </span>
  );
}

function EditableBlock({ node, focus, selected, handlers, readOnly, fallback,
                         onRequestUpload, viewMode, number, openMenuUid,
                         stamps, nowMs, onOpenMenu }: {
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
  stamps: boolean;
  nowMs: number;
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
        {stamps && <BlockStamp node={node} nowMs={nowMs} />}
      </div>
      {hasChildren && !showTable && (tableRows !== null || !node.collapsed) && (
        <div className={`block-children ${childrenView}-view`}>
          {node.children.map((c, index) => (
            <EditableBlock key={c.uid} node={c} focus={focus} selected={selected}
                           handlers={handlers} readOnly={readOnly}
                           fallback={fallback} onRequestUpload={onRequestUpload}
                           viewMode={childrenView} number={index + 1}
                           openMenuUid={openMenuUid}
                           stamps={stamps} nowMs={nowMs}
                           onOpenMenu={onOpenMenu} />
          ))}
        </div>
      )}
    </div>
  );
}
