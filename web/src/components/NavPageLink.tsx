// pattern: Imperative Shell
// Reads SidebarContext and navigates via react-router's NavLink -- runtime
// React context and navigation, not a pure rendering decision.
import { type ReactNode, useContext } from "react";
import { NavLink } from "react-router-dom";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";

/** A left-nav link to a *page*, carrying the same shift-click contract as
 * PageLink: open in the right-hand sidebar instead of navigating.
 *
 * react-router deliberately ignores modified clicks (shouldProcessLinkClick
 * bails on shiftKey), so without a handler that preventDefaults, the
 * browser's own shift-click wins and opens the whole app in a second window
 * -- which then warns about two copies of the same page being open
 * (pkm-10ah). Nav destinations that aren't pages (Daily Notes, Current Work,
 * Files, Settings) deliberately keep the native behaviour: a SidebarPanel
 * renders a page by title, and there is no page behind those routes. */
export function NavPageLink({ title, className, onNavigate, children }: {
  title: string;
  /** Base class; " active" is appended while the route matches. */
  className: string;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  const { openInSidebar } = useContext(SidebarContext);
  return (
    <NavLink
      to={pagePath(title)}
      className={({ isActive }) => className + (isActive ? " active" : "")}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          openInSidebar(title);
        }
        // Runs either way: on a phone the drawer covers the sidebar it just
        // opened, so it has to close even when we didn't navigate.
        onNavigate?.();
      }}
    >
      {children ?? title}
    </NavLink>
  );
}
