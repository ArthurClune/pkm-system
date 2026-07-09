// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { SidebarNavEntry, SidebarNavPayload } from "../api/payloads";
import { pagePath } from "../paths";

/** Left-nav shortcuts to pinned pages (managing entries is a follow-up). */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const [entries, setEntries] = useState<SidebarNavEntry[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<SidebarNavPayload>("/api/sidebar")
      .then((p) => { if (!cancelled) setEntries(p.entries); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="error nav-sidebar-error">Couldn't load sidebar entries.</p>;
  if (entries.length === 0) return null;

  return (
    <ul className="nav-sidebar-entries">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link to={pagePath(entry.title)} className="nav-link" onClick={onNavigate}>
            {entry.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
