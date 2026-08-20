// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/typedClient";
import type { SearchPayload } from "../api/payloads";
import { SidebarContext } from "../contexts";
import { parseSnippet } from "../grammar/snippet";
import { pagePath } from "../paths";
import { useDismiss } from "../useDismiss";
import { useStaleGuard } from "../useStaleGuard";
import { SearchIcon } from "./icons";

interface ResultRow {
  key: string;
  title: string;          // navigation target (page title)
  label: string;
  snippet: string | null; // block hits only
  uid?: string;           // block hits only: jump-to-block target on the page
}

function toRows(p: SearchPayload): ResultRow[] {
  const pages: ResultRow[] = p.pages.map((h) => ({
    key: `p-${h.id}`, title: h.title, label: h.title, snippet: null,
  }));
  const blocks: ResultRow[] = p.blocks.map((h) => ({
    key: `b-${h.uid}`, title: h.page_title, label: h.page_title,
    snippet: h.snippet, uid: h.uid,
  }));
  return [...pages, ...blocks]; // pages ranked first, then block snippets
}

const CREATE_ROW_KEY = "create";

// navigator.platform is legacy but still the reliable way to pick the
// modifier glyph; iOS devices report iPhone/iPad and take ⌘ from a
// paired keyboard.
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** True when some PAGE hit's title equals `title` case-insensitively.
 * Block hits don't count -- their `title` is the containing page, not
 * necessarily a title match for the query itself. */
function hasExactPageMatch(rows: ResultRow[], title: string): boolean {
  const needle = title.toLowerCase();
  return rows.some((r) => r.key.startsWith("p-") && r.title.toLowerCase() === needle);
}

/** Inline search bar for the top bar: a real input that owns focus, with a
 * results dropdown anchored beneath it. Escape, an outside click, or picking
 * a result cancels the search (clears the query, closes the dropdown).
 * Cmd/Ctrl-U focuses the bar from anywhere; pressing it again cancels. */
export function SearchBar() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false); // dropdown may show (bar engaged)
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [selected, setSelected] = useState(0);
  // The query whose results `rows` currently reflects -- null while a fetch
  // for the current query hasn't settled yet. Gates the create-page row so
  // it only appears once we actually know there's no exact page match,
  // instead of flashing on for a query whose real results haven't arrived.
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Only the latest dispatched request may set rows, so a slow response for
  // an old query can't clobber newer results.
  const guard = useStaleGuard();
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);

  // Stable: closes over refs, state setters, and the guard (itself stable),
  // so the document-level listeners below bind once rather than per render.
  const cancel = useCallback(() => {
    guard.cancel(); // drop any in-flight response after cancel
    setOpen(false);
    setQuery("");
    setRows([]);
    setResultsQuery(null);
    setSelected(0);
    inputRef.current?.blur();
  }, [guard]);

  // Cmd/Ctrl-U: focus the bar from anywhere; when the bar already has focus
  // the shortcut cancels instead (a toggle, like the old search modal).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        if (document.activeElement === inputRef.current) cancel();
        else inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cancel]);

  // While engaged: an outside click cancels, and Escape cancels at the
  // document level so the search can be dismissed even when focus has
  // wandered off the input. Escape does not preventDefault here — the input
  // is a real text field with its own Escape handling.
  useDismiss(wrapRef, cancel, { enabled: open });

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      guard.cancel(); // drop any in-flight response for a cleared query
      setRows([]);
      setResultsQuery(null);
      setSelected(0);
      return;
    }
    const timer = setTimeout(() => {
      const token = guard.begin();
      apiGet("/api/search", { query: { q: query } })
        .then((p) => {
          if (guard.isStale(token)) return; // stale response: drop
          setRows(toRows(p));
          setResultsQuery(trimmed);
          setSelected(0);
        })
        .catch(() => {
          if (guard.isStale(token)) return;
          setRows([]);
          setResultsQuery(trimmed);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, guard]);

  const trimmedQuery = query.trim();
  const showCreateRow = trimmedQuery !== "" && resultsQuery === trimmedQuery
    && !hasExactPageMatch(rows, trimmedQuery);
  const displayRows: ResultRow[] = showCreateRow
    ? [{ key: CREATE_ROW_KEY, title: trimmedQuery,
         label: `Create page "${trimmedQuery}"`, snippet: null }, ...rows]
    : rows;

  // `sidebar`: open the row's page in the sidebar instead of navigating the
  // main view -- same semantics as shift-clicking a wiki link (PageLink.tsx).
  // A not-yet-existing page isn't "a chosen result", so the create row always
  // takes its normal create+navigate path regardless of the shift flag.
  const go = async (row: ResultRow, sidebar: boolean) => {
    if (row.key === CREATE_ROW_KEY) {
      try {
        await apiPost("/api/pages", { body: { title: row.title } });
      } catch {
        return; // creation failed: keep the search open, don't navigate
      }
      cancel();
      navigate(pagePath(row.title));
      return;
    }
    cancel();
    // Block hits carry their uid so both destinations scroll to and flash the
    // matched block: the main pane reads it from the URL hash (pkm-pzdu), the
    // sidebar panel takes it directly (pkm-gdi5).
    if (sidebar) openInSidebar(row.title, row.uid);
    else navigate(pagePath(row.title) + (row.uid ? `#${row.uid}` : ""));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      cancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, displayRows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && displayRows[selected]) {
      void go(displayRows[selected], e.shiftKey);
    }
  };

  return (
    <div className="search-field" ref={wrapRef}>
      <span className="search-field-icon"><SearchIcon /></span>
      <input ref={inputRef} className="search-field-input top-bar-search-input"
             placeholder="Search…"
             aria-label="Search" value={query}
             onFocus={() => setOpen(true)}
             onChange={(e) => { setOpen(true); setQuery(e.target.value); }}
             onKeyDown={onKeyDown} />
      {/* must directly follow the input: the CSS hides it via `+` when the
        * input is focused or holds text (pkm-absu) */}
      <kbd className="top-bar-search-hint" aria-hidden="true">
        {IS_MAC ? "⌘U" : "Ctrl+U"}
      </kbd>
      {open && displayRows.length > 0 && (
        <ul className="search-results">
          {displayRows.map((row, i) => (
            <li key={row.key}
                className={"search-result" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={(e) => void go(row, e.shiftKey)}>
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
      )}
    </div>
  );
}
