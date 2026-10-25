// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, OfflineError, apiDownload } from "../api/client";
import type { RawTitle } from "../api/brands";
import { apiDelete, apiGet } from "../api/typedClient";
import { BlockStampsContext, SidebarContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";
import { PAGE_ROUTE_PREFIX, ROUTES, routeMetaFor } from "../routeMeta";
import { useDismiss } from "../useDismiss";
import { useConfirm } from "./ConfirmDialog";
import { DeleteBlockedDialog } from "./DeleteBlockedDialog";
import {
  blockedHeading, deleteConfirmMessage, plainDeleteMessage, type DeleteBlocker,
  type DeletePreview,
} from "./deletePageCopy";
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
  // controls. Doubles as the flex spacer between the left
  // and right button groups. Static routes' labels come from the same
  // table App.tsx's routing and the browser-title effect consume
  // (routeMeta.ts), so a newly declared route can't end up
  // labelled here but not there, or vice versa.
  const barLabel = title ?? routeMetaFor(pathname)?.label ?? null;
  const { openInSidebar } = useContext(SidebarContext);
  const { stamps, toggle: toggleStamps } = useContext(BlockStampsContext);
  const [menuOpen, setMenuOpen] = useState(false);
  // Surfaces a failed deletion or export the same way PageTitle/EditablePage
  // do: a dismissible `.error` paragraph, not a new notification mechanism.
  // Kept separate from menuOpen because the menu closes on both outcomes but
  // the error should only outlive a failure.
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();

  // Blockers (blocks whose unlinking would break them) shown in place of the
  // confirmation; the server enforces them too, so this is only the readable
  // version of a refusal.
  const [blockers, setBlockers] = useState<DeleteBlocker[] | null>(null);
  const closeBlocked = useCallback(() => setBlockers(null), []);

  const fetchPreview = async (t: RawTitle): Promise<DeletePreview | null> => {
    try {
      return await apiGet("/api/delete-preview", { query: { title: t } });
    } catch {
      return null;
    }
  };

  const handleDelete = async () => {
    if (title === null) return;
    const preview = await fetchPreview(title);
    if (preview !== null && preview.blockers.length > 0) {
      setMenuOpen(false);
      setBlockers(preview.blockers);
      return;
    }
    const message = preview === null
      ? plainDeleteMessage(title) : deleteConfirmMessage(title, preview);
    const ok = await confirm(message, { confirmLabel: "Delete", danger: true });
    if (!ok) return;
    // Clear any error from a previous attempt as this one starts, so a
    // retry never leaves a stale message sitting alongside (or instead of)
    // the new outcome.
    setMenuError(null);
    try {
      await apiDelete("/api/page/{title}", { path: { title } });
    } catch (e) {
      setMenuOpen(false);
      // A 409 means blockers appeared after the preview; show them from a
      // fresh preview rather than parsing the refusal.
      if (e instanceof ApiError && e.status === 409) {
        const fresh = await fetchPreview(title);
        if (fresh !== null && fresh.blockers.length > 0) {
          setBlockers(fresh.blockers);
          return;
        }
      }
      // Matches PageTitle's `setError(String(e))` -- same shape of error,
      // same amount of detail, no second convention to learn.
      setMenuError(`Couldn't delete "${title}": ${String(e)}`);
      return;
    }
    setMenuOpen(false);
    navigate("/");
  };

  // The page the bar shows now, so a slow export that settles after the user
  // has navigated away neither downloads nor reports against the new route.
  const titleRef = useRef(title);
  titleRef.current = title;

  const handleExport = async () => {
    if (title === null) return;
    setMenuOpen(false);
    setMenuError(null);
    try {
      const { blob, filename } = await apiDownload(
        `/api/export/page/${encodeTitle(title)}`);
      if (titleRef.current !== title) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? `${title}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Safari may still be reading the blob well after the click returns
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      if (titleRef.current !== title) return;
      // ApiError's message prefixes "request failed: 422 path:", which is
      // noise to a user; the server's detail is the reason. An offline or
      // network failure has no detail, so it gets its own plain copy.
      const reason = e instanceof ApiError && e.detail ? e.detail
        : e instanceof OfflineError ? e.message
        : e instanceof TypeError ? "couldn't reach the server"
        : String(e);
      setMenuError(`Couldn't export "${title}": ${reason}`);
    }
  };

  // Route changes (including away from /page/*) should never leave a stale
  // menu -- or a stale deletion error for a page the user has moved past --
  // open/visible.
  useEffect(() => { setMenuOpen(false); setMenuError(null); setBlockers(null); }, [pathname]);

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
                      label needs no slot, so all four items share one left
                      edge. Hence role=menuitem, not menuitemcheckbox -- there
                      is no checked state to announce once the text carries
                      it. */}
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
                  {/* A fetch, not a download link: a refused export must show
                      its reason, which a navigation cannot. */}
                  <button type="button" role="menuitem" onClick={() => void handleExport()}>
                    Export as Markdown
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
        {dialog}
        {blockers !== null && title !== null && (
          <DeleteBlockedDialog heading={blockedHeading(title)} blockers={blockers}
                               onClose={closeBlocked} />
        )}
      </div>
      {menuError !== null && (
        <p className="error upload-error top-bar-error" role="alert">
          {menuError}
          <button type="button" className="btn-secondary" onClick={() => setMenuError(null)}>
            Dismiss
          </button>
        </p>
      )}
    </>
  );
}
