// pattern: Imperative Shell
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { SearchModal } from "./components/SearchModal";
import { SidebarPanel } from "./components/SidebarPanel";
import { SidebarContext } from "./contexts";
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

  const sidebarApi = useMemo(() => ({
    openInSidebar: (title: string) => {
      const id = idRef.current;
      idRef.current += 1;
      setStack((s) => [{ id, title }, ...s]); // newest on top
    },
  }), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <SidebarContext.Provider value={sidebarApi}>
      <div className="app">
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
  );
}
