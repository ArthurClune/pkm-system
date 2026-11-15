// pattern: Imperative Shell
// A query's records as a DataTable: the title column, then one column per
// `::` key, each with a menu that hides, adds and moves columns. Cells
// write through `onWrite`; the title is a link, never edited here.
import { useRef, useState } from "react";
import type { KeyStat, QueryRecordModel } from "../api/payloads";
import { BlockMenu, type BlockMenuItem } from "../components/BlockMenu";
import { DataTable, type Column } from "./DataTable";
import { CellValue, RecordLink, RecordSource } from "./recordCells";
import { RESULT, type QueryColumn, type ShownRow } from "./queryView";
import { similarKey, suggestions } from "./records";
import type { ViewFields } from "./viewState";

export interface QueryTableProps {
  rows: ShownRow[];
  columns: QueryColumn[];
  keys: readonly KeyStat[];
  records: readonly QueryRecordModel[];
  sort: ViewFields["sort"];
  onSortClick: (col: string) => void;
  canEdit: boolean;
  onWrite: (r: QueryRecordModel, c: QueryColumn, value: string) => void;
  onColumns: (labels: string[]) => void;
  depth: number;
}

const TITLE: Column = { key: RESULT, label: RESULT, editable: false };

export function QueryTable({ rows, columns, keys, records, sort, onSortClick,
                             canEdit, onWrite, onColumns,
                             depth }: QueryTableProps) {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const tableColumns: Column[] = [TITLE, ...columns.map((c) => (
    { key: c.name, label: c.label, editable: true }))];
  const stale = new Set(rows.filter((r) => r.stale).map((r) => r.record.key));
  const cellOf = (r: ShownRow, c: Column) => {
    const qc = byName.get(c.key);
    return qc ? r.record.cells[qc.key] : undefined;
  };

  return (
    <DataTable<ShownRow>
      columns={tableColumns} rows={rows} rowId={(r) => r.record.key}
      renderCell={(r, c) => {
        if (c.key === RESULT) {
          return <><RecordLink record={r.record} depth={depth} /><RecordSource record={r.record} /></>;
        }
        const cell = cellOf(r, c);
        return cell ? <CellValue cell={cell} depth={depth} /> : null;
      }}
      rawValue={(r, c) => cellOf(r, c)?.value ?? ""}
      sort={sort} onSortClick={onSortClick} staleIds={stale}
      canEdit={canEdit}
      onWrite={(r, c, value) => {
        const qc = byName.get(c.key);
        if (qc) onWrite(r.record, qc, value);
      }}
      cellHint={(r, c) => {
        const qc = byName.get(c.key);
        const near = qc ? similarKey(r.record, qc.key, qc.label) : null;
        return near === null ? null
          : `This page has ${near}:: — saving adds a ${qc!.label}:: line.`;
      }}
      suggest={(_r, c, typed) => {
        const qc = byName.get(c.key);
        return qc ? suggestions(records, qc.key, typed) : [];
      }}
      headerMenu={(c) => (
        <ColumnMenu column={c} columns={columns} keys={keys}
                    onColumns={onColumns} />
      )} />
  );
}

function ColumnMenu({ column, columns, keys, onColumns }: {
  column: Column;
  columns: QueryColumn[];
  keys: readonly KeyStat[];
  onColumns: (labels: string[]) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const labels = columns.map((c) => c.label);
  const index = columns.findIndex((c) => c.name === column.key);
  const moved = (to: number) => {
    const next = [...labels];
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  };
  const shown = new Set(columns.map((c) => c.key));
  const items: BlockMenuItem[] = [];
  if (index !== -1) {
    items.push(
      { label: "Move left", disabled: index === 0,
        action: () => onColumns(moved(index - 1)) },
      { label: "Move right", disabled: index === columns.length - 1,
        action: () => onColumns(moved(index + 1)) },
      // An empty column list has no option to save it in.
      { label: "Hide column", disabled: columns.length === 1,
        action: () => onColumns(labels.filter((_, i) => i !== index)) },
    );
  }
  for (const k of keys) {
    if (shown.has(k.key)) continue;
    items.push({ label: k.label, group: "Add column",
                 action: () => onColumns([...labels, k.label]) });
  }
  return (
    <>
      <button ref={button} type="button" className="data-table-menu"
              aria-label={`${column.label} column menu`} aria-haspopup="menu"
              aria-expanded={at !== null} disabled={items.length === 0}
              onClick={() => {
                const rect = button.current!.getBoundingClientRect();
                setAt({ x: rect.left, y: rect.bottom });
              }}>▾</button>
      {at !== null && (
        <BlockMenu x={at.x} y={at.y} items={items} label="Column actions"
                   onClose={() => setAt(null)} />
      )}
    </>
  );
}
