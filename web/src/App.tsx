// pattern: Imperative Shell
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { MenuIcon } from "./components/icons";
import { NavPageLink } from "./components/NavPageLink";
import { NavRouteLink } from "./components/NavRouteLink";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { UndoRedoKeys } from "./components/UndoRedoKeys";
import { SidebarNav } from "./components/SidebarNav";
import { SidebarPanel } from "./components/SidebarPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { TopBar } from "./components/TopBar";
import { BlockStampsContext, SidebarContext } from "./contexts";
import { DndProvider } from "./dnd/DndContext";
import { ROUTES } from "./routeMeta";
import { SyncProvider } from "./sync/SyncProvider";
import { useBlockStampsPref } from "./useBlockStampsPref";
import { useRouteTitle } from "./useRouteTitle";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
import { CurrentWork } from "./views/CurrentWork";
import { Files } from "./views/Files";
import { Help } from "./views/Help";
import { Journal } from "./views/Journal";
import { PageView } from "./views/PageView";
import { Settings } from "./views/Settings";

interface SidebarEntry {
  id: number; // monotonic: the same title can be stacked twice
  title: string;
  // The block to scroll to and flash within this panel (pkm-gdi5), e.g. a
  // shift-clicked block ref or assistant asset link.
  uid?: string;
}

function NotFound() {
  return (
    <div className="not-found">
      <h1>Page not found</h1>
      <p>No app route matches this address.</p>
      <Link to={ROUTES.journal}>Go to Daily Notes</Link>
    </div>
  );
}

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed();
  const { stamps, toggle: toggleStamps } = useBlockStampsPref();
  const blockStampsApi = useMemo(
    () => ({ stamps, toggle: toggleStamps }), [stamps, toggleStamps]);
  const [stack, setStack] = useState<SidebarEntry[]>([]);
  // Session-only, unlike the left nav's persisted collapse: the panel stack
  // itself resets on reload, so a persisted hidden flag would only ever
  // apply to an empty (invisible) sidebar.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const idRef = useRef(1);
  const appShellRef = useRef<HTMLDivElement>(null);
  const bannerStackRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const navWasOpenRef = useRef(false);
  const navigate = useNavigate();
  useRouteTitle();
  // Governs both whether <aside class="sidebar"> renders (below) and how
  // much room the center pane claims (pkm-57mo): the two must agree, or the
  // pane would stay narrow next to a sidebar that isn't actually there.
  const rightSidebarOpen = stack.length > 0 && !sidebarHidden;

  const sidebarApi = useMemo(() => ({
    openInSidebar: (title: string, uid?: string) => {
      const id = idRef.current;
      idRef.current += 1;
      setStack((s) => [{ id, title, uid }, ...s]); // newest on top
      setSidebarHidden(false); // opening while hidden must not be a silent no-op
    },
  }), []);

  useLayoutEffect(() => {
    const shell = appShellRef.current;
    const bannerStack = bannerStackRef.current;
    if (!shell || !bannerStack) return;

    const updateBannerHeight = () => {
      shell.style.setProperty(
        "--app-banner-height",
        `${bannerStack.getBoundingClientRect().height}px`,
      );
    };
    updateBannerHeight();

    if (typeof ResizeObserver === "undefined") {
      return () => shell.style.removeProperty("--app-banner-height");
    }
    const observer = new ResizeObserver(updateBannerHeight);
    observer.observe(bannerStack);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--app-banner-height");
    };
  }, []);

  // Closing the phone drawer must not leave focus inside it: below 600px the
  // closed nav is visibility:hidden, so a focused link there would strand the
  // keyboard on an invisible element. Hand focus back to the control that
  // opened it (pkm-rwwp). Guarded on the previous state, because every nav
  // link that navigates calls setNavOpen(false) whether or not the drawer was
  // open -- on desktop navOpen is already false and the hamburger is
  // display:none.
  useEffect(() => {
    if (navWasOpenRef.current && !navOpen) hamburgerRef.current?.focus();
    navWasOpenRef.current = navOpen;
  }, [navOpen]);

  // Cmd/Ctrl-U (focus search) lives in SearchBar, next to the input it targets.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Not Ctrl-Cmd-D: macOS reserves that for dictionary lookup and the
      // page never receives the keydown.
      if (e.ctrlKey && e.shiftKey && !e.metaKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        navigate("/");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setSidebarHidden((h) => !h);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAssistantOpen((o) => !o);
      }
      // Not Cmd-T either: the browser owns that for a new tab. Same Ctrl-Shift
      // family as the daily-notes chord above, hence the same !metaKey guard.
      if (e.ctrlKey && e.shiftKey && !e.metaKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleStamps();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, toggleStamps]);

  return (
    <SyncProvider>
      <DndProvider>
        <SidebarContext.Provider value={sidebarApi}>
        <BlockStampsContext.Provider value={blockStampsApi}>
          <div className="app-shell" ref={appShellRef}>
            <div className="app-banner-stack" ref={bannerStackRef}>
              <OfflineIndicator />
            </div>
            <div className={"app"
              + (sidebarCollapsed ? " nav-collapsed" : "")
              + (rightSidebarOpen ? "" : " no-sidebar")}>
              <UndoRedoKeys />
              <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
              <button className="hamburger" aria-label="menu"
                      ref={hamburgerRef}
                      aria-expanded={navOpen} aria-controls="left-nav"
                      onClick={() => setNavOpen((o) => !o)}>
                <MenuIcon />
              </button>
              <nav id="left-nav"
                   className={"left-nav" + (navOpen ? " open" : "") + (sidebarCollapsed ? " collapsed" : "")}>
                <div className="nav-title">pkm</div>
                {/* "primary": always accent-coloured, unlike the pinned pages
                  * below which are muted until active (pkm-nn7o) */}
                <NavRouteLink to={ROUTES.journal} end className="nav-link primary"
                              onNavigate={() => setNavOpen(false)}>
                  Daily Notes
                </NavRouteLink>
                <NavRouteLink to={ROUTES.currentWork} className="nav-link primary"
                              onNavigate={() => setNavOpen(false)}>
                  Current Work
                </NavRouteLink>
                {/* A real page, unlike the routes around it, so shift-click
                  * opens it in the sidebar rather than a second window. */}
                <NavPageLink title="TODO" className="nav-link primary"
                             onNavigate={() => setNavOpen(false)} />
                <ThemeToggle />
                <SidebarNav onNavigate={() => setNavOpen(false)} />
                {/* "nav-section-start": closes off the pinned pages above with
                  * the same rule that opens them, so they read as the user's
                  * own block rather than running on into these links (pkm-usb6) */}
                <button type="button" className="nav-link primary nav-section-start"
                        onClick={() => {
                          setAssistantOpen(true);
                          setNavOpen(false);
                        }}>
                  Assistant
                </button>
                {/* Below the user-editable favourites, but styled "primary"
                  * like Daily Notes/Current Work/TODO above (pkm-eztt). Only
                  * one setting exists today; more are coming, so this link --
                  * not those -- is where they'll live. */}
                <NavRouteLink to={ROUTES.files} className="nav-link primary"
                              onNavigate={() => setNavOpen(false)}>
                  Files
                </NavRouteLink>
                <NavRouteLink to={ROUTES.settings} className="nav-link primary"
                              onNavigate={() => setNavOpen(false)}>
                  Settings
                </NavRouteLink>
              </nav>
              <div className="content-area">
                <TopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
                <main className="main-pane">
                  <Routes>
                    <Route path={ROUTES.journal} element={<Journal />} />
                    <Route path={ROUTES.currentWork} element={<CurrentWork />} />
                    <Route path={ROUTES.page} element={<PageView />} />
                    <Route path={ROUTES.help} element={<Help />} />
                    <Route path={ROUTES.files} element={<Files />} />
                    <Route path={ROUTES.settings} element={<Settings />} />
                    <Route path={ROUTES.notFound} element={<NotFound />} />
                  </Routes>
                </main>
              </div>
              {rightSidebarOpen && (
                <aside className="sidebar">
                  {stack.map((entry) => (
                    <SidebarPanel
                      key={entry.id}
                      title={entry.title}
                      uid={entry.uid}
                      onClose={() => setStack((s) => s.filter((e) => e.id !== entry.id))}
                    />
                  ))}
                </aside>
              )}
            </div>
          </div>
        </BlockStampsContext.Provider>
        </SidebarContext.Provider>
      </DndProvider>
    </SyncProvider>
  );
}
