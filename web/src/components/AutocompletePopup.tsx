// pattern: Imperative Shell
// Title options for the [[ / # popup: debounced fetch with a stale-response
// token (same pattern as SearchModal), plus the dumb popup list itself.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { TitlesPayload } from "../api/payloads";

const DEBOUNCE_MS = 150;

export function useTitleOptions(query: string | null): string[] {
  const [options, setOptions] = useState<string[]>([]);
  const seqRef = useRef(0);
  useEffect(() => {
    if (query === null || query === "") {
      seqRef.current++;
      setOptions([]);
      return;
    }
    const token = ++seqRef.current;
    const timer = setTimeout(() => {
      apiFetch<TitlesPayload>(`/api/titles?q=${encodeURIComponent(query)}`)
        .then((p) => { if (token === seqRef.current) setOptions(p.titles); })
        .catch(() => { if (token === seqRef.current) setOptions([]); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  return options;
}

export interface AcRow {
  title: string;
  isNew: boolean;
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
