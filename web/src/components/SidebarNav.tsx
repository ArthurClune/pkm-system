// pattern: Imperative Shell
import { type FormEvent, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { SidebarNavEntry, SidebarNavPayload } from "../api/payloads";
import { pagePath } from "../paths";

/** Left-nav shortcuts to pinned pages, with an edit mode to add, remove, and
 * reorder them. Writes refetch the list rather than updating optimistically,
 * since order_idx is server-assigned and entries are few. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const [entries, setEntries] = useState<SidebarNavEntry[]>([]);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = () =>
    apiFetch<SidebarNavPayload>("/api/sidebar").then((p) => setEntries(p.entries));

  useEffect(() => {
    let cancelled = false;
    apiFetch<SidebarNavPayload>("/api/sidebar")
      .then((p) => { if (!cancelled) setEntries(p.entries); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="error nav-sidebar-error">Couldn't load sidebar entries.</p>;

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setAddError(null);
    try {
      await apiFetch("/api/sidebar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setNewTitle("");
      await refresh();
    } catch (err) {
      setAddError(err instanceof ApiError && err.status === 409
        ? "That entry already exists." : "Couldn't add entry.");
    }
  }

  async function removeEntry(id: number) {
    await apiFetch(`/api/sidebar/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function reorder(order: number[]) {
    await apiFetch("/api/sidebar", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });
    await refresh();
  }

  function moveEntry(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= entries.length) return;
    const ids = entries.map((entry) => entry.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void reorder(ids);
  }

  if (entries.length === 0 && !editing) {
    return (
      <button type="button" className="nav-link nav-sidebar-edit-toggle"
              onClick={() => setEditing(true)}>
        Edit
      </button>
    );
  }

  return (
    <div className="nav-sidebar">
      <button type="button" className="nav-link nav-sidebar-edit-toggle"
              onClick={() => setEditing((v) => !v)}>
        {editing ? "Done" : "Edit"}
      </button>
      {entries.length > 0 && (
        <ul className="nav-sidebar-entries">
          {entries.map((entry, i) => (
            <li key={entry.id} className="nav-sidebar-entry">
              <NavLink to={pagePath(entry.title)} onClick={onNavigate}
                       className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}>
                {entry.title}
              </NavLink>
              {editing && (
                <span className="nav-sidebar-entry-controls">
                  <button type="button" aria-label={`Move ${entry.title} up`}
                          disabled={i === 0} onClick={() => moveEntry(i, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${entry.title} down`}
                          disabled={i === entries.length - 1} onClick={() => moveEntry(i, 1)}>
                    ↓
                  </button>
                  <button type="button" aria-label={`Remove ${entry.title}`}
                          onClick={() => removeEntry(entry.id)}>
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form className="nav-sidebar-add" onSubmit={addEntry}>
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                 placeholder="Add page…" aria-label="New sidebar entry title" />
          <button type="submit">Add</button>
          {addError && <p className="error nav-sidebar-error">{addError}</p>}
        </form>
      )}
    </div>
  );
}
