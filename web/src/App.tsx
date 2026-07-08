// pattern: Imperative Shell
import { Link, Route, Routes } from "react-router-dom";
import { PageView } from "./views/PageView";

export function App() {
  return (
    <div className="app">
      <nav className="left-nav">
        <div className="nav-title">pkm</div>
        <Link to="/" className="nav-link">Daily Notes</Link>
      </nav>
      <main className="main-pane">
        <Routes>
          {/* Task 8 replaces this element with <Journal /> */}
          <Route path="/" element={<p className="empty">pkm</p>} />
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </main>
    </div>
  );
}
