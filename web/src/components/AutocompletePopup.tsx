// pattern: Imperative Shell
// Title options for the [[ / # popup: debounced fetch behind the shared
// stale-response guard (useStaleGuard, same as SearchBar), plus the dumb
// popup list itself.
import { useEffect, useState } from "react";
import type { CanonicalTitle, RawTitle } from "../api/brands";
import { apiGet } from "../api/typedClient";
import { asRawTitle } from "../replica/titles";
import { useStaleGuard } from "../useStaleGuard";

const DEBOUNCE_MS = 150;

export function useTitleOptions(query: string | null): CanonicalTitle[] {
  const [options, setOptions] = useState<CanonicalTitle[]>([]);
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

/** A ref/tag row: picking inserts `pageTitle`. A search hit is canonical and
 * the "New page" row is the typed query, so the row holds the wider kind. */
export interface TitleAcRow {
  label: string;
  isNew: boolean;
  pageTitle: RawTitle;
  command?: undefined;
}

/** A "command" (slash) row: picking runs applySlashCommand instead of the
 * ref/tag applyCompletion path. */
export interface CommandAcRow {
  label: string;
  isNew: boolean;
  command: string;
  pageTitle?: undefined;
}

export type AcRow = TitleAcRow | CommandAcRow;

export function buildRows(options: CanonicalTitle[],
                          query: string): TitleAcRow[] {
  const rows: TitleAcRow[] = options.map((t) => (
    { label: t, isNew: false, pageTitle: t }));
  const exact = options.some((t) => t.toLowerCase() === query.toLowerCase());
  if (query !== "" && !exact) {
    rows.push({ label: query, isNew: true, pageTitle: asRawTitle(query) });
  }
  return rows;
}

export function AutocompletePopup<R extends AcRow>(
  { rows, selected, onPick }: {
    rows: R[]; selected: number; onPick: (row: R) => void;
  }) {
  if (rows.length === 0) return null;
  return (
    <div className="ac-popup" role="listbox">
      {rows.map((row, i) => (
        <div key={`${row.isNew ? "new" : "t"}-${row.label}`} role="option"
             aria-selected={i === selected}
             className={"ac-row" + (i === selected ? " selected" : "")}
             onMouseDown={(e) => { e.preventDefault(); onPick(row); }}>
          {row.isNew ? <>New page: <b>{row.label}</b></> : row.label}
        </div>
      ))}
    </div>
  );
}
