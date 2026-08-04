// pattern: Imperative Shell
// Navigates via react-router's NavLink -- runtime navigation, not a pure
// rendering decision.
import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";

/** A left-nav link to a route that *isn't* a page — Daily Notes, Current
 * Work, Files, Settings. `NavPageLink` is the counterpart for the ones that
 * name a page.
 *
 * Shift-click is trapped and does nothing at all. react-router ignores
 * modified clicks (`shouldProcessLinkClick` bails on `shiftKey`), so an
 * untrapped shift-click falls through to the browser, which opens the whole
 * app in a second window — two live copies of the same page, which the sync
 * layer then warns about (pkm-10ah). Unlike NavPageLink there is nothing
 * better to offer in its place: a `SidebarPanel` renders a page *by title*,
 * and no page sits behind these routes. So the click is swallowed and the app
 * is left exactly as it was — same route, and `onNavigate` deliberately
 * unfired, so a phone drawer stays open rather than closing onto nothing. */
export function NavRouteLink({ to, end, className, onNavigate, children }: {
  to: string;
  /** react-router's exact-match flag; "/" needs it or every route is active. */
  end?: boolean;
  /** Base class; " active" is appended while the route matches. */
  className: string;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => className + (isActive ? " active" : "")}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          return;
        }
        onNavigate?.();
      }}
    >
      {children}
    </NavLink>
  );
}
