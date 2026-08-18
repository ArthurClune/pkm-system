// pattern: Imperative Shell
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiDelete } from "../api/typedClient";
import { BlockStampsContext, SidebarContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";
import { PAGE_ROUTE_PREFIX, ROUTES, routeMetaFor } from "../routeMeta";
import { useDismiss } from "../useDismiss";
import { useConfirm } from "./ConfirmDialog";
import { HelpCircleIcon, MoreHorizontalIcon, PanelLeftIcon } from "./icons";
import { SearchBar } from "./SearchBar";

/** Menu bar spanning the top of the main pane. Houses the left-nav collapse
 * toggle (leftmost, so it stays put regardless of what else is here), the
 * search bar (self-contained: SearchBar owns query, results dropdown, and
 * the Cmd/Ctrl-U shortcut), and, on /page/* routes, a "…" page menu -- the
 * anchor for page-level actions ("Open in sidebar", "Delete page…"; more
 * land here later). */
export function TopBar({ sidebarCollapsed, onToggleSidebar }: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { pathname } = useLocation();
  const onPageRoute = pathname.startsWith(PAGE_ROUTE_PREFIX);
  const title = onPageRoute ? titleFromPathname(pathname) : null;
  // Context label so the bar reads as one surface, not two orphaned
  // controls (pkm-absu). Doubles as the flex spacer between the left
  // and right button groups. Static routes' labels come from the same
  // table App.tsx's routing and the browser-title effect consume
  // (routeMeta.ts, pkm-77w2), so a newly declared route can't end up
  // labelled here but not there, or vice versa.
  const barLabel = title ?? routeMetaFor(pathname)?.label ?? null;
  const { openInSidebar } = useContext(SidebarContext);
  const { stamps, toggle: toggleStamps } = useContext(BlockStampsContext);
  const [menuOpen, setMenuOpen] = useState(false);
  // Surfaces a failed deletion the same way PageTitle/EditablePage do: a
  // dismissible `.error` paragraph, not a new notification mechanism. Kept
  // separate from menuOpen because the menu closes on both outcomes but the
  // error should only outlive a failure.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();

  const handleDelete = async () => {
    if (title === null) return;
    const ok = await confirm(`Delete "${title}"? This cannot be undone.`,
      { confirmLabel: "Delete", danger: true });
    if (!ok) return;
    // Clear any error from a previous attempt as this one starts, so a
    // retry never leaves a stale message sitting alongside (or instead of)
    // the new outcome.
    setDeleteError(null);
    try {
      await apiDelete("/api/page/{title}", { path: { title } });
    } catch (e) {
      setMenuOpen(false);
      // Matches PageTitle's `setError(String(e))` -- same shape of error,
      // same amount of detail, no second convention to learn.
      setDeleteError(`Couldn't delete "${title}": ${String(e)}`);
      return;
    }
    setMenuOpen(false);
    navigate("/");
  };

  // Route changes (including away from /page/*) should never leave a stale
  // menu -- or a stale deletion error for a page the user has moved past --
  // open/visible.
  useEffect(() => { setMenuOpen(false); setDeleteError(null); }, [pathname]);

  // Escape here does not preventDefault: the confirm dialog this menu opens
  // owns the keystroke while it is up, and the menu closing underneath it is
  // incidental.
  useDismiss(menuRef, () => setMenuOpen(false), { enabled: menuOpen });

  return (
    <>
      <div className="top-bar">
        <button type="button" className="sidebar-toggle-button"
                aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                aria-expanded={!sidebarCollapsed}
                onClick={onToggleSidebar}>
          <PanelLeftIcon />
        </button>
        <span className="top-bar-title">{barLabel}</span>
        <SearchBar />
        <button type="button" className="help-button" aria-label="help"
                title="Keyboard shortcuts" onClick={() => navigate(ROUTES.help)}>
          <HelpCircleIcon />
        </button>
        {title !== null && (
          <div className="top-bar-page-menu" ref={menuRef}>
            <button type="button" className="top-bar-menu-button"
                    aria-label="Page menu" aria-haspopup="menu" aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((o) => !o)}>
              <MoreHorizontalIcon />
            </button>
            {menuOpen && (
              <ul className="top-bar-menu" role="menu">
                <li role="none">
                  {/* A setting, not a destination: flipping it leaves the menu
                      open so the effect is visible behind it and a change of
                      mind is one more click, not four.

                      The label names the action, rather than a checkmark naming
                      the state: BlockMenu's reserved-slot idiom
                      (.block-menu-item-check) indents the label in both states,
                      which in a menu this narrow wrapped "Show timestamps" onto
                      two lines while every sibling item sat flush. A flipped
                      label needs no slot, so all four items share one left edge.
                      Hence role=menuitem, not menuitemcheckbox -- there is no
                      checked state to announce once the text carries it. */}
                  <button type="button" role="menuitem" onClick={toggleStamps}>
                    {stamps ? "Hide timestamps" : "Show timestamps"}
                  </button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem"
                          onClick={() => { openInSidebar(title); setMenuOpen(false); }}>
                    Open in sidebar
                  </button>
                </li>
                <li role="none">
                  {/* Plain download navigation (cookies carry auth) rather than
                      fetch+blob, matching PdfFallbackLink's pattern -- the
                      server sets Content-Disposition: attachment either way,
                      so `download` is a belt-and-suspenders hint. */}
                  <a role="menuitem" href={`/api/export/page/${encodeTitle(title)}`}
                     download onClick={() => setMenuOpen(false)}>
                    Export as Markdown
                  </a>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" onClick={() => void handleDelete()}>
                    Delete page…
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}
        {dialog}
      </div>
      {deleteError !== null && (
        <p className="error upload-error top-bar-error" role="alert">
          {deleteError}
          <button type="button" className="btn-secondary" onClick={() => setDeleteError(null)}>
            Dismiss
          </button>
        </p>
      )}
    </>
  );
}
