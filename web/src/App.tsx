// pattern: Imperative Shell
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { MenuIcon } from "./components/icons";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { UndoRedoKeys } from "./components/UndoRedoKeys";
import { SidebarNav } from "./components/SidebarNav";
import { SidebarPanel } from "./components/SidebarPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { TopBar } from "./components/TopBar";
import { SidebarContext } from "./contexts";
import { DndProvider } from "./dnd/DndContext";
import { SyncProvider } from "./sync/SyncProvider";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
import { CurrentWork } from "./views/CurrentWork";
import { Help } from "./views/Help";
import { Journal } from "./views/Journal";
import { PageView } from "./views/PageView";

interface SidebarEntry {
  id: number; // monotonic: the same title can be stacked twice
  title: string;
}

function NotFound() {
  return (
    <div className="not-found">
      <h1>Page not found</h1>
      <p>No app route matches this address.</p>
      <Link to="/">Go to Daily Notes</Link>
    </div>
  );
}

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed();
  const [stack, setStack] = useState<SidebarEntry[]>([]);
  // Session-only, unlike the left nav's persisted collapse: the panel stack
  // itself resets on reload, so a persisted hidden flag would only ever
  // apply to an empty (invisible) sidebar.
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const idRef = useRef(1);
  const appShellRef = useRef<HTMLDivElement>(null);
  const bannerStackRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const sidebarApi = useMemo(() => ({
    openInSidebar: (title: string) => {
      const id = idRef.current;
      idRef.current += 1;
      setStack((s) => [{ id, title }, ...s]); // newest on top
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  return (
    <SyncProvider>
      <DndProvider>
        <SidebarContext.Provider value={sidebarApi}>
          <div className="app-shell" ref={appShellRef}>
            <div className="app-banner-stack" ref={bannerStackRef}>
              <OfflineIndicator />
            </div>
            <div className="app">
              <UndoRedoKeys />
              <button className="hamburger" aria-label="menu"
                      onClick={() => setNavOpen((o) => !o)}>
                <MenuIcon />
              </button>
              <nav className={"left-nav" + (navOpen ? " open" : "") + (sidebarCollapsed ? " collapsed" : "")}>
                <div className="nav-title">pkm</div>
                {/* "primary": always accent-coloured, unlike the pinned pages
                  * below which are muted until active (pkm-nn7o) */}
                <NavLink to="/" end onClick={() => setNavOpen(false)}
                         className={({ isActive }) => "nav-link primary" + (isActive ? " active" : "")}>
                  Daily Notes
                </NavLink>
                <NavLink to="/current-work" onClick={() => setNavOpen(false)}
                         className={({ isActive }) => "nav-link primary" + (isActive ? " active" : "")}>
                  Current Work
                </NavLink>
                <ThemeToggle />
                <SidebarNav onNavigate={() => setNavOpen(false)} />
              </nav>
              <div className="content-area">
                <TopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
                <main className="main-pane">
                  <Routes>
                    <Route path="/" element={<Journal />} />
                    <Route path="/current-work" element={<CurrentWork />} />
                    <Route path="/page/*" element={<PageView />} />
                    <Route path="/help" element={<Help />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </main>
              </div>
              {stack.length > 0 && !sidebarHidden && (
                <aside className="sidebar">
                  {stack.map((entry) => (
                    <SidebarPanel
                      key={entry.id}
                      title={entry.title}
                      onClose={() => setStack((s) => s.filter((e) => e.id !== entry.id))}
                    />
                  ))}
                </aside>
              )}
            </div>
          </div>
        </SidebarContext.Provider>
      </DndProvider>
    </SyncProvider>
  );
}
