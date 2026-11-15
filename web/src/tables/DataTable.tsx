// pattern: Imperative Shell
// The table both query tables and plain {{table}} blocks render: sortable
// headers, one cell editor at a time driven by stepEditor, and the rows
// marked stale after an edit. What a write does is the caller's: onWrite
// gets the row, the column and the trimmed value.
import { useEffect, useLayoutEffect, useRef, useState,
         type ReactNode } from "react";
import { neighbourCell, stepEditor, type CellRef, type EditorEffect,
         type EditorEvent, type EditorState } from "./cellEditor";
import { CellTextarea, type Suggestion } from "./CellTextarea";
import { island } from "./island";
import type { ViewFields } from "./viewState";

export interface Column {
  key: string;
  label: string;
  editable: boolean;
  numeric?: boolean;
}

export interface DataTableProps<R> {
  columns: Column[];
  rows: R[];
  rowId: (r: R) => string;
  renderCell: (r: R, c: Column) => ReactNode;
  /** The text the editor opens with: the cell as typed, not as rendered. */
  rawValue: (r: R, c: Column) => string;
  sort: ViewFields["sort"];
  onSortClick: (col: string) => void;
  staleIds?: ReadonlySet<string>;
  canEdit: boolean;
  onWrite: (r: R, c: Column, value: string) => void;
  /** Shown with the open editor: a warning before the write. */
  cellHint?: (r: R, c: Column) => ReactNode;
  suggest?: (r: R, c: Column, typed: string) => Suggestion[];
}

const IDLE: EditorState = { kind: "idle" };

export function DataTable<R>({ columns, rows, rowId, renderCell, rawValue,
                               sort, onSortClick, staleIds, canEdit, onWrite,
                               cellHint, suggest }: DataTableProps<R>) {
  const [editor, setEditor] = useState<EditorState>(IDLE);
  // Read by dispatch, which can run twice before a re-render (the capture
  // mousedown commits, then the click opens another cell).
  const editorRef = useRef<EditorState>(IDLE);
  // The rows open in the editor, by id: a write lands on its row even after
  // a refetch has dropped that row from `rows`.
  const openRows = useRef(new Map<string, R>());

  const byId = new Map(rows.map((r) => [rowId(r), r]));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const editable = (c: Column) => canEdit && c.editable;
  const order: CellRef[] = rows.flatMap((r) => columns.filter(editable)
    .map((c) => ({ row: rowId(r), col: c.key })));

  const runWrites = (effects: EditorEffect[]) => {
    for (const w of effects) {
      const r = byId.get(w.cell.row) ?? openRows.current.get(w.cell.row);
      const c = byKey.get(w.cell.col);
      if (r !== undefined && c !== undefined) onWrite(r, c, w.value);
    }
  };

  const dispatch = (event: EditorEvent) => {
    const { state, effects } = stepEditor(editorRef.current, event);
    editorRef.current = state;
    setEditor(state);
    runWrites(effects);
    const keep = state.kind === "editing"
      ? openRows.current.get(state.cell.row) : undefined;
    openRows.current.clear();
    if (state.kind === "editing" && keep !== undefined) {
      openRows.current.set(state.cell.row, keep);
    }
  };

  const open = (r: R, c: Column) => {
    const id = rowId(r);
    openRows.current.set(id, r);
    dispatch({ kind: "open", cell: { row: id, col: c.key },
               value: rawValue(r, c) });
  };

  const tab = (dir: 1 | -1) => {
    const cur = editorRef.current;
    if (cur.kind !== "editing") return;
    const cell = neighbourCell(order, cur.cell, dir);
    const r = cell && byId.get(cell.row);
    const c = cell && byKey.get(cell.col);
    if (cell && r !== undefined && r !== null && c) {
      openRows.current.set(cell.row, r);
      dispatch({ kind: "tab", dir, next: { cell, value: rawValue(r, c) } });
    } else {
      dispatch({ kind: "tab", dir, next: null });
    }
  };

  // An open cell that stops rendering (a refetch dropped its row, its column
  // went, editing was switched off) commits, as a click elsewhere does.
  useEffect(() => {
    const cur = editorRef.current;
    if (cur.kind !== "editing") return;
    const c = byKey.get(cur.cell.col);
    if (!byId.has(cur.cell.row) || c === undefined || !editable(c)) {
      dispatch({ kind: "outside" });
    }
  });

  // A table unmounted with a cell open (keyboard navigation away) commits
  // it. React runs the host's effect cleanups before this one, so onWrite
  // may be called after the host's own cleanup, in the same commit.
  const commitOnUnmount = useRef(() => {});
  useLayoutEffect(() => {
    commitOnUnmount.current = () => {
      const { effects } = stepEditor(editorRef.current, { kind: "outside" });
      editorRef.current = IDLE;
      runWrites(effects);
    };
  });
  useEffect(() => {
    const commit = commitOnUnmount;
    return () => commit.current();
  }, []);

  // The capture mousedown and the blur both report leaving, and the second
  // must not close a cell opened since: Tab's next cell, or a clicked one.
  const leave = (id: string, col: string) => () => {
    const cur = editorRef.current;
    if (cur.kind === "editing" && cur.cell.row === id && cur.cell.col === col) {
      dispatch({ kind: "outside" });
    }
  };

  const onCellClick = (e: React.MouseEvent, r: R, c: Column) => {
    if ((e.target as Element).closest("a")) return;
    open(r, c);
  };

  const isOpen = (id: string, c: Column) => editor.kind === "editing"
    && editor.cell.row === id && editor.cell.col === c.key;

  return (
    <div className="data-table-scroll" {...island}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const dir = sort?.col === c.key ? sort.dir : null;
              return (
                <th key={c.key} className={c.numeric ? "numeric" : undefined}
                    aria-sort={dir === null ? undefined
                      : dir === "asc" ? "ascending" : "descending"}>
                  <button type="button" className="data-table-sort"
                          onClick={() => onSortClick(c.key)}>
                    {c.label}
                    {dir !== null && (
                      <span className="data-table-arrow" aria-hidden="true">
                        {dir === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = rowId(r);
            const stale = staleIds?.has(id) ?? false;
            return (
              <tr key={id} className={stale ? "stale" : undefined}>
                {columns.map((c, i) => {
                  const classes = [c.numeric ? "numeric" : "",
                                   editable(c) ? "editable" : ""]
                    .filter(Boolean).join(" ");
                  return (
                    <td key={c.key} className={classes || undefined}
                        onClick={editable(c) ? (e) => onCellClick(e, r, c)
                          : undefined}>
                      {editable(c) && isOpen(id, c) && editor.kind === "editing"
                        ? <CellTextarea
                            key={`${id}\u0000${c.key}`}
                            label={c.label} draft={editor.draft}
                            onDraft={(draft) => dispatch({ kind: "input", draft })}
                            onCommit={() => dispatch({ kind: "commit" })}
                            onCancel={() => dispatch({ kind: "cancel" })}
                            onOutside={leave(id, c.key)}
                            onTab={tab}
                            hint={cellHint?.(r, c)}
                            suggest={suggest
                              ? (typed) => suggest(r, c, typed) : undefined} />
                        : renderCell(r, c)}
                      {stale && i === 0 && (
                        <span className="data-table-stale-label">
                          no longer matches
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
