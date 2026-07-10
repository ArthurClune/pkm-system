// pattern: Imperative Shell
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { ReconnectBanner } from "./components/ReconnectBanner";
import { SidebarNav } from "./components/SidebarNav";
import { SidebarPanel } from "./components/SidebarPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { TopBar } from "./components/TopBar";
import { SidebarContext } from "./contexts";
import { DndProvider } from "./dnd/DndContext";
import { SyncProvider } from "./sync/SyncProvider";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
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
  const idRef = useRef(1);
  const navigate = useNavigate();

  const sidebarApi = useMemo(() => ({
    openInSidebar: (title: string) => {
      const id = idRef.current;
      idRef.current += 1;
      setStack((s) => [{ id, title }, ...s]); // newest on top
    },
  }), []);

  // Cmd/Ctrl-U (focus search) lives in SearchBar, next to the input it targets.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        navigate("/");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  return (
    <SyncProvider>
      <DndProvider>
        <SidebarContext.Provider value={sidebarApi}>
          <div className="app">
            <ReconnectBanner />
            <button className="hamburger" aria-label="menu"
                    onClick={() => setNavOpen((o) => !o)}>
              ☰
            </button>
            <nav className={"left-nav" + (navOpen ? " open" : "") + (sidebarCollapsed ? " collapsed" : "")}>
              <div className="nav-title">pkm</div>
              <Link to="/" className="nav-link" onClick={() => setNavOpen(false)}>
                Daily Notes
              </Link>
              <ThemeToggle />
              <SidebarNav onNavigate={() => setNavOpen(false)} />
            </nav>
            <div className="content-area">
              <TopBar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
              <main className="main-pane">
                <Routes>
                  <Route path="/" element={<Journal />} />
                  <Route path="/page/*" element={<PageView />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </main>
            </div>
            {stack.length > 0 && (
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
        </SidebarContext.Provider>
      </DndProvider>
    </SyncProvider>
  );
}
