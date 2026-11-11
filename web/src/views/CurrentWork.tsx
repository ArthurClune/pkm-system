// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../api/typedClient";
import type { CurrentWorkPayload } from "../api/payloads";
import { pagePath } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { useStaleGuard } from "../useStaleGuard";
import { Link } from "react-router";

export function CurrentWork() {
  const [payload, setPayload] = useState<CurrentWorkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guard = useStaleGuard();

  const load = useCallback(() => {
    const token = guard.begin();
    setError(null);
    apiGet("/api/current-work")
      .then((p) => { if (!guard.isStale(token)) setPayload(p); })
      .catch((e: unknown) => {
        if (!guard.isStale(token)) setError(String(e));
      });
  }, [guard]);

  useEffect(() => { load(); }, [load]);
  useResync(load);

  if (error) return <p className="error">Could not load Current Work: {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;

  return (
    <article className="current-work">
      <h1 className="page-title">Current Work</h1>
      {payload.sections.map((section) => (
        <section key={section.id} className="current-work-section"
                 aria-label={section.heading}>
          <h2>{section.heading}</h2>
          {section.pages.length === 0 ? (
            <p className="empty">No pages changed in this window.</p>
          ) : (
            <ul>
              {section.pages.map((page) => (
                <li key={page.id}>
                  <Link to={pagePath(page.title)}>{page.title}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </article>
  );
}
