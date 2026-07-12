// pattern: Functional Core
import { useContext, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { BlockRefContext, BlockRefRequestContext,
         SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { pagePath } from "../paths";
import { InlineSegments } from "./InlineSegments";

// Mutually-referencing blocks in the same payload could otherwise recurse
// forever (A's text embeds B's, whose text embeds A's, ...).
const MAX_DEPTH = 3;

export function BlockRef({ uid, depth }: { uid: string; depth: number }) {
  const refTexts = useContext(BlockRefContext);
  const requestRef = useContext(BlockRefRequestContext);
  const { openInSidebar } = useContext(SidebarContext);
  const navigate = useNavigate();
  const resolved = refTexts[uid];
  // A uid missing from the map may have been pasted after the payload
  // loaded: ask the provider (if any) to fetch it.
  useEffect(() => {
    if (!resolved) requestRef(uid);
  }, [resolved, requestRef, uid]);
  if (!resolved || depth >= MAX_DEPTH) {
    return <span className="block-ref unresolved">(({uid}))</span>;
  }
  // Navigate to the page holding the target block; PageView scrolls to the
  // uid in the hash. Shift-click opens in the sidebar (same as PageLink).
  const go = (e: { shiftKey: boolean }) => {
    if (e.shiftKey) openInSidebar(resolved.page_title);
    else navigate(`${pagePath(resolved.page_title)}#${uid}`);
  };
  return (
    <span className="block-ref" role="link" tabIndex={0}
          title={`from ${resolved.page_title}`}
          onClick={(e) => {
            // Never bubble to the enclosing block's click-to-edit handler,
            // and leave clicks on nested anchors (plain markdown links —
            // PageLink already stops its own propagation) to the anchor.
            e.stopPropagation();
            if ((e.target as Element).closest("a")) return;
            go(e);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target === e.currentTarget) {
              e.preventDefault();
              go(e);
            }
          }}>
      <InlineSegments segments={tokenizeBlock(resolved.text)} depth={depth + 1} />
    </span>
  );
}
