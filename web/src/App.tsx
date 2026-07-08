// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { SearchModal } from "./components/SearchModal";
import { Journal } from "./views/Journal";
import { PageView } from "./views/PageView";

export function App() {
  const [searchOpen, setSearchOpen] = useState(false);

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
    <div className="app">
      <nav className="left-nav">
        <div className="nav-title">pkm</div>
        <Link to="/" className="nav-link">Daily Notes</Link>
        <button className="nav-link search-button"
                onClick={() => setSearchOpen(true)}>
          Search
        </button>
      </nav>
      <main className="main-pane">
        <Routes>
          <Route path="/" element={<Journal />} />
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </main>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
