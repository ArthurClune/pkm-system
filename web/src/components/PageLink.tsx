// pattern: Imperative Shell
// Reads SidebarContext and navigates via react-router's Link/shift-click --
// runtime React context and navigation, not a pure rendering decision.
import { useContext } from "react";
import { Link } from "react-router-dom";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";
import { pageNamespace } from "./pageNamespace";

export function PageLink({ title, tag }: { title: string; tag: boolean }) {
  const { openInSidebar } = useContext(SidebarContext);
  return (
    <Link
      to={pagePath(title)}
      className={tag ? "tag" : "page-link"}
      // tags are chips with their own colour; only prose links take the
      // per-tree colour (see the data-ns rules in styles.css)
      data-ns={tag ? undefined : pageNamespace(title)}
      onClick={(e) => {
        // Stop the click from bubbling to the enclosing block's
        // click-to-edit handler (EditableBlockTree) — a link click should
        // navigate/open-in-sidebar, never flip the block into edit mode.
        e.stopPropagation();
        if (e.shiftKey) {
          e.preventDefault();
          openInSidebar(title);
        }
      }}
    >
      {tag ? `#${title}` : title}
    </Link>
  );
}
