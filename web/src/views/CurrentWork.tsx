// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { CurrentWorkPayload } from "../api/payloads";
import { pagePath } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { Link } from "react-router-dom";

export function CurrentWork() {
  const [payload, setPayload] = useState<CurrentWorkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const token = ++seqRef.current;
    setError(null);
    apiFetch<CurrentWorkPayload>("/api/current-work")
      .then((p) => { if (token === seqRef.current) setPayload(p); })
      .catch((e: unknown) => {
        if (token === seqRef.current) setError(String(e));
      });
  }, []);

  useEffect(() => { load(); }, [load]);
  useResync(load);
  useEffect(() => { document.title = "Current Work — pkm"; }, []);

  if (error) return <p className="error">Could not load Current Work: {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;

  return (
    <article className="current-work">
      <h1 className="page-title">Current Work</h1>
      {payload.sections.map((section) => (
        <section key={section.id} className="current-work-section"
                 aria-label={section.title}>
          <h2>{section.title}</h2>
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
