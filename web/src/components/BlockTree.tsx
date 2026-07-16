// pattern: Imperative Shell
// A read-only outline renderer: no draggable bullets, no drop zone. Used for
// the same-title-active-elsewhere fallback in EditablePage, which is
// deliberately excluded from block drag-and-drop (see EditablePage).
import { useState } from "react";
import type { BlockNode } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { quoteContent } from "./blockPresentation";
import { effectiveChildView, type EffectiveBlockView } from "./blockView";

export function Block({ node, viewMode = "document", number = 1 }: {
  node: BlockNode;
  viewMode?: EffectiveBlockView;
  number?: number;
}) {
  // node.collapsed seeds the state; toggling is view-only in plan 4
  // (persisting collapse is a plan-5 set_collapsed op). `blocks` can be
  // replaced with a new array/object for the same uid across renders (e.g.
  // a sibling edit, or another editor's own toggle arriving over the
  // socket) without the value actually changing, so a real transition is
  // detected by comparing values, not identity: prevAuthoritative tracks
  // the last authoritative value we've adopted, and only a genuine change
  // from it overrides the local (possibly user-toggled) view state. This is
  // React's documented "adjusting state during render" pattern, applied
  // during render so there's no extra commit/flash before it takes effect.
  const [prevAuthoritative, setPrevAuthoritative] = useState(node.collapsed);
  const [collapsed, setCollapsed] = useState(node.collapsed);
  if (node.collapsed !== prevAuthoritative) {
    setPrevAuthoritative(node.collapsed);
    setCollapsed(node.collapsed);
  }
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  const quoted = quoteContent(node.text);
  const childrenView = effectiveChildView(node.view_type);
  return (
    <div className="block">
      <div className="block-row" data-uid={node.uid}>
        <button
          className={"chevron" + (collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => setCollapsed(!collapsed)}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span
          className={"bullet" + (viewMode === "numbered" ? " numbered" : "")
            + (hasChildren && collapsed ? " closed" : "")}
          aria-hidden="true"
        >
          {viewMode === "numbered" ? `${number}.` : ""}
        </span>
        <Tag className={"block-text" + (quoted !== null ? " quote-block" : "")}>
          <InlineSegments segments={tokenizeBlock(quoted ?? node.text)} />
        </Tag>
      </div>
      {hasChildren && !collapsed && (
        <div className={`block-children ${childrenView}-view`}>
          {node.children.map((c, index) => (
            <Block key={c.uid} node={c} viewMode={childrenView} number={index + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BlockTree({ blocks }: { blocks: BlockNode[] }) {
  return (
    <div className="block-tree">
      {blocks.map((b, index) => (
        <Block key={b.uid} node={b} viewMode="document" number={index + 1} />
      ))}
    </div>
  );
}
