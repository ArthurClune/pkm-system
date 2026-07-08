// pattern: Functional Core
import { useState } from "react";
import type { BlockNode } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

export function Block({ node }: { node: BlockNode }) {
  // node.collapsed seeds the state; toggling is view-only in plan 4
  // (persisting collapse is a plan-5 set_collapsed op).
  const [collapsed, setCollapsed] = useState(node.collapsed);
  const hasChildren = node.children.length > 0;
  const Tag: "h1" | "h2" | "h3" | "div" =
    node.heading === 1 ? "h1" :
    node.heading === 2 ? "h2" :
    node.heading === 3 ? "h3" : "div";
  return (
    <div className="block">
      <div className="block-row">
        <button
          className={"chevron" + (collapsed ? " closed" : "") + (hasChildren ? "" : " hidden")}
          onClick={() => setCollapsed(!collapsed)}
          aria-label="toggle children"
        >
          ▸
        </button>
        <span className="bullet">•</span>
        <Tag className="block-text">
          <InlineSegments segments={tokenizeBlock(node.text)} />
        </Tag>
      </div>
      {hasChildren && !collapsed && (
        <div className="block-children">
          {node.children.map((c) => <Block key={c.uid} node={c} />)}
        </div>
      )}
    </div>
  );
}

export function BlockTree({ blocks }: { blocks: BlockNode[] }) {
  return (
    <div className="block-tree">
      {blocks.map((b) => <Block key={b.uid} node={b} />)}
    </div>
  );
}
