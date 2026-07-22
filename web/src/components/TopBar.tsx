// pattern: Imperative Shell
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { SidebarContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";
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
  const onPageRoute = pathname.startsWith("/page/");
  const title = onPageRoute ? titleFromPathname(pathname) : null;
  // Context label so the bar reads as one surface, not two orphaned
  // controls (pkm-absu). Doubles as the flex spacer between the left
  // and right button groups.
  const barLabel = title
    ?? (pathname === "/" ? "Daily Notes" : null)
    ?? (pathname === "/current-work" ? "Current Work" : null)
    ?? (pathname === "/help" ? "Help" : null);
  const { openInSidebar } = useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const handleDelete = async () => {
    if (title === null) return;
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    let deleted = true;
    try {
      await apiFetch(`/api/page/${encodeTitle(title)}`, { method: "DELETE" });
    } catch {
      deleted = false;
    }
    setMenuOpen(false);
    if (deleted) navigate("/");
  };

  // Route changes (including away from /page/*) should never leave a stale
  // menu open.
  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
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
              title="Keyboard shortcuts" onClick={() => navigate("/help")}>
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
                <button type="button" role="menuitem"
                        onClick={() => { openInSidebar(title); setMenuOpen(false); }}>
                  Open in sidebar
                </button>
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
    </div>
  );
}
