// pattern: Functional Core
// A query block's table and cards: its columns from the view's column names,
// the rows the view shows, Save planned against the host block's own text,
// and the bookkeeping of a cell write (its inverse, and the record as the
// write leaves it, shown until the next refetch).
import type { CanonicalTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type {
  KeyStat, QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../api/payloads";
import type { MacroOptions } from "../grammar/macroOptions";
import {
  formatMacroOptions, normaliseMacroOptions, optionsRefusal,
  rewriteMacroOptions,
} from "../grammar/macroOptionsWrite";
import { tokenizeBlock } from "../grammar/tokenize";
import { orderIdxAfter } from "../outline/orderIdx";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import type { FilterRow } from "./filter";
import { columnName, defaultColumns, recordRow } from "./records";
import { viewRows } from "./viewRows";
import type { ViewDefaults, ViewFields } from "./viewState";

/** The title column's name, in filters, sorts and DataTable keys. */
export const RESULT = "Result";
const SOURCE = "Source";

/** An attribute column: `name` is its FilterRow and DataTable key, `label`
 * the name the view stores and the header shows, `key` the record cells'
 * key (the attribute page). */
export interface QueryColumn { name: string; label: string; key: string }

/** The server sends the groups exactly when no record has a `::` cell,
 * which is when the default view is blocks. */
export function queryDefaults(p: QueryRecordsPayload): ViewDefaults {
  const labelOf = new Map(p.keys.map((k) => [k.key as string, k.label]));
  return {
    view: p.groups === null ? "table" : "blocks",
    columns: defaultColumns(p).map((k) => labelOf.get(k) ?? k),
  };
}

/** A stored name finds its key by the label the server reports for it, or
 * as a key itself; a name matching neither is a column no record holds. */
export function queryColumns(labels: readonly string[],
                             keys: readonly KeyStat[]): QueryColumn[] {
  const byName = new Map<string, string>();
  for (const k of keys) if (!byName.has(k.label)) byName.set(k.label, k.key);
  for (const k of keys) if (!byName.has(k.key)) byName.set(k.key, k.key);
  const seen = new Set<string>();
  const out: QueryColumn[] = [];
  for (const label of labels) {
    const name = columnName(label);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, label, key: byName.get(label) ?? label });
  }
  return out;
}

export interface ShownRow {
  record: QueryRecordModel;
  row: FilterRow;
  stale: boolean;
}

/** `matching` is the "N" of "N of M results": the rows shown that still
 * match the filter. `held` is holdRecords' answer. */
export function shownRows(
  records: readonly QueryRecordModel[], columns: readonly QueryColumn[],
  live: ViewFields, frozen: readonly string[] | null,
  held?: ReadonlyMap<string, QueryRecordModel>,
): { rows: ShownRow[]; matching: number } {
  const labels = new Map(columns.map((c) => [c.key, c.label]));
  const { rows, matching } = viewRows(
    records, (r) => r.key, (r) => recordRow(r, labels),
    [RESULT, SOURCE, ...columns.map((c) => c.name)], live, frozen, held);
  return { rows: rows.map(({ item, row, stale }) => ({ record: item, row, stale })),
           matching };
}

/** The records a frozen view goes on showing after a refetch to `next`:
 * each frozen id `next` lacks keeps its last record, from `prev` or from
 * `held`, so an edit that makes a row stop matching the query itself does
 * not take the row out from under the reader. An id `next` returns again
 * shows `next`'s record. While unfrozen it keeps what this refetch dropped
 * from `prev`, which the view ignores: an edit whose freeze is not yet
 * committed when the refetch lands still finds the row it froze. */
export function holdRecords(
  prev: readonly QueryRecordModel[],
  held: ReadonlyMap<string, QueryRecordModel>,
  next: readonly QueryRecordModel[], frozen: readonly string[] | null,
): Map<string, QueryRecordModel> {
  const out = new Map<string, QueryRecordModel>();
  const returned = new Set(next.map((r) => r.key));
  const last = new Map(frozen === null ? [] : held);
  for (const r of prev) last.set(r.key, r);
  for (const key of frozen ?? last.keys()) {
    const r = last.get(key);
    if (!returned.has(key) && r !== undefined) out.set(key, r);
  }
  return out;
}

/** The default columns a frozen view showed when the first refetch of its
 * freeze landed, with the key stats that name their keys. `frozen` is that
 * freeze, by identity: a later one holds afresh. */
export interface HeldColumns {
  frozen: readonly string[];
  labels: readonly string[];
  keys: readonly KeyStat[];
}

/** What a refetch landing under `frozen` holds: this freeze's hold if
 * `prev`, the load before it, has one, else `prev`'s defaults and keys. */
export function holdColumns(
  prev: { defaults: ViewDefaults; keys: readonly KeyStat[];
          held: HeldColumns | null } | null,
  frozen: readonly string[] | null,
): HeldColumns | null {
  if (frozen === null || prev === null) return null;
  if (prev.held?.frozen === frozen) return prev.held;
  return { frozen, labels: prev.defaults.columns, keys: prev.keys };
}

/** The columns a query view shows. While `held` is this freeze's, columns
 * that follow the defaults (`defaulted`) are the held ones, so a refetch
 * whose records no longer hold a key does not take its column, and a draft
 * open in it, from under the reader; and a column the current stats no
 * longer name finds its key in the held ones, as a held row's cells need.
 * Columns the macro or the reader chose are shown as they are. */
export function shownColumns(
  live: readonly string[], keys: readonly KeyStat[],
  held: HeldColumns | null, frozen: readonly string[] | null,
  defaulted: boolean,
): QueryColumn[] {
  if (held === null || held.frozen !== frozen) return queryColumns(live, keys);
  return queryColumns(defaulted ? held.labels : live, [...keys, ...held.keys]);
}

const sameOptions = (a: MacroOptions, b: MacroOptions): boolean =>
  formatMacroOptions(a) === formatMacroOptions(b);

const NOT_FOUND = "Can't find this query in its block's text to save the "
  + "view. Use Edit as text.";
const NO_ROUND_TRIP = "This view would not read back from the block's text, "
  + "so it was not saved. Use Edit as text.";

/** The host block's text with `next` saved into this query's macro, found
 * by its expression and current options in the host's own text: the
 * tokenizer's span for a rendered query is relative to the text it was
 * given, which a quote prefix or a block ref makes another text. */
export function planQuerySave(
  hostText: string, expr: string, own: MacroOptions, next: MacroOptions,
): { text: string } | { refusal: string } {
  const refused = optionsRefusal(next);
  if (refused !== null) return { refusal: refused };
  const found = tokenizeBlock(hostText).flatMap((s) =>
    s.kind === "query" && s.expr === expr && sameOptions(s.options, own)
      ? [s.span] : []);
  if (found.length !== 1) return { refusal: NOT_FOUND };
  const span = found[0]!;
  const text = rewriteMacroOptions(hostText, span, next);
  const back = tokenizeBlock(text).find((s) =>
    s.kind === "query" && s.span[0] === span[0]);
  if (back?.kind !== "query" || back.expr !== expr
      || !sameOptions(back.options, normaliseMacroOptions(next))) {
    return { refusal: NO_ROUND_TRIP };
  }
  return { text };
}

/** The ops that undo `ops`, the write planCellWrite made to `r`'s column
 * `key`. Its hash is of the text the write leaves, so an edit made since
 * lands as a conflict rather than being overwritten. */
export function inverseCellWrite(r: QueryRecordModel, key: string,
                                 ops: readonly BlockOp[]): BlockOp[] {
  return ops.flatMap((op): BlockOp[] => {
    if (op.op === "update_text") {
      const before = r.cells[key]?.text;
      if (before === undefined) return [];
      return [{ op: "update_text", uid: op.uid, text: before,
                base_text_hash: sha256Hex(op.text), page_title: r.page_title }];
    }
    if (op.op === "create") {
      return [{ op: "delete", uid: op.uid,
                base_subtree_hash: subtreeHash([[op.uid, op.text]]) }];
    }
    return [];
  });
}

const valueOf = (text: string, start: number): string =>
  text.slice(start).replace(/^\s+/, "");

/** `cur` with column `key` and the insert slot as they were in `before`, the
 * record captured before a write: what an undo or a failed write shows.
 * Other cells keep what has happened to them since. */
export function restoreCell(cur: QueryRecordModel, before: QueryRecordModel,
                            key: string): QueryRecordModel {
  const cells = { ...cur.cells };
  const was = before.cells[key];
  if (was === undefined) delete cells[key];
  else cells[key] = was;
  return { ...cur, cells,
           insert_before_order_idx: before.insert_before_order_idx,
           last_attr_order_idx: before.last_attr_order_idx };
}

/** `r` as a cell write's `ops` leave it. A line created
 * where the server said to insert takes that slot and shifts the sibling
 * there down one, so the next insert goes one further. */
export function patchRecord(r: QueryRecordModel, key: string,
                            ops: readonly BlockOp[]): QueryRecordModel {
  let next = r;
  for (const op of ops) {
    if (op.op === "update_text") {
      const entry = Object.entries(next.cells).find(([, c]) => c.uid === op.uid);
      if (!entry) continue;
      const [at, c] = entry;
      next = { ...next, cells: { ...next.cells, [at]: {
        ...c, text: op.text, value: valueOf(op.text, c.value_start) } } };
    } else if (op.op === "create") {
      const start = op.text.indexOf("::") + 2;
      const made: RecordCell = {
        uid: op.uid, key_raw: op.text.slice(0, start - 2), text: op.text,
        value: valueOf(op.text, start), value_start: start,
      };
      next = {
        ...next, cells: { ...next.cells, [key]: made },
        ...(next.insert_before_order_idx !== null
          ? { insert_before_order_idx: orderIdxAfter(next.insert_before_order_idx) }
          : { last_attr_order_idx: op.order_idx }),
      };
    }
  }
  return next;
}

export function writeMessage(label: string, value: string,
                             page: CanonicalTitle): string {
  return value === "" ? `${label} cleared on ${page}`
    : `${label}:: ${value} written to ${page}`;
}
