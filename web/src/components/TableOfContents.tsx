// pattern: Imperative Shell
// Renders what tocEntries derived: a nested list of links to #<uid>. The
// links do no scrolling of their own -- the hash is picked up by the page's
// useScrollFlashTarget, which scrolls the block into view and flashes it,
// exactly as an incoming ((uid)) link does.
import { useContext } from "react";
import { Link } from "react-router-dom";
import { RootBlocksContext } from "../contexts";
import { tocEntries, type TocEntry } from "./tocEntries";

function TocItems({ entries }: { entries: TocEntry[] }) {
  return (
    <ol className="toc-list">
      {entries.map((entry) => (
        <li key={entry.uid} className={`toc-item toc-level-${entry.level}`}>
          <Link to={`#${entry.uid}`} className="toc-link"
                // The enclosing block row turns into a textarea when clicked
                // (EditableBlockTree); a click on an entry must navigate
                // instead, so it never reaches that handler.
                onClick={(e) => e.stopPropagation()}>
            {entry.text}
          </Link>
          {entry.children.length > 0 && <TocItems entries={entry.children} />}
        </li>
      ))}
    </ol>
  );
}

export function TableOfContents({ entries }: { entries: TocEntry[] }) {
  return (
    <nav className="toc" aria-label="Table of contents">
      <div className="toc-header">Table of Contents</div>
      {entries.length === 0
        ? <div className="toc-empty">no headings on this page</div>
        : <TocItems entries={entries} />}
    </nav>
  );
}

/** The toc block's own render: the walk needs the whole page tree, which a
 * memoised row never sees, so it comes from the tree-root context. Only this
 * branch reads it, which is what keeps every other row's memo intact. */
export function TocBlock({ selfUid }: { selfUid: string }) {
  const blocks = useContext(RootBlocksContext);
  return <TableOfContents entries={tocEntries(blocks, selfUid)} />;
}
