// pattern: Imperative Shell
import { Link, Route, Routes } from "react-router-dom";
import { Journal } from "./views/Journal";
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
          <Route path="/" element={<Journal />} />
          <Route path="/page/*" element={<PageView />} />
        </Routes>
      </main>
    </div>
  );
}
