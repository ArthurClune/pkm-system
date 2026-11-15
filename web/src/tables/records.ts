// pattern: Functional Core
import type { BlockUid } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type {
  QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../api/payloads";
import { FIRST_ORDER_IDX, orderIdxAfter } from "../outline/orderIdx";
import { sha256Hex } from "../replica/sha256";
import type { FilterRow } from "./filter";

export function defaultColumns(p: QueryRecordsPayload): string[] {
  return p.keys.filter((k) => k.count * 2 >= p.total).map((k) => k.key);
}

/** `labels` maps a column key to its header; Source reads `page` for a
 * page record so `source:page` picks page results. */
export function recordRow(
  r: QueryRecordModel,
  labels: ReadonlyMap<string, string>,
): FilterRow {
  const row: Record<string, string> = {
    Result: r.row_title,
    Source: r.kind === "page" ? "page" : r.page_title,
  };
  for (const [key, label] of labels) {
    const cell = r.cells[key];
    if (cell) row[label] = cell.value;
  }
  return row;
}

function startsAWord(value: string, typed: string): boolean {
  const lower = value.toLowerCase();
  for (let at = lower.indexOf(typed); at !== -1;
       at = lower.indexOf(typed, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(lower[at - 1]!)) return true;
  }
  return false;
}

function isCapitalised(s: string): boolean {
  const first = s[0] ?? "";
  return first !== first.toLowerCase();
}

/** The spelling a merged group shows: a capitalised one if any, then the
 * most common, then the first in alphabetical order. */
function displaySpelling(spellings: Map<string, number>): string {
  return [...spellings].sort(([a, na], [b, nb]) =>
    Number(isCapitalised(b)) - Number(isCapitalised(a)) || nb - na ||
    (a < b ? -1 : a > b ? 1 : 0))[0]![0];
}

export function suggestions(
  records: readonly QueryRecordModel[],
  key: string,
  typed: string,
): { value: string; count: number }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const r of records) {
    const value = r.cells[key]?.value.trim() ?? "";
    if (value === "") continue;
    const lower = value.toLowerCase();
    const spellings = groups.get(lower) ?? new Map<string, number>();
    spellings.set(value, (spellings.get(value) ?? 0) + 1);
    groups.set(lower, spellings);
  }
  const merged = [...groups.values()].map((spellings) => ({
    value: displaySpelling(spellings),
    count: [...spellings.values()].reduce((a, b) => a + b, 0),
  }));
  if (!merged.some((m) => m.count >= 2)) return [];
  const want = typed.trim().toLowerCase();
  return merged
    .filter((m) => m.value !== typed.trim() && startsAWord(m.value, want))
    .sort((a, b) => b.count - a.count ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

function fold(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1,
                        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The raw spelling of a key on `r` that looks like a misspelt `label`
 * (a shared prefix of four or more, or two edits apart when both have four
 * or more letters), so the editor can warn before writing a second key.
 * Null when `r` already holds the label's column. */
export function similarKey(r: QueryRecordModel, label: string): string | null {
  const want = fold(label);
  const cells = Object.entries(r.cells);
  if (cells.some(([key, c]) => fold(key) === want || fold(c.key_raw) === want)) {
    return null;
  }
  let best: { raw: string; distance: number; prefix: number } | null = null;
  for (const [, c] of cells) {
    const have = fold(c.key_raw);
    const prefix = sharedPrefix(have, want);
    const distance = levenshtein(have, want);
    const near = have.length >= 4 && want.length >= 4 && distance <= 2;
    if (prefix < 4 && !near) continue;
    if (!best || distance < best.distance ||
        (distance === best.distance && prefix > best.prefix)) {
      best = { raw: c.key_raw, distance, prefix };
    }
  }
  return best?.raw ?? null;
}

function writeExisting(
  r: QueryRecordModel, cell: RecordCell, value: string,
): BlockOp[] {
  const head = cell.text.slice(0, cell.value_start);
  const text = value.trim() === "" ? head : `${head} ${value}`;
  if (text === cell.text) return [];
  return [{
    op: "update_text", uid: cell.uid, text,
    base_text_hash: sha256Hex(cell.text), page_title: r.page_title,
  }];
}

/** The ops that set column `key` of `r` to `value`. A new line is spelled
 * as the column header and lands right after the record's last `::` line:
 * a create at an existing sibling's `order_idx` shifts that sibling and
 * everything after it down one, on the server and in the replica. */
export function planCellWrite(
  r: QueryRecordModel,
  key: string,
  label: string,
  value: string,
  mint: () => BlockUid,
): BlockOp[] {
  const cell = r.cells[key];
  if (cell) return writeExisting(r, cell, value);
  if (value.trim() === "") return [];
  const orderIdx = r.insert_before_order_idx ??
    (r.last_attr_order_idx !== null
      ? orderIdxAfter(r.last_attr_order_idx) : FIRST_ORDER_IDX);
  return [{
    op: "create", uid: mint(), page_title: r.page_title,
    parent_uid: r.insert_parent_uid, order_idx: orderIdx,
    text: `${label}:: ${value}`,
  }];
}
