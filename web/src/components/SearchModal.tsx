// pattern: Imperative Shell
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { SearchPayload } from "../api/payloads";
import { parseSnippet } from "../grammar/snippet";
import { pagePath } from "../paths";

interface ResultRow {
  key: string;
  title: string;          // navigation target (page title)
  label: string;
  snippet: string | null; // block hits only
}

function toRows(p: SearchPayload): ResultRow[] {
  const pages: ResultRow[] = p.pages.map((h) => ({
    key: `p-${h.id}`, title: h.title, label: h.title, snippet: null,
  }));
  const blocks: ResultRow[] = p.blocks.map((h) => ({
    key: `b-${h.uid}`, title: h.page_title, label: h.page_title, snippet: h.snippet,
  }));
  return [...pages, ...blocks]; // pages ranked first, then block snippets
}

const CREATE_ROW_KEY = "create";

/** True when some PAGE hit's title equals `title` case-insensitively.
 * Block hits don't count -- their `title` is the containing page, not
 * necessarily a title match for the query itself. */
function hasExactPageMatch(rows: ResultRow[], title: string): boolean {
  const needle = title.toLowerCase();
  return rows.some((r) => r.key.startsWith("p-") && r.title.toLowerCase() === needle);
}

export function SearchModal({ open, onClose }:
    { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [selected, setSelected] = useState(0);
  // The query whose results `rows` currently reflects -- null while a fetch
  // for the current query hasn't settled yet. Gates the create-page row so
  // it only appears once we actually know there's no exact page match,
  // instead of flashing on for a query whose real results haven't arrived.
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Request sequence token: only the latest dispatched request may set rows,
  // so a slow response for an old query can't clobber newer results.
  const seqRef = useRef(0);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      seqRef.current++; // drop any in-flight response after close
      setQuery("");
      setRows([]);
      setResultsQuery(null);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      seqRef.current++; // drop any in-flight response for a cleared query
      setRows([]);
      setResultsQuery(null);
      setSelected(0);
      return;
    }
    const timer = setTimeout(() => {
      const token = ++seqRef.current;
      apiFetch<SearchPayload>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((p) => {
          if (token !== seqRef.current) return; // stale response: drop
          setRows(toRows(p));
          setResultsQuery(trimmed);
          setSelected(0);
        })
        .catch(() => {
          if (token !== seqRef.current) return;
          setRows([]);
          setResultsQuery(trimmed);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const trimmedQuery = query.trim();
  const showCreateRow = trimmedQuery !== "" && resultsQuery === trimmedQuery
    && !hasExactPageMatch(rows, trimmedQuery);
  const displayRows: ResultRow[] = showCreateRow
    ? [...rows, { key: CREATE_ROW_KEY, title: trimmedQuery,
                  label: `Create page "${trimmedQuery}"`, snippet: null }]
    : rows;

  const go = async (row: ResultRow) => {
    if (row.key === CREATE_ROW_KEY) {
      try {
        await apiFetch("/api/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: row.title }),
        });
      } catch {
        return; // creation failed: keep the modal open, don't navigate
      }
    }
    onClose();
    navigate(pagePath(row.title));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, displayRows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && displayRows[selected]) {
      void go(displayRows[selected]);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="search-input" placeholder="Search…"
               aria-label="Search"
               value={query} onKeyDown={onKeyDown}
               onChange={(e) => setQuery(e.target.value)} />
        <ul className="search-results">
          {displayRows.map((row, i) => (
            <li key={row.key}
                className={"search-result" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => void go(row)}>
              <span className="result-page">{row.label}</span>
              {row.snippet !== null && (
                <span className="result-snippet">
                  {parseSnippet(row.snippet).map((part, j) =>
                    part.mark
                      ? <mark key={j}>{part.text}</mark>
                      : <span key={j}>{part.text}</span>)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
