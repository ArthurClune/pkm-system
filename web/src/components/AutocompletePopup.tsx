// pattern: Imperative Shell
// Title options for the [[ / # popup: debounced fetch behind the shared
// stale-response guard (useStaleGuard, same as SearchBar), plus the dumb
// popup list itself.
import { useEffect, useState } from "react";
import { apiGet } from "../api/typedClient";
import { useStaleGuard } from "../useStaleGuard";

const DEBOUNCE_MS = 150;

export function useTitleOptions(query: string | null): string[] {
  const [options, setOptions] = useState<string[]>([]);
  const guard = useStaleGuard();
  useEffect(() => {
    if (query === null || query === "") {
      guard.cancel(); // an emptied query must not be repopulated by an answer
      setOptions([]);
      return;
    }
    // The token is taken when the keystroke arrives, not when the debounce
    // fires, so a superseded request is already stale before it is sent.
    const token = guard.begin();
    const timer = setTimeout(() => {
      apiGet("/api/titles", { query: { q: query } })
        .then((p) => { if (!guard.isStale(token)) setOptions(p.titles); })
        .catch(() => { if (!guard.isStale(token)) setOptions([]); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, guard]);
  return options;
}

export interface AcRow {
  title: string;
  isNew: boolean;
  /** Set for "command" (slash) rows; picking runs applySlashCommand instead
   * of the ref/tag applyCompletion path. */
  command?: string;
}

export function buildRows(options: string[], query: string): AcRow[] {
  const rows: AcRow[] = options.map((t) => ({ title: t, isNew: false }));
  const exact = options.some((t) => t.toLowerCase() === query.toLowerCase());
  if (query !== "" && !exact) rows.push({ title: query, isNew: true });
  return rows;
}

export function AutocompletePopup({ rows, selected, onPick }: {
  rows: AcRow[]; selected: number; onPick: (row: AcRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="ac-popup" role="listbox">
      {rows.map((row, i) => (
        <div key={`${row.isNew ? "new" : "t"}-${row.title}`} role="option"
             aria-selected={i === selected}
             className={"ac-row" + (i === selected ? " selected" : "")}
             onMouseDown={(e) => { e.preventDefault(); onPick(row); }}>
          {row.isNew ? <>New page: <b>{row.title}</b></> : row.title}
        </div>
      ))}
    </div>
  );
}
