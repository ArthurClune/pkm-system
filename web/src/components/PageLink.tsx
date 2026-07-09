// pattern: Functional Core
import { useContext } from "react";
import { Link } from "react-router-dom";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";

export function PageLink({ title, tag }: { title: string; tag: boolean }) {
  const { openInSidebar } = useContext(SidebarContext);
  return (
    <Link
      to={pagePath(title)}
      className={tag ? "tag" : "page-link"}
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
