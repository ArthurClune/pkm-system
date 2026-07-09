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
