// pattern: Imperative Shell
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { ReconnectBanner } from "./components/ReconnectBanner";
import { SearchModal } from "./components/SearchModal";
import { SidebarNav } from "./components/SidebarNav";
import { SidebarPanel } from "./components/SidebarPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { SidebarContext } from "./contexts";
import { DndProvider } from "./dnd/DndContext";
import { SyncProvider } from "./sync/SyncProvider";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === "d") {
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
            <nav className={"left-nav" + (navOpen ? " open" : "")}>
              <div className="nav-title">pkm</div>
              <Link to="/" className="nav-link" onClick={() => setNavOpen(false)}>
                Daily Notes
              </Link>
              <button className="nav-link search-button"
                      onClick={() => { setNavOpen(false); setSearchOpen(true); }}>
                Search
              </button>
              <ThemeToggle />
              <SidebarNav onNavigate={() => setNavOpen(false)} />
            </nav>
            <main className="main-pane">
              <Routes>
                <Route path="/" element={<Journal />} />
                <Route path="/page/*" element={<PageView />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </main>
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
            <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
          </div>
        </SidebarContext.Provider>
      </DndProvider>
    </SyncProvider>
  );
}
