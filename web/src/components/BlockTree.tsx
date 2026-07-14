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
  // (persisting collapse is a plan-5 set_collapsed op).
  const [collapsed, setCollapsed] = useState(node.collapsed);
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
