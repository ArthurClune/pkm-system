// pattern: Functional Core
import { useContext, useEffect } from "react";
import { BlockRefContext, BlockRefRequestContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

// Mutually-referencing blocks in the same payload could otherwise recurse
// forever (A's text embeds B's, whose text embeds A's, ...).
const MAX_DEPTH = 3;

export function BlockRef({ uid, depth }: { uid: string; depth: number }) {
  const refTexts = useContext(BlockRefContext);
  const requestRef = useContext(BlockRefRequestContext);
  const resolved = refTexts[uid];
  // A uid missing from the map may have been pasted after the payload
  // loaded: ask the provider (if any) to fetch it.
  useEffect(() => {
    if (!resolved) requestRef(uid);
  }, [resolved, requestRef, uid]);
  if (!resolved || depth >= MAX_DEPTH) {
    return <span className="block-ref unresolved">(({uid}))</span>;
  }
  return (
    <span className="block-ref" title={`from ${resolved.page_title}`}>
      <InlineSegments segments={tokenizeBlock(resolved.text)} depth={depth + 1} />
    </span>
  );
}
