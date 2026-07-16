// pattern: Imperative Shell
import { type FormEvent, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { SidebarNavEntry, SidebarNavPayload } from "../api/payloads";
import { pagePath } from "../paths";

type MutationState = "idle" | "running" | "failed";

/** Left-nav shortcuts to pinned pages, with an edit mode to add, remove, and
 * reorder them. Writes refetch the list rather than updating optimistically,
 * since order_idx is server-assigned and entries are few. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const [entries, setEntries] = useState<SidebarNavEntry[]>([]);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [mutationState, setMutationState] = useState<MutationState>("idle");

  // The freshest entries, updated imperatively alongside setEntries so a
  // queued mutation can read them the instant its turn comes up rather than
  // through React's own render/commit timing.
  const entriesRef = useRef<SidebarNavEntry[]>(entries);
  // One lane: a mutation plus its authoritative refresh always run start to
  // finish before the next queued one begins, so a reorder or remove
  // clicked while another mutation is still settling never computes from
  // stale entries or interleaves its refresh with the in-flight one's.
  const laneRef = useRef<Promise<void>>(Promise.resolve());

  function applyEntries(list: SidebarNavEntry[]) {
    entriesRef.current = list;
    setEntries(list);
  }

  const refresh = () =>
    apiFetch<SidebarNavPayload>("/api/sidebar").then((p) => applyEntries(p.entries));

  useEffect(() => {
    let cancelled = false;
    apiFetch<SidebarNavPayload>("/api/sidebar")
      .then((p) => { if (!cancelled) applyEntries(p.entries); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="error nav-sidebar-error">Couldn't load sidebar entries.</p>;

  /** Queue `mutate` behind whatever mutation is currently running. `mutate`
   * receives the entries current when its turn actually begins, not the
   * entries in scope when it was queued. Every rejection — from the
   * mutation itself or the refresh that follows it — is caught here, so it
   * surfaces as mutationState "failed" instead of an unhandled rejection. */
  function runMutation(mutate: (current: SidebarNavEntry[]) => Promise<void>): Promise<void> {
    const started = laneRef.current.then(async () => {
      setMutationState("running");
      try {
        await mutate(entriesRef.current);
        await refresh();
        setMutationState("idle");
      } catch {
        setMutationState("failed");
      }
    });
    laneRef.current = started;
    return started;
  }

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setAddError(null);
    await runMutation(async () => {
      try {
        await apiFetch("/api/sidebar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        setNewTitle("");
      } catch (err) {
        setAddError(err instanceof ApiError && err.status === 409
          ? "That entry already exists." : "Couldn't add entry.");
        throw err;
      }
    });
  }

  function removeEntry(id: number) {
    void runMutation(() => apiFetch(`/api/sidebar/${id}`, { method: "DELETE" }).then(() => undefined));
  }

  function moveEntry(index: number, direction: -1 | 1) {
    void runMutation(async (current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return;
      const ids = current.map((entry) => entry.id);
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await apiFetch("/api/sidebar", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
      });
    });
  }

  const busy = mutationState === "running";

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
      {mutationState === "failed" && (
        <p className="error nav-sidebar-error">Couldn't save the change. Try again.</p>
      )}
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
                  <button type="button" className="btn-secondary" aria-label={`Move ${entry.title} up`}
                          disabled={busy || i === 0} onClick={() => moveEntry(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn-secondary" aria-label={`Move ${entry.title} down`}
                          disabled={busy || i === entries.length - 1} onClick={() => moveEntry(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn-secondary" aria-label={`Remove ${entry.title}`}
                          disabled={busy} onClick={() => removeEntry(entry.id)}>
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <form className="nav-sidebar-add" onSubmit={(e) => { void addEntry(e); }}>
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                 disabled={busy} placeholder="Add page…" aria-label="New sidebar entry title" />
          <button type="submit" className="btn-secondary" disabled={busy}>Add</button>
          {addError && <p className="error nav-sidebar-error">{addError}</p>}
        </form>
      )}
    </div>
  );
}
