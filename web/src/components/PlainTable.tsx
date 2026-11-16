// pattern: Imperative Shell
// A plain {{table}} block, loaded lazily by RoamTable: its body rows
// filtered and sorted in the browser (the blocks never move), its cells
// edited in place, "+ New row", and the filter and sort saved into the
// macro's options.
//
// Every write goes through an outline handler, so it is one entry in the
// outline's undo history like any other edit of the page, and Cmd-Z undoes
// it. No write notice is shown: the cell is the block that changed, in
// view, and an Undo on a notice could only undo the newest history entry,
// not this write.
//
// DataTable may commit an open cell after this component has unmounted, so
// onWrite reads only its props.
import { useContext, useState } from "react";
import type { CreateOp, UpdateTextOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import type { MacroOptions } from "../grammar/macroOptions";
import { formatMacroOptions, optionsRefusal } from "../grammar/macroOptionsWrite";
import { CellMediaContext, OutlinePageContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import type { OutlineHandlers } from "../outline/handlers";
import { roamTable, type RoamTableRows } from "../outline/roamTableRows";
import type { CellRef } from "../tables/cellEditor";
import { DataTable, type Column } from "../tables/DataTable";
import { island } from "../tables/island";
import {
  bodyRows, headerSegments, planTableSave, shownTableRows, TABLE_DEFAULTS, tableColumns,
  tableSavedView, type TableRow,
} from "../tables/plainTable";
import { planNewRow, planTableCellWrite } from "../tables/tableWrites";
import { TableToolbar } from "../tables/TableToolbar";
import type { Shown } from "../tables/viewRows";
import { initialView, isDirty, optionsFromView, stepView,
         type ViewEvent, type ViewFields } from "../tables/viewState";
import { newUid } from "../uid";
import { InlineSegments } from "./InlineSegments";

export interface PlainTableProps {
  /** The {{table}} block. */
  node: BlockNode;
  rows: RoamTableRows;
  options: MacroOptions;
  handlers: OutlineHandlers;
  /** False in a read-only outline: no cell opens, and Save, Edit as text
   * and "+ New row" are not offered. */
  editable: boolean;
}

const content = (text: string) => <InlineSegments segments={tokenizeBlock(text)} />;

export function PlainTable({ node, rows, options, handlers,
                             editable }: PlainTableProps) {
  const saved = tableSavedView(options);
  const savedText = formatMacroOptions(optionsFromView(saved, TABLE_DEFAULTS));
  const [view, setView] = useState(() => initialView(saved));
  // An edit of the macro's options (a Save, Edit as text, another device)
  // brings a new saved view; one the reader has not touched follows it.
  const [seen, setSeen] = useState(savedText);
  if (seen !== savedText) {
    setSeen(savedText);
    setView((v) => stepView(v, { kind: "loaded", saved }));
  }
  const [saveRefusal, setSaveRefusal] =
    useState<{ live: ViewFields; text: string } | null>(null);
  // Rows "+ New row" made under this live view: shown at the end even when
  // the filter or a frozen view would leave them out, until the view changes.
  const [added, setAdded] = useState<{ live: ViewFields; ids: string[] } | null>(null);
  const [openCell, setOpenCell] = useState<CellRef | null>(null);
  const page = useContext(OutlinePageContext);

  const step = (e: ViewEvent) => setView((v) => stepView(v, e));
  const live = view.live;
  const columns = tableColumns(rows[0]!);
  const at = new Map(columns.map((c, i) => [c.key, i]));
  const body = bodyRows(rows);
  const shown = shownTableRows(body, columns, live, view.frozen);
  const listed = new Set(shown.rows.map((s) => s.item.id));
  const extra = (added?.live === live ? added.ids : []).filter((id) => !listed.has(id));
  const tail = extra.length > 0 ? shownTableRows(body, columns, live, extra).rows : [];
  const shownRows = [...shown.rows, ...tail];
  const matching = shown.matching + tail.filter((s) => !s.stale).length;

  const next = optionsFromView(live, TABLE_DEFAULTS);
  const refusal = optionsRefusal(next)
    ?? (saveRefusal?.live === live ? saveRefusal.text : null);

  // Planned against the block's text as the tree holds it now, and the view
  // counts as saved only once the write went through: a refused write (an
  // unsaved draft, a text limit) leaves Reset and Save showing.
  const save = () => {
    const seen: { refusal: string | null; unchanged: boolean } =
      { refusal: null, unchanged: false };
    const written = handlers.onEditInBlock(node.uid, (table) => {
      const plan = planTableSave(table.text, next);
      if ("refusal" in plan) {
        seen.refusal = plan.refusal;
        return [];
      }
      seen.unchanged = plan.text === table.text;
      return seen.unchanged ? []
        : [{ op: "update_text", uid: table.uid, text: plan.text }];
    });
    if (seen.refusal !== null) setSaveRefusal({ live, text: seen.refusal });
    else if (written || seen.unchanged) step({ kind: "saved" });
  };

  const onWrite = (r: Shown<TableRow>, c: Column, value: string) => {
    const col = at.get(c.key);
    if (col === undefined) return;
    const written = handlers.onEditInBlock(node.uid,
                                           (table, title): (CreateOp | UpdateTextOp)[] => {
      const t = roamTable(table);
      const index = t ? t.rows.findIndex((row) => row[0]?.uid === r.item.id) : -1;
      const write = t && index > 0
        ? planTableCellWrite(t.rows, index, col, value, newUid, title) : null;
      if (write === null) return [];
      return write.kind === "text"
        ? [{ op: "update_text", uid: write.uid, text: write.text }] : write.ops;
    });
    if (written) step({ kind: "edited", visibleIds: shownRows.map((s) => s.item.id) });
  };

  const newRow = () => {
    const made: string[] = [];
    const inserted = handlers.onEditInBlock(node.uid, (table, title) => {
      const t = roamTable(table);
      const ops = t ? planNewRow(table, t.rows[0]!.length, newUid, title) : [];
      if (ops[0]) made.push(ops[0].uid);
      return ops;
    });
    const row = made[0];
    if (!inserted || row === undefined) return;
    setAdded({ live, ids: [...(added?.live === live ? added.ids : []), row] });
    setOpenCell({ row, col: columns[0]!.key });
  };

  const dataColumns: Column[] = columns.map((c) => ({
    key: c.key, label: c.key, editable: true,
    heading: c.header
      ? <InlineSegments segments={headerSegments(c.header.text)} />
      : undefined,
  }));

  return (
    <div {...island}>
      <TableToolbar filter={live.filter}
                    onFilter={(text) => step({ kind: "filter", text })}
                    count={`${matching} of ${body.length} rows`}
                    dirty={isDirty(view)} saved={savedText !== ""}
                    canSave refusal={refusal}
                    onReset={() => step({ kind: "reset" })}
                    onSave={editable ? save : undefined}
                    onEditAsText={editable
                      ? () => handlers.onFocusBlock(node.uid, node.text.length)
                      : undefined} />
      <DataTable<Shown<TableRow>>
        columns={dataColumns} rows={shownRows} rowId={(r) => r.item.id}
        renderCell={(r, c) => {
          const cell = r.item.cells[at.get(c.key)!];
          if (!cell) return null;
          return (
            <CellMediaContext.Provider value={{ page, uid: cell.uid }}>
              {content(cell.text)}
            </CellMediaContext.Provider>
          );
        }}
        cellAnchor={(r, c) => r.item.cells[at.get(c.key)!]?.uid ?? null}
        rawValue={(r, c) => r.item.cells[at.get(c.key)!]?.text ?? ""}
        sort={live.sort} onSortClick={(col) => step({ kind: "sortClick", col })}
        staleIds={new Set(shownRows.filter((s) => s.stale).map((s) => s.item.id))}
        canEdit={editable} onWrite={onWrite}
        openCell={openCell} onCellOpened={() => setOpenCell(null)} />
      {editable && (
        <button type="button" className="btn-secondary btn-compact"
                onClick={newRow}>+ New row</button>
      )}
    </div>
  );
}
