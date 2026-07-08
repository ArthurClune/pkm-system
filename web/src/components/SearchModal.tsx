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

export function SearchModal({ open, onClose }:
    { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setRows([]);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setRows([]);
      setSelected(0);
      return;
    }
    const timer = setTimeout(() => {
      apiFetch<SearchPayload>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((p) => { setRows(toRows(p)); setSelected(0); })
        .catch(() => setRows([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  if (!open) return null;

  const go = (row: ResultRow) => {
    onClose();
    navigate(pagePath(row.title));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && rows[selected]) {
      go(rows[selected]);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="search-input" placeholder="Search…"
               value={query} onKeyDown={onKeyDown}
               onChange={(e) => setQuery(e.target.value)} />
        <ul className="search-results">
          {rows.map((row, i) => (
            <li key={row.key}
                className={"search-result" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => go(row)}>
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
