// pattern: Imperative Shell
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { SidebarContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";

/** Menu bar spanning the top of the main pane. Houses the search entry point
 * (opens SearchModal, which App still owns) and, on /page/* routes, a "…"
 * page menu -- the anchor for page-level actions ("Open in sidebar", "Delete
 * page…"; more land here later). */
export function TopBar({ onSearchClick }: { onSearchClick: () => void }) {
  const { pathname } = useLocation();
  const onPageRoute = pathname.startsWith("/page/");
  const title = onPageRoute ? titleFromPathname(pathname) : null;
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
      <button type="button" className="top-bar-search-button" onClick={onSearchClick}>
        Search
      </button>
      {title !== null && (
        <div className="top-bar-page-menu" ref={menuRef}>
          <button type="button" className="top-bar-menu-button"
                  aria-label="Page menu" aria-haspopup="menu" aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}>
            …
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
